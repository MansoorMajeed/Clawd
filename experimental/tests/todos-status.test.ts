import { describe, expect, it } from "vitest";
import { isTodoClosed, parseTodoStatus } from "../extensions/todos-status";

const baseFront = (status: string) =>
	JSON.stringify(
		{
			id: "deadbeef",
			title: "Add tests",
			tags: [],
			status,
			created_at: "2026-01-25T17:00:00.000Z",
		},
		null,
		2,
	);

describe("parseTodoStatus", () => {
	it("extracts status from the JSON front matter written by todos.ts", () => {
		expect(parseTodoStatus(baseFront("open"))).toBe("open");
		expect(parseTodoStatus(baseFront("closed"))).toBe("closed");
		expect(parseTodoStatus(baseFront("done"))).toBe("done");
	});

	it("lowercases status values", () => {
		expect(parseTodoStatus(baseFront("Closed"))).toBe("closed");
	});

	it("handles JSON front matter followed by a markdown body", () => {
		const text = `${baseFront("closed")}\n\nNotes here.\n`;
		// Regression for review finding #2: the old YAML-style regex matched
		// nothing in this format, so closed todos were counted as open.
		expect(parseTodoStatus(text)).toBe("closed");
	});

	it("defaults to 'open' for empty or malformed content", () => {
		expect(parseTodoStatus("")).toBe("open");
		expect(parseTodoStatus("just a markdown note\n")).toBe("open");
		expect(parseTodoStatus("{not json")).toBe("open");
		expect(parseTodoStatus('{"title": "no status"}')).toBe("open");
	});

	it("ignores embedded `status:` strings that aren't in the front matter", () => {
		// Pre-fix the YAML regex would match this body line and report "blocked"
		// even though the JSON front matter says open.
		const text = `${baseFront("open")}\n\nstatus: blocked from upstream\n`;
		expect(parseTodoStatus(text)).toBe("open");
	});
});

describe("isTodoClosed", () => {
	it("treats 'closed' and 'done' as closed; everything else as open", () => {
		expect(isTodoClosed("closed")).toBe(true);
		expect(isTodoClosed("done")).toBe(true);
		expect(isTodoClosed("open")).toBe(false);
		expect(isTodoClosed("blocked")).toBe(false);
		expect(isTodoClosed("")).toBe(false);
	});
});
