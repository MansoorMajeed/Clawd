import { afterEach, describe, expect, it, vi } from "vitest";
import registerContext from "../extensions/context/index";
import registerGitStatus from "../extensions/git-status";
import registerSessionMeter from "../extensions/session-meter";

afterEach(() => {
	vi.restoreAllMocks();
});

function usage(input: number, output: number, cacheRead: number, cacheWrite: number, cost: number) {
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens: input + output + cacheRead + cacheWrite,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
	};
}

describe("retained /context repairs", () => {
	it("uses active native context, native usage sources, loaded resources, and an RPC text fallback", async () => {
		const commands = new Map<string, any>();
		const sent: any[] = [];
		const entries = [
			{ type: "message", id: "root", parentId: null, timestamp: "2026-01-02T00:00:00Z", message: { role: "user", content: "kept", timestamp: 1 } },
			{ type: "message", id: "abandoned", parentId: "root", timestamp: "2026-01-02T00:01:00Z", message: { role: "user", content: "x".repeat(4000), timestamp: 2 } },
			{ type: "custom_message", id: "active", parentId: "root", timestamp: "2026-01-02T00:02:00Z", customType: "fixture", content: [{ type: "text", text: "tiny" }], display: false },
			{ type: "message", id: "excluded", parentId: "active", timestamp: "2026-01-02T00:03:00Z", message: { role: "bashExecution", command: "echo", output: "z".repeat(4000), excludeFromContext: true, timestamp: 3 } },
			{ type: "message", id: "assistant", parentId: "abandoned", timestamp: "2026-01-02T00:04:00Z", message: { role: "assistant", content: [], usage: usage(100, 50, 10, 5, 1), timestamp: 4 } },
			{ type: "message", id: "tool", parentId: "assistant", timestamp: "2026-01-02T00:05:00Z", message: { role: "toolResult", content: [], usage: usage(1, 2, 3, 4, 0.2), timestamp: 5 } },
			{ type: "compaction", id: "compact", parentId: "tool", timestamp: "2026-01-02T00:06:00Z", summary: "summary", firstKeptEntryId: "root", tokensBefore: 1000, usage: usage(5, 6, 7, 8, 0.3) },
			{ type: "branch_summary", id: "branch", parentId: "compact", timestamp: "2026-01-02T00:07:00Z", summary: "branch", fromId: "tool", usage: usage(9, 10, 11, 12, 0.4) },
		];
		const pi = {
			on: vi.fn(),
			appendEntry: vi.fn(),
			getCommands: () => [
				{ name: "one", source: "extension", sourceInfo: { path: "/x/a/index.ts" } },
				{ name: "two", source: "extension", sourceInfo: { path: "/x/b/index.ts" } },
			],
			getActiveTools: () => [],
			getAllTools: () => [],
			registerCommand: (name: string, command: any) => commands.set(name, command),
			sendMessage: (message: any) => sent.push(message),
		};
		registerContext(pi as any);
		const custom = vi.fn();
		const ctx = {
			mode: "rpc",
			hasUI: true,
			cwd: "/work/project",
			model: undefined,
			getSystemPrompt: () => [
				"The following skills provide specialized instructions for specific tasks.",
				"Use the read tool to load a skill's file when the task matches its description.",
				"",
				"<available_skills>",
				"<skill><name>alpha</name><description>prompted</description><location>/skills/alpha/SKILL.md</location></skill>",
				"</available_skills>",
			].join("\n"),
			getSystemPromptOptions: () => ({
				cwd: "/work/project",
				contextFiles: [{ path: "/work/project/AGENTS.override.md", content: "actual loaded instructions" }],
				skills: [
					{ name: "alpha", description: "prompted", filePath: "/skills/alpha/SKILL.md", baseDir: "/skills/alpha", disableModelInvocation: false },
					{ name: "manual", description: "explicit only", filePath: "/skills/manual/SKILL.md", baseDir: "/skills/manual", disableModelInvocation: true },
				],
			}),
			getContextUsage: () => undefined,
			sessionManager: {
				getSessionId: () => "session",
				getEntries: () => entries,
				getLeafId: () => "excluded",
			},
			ui: { custom },
		};

		await commands.get("context").handler("", ctx);

		expect(custom).not.toHaveBeenCalled();
		expect(sent).toHaveLength(1);
		const text = sent[0].content as string;
		expect(text).toMatch(/Messages\s+~2\s/);
		expect(text).toContain("Session: 243 tokens · $1.90");
		expect(text).toContain("Memory (1): ./AGENTS.override.md");
		expect(text).toMatch(/Available skills \(2, ~\d+ in prompt\):/);
		expect(text).toMatch(/alpha\s+~\d+/);
		expect(text).toMatch(/manual\s+~0/);
		expect(text).toContain("Command-providing extensions (2): /x/a/index.ts, /x/b/index.ts");
	});
});

describe("retained lifecycle event contracts", () => {
	it.each([
		["session-meter", registerSessionMeter],
		["git-status", registerGitStatus],
	])("does not subscribe %s to the removed session_switch event", (_name, register) => {
		const events: string[] = [];
		register({ on: (event: string) => events.push(event) } as any);
		expect(events).not.toContain("session_switch");
		expect(events).toContain("session_start");
	});
});
