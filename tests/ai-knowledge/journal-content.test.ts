import { describe, it, expect } from "vitest";
import { foldAppend } from "../../extensions/ai-knowledge/journal-content.js";

const NOW = { date: "2026-05-05", hhmm: "19:30" };

describe("foldAppend", () => {
	it("creates a new file with header + subheading + bullet", () => {
		const out = foldAppend("", "explored option A", NOW, "first-task");
		expect(out).toBe(
			"# 2026-05-05 19:30 — first-task\n\n## 19:30\n- explored option A\n",
		);
	});

	it("folds bullets under existing same-minute subheading", () => {
		const existing =
			"# 2026-05-05 19:30 — first-task\n\n## 19:30\n- first bullet\n";
		const out = foldAppend(existing, "second bullet", NOW, "first-task");
		expect(out).toBe(existing + "- second bullet\n");
	});

	it("starts a new subheading when minute differs", () => {
		const existing =
			"# 2026-05-05 19:30 — first-task\n\n## 19:30\n- earlier\n";
		const later = { date: "2026-05-05", hhmm: "19:32" };
		const out = foldAppend(existing, "later note", later, "first-task");
		expect(out).toBe(existing + "\n## 19:32\n- later note\n");
	});

	it("starts a new subheading when content has bullets but no recent subheading", () => {
		const existing =
			"# 2026-05-05 19:30 — first-task\n\n## 19:30\n- first\n## something else\n- text\n";
		const out = foldAppend(existing, "new", NOW, "first-task");
		// Last subheading is "## something else" not "## 19:30", so we add a new one
		expect(out.endsWith("\n## 19:30\n- new\n")).toBe(true);
	});

	it("each line of multi-line text becomes its own bullet", () => {
		const out = foldAppend("", "line one\nline two\nline three", NOW, "t");
		expect(out).toContain("- line one\n- line two\n- line three\n");
	});

	it("preserves lines that already start with - or *", () => {
		const out = foldAppend("", "- already\n* asterisk", NOW, "t");
		expect(out).toContain("- already\n* asterisk\n");
	});

	it("treats indented continuations as part of preceding bullet", () => {
		const out = foldAppend("", "main bullet\n  continuation\n  more", NOW, "t");
		// Pure: indented lines remain attached to whatever precedes them.
		expect(out).toContain("- main bullet\n  continuation\n  more\n");
	});

	it("skips empty lines in input text", () => {
		const out = foldAppend("", "first\n\nsecond\n\n\n", NOW, "t");
		expect(out).toContain("- first\n- second\n");
		expect(out).not.toContain("- \n");
	});

	it("ensures trailing newline in output regardless of input shape", () => {
		const out = foldAppend("", "x", NOW, "t");
		expect(out.endsWith("\n")).toBe(true);
	});

	it("handles existing file without trailing newline", () => {
		const existing = "# 2026-05-05 19:30 — t\n\n## 19:30\n- a";
		const out = foldAppend(existing, "b", NOW, "t");
		expect(out).toBe("# 2026-05-05 19:30 — t\n\n## 19:30\n- a\n- b\n");
	});
});
