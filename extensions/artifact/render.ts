import { createHash } from "node:crypto";
import { Marked, type Token, type Tokens } from "marked";

export type BlockKind = "heading" | "paragraph" | "list" | "code" | "mermaid" | "table" | "blockquote" | "callout" | "decision" | "hr" | "html";

export interface Block {
	/** Stable ID: nearest heading slug plus a hash of the block's text. */
	id: string;
	/** Slug of the nearest heading at or above this block ("" before the first heading). */
	heading: string;
	/** Whitespace-normalized source text. */
	text: string;
	/** Whitespace-normalized rendered text (what the reader sees), used to find quoted selections. */
	plain: string;
	/** Heading path below the document title, e.g. "Tasks › Phase 1" ("" before the first heading). */
	path: string;
	/** Raw diagram source, for Mermaid blocks only. */
	source?: string;
	kind: BlockKind;
	html: string;
}

export interface RenderedDocument {
	title: string;
	blocks: Block[];
	hasMermaid: boolean;
}

const CALLOUTS: Record<string, string> = {
	NOTE: "Note",
	TIP: "Tip",
	IMPORTANT: "Important",
	WARNING: "Warning",
	CAUTION: "Caution",
	DECISION: "Decision",
};

export function escapeHtml(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function safeUrl(href: string): string | undefined {
	const trimmed = href.trim();
	// Browsers strip tabs and newlines inside URLs, so "java\tscript:" would still run.
	if (/[\u0000-\u001F\u007F]/.test(trimmed)) return undefined;
	if (/^(https?:|mailto:|#|\/|\.)/i.test(trimmed)) return trimmed;
	if (!/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return trimmed;
	return undefined;
}

const marked = new Marked({
	gfm: true,
	renderer: {
		html({ text }) {
			return escapeHtml(text);
		},
		link({ href, title, tokens }) {
			const text = this.parser.parseInline(tokens);
			const url = safeUrl(href);
			if (!url) return text;
			const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
			return `<a href="${escapeHtml(url)}"${titleAttr} target="_blank" rel="noopener noreferrer">${text}</a>`;
		},
		image({ href, title, text }) {
			const url = safeUrl(href);
			if (!url) return escapeHtml(text);
			const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
			return `<img src="${escapeHtml(url)}" alt="${escapeHtml(text)}"${titleAttr}>`;
		},
	},
});

function slugify(text: string): string {
	return text
		.toLowerCase()
		.replace(/[^\p{L}\p{N}\s-]/gu, "")
		.trim()
		.replace(/\s+/g, "-") || "section";
}

export function normalize(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function plainText(html: string): string {
	const text = html
		.replace(/<[^>]*>/g, " ")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&amp;/g, "&");
	return normalize(text);
}

function renderBlockquote(token: Tokens.Blockquote): { kind: BlockKind; html: string } {
	const lines = token.raw.split("\n").map((line) => line.replace(/^ {0,3}> ?/, ""));
	const match = /^\[!([A-Za-z]+)\]\s*$/.exec(lines[0] ?? "");
	const type = match?.[1].toUpperCase();
	if (!type || !CALLOUTS[type]) return { kind: "blockquote", html: marked.parser([token]) };
	const body = marked.parse(lines.slice(1).join("\n"), { async: false });
	const kind: BlockKind = type === "DECISION" ? "decision" : "callout";
	return {
		kind,
		html: `<div class="callout callout-${type.toLowerCase()}"><div class="callout-title">${CALLOUTS[type]}</div>${body}</div>`,
	};
}

function renderToken(token: Token): { kind: BlockKind; html: string } {
	switch (token.type) {
		case "code":
			if ((token as Tokens.Code).lang?.trim().toLowerCase() === "mermaid") {
				return { kind: "mermaid", html: `<pre class="mermaid">${escapeHtml((token as Tokens.Code).text)}</pre>` };
			}
			return { kind: "code", html: marked.parser([token]) };
		case "blockquote":
			return renderBlockquote(token as Tokens.Blockquote);
		case "heading":
		case "paragraph":
		case "list":
		case "table":
		case "hr":
		case "html":
			return { kind: token.type, html: marked.parser([token]) };
		default:
			return { kind: "paragraph", html: marked.parser([token]) };
	}
}

export function renderDocument(markdown: string): RenderedDocument {
	const tokens = marked.lexer(markdown);
	const blocks: Block[] = [];
	const slugCounts = new Map<string, number>();
	const idCounts = new Map<string, number>();
	let heading = "";
	const trail: Array<{ depth: number; text: string }> = [];
	let firstH1: string | undefined;
	let firstHeading: string | undefined;

	for (const token of tokens) {
		if (token.type === "space" || token.type === "def") continue;
		if (token.type === "heading") {
			const headingToken = token as Tokens.Heading;
			const base = slugify(headingToken.text);
			const seen = slugCounts.get(base) ?? 0;
			slugCounts.set(base, seen + 1);
			heading = seen === 0 ? base : `${base}-${seen}`;
			while (trail.length > 0 && trail[trail.length - 1].depth >= headingToken.depth) trail.pop();
			trail.push({ depth: headingToken.depth, text: plainText(marked.parseInline(headingToken.text, { async: false })) });
			firstHeading ??= headingToken.text;
			if (headingToken.depth === 1) firstH1 ??= headingToken.text;
		}
		const text = normalize(token.raw);
		const base = `${heading || "top"}--${createHash("sha1").update(text).digest("hex").slice(0, 8)}`;
		const seen = idCounts.get(base) ?? 0;
		idCounts.set(base, seen + 1);
		const { kind, html } = renderToken(token);
		const plain = kind === "mermaid" ? normalize((token as Tokens.Code).text) : plainText(html);
		// The document title adds nothing once there is a subsection to name.
		const named = trail.length > 1 && trail[0].depth === 1 ? trail.slice(1) : trail;
		const path = named.map((t) => t.text).join(" › ");
		const block: Block = { id: seen === 0 ? base : `${base}-${seen + 1}`, heading, text, plain, path, kind, html };
		if (kind === "mermaid") block.source = (token as Tokens.Code).text;
		blocks.push(block);
	}

	return {
		title: firstH1 ?? firstHeading ?? "Untitled",
		blocks,
		hasMermaid: blocks.some((b) => b.kind === "mermaid"),
	};
}
