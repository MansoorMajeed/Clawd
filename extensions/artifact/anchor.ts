import { normalize, type Block } from "./render";

/** What a thread froze at comment time. This is also what the agent is told. */
export interface Anchor {
	/** Heading slug of the section the comment was made in ("" before the first heading). */
	section: string;
	/** Readable heading path, e.g. "Plan › Tasks". */
	path: string;
	/** Block the comment was made on, used first when placing the thread. */
	blockId: string;
	/** The selected text, or a diagram label. */
	quote: string;
	/** Text around the selection, to tell the agent (and the page) which occurrence was meant. */
	context?: string;
	/** For diagram labels: the matching Mermaid source line(s). */
	diagramSource?: string;
	/** Which copy of the quote in the original block (0-based), for repeated text. */
	occurrence?: number;
	/** Set by the agent (artifact_reply moved_to) after rewriting the commented text. */
	movedTo?: string;
}

export type Attachment =
	| { status: "exact"; blockId: string }
	| { status: "section"; blockId: string }
	| { status: "outdated" };

/**
 * Where to show a thread on the current page: where the agent moved it, else the original block if it still
 * contains the quote, else a block containing the surrounding text, else a
 * block under the same heading containing the quote, else the heading itself,
 * else nowhere (outdated).
 */
export function attach(anchor: Anchor, blocks: Block[]): Attachment {
	if (typeof anchor.quote !== "string" || !anchor.quote) return { status: "outdated" };
	if (anchor.movedTo) {
		const movedTo = normalize(anchor.movedTo);
		const moved = blocks.find((b) => b.plain.includes(movedTo));
		if (moved) return { status: "exact", blockId: moved.id };
	}
	const quote = normalize(anchor.quote);
	const context = anchor.context ? normalize(anchor.context) : undefined;

	const found =
		blocks.find((b) => b.id === anchor.blockId && b.plain.includes(quote)) ??
		(context ? blocks.find((b) => b.plain.includes(context)) : undefined) ??
		blocks.find((b) => b.heading === anchor.section && b.plain.includes(quote));
	if (found) return { status: "exact", blockId: found.id };

	const heading = anchor.section && blocks.find((b) => b.kind === "heading" && b.heading === anchor.section);
	if (heading) return { status: "section", blockId: heading.id };
	return { status: "outdated" };
}
