import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getAgentDir, SessionManager } from "@earendil-works/pi-coding-agent";
import registerSessionBreakdown, { computeSessionBreakdown } from "../extensions/session-breakdown";

const tempDirs: string[] = [];

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function usage(totalTokens: number, total: number) {
	return {
		input: totalTokens,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens,
		cost: { input: total, output: 0, cacheRead: 0, cacheWrite: 0, total },
	};
}

async function fixtureStore(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "clawd-session-breakdown-"));
	tempDirs.push(dir);
	const lines = [
		{ type: "session", version: 3, id: "session-id", timestamp: "2025-09-01T10:00:00.000Z", cwd: "/project" },
		{ type: "message", id: "a", parentId: null, timestamp: "2026-01-02T12:05:00.000Z", message: { role: "assistant", provider: "anthropic", model: "claude", content: [], usage: usage(10, 1), timestamp: Date.parse("2026-01-02T00:05:00.000Z") } },
		{ type: "message", id: "b", parentId: "a", timestamp: "2026-01-02T12:06:00.000Z", message: { role: "toolResult", toolCallId: "x", toolName: "nested", content: [], isError: false, usage: usage(20, 1), timestamp: Date.parse("2026-01-02T00:06:00.000Z") } },
		{ type: "compaction", id: "c", parentId: "b", timestamp: "2026-01-02T12:07:00.000Z", summary: "compact", firstKeptEntryId: "a", tokensBefore: 100, usage: usage(30, 1) },
		{ type: "branch_summary", id: "d", parentId: "c", timestamp: "2026-01-02T12:08:00.000Z", fromId: "b", summary: "branch", usage: usage(40, 1) },
	];
	await writeFile(join(dir, "2025-09-01T10-00-00-000Z_session-id.jsonl"), lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
	return dir;
}

describe("retained session breakdown accounting", () => {
	it("attributes usage to entry activity time and includes unattributed summary usage", async () => {
		const store = await fixtureStore();
		const data = await computeSessionBreakdown(store, new Date("2026-01-02T18:00:00.000Z"));
		const range = data.ranges.get(7)!;
		const jan2 = range.dayByKey.get("2026-01-02")!;

		expect(range.sessions).toBe(0);
		expect(range.totalMessages).toBe(2);
		expect(range.totalTokens).toBe(100);
		expect(range.totalCost).toBe(4);
		expect(jan2.messages).toBe(2);
		expect(jan2.tokens).toBe(100);
		expect(jan2.totalCost).toBe(4);
		expect(range.modelTokens.get("unattributed")).toBe(70);
		expect(range.modelCost.get("unattributed")).toBe(2);
	});

	it("uses a custom store nested under the default sessions root", async () => {
		const customStore = join(getAgentDir(), "sessions", "custom");
		const listAll = vi.spyOn(SessionManager, "listAll").mockResolvedValue([]);
		const commands = new Map<string, any>();
		registerSessionBreakdown({
			registerCommand: (name: string, command: any) => commands.set(name, command),
			sendMessage: vi.fn(),
		} as any);

		await commands.get("session-breakdown").handler("", {
			mode: "rpc",
			hasUI: true,
			cwd: "/project",
			sessionManager: {
				getCwd: () => "/project",
				getSessionDir: () => customStore,
			},
		});

		expect(listAll).toHaveBeenCalledWith(customStore, expect.any(Function));
	});

	it("uses the active custom session store and text fallback in RPC mode", async () => {
		const store = await fixtureStore();
		const commands = new Map<string, any>();
		const sendMessage = vi.fn();
		const custom = vi.fn();
		registerSessionBreakdown({
			registerCommand: (name: string, command: any) => commands.set(name, command),
			sendMessage,
		} as any);
		await commands.get("session-breakdown").handler("", {
			mode: "rpc",
			hasUI: true,
			cwd: "/project",
			sessionManager: { getCwd: () => "/project", getSessionDir: () => store },
			ui: { custom, notify: vi.fn() },
		});

		expect(custom).not.toHaveBeenCalled();
		expect(sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({ customType: "session-breakdown" }),
			{ triggerTurn: false },
		);
	});
});
