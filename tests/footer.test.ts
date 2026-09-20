import { homedir } from "node:os";
import { stripVTControlCharacters } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";

vi.mock("@earendil-works/pi-coding-agent", () => ({
	SettingsManager: { create: vi.fn() },
}));

import { SettingsManager } from "@earendil-works/pi-coding-agent";
import registerFooter from "../extensions/footer";

function setup(mode = "tui") {
	const handlers = new Map<string, (event: any, ctx: any) => void>();
	const settings = { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 };
	vi.mocked(SettingsManager.create).mockReturnValue({ getCompactionSettings: () => ({ ...settings }) } as any);
	const colors: Record<string, number> = { accent: 36, muted: 90, dim: 90, text: 39, warning: 33, error: 31 };
	const fg = vi.fn((color: string, text: string) => `\x1b[${colors[color]}m${text}\x1b[39m`);
	const statuses = new Map<string, string>([
		["token-tps", "Speed 42 tok/s · avg 38 tok/s"],
		["chatgpt-limit", "\x1b[32mGPT W 78% ↓6d\x1b[39m"],
		["git-status", "git ✓"],
		["session-meter", "24m"],
	]);
	let branch: string | null = "main";
	let branchChanged = () => {};
	let footer: any;
	let thinking = "medium";
	const requestRender = vi.fn();
	const unsubscribe = vi.fn();
	const ctx = {
		mode,
		cwd: `${homedir()}/git/Clawd`,
		isProjectTrusted: () => false,
		model: { id: "gpt-6-astra", contextWindow: 272_000, reasoning: true },
		getContextUsage: () => ({ tokens: 55_000, contextWindow: ctx.model.contextWindow, percent: 20.2 }),
		sessionManager: { getEntries: () => [] as any[], getSessionName: () => undefined as string | undefined },
		ui: {
			theme: { fg },
			setFooter: vi.fn((factory) => {
				footer?.dispose();
				footer = factory?.({ requestRender }, ctx.ui.theme, {
					getGitBranch: () => branch,
					getExtensionStatuses: () => statuses,
					onBranchChange: (callback: () => void) => { branchChanged = callback; return unsubscribe; },
				});
			}),
		},
	};
	registerFooter({
		on: (name: string, handler: any) => handlers.set(name, handler),
		getThinkingLevel: () => thinking,
	} as any);
	const emit = (name: string) => handlers.get(name)?.({}, ctx);
	emit("session_start");
	return {
		ctx, settings, statuses, fg, emit, requestRender, unsubscribe,
		render: (width = 160) => footer.render(width) as string[],
		plain: (width = 160) => (footer.render(width) as string[]).map(stripVTControlCharacters),
		setBranch: (value: string | null) => { branch = value; branchChanged(); },
		setThinking: (value: string) => { thinking = value; emit("thinking_level_select"); },
	};
}

