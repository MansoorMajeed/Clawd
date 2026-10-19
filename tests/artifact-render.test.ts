import { describe, expect, it } from "vitest";
import { attach } from "../extensions/artifact/anchor";
import { renderDocument } from "../extensions/artifact/render";

const DOC = `# Plan title

Intro paragraph.

## Decisions

> [!DECISION]
> 1. Pick option A.

> [!DECISION]
> 2. Ship on Friday.

## Tasks

- [ ] Phase 1
- [ ] Phase 2
`;

function blockByText(doc: ReturnType<typeof renderDocument>, needle: string) {
	const block = doc.blocks.find((b) => b.text.includes(needle));
	if (!block) throw new Error(`no block containing ${needle}`);
	return block;
}

describe("renderDocument", () => {
	it("splits top-level blocks and tags each with its heading", () => {
		const doc = renderDocument(DOC);
		expect(doc.title).toBe("Plan title");
		expect(doc.blocks.map((b) => [b.kind, b.heading])).toEqual([
			["heading", "plan-title"],
			["paragraph", "plan-title"],
			["heading", "decisions"],
			["decision", "decisions"],
			["decision", "decisions"],
			["heading", "tasks"],
			["list", "tasks"],
		]);
	});

	it("keeps block IDs stable when unrelated text changes", () => {
		const before = renderDocument(DOC);
		const after = renderDocument(DOC.replace("Intro paragraph.", "A rewritten intro.\n\nPlus a new paragraph."));
		const idOf = (doc: typeof before, needle: string) => blockByText(doc, needle).id;
		expect(idOf(after, "Ship on Friday")).toBe(idOf(before, "Ship on Friday"));
		expect(idOf(after, "Phase 1")).toBe(idOf(before, "Phase 1"));
		expect(new Set(after.blocks.map((b) => b.id)).size).toBe(after.blocks.length);
	});

	it("gives each block its rendered plain text and heading path", () => {
		const doc = renderDocument("# Plan\n\n## Tasks\n\n### Phase 1\n\n- **Bold** item with `code` & more\n\n## Other\n\nText.");
		const item = doc.blocks.find((b) => b.kind === "list")!;
		expect(item.plain).toBe("Bold item with code & more");
		expect(item.path).toBe("Tasks › Phase 1");
		expect(doc.blocks.at(-1)!.path).toBe("Other");
		expect(doc.blocks[0].path).toBe("Plan");
		expect(renderDocument("```mermaid\nA-->B: hi\n```").blocks[0].plain).toBe("A-->B: hi");
	});

	it("keeps inline formatting joined to its neighbors in plain text", () => {
		const [para, table] = renderDocument("Use **bold**. Then `foo`bar &amp; more.\n\n| Name | Value |\n|---|---|\n| alpha | beta |").blocks;
		expect(para.plain).toBe("Use bold. Then foobar & more.");
		expect(table.plain).toBe("Name Value alpha beta");
		expect(attach({ section: "", path: "", blockId: "gone", quote: "alpha beta" }, [para, table])).toEqual({ status: "exact", blockId: table.id });
	});

	it("gives duplicate headings and blocks distinct IDs", () => {
		const doc = renderDocument("## Notes\n\nSame.\n\nSame.\n\n## Notes\n\nOther.");
		expect(doc.blocks.map((b) => b.heading)).toEqual(["notes", "notes", "notes", "notes-1", "notes-1"]);
		expect(new Set(doc.blocks.map((b) => b.id)).size).toBe(5);
	});

	it("renders raw HTML as text", () => {
		const doc = renderDocument(
			"Para with <img src=x onerror=alert(1)> and <b>bold</b>\n\n<script>alert(1)</script>\n",
		);
		const html = doc.blocks.map((b) => b.html).join("");
		expect(html).not.toMatch(/<script|<img|<b>/);
		expect(html).toContain("&lt;script&gt;");
		expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
	});

	it("drops unsafe link and image URLs but keeps their text", () => {
		const doc = renderDocument("[click](javascript:alert(1)) and ![pic](data:text/html,x) and [ok](https://example.com)");
		const html = doc.blocks[0].html;
		expect(html).not.toMatch(/javascript:|data:text/);
		expect(html).toContain("click");
		expect(html).toContain('href="https://example.com"');
		expect(html).toContain('rel="noopener noreferrer"');
	});

	it("drops javascript URLs disguised with control characters", () => {
		for (const sep of ["\t", "\r", "\n"]) {
			const md = `[a](<java${sep}script:alert(1)>) ![b](<java${sep}script:x>)\n\n> [!NOTE]\n> [c](<java${sep}script:y>)`;
			const html = renderDocument(md).blocks.map((b) => b.html).join("");
			expect(html).not.toMatch(/href=|src=/);
		}
		expect(renderDocument("[rel](./docs/x.md)").blocks[0].html).toContain('href="./docs/x.md"');
	});

	it("emits Mermaid fences as escaped diagram placeholders", () => {
		const doc = renderDocument("```mermaid\ngraph TD; A-->B<script>\n```");
		expect(doc.blocks[0].kind).toBe("mermaid");
		expect(doc.blocks[0].html).toBe('<pre class="mermaid">graph TD; A--&gt;B&lt;script&gt;</pre>');
		expect(doc.hasMermaid).toBe(true);
		expect(renderDocument("plain").hasMermaid).toBe(false);
	});

	it("renders callouts and decisions as components with escaped content", () => {
		const doc = renderDocument("> [!WARNING]\n> Careful **now** <script>x</script>\n\n> [!DECISION]\n> 1. Pick A.\n\n> Plain quote");
		const [warning, decision, quote] = doc.blocks;
		expect(warning.kind).toBe("callout");
		expect(warning.html).toContain('class="callout callout-warning"');
		expect(warning.html).toContain("<strong>now</strong>");
		expect(warning.html).toContain("&lt;script&gt;");
		expect(warning.html).not.toContain("[!WARNING]");
		expect(decision.kind).toBe("decision");
		expect(decision.html).toContain('class="callout callout-decision"');
		expect(quote.kind).toBe("blockquote");
		expect(quote.html).toContain("<blockquote>");
	});
});

