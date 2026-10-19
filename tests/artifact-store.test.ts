import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { formatSendMessage } from "../extensions/artifact/message";
import { ThreadStore, threadStatus } from "../extensions/artifact/store";

const DOC = "/work/repo/.scratch/plans/todo/plan.md";
const anchor = { heading: "decisions", text: "> [!DECISION] > 1. Pick option A." };

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

	it("rejects replies to unknown threads", () => {
		const store = new ThreadStore(root, DOC);
		expect(() => store.addReply(9, "x")).toThrow(/thread #9/);
	});
});

describe("formatSendMessage", () => {
	it("tags each thread with the viewer header, quote, and comments", () => {
		const store = new ThreadStore(root, DOC);
		store.addComment({ anchor, text: "Why A?\nNot B?" });
		store.addComment({ anchor: { heading: "tasks", text: "x".repeat(400) }, text: "Too long" });
		const message = formatSendMessage(".scratch/plans/todo/plan.md", store.takeDrafts());
		expect(message).toBe(
			[
				"[artifact viewer · .scratch/plans/todo/plan.md · thread #1]",
				"> > [!DECISION] > 1. Pick option A.",
				"",
				"Why A?\nNot B?",
				"",
				"[artifact viewer · .scratch/plans/todo/plan.md · thread #2]",
				`> ${"x".repeat(300)}…`,
				"",
				"Too long",
				"",
				'Reply to each thread with artifact_reply (file: ".scratch/plans/todo/plan.md"). Edit the file if the document should change.',
			].join("\n"),
		);
	});
});