describe("readable footer", () => {
	it("puts the model on the left with readable context and estimated session cost", () => {
		const h = setup();
		h.ctx.sessionManager.getEntries = () => [
			{ type: "message", message: { role: "assistant", usage: { cost: { total: 1.25 } } } },
			{ type: "message", message: { role: "toolResult", usage: { cost: { total: 0.5 } } } },
			{ type: "compaction", usage: { cost: { total: 0.3 } } },
			{ type: "branch_summary", usage: { cost: { total: 0.2 } } },
			{ type: "message", message: { role: "user" } },
		];
		expect(h.plain().slice(0, 2)).toEqual([
			"~/git/Clawd (main)",
			"gpt-6-astra · medium · Context 55k / 272k (20%) · Est. $2.25",
		]);
		expect(h.fg).toHaveBeenCalledWith("accent", "gpt-6-astra");
	});

	it("preserves all extension statuses, their colors, and live updates", () => {
		const h = setup();
		expect(h.plain()[2]).toBe("GPT W 78% ↓6d · git ✓ · 24m · Speed 42 tok/s · avg 38 tok/s");
		expect(h.render()[2]).toContain("\x1b[32mGPT W 78% ↓6d\x1b[39m");
		h.statuses.set("chatgpt-limit", "GPT W 75% ↓6d");
		h.statuses.set("todos-status", "todo\n2\topen");
		expect(h.plain().join("\n")).toContain("GPT W 75% ↓6d");
		expect(h.plain().join("\n")).toContain("todo 2 open");
		h.statuses.clear();
		expect(h.plain()).toHaveLength(2);
	});

	it.each([1, 12, 40, 60, 80, 160])("fits a %i-column terminal without dropping cost or quota", (width) => {
		const h = setup();
		h.ctx.cwd = `${homedir()}/a-very-long-path/项目/Clawd`;
		h.setBranch("feature/a-long-branch-name");
		for (const line of h.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		if (width >= 40) {
			expect(h.plain(width).join(" ")).toContain("Est. $0.00");
			expect(h.plain(width).join(" ")).toContain("GPT W 78% ↓6d");
		}
	});

	it("keeps unknown usage unknown after compaction and handles unavailable models", () => {
		const h = setup();
		h.ctx.getContextUsage = () => ({ tokens: null, contextWindow: 272_000, percent: null }) as any;
		expect(h.plain()[1]).toContain("Context ? / 272k");
		expect(h.plain()[1]).not.toContain("0%");
		h.ctx.model = undefined as any;
		h.ctx.getContextUsage = () => undefined as any;
		expect(h.plain()[1]).toBe("No model · Context ? / ? · Est. $0.00");
	});

	it("warns relative to the configured native compaction trigger, not a hardcoded window", () => {
		const h = setup();
		h.ctx.model.contextWindow = 1_000_000;
		h.settings.reserveTokens = 100_000;
		h.emit("turn_start");
		for (const [tokens, color] of [[719_999, "text"], [720_000, "warning"], [855_000, "error"]] as const) {
			h.ctx.getContextUsage = () => ({ tokens, contextWindow: 1_000_000, percent: tokens / 10_000 });
			h.fg.mockClear();
			h.render();
			expect(h.fg).toHaveBeenCalledWith(color, expect.stringContaining("Context"));
		}
		expect(h.plain()[1]).toContain("(86%)");
		h.settings.enabled = false;
		h.emit("turn_start");
		h.fg.mockClear();
		expect(h.plain()[1]).toContain("auto off");
		expect(h.fg).toHaveBeenCalledWith("warning", expect.stringContaining("Context"));
		expect(SettingsManager.create).toHaveBeenLastCalledWith(h.ctx.cwd, undefined, { projectTrusted: false });
	});

	it("refreshes compaction settings during rendering without waiting for another event", () => {
		const h = setup();
		expect(h.plain()[1]).not.toContain("auto off");
		h.settings.enabled = false;
		expect(h.plain()[1]).toContain("auto off");
	});

	it("updates model, thinking, branch, session name and theme without a restart", () => {
		const h = setup();
		h.ctx.model = { id: "other-model", contextWindow: 128_000, reasoning: true };
		h.emit("model_select");
		h.setThinking("high");
		h.setBranch("feature/footer");
		h.ctx.sessionManager.getSessionName = () => "Footer work";
		expect(h.plain()[0]).toBe("~/git/Clawd (feature/footer) · Footer work");
		expect(h.plain()[1]).toContain("other-model · high · Context 55k / 128k (43%)");
		expect(h.requestRender).toHaveBeenCalled();
		h.ctx.ui.theme = { fg: vi.fn((_color, text) => text) };
		expect(h.render()[1]).toBe(h.plain()[1]);
		h.emit("session_shutdown");
		expect(h.ctx.ui.setFooter).toHaveBeenLastCalledWith(undefined);
		expect(h.unsubscribe).toHaveBeenCalledOnce();
	});

	it.each(["rpc", "json", "print"])("does not install a terminal footer in %s mode", (mode) => {
		const h = setup(mode);
		expect(h.ctx.ui.setFooter).not.toHaveBeenCalled();
	});
});