describe("attach", () => {
	const doc = renderDocument(DOC);
	const decision = blockByText(doc, "Ship on Friday");
	const anchor = {
		section: "decisions",
		path: "Plan title › Decisions",
		blockId: decision.id,
		quote: "Ship on Friday",
		context: "Ship on Friday.",
	};
	const headingOf = (d: typeof doc, slug: string) => d.blocks.find((b) => b.kind === "heading" && b.heading === slug)!;

	it("stays on the original block while it still contains the quote", () => {
		expect(attach(anchor, doc.blocks)).toEqual({ status: "exact", blockId: decision.id });
	});

	it("follows the surrounding text when the block moves to another section", () => {
		const moved = renderDocument(DOC.replace("> [!DECISION]\n> 2. Ship on Friday.\n", "").replace("- [ ] Phase 2", "- [ ] Phase 2\n\n2. Ship on Friday."));
		expect(attach(anchor, moved.blocks)).toEqual({ status: "exact", blockId: blockByText(moved, "Ship on Friday").id });
	});

	it("finds the quote under the same heading after the block was rewritten around it", () => {
		const edited = renderDocument(DOC.replace("2. Ship on Friday.", "2. We should Ship on Friday, after review."));
		expect(attach(anchor, edited.blocks)).toEqual({ status: "exact", blockId: blockByText(edited, "after review").id });
	});

	it("does not match a short quote in another section", () => {
		const short = { ...anchor, quote: "Phase", context: "Phase gone" };
		const heading = headingOf(doc, "decisions");
		expect(attach(short, doc.blocks)).toEqual({ status: "section", blockId: heading.id });
	});

	it("falls back to the section heading when the quote is gone", () => {
		const edited = renderDocument(DOC.replace("Ship on Friday", "Ship on Monday"));
		expect(attach(anchor, edited.blocks)).toEqual({ status: "section", blockId: headingOf(edited, "decisions").id });
	});

	it("is outdated when the section is gone too", () => {
		const edited = renderDocument(DOC.replace("## Decisions", "## Choices").replace("Ship on Friday", "Ship later"));
		expect(attach(anchor, edited.blocks)).toEqual({ status: "outdated" });
	});

	it("keeps a comment on the second of two identical blocks on that copy", () => {
		const dup = renderDocument("## Notes\n\nSame.\n\nSame.\n");
		const second = dup.blocks[2];
		expect(attach({ section: "notes", path: "Notes", blockId: second.id, quote: "Same." }, dup.blocks)).toEqual({
			status: "exact",
			blockId: second.id,
		});
	});

	it("prefers the text the agent moved the thread to", () => {
		const edited = renderDocument(DOC.replace("Ship on Friday", "Ship next week"));
		const moved = { ...anchor, movedTo: "Ship next week" };
		expect(attach(moved, edited.blocks)).toEqual({ status: "exact", blockId: blockByText(edited, "Ship next week").id });
	});

	it("treats anchors from the old block format as outdated", () => {
		expect(attach({ heading: "decisions", text: "x" } as any, doc.blocks)).toEqual({ status: "outdated" });
	});
});
