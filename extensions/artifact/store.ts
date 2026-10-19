import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Anchor } from "./anchor";

export interface ThreadMessage {
	author: "user" | "agent";
	text: string;
	at: string;
	/** User messages start as drafts until sent to the session. */
	sent: boolean;
}

export interface Thread {
	id: number;
	anchor: Anchor;
	resolved: boolean;
	messages: ThreadMessage[];
}

interface ThreadFile {
	path: string;
	nextId: number;
	threads: Thread[];
}

export type ThreadStatus = "draft" | "sent" | "replied" | "resolved";

export interface SentDrafts {
	thread: Thread;
	texts: string[];
}

export function defaultRoot(): string {
	return join(homedir(), ".pi", "agent", "artifacts");
}

export function threadStatus(thread: Thread): ThreadStatus {
	if (thread.resolved) return "resolved";
	if (thread.messages.some((m) => !m.sent)) return "draft";
	return thread.messages.at(-1)?.author === "agent" ? "replied" : "sent";
}

/** Comment threads for one document, saved under `<root>/threads/<sha1(path)>.json`. */
export class ThreadStore {
	private readonly file: string;
	private data!: ThreadFile;

	constructor(root: string, readonly docPath: string) {
		const dir = join(root, "threads");
		this.file = join(dir, `${createHash("sha1").update(docPath).digest("hex")}.json`);
		this.load();
	}

	/** Re-read from disk so another session's changes to the same document are not overwritten. */
	private load(): void {
		this.data = existsSync(this.file)
			? (JSON.parse(readFileSync(this.file, "utf8")) as ThreadFile)
			: { path: this.docPath, nextId: 1, threads: [] };
	}

	threads(): Thread[] {
		this.load();
		return this.data.threads;
	}

	get(id: number): Thread | undefined {
		this.load();
		return this.find(id);
	}

	private find(id: number): Thread | undefined {
		return this.data.threads.find((t) => t.id === id);
	}

	addComment(input: { anchor: Anchor; text: string } | { threadId: number; text: string }): Thread {
		this.load();
		const message: ThreadMessage = { author: "user", text: input.text, at: new Date().toISOString(), sent: false };
		let thread: Thread;
		if ("threadId" in input) {
			thread = this.require(input.threadId);
			thread.messages.push(message);
			thread.resolved = false;
		} else {
			thread = { id: this.data.nextId++, anchor: input.anchor, resolved: false, messages: [message] };
			this.data.threads.push(thread);
		}
		this.save();
		return thread;
	}

	/** Drop unsent comments; a thread left with no messages is removed. */
	discardDrafts(threadId: number): void {
		this.load();
		const thread = this.require(threadId);
		thread.messages = thread.messages.filter((m) => m.sent);
		if (thread.messages.length === 0) this.data.threads = this.data.threads.filter((t) => t !== thread);
		this.save();
	}

	/**
	 * Unsent comments for one thread or all (resolved threads skipped). They are
	 * marked sent only after `deliver` returns, so a failed delivery loses nothing.
	 */
	takeDrafts(threadId?: number, deliver?: (drafts: SentDrafts[]) => void): SentDrafts[] {
		this.load();
		const out: SentDrafts[] = [];
		const unsent: ThreadMessage[] = [];
		for (const thread of this.data.threads) {
			if (thread.resolved || (threadId !== undefined && thread.id !== threadId)) continue;
			const drafts = thread.messages.filter((m) => !m.sent);
			if (drafts.length === 0) continue;
			unsent.push(...drafts);
			out.push({ thread, texts: drafts.map((m) => m.text) });
		}
		if (out.length === 0) return out;
		deliver?.(out);
		for (const m of unsent) m.sent = true;
		this.save();
		return out;
	}

	addReply(threadId: number, text: string, movedTo?: string): Thread {
		this.load();
		const thread = this.require(threadId);
		if (movedTo) thread.anchor.movedTo = movedTo;
		thread.messages.push({ author: "agent", text, at: new Date().toISOString(), sent: true });
		this.save();
		return thread;
	}

	setResolved(threadId: number, resolved: boolean): void {
		this.load();
		this.require(threadId).resolved = resolved;
		this.save();
	}

	private require(id: number): Thread {
		const thread = this.find(id);
		if (!thread) throw new Error(`No thread #${id} in ${this.docPath}`);
		return thread;
	}

	private save(): void {
		mkdirSync(join(this.file, ".."), { recursive: true });
		const tmp = `${this.file}.${process.pid}.tmp`;
		writeFileSync(tmp, JSON.stringify(this.data, null, "\t"));
		renameSync(tmp, this.file);
	}
}
