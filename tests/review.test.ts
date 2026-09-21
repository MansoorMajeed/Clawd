import { beforeEach, describe, expect, it, vi } from "vitest";

async function setupExtension() {
	const commands = new Map<string, (args: string, ctx: any) => Promise<void>>();
	const events = new Map<string, (event: any, ctx: any) => Promise<void> | void>();
	const pi = {
		appendEntry: vi.fn(),
		exec: vi.fn().mockResolvedValue({ code: 0, stdout: "", stderr: "" }),
		on: vi.fn((event: string, handler: (event: any, ctx: any) => Promise<void> | void) => {
			events.set(event, handler);
		}),
		registerCommand: vi.fn((name: string, options: { handler: (args: string, ctx: any) => Promise<void> }) => {
			commands.set(name, options.handler);
		}),
		sendUserMessage: vi.fn(),
	};
	const { default: reviewExtension } = await import("../extensions/review");
	reviewExtension(pi as any);
	return { commands, events, pi };
}

function reviewContext(overrides: Record<string, unknown> = {}) {
	const reviewState = {
		type: "custom",
		customType: "review-session",
		data: { active: true, originId: "origin-entry" },
	};
	return {
		mode: "rpc",
		hasUI: true,
		isIdle: () => true,
		hasPendingMessages: () => false,
		navigateTree: vi.fn().mockResolvedValue({ cancelled: false }),
		sessionManager: {
			getBranch: () => [reviewState],
			getEntries: () => [reviewState],
		},
		ui: {
			custom: vi.fn().mockResolvedValue(undefined),
			getEditorText: vi.fn().mockReturnValue(""),
			notify: vi.fn(),
			select: vi.fn().mockResolvedValue("Return and summarize"),
			setEditorText: vi.fn(),
			setWidget: vi.fn(),
		},
		...overrides,
	};
}

describe("review RPC behavior", () => {
	beforeEach(() => {
		vi.resetModules();
	});

	it("uses the non-loader navigation path when ending a review over RPC", async () => {
		const { commands, events } = await setupExtension();
		const ctx = reviewContext();
		events.get("session_start")?.({}, ctx);

		await expect(commands.get("end-review")?.("", ctx)).resolves.toBeUndefined();

		expect(ctx.ui.custom).not.toHaveBeenCalled();
		expect(ctx.navigateTree).toHaveBeenCalledWith("origin-entry", {
			summarize: true,
			customInstructions: expect.stringContaining("structured handoff"),
			replaceInstructions: true,
		});
	});

	it("rejects the TUI-only review selector explicitly instead of calling custom UI", async () => {
		const { commands, pi } = await setupExtension();
		const ctx = reviewContext({
			sessionManager: { getBranch: () => [], getEntries: () => [] },
		});
		pi.exec.mockResolvedValueOnce({ code: 0, stdout: ".git\n", stderr: "" });

		await commands.get("review")?.("", ctx);

		expect(ctx.ui.custom).not.toHaveBeenCalled();
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			"Review selection requires interactive mode; pass a review target explicitly in RPC mode.",
			"error",
		);
	});
});
