import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { formatSendMessage } from "../extensions/artifact/message";
import { ThreadStore, threadStatus } from "../extensions/artifact/store";

const DOC = "/work/repo/.scratch/plans/todo/plan.md";
const anchor = { section: "decisions", path: "Plan › Decisions", blockId: "decisions--1", quote: "Pick option A", context: "1. Pick option A." };

let root: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "artifact-store-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("ThreadStore", () => {
	it("creates draft threads and appends follow-ups", () => {
		const store = new ThreadStore(root, DOC);
		const first = store.addComment({ anchor, text: "Why A?" });
		const second = store.addComment({ anchor, text: "Another point" });
		store.addComment({ threadId: first.id, text: "Also this" });
		expect([first.id, second.id]).toEqual([1, 2]);
		expect(store.get(1)!.messages.map((m) => [m.author, m.text, m.sent])).toEqual([
			["user", "Why A?", false],
			["user", "Also this", false],
		]);
		expect(threadStatus(store.get(1)!)).toBe("draft");
	});

	it("takes drafts from one thread or all threads and marks them sent", () => {
		const store = new ThreadStore(root, DOC);
		store.addComment({ anchor, text: "one" });
		store.addComment({ anchor, text: "two" });
		store.addComment({ anchor, text: "three" });

		const single = store.takeDrafts(2);
		expect(single.map((d) => [d.thread.id, d.texts])).toEqual([[2, ["two"]]]);
		expect(threadStatus(store.get(2)!)).toBe("sent");

		const rest = store.takeDrafts();
		expect(rest.map((d) => [d.thread.id, d.texts])).toEqual([[1, ["one"]], [3, ["three"]]]);
		expect(store.takeDrafts()).toEqual([]);
	});

	it("tracks replies, resolution, and discarded drafts", () => {
		const store = new ThreadStore(root, DOC);
		store.addComment({ anchor, text: "q" });
		store.takeDrafts();
		store.addReply(1, "answer");
		expect(threadStatus(store.get(1)!)).toBe("replied");
		store.setResolved(1, true);
		expect(threadStatus(store.get(1)!)).toBe("resolved");

		store.addComment({ anchor, text: "draft to drop" });
		store.discardDrafts(2);
		expect(store.get(2)).toBeUndefined();
	});

	it("persists under the root keyed by document path, without temp files", () => {
		const store = new ThreadStore(root, DOC);
		store.addComment({ anchor, text: "kept" });
		const reloaded = new ThreadStore(root, DOC);
		expect(reloaded.get(1)!.messages[0].text).toBe("kept");
		expect(reloaded.addComment({ anchor, text: "next" }).id).toBe(2);
		expect(new ThreadStore(root, "/other/doc.md").threads()).toEqual([]);
		expect(readdirSync(join(root, "threads")).filter((f) => !f.endsWith(".json"))).toEqual([]);
	});

	it("does not lose updates when two stores share a document", () => {
		const a = new ThreadStore(root, DOC);
		const b = new ThreadStore(root, DOC);
		expect(a.addComment({ anchor, text: "from A" }).id).toBe(1);
		expect(b.addComment({ anchor, text: "from B" }).id).toBe(2);
		a.addReply(2, "A answers B");
		expect(b.takeDrafts().map((d) => d.thread.id)).toEqual([1, 2]);
		const fresh = new ThreadStore(root, DOC);
		expect(fresh.threads().map((t) => [t.id, t.messages.map((m) => [m.text, m.sent])])).toEqual([
			[1, [["from A", true]]],
			[2, [["from B", true], ["A answers B", true]]],
		]);
	});

	it("does not send drafts from resolved threads until reopened", () => {
		const store = new ThreadStore(root, DOC);
		store.addComment({ anchor, text: "parked" });
		store.setResolved(1, true);
		store.addComment({ anchor, text: "active" });
		expect(store.takeDrafts().map((d) => d.texts)).toEqual([["active"]]);
		store.setResolved(1, false);
		expect(store.takeDrafts().map((d) => d.texts)).toEqual([["parked"]]);
	});

	it("marks drafts sent only after delivery succeeds", () => {
		const store = new ThreadStore(root, DOC);
		store.addComment({ anchor, text: "one" });
		expect(() =>
			store.takeDrafts(undefined, () => {
				throw new Error("boom");
			}),
		).toThrow("boom");
		expect(threadStatus(store.get(1)!)).toBe("draft");
		const delivered: string[][] = [];
		store.takeDrafts(undefined, (drafts) => delivered.push(...drafts.map((d) => d.texts)));
		expect(delivered).toEqual([["one"]]);
		expect(threadStatus(store.get(1)!)).toBe("sent");
	});

	it("records where the agent moved a thread", () => {
		const store = new ThreadStore(root, DOC);
		store.addComment({ anchor, text: "q" });
		store.addReply(1, "Reworded it", "Pick option B");
		expect(store.get(1)!.anchor).toMatchObject({ quote: "Pick option A", movedTo: "Pick option B" });
	});

	it("rejects replies to unknown threads", () => {
		const store = new ThreadStore(root, DOC);
		expect(() => store.addReply(9, "x")).toThrow(/thread #9/);
	});
});

describe("formatSendMessage", () => {
	it("sends threads saved by an older viewer version without failing", () => {
		const legacy = { thread: { id: 7, anchor: { heading: "x", text: "y" } as any, resolved: false, messages: [] }, texts: ["still here"] };
		expect(formatSendMessage("plan.md", [legacy])).toContain("[artifact viewer · plan.md · thread #7]\n\nstill here");
	});

	it("tells the agent the section, selection, context, and comment", () => {
		const store = new ThreadStore(root, DOC);
		store.addComment({ anchor, text: "Why A?\nNot B?" });
		store.addComment({ anchor: { section: "", path: "", blockId: "top--1", quote: "x".repeat(400) }, text: "Long" });
		store.addComment({
			anchor: { section: "flow", path: "Plan › Flow", blockId: "flow--1", quote: "user message", diagramSource: "Browser->>Session: user message" },
			text: "Tool call instead?",
		});
		const message = formatSendMessage(".scratch/plans/todo/plan.md", store.takeDrafts());
		expect(message).toBe(
			[
				"[artifact viewer · .scratch/plans/todo/plan.md · thread #1]",
				"Section: Plan › Decisions",
				'Selected: "Pick option A"',
				'Context: "…1. Pick option A.…"',
				"",
				"Why A?\nNot B?",
				"",
				"[artifact viewer · .scratch/plans/todo/plan.md · thread #2]",
				`Selected: "${"x".repeat(400)}"`,
				"",
				"Long",
				"",
				"[artifact viewer · .scratch/plans/todo/plan.md · thread #3]",
				"Section: Plan › Flow",
				'Diagram label: "user message"',
				"Mermaid source: Browser->>Session: user message",
				"",
				"Tool call instead?",
				"",
				'Reply to each thread with artifact_reply (file: ".scratch/plans/todo/plan.md"). Edit the file if the document should change; if you rewrite the text a thread points at, pass moved_to with the new text.',
			].join("\n"),
		);
	});
});
