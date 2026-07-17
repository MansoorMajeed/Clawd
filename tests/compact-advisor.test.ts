import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import compactAdvisor, {
	computeCompactThreshold,
	computeHardCompactThreshold,
	HARD_TARGET_TOKENS,
	isCompactionReady,
	RESERVE_MARGIN,
	shouldCompactAtBoundary,
	TARGET_TOKENS,
} from "../extensions/compact-advisor";

function entry(id: string, parentId: string | null, message: Record<string, unknown>) {
	return {
		type: "message" as const,
		id,
		parentId,
		timestamp: "2026-07-17T00:00:00.000Z",
		message: { timestamp: 0, ...message },
	};
}

describe("computeCompactThreshold", () => {
	it("uses the target ceiling on large windows", () => {
		expect(computeCompactThreshold(1_000_000)).toBe(TARGET_TOKENS);
		expect(computeCompactThreshold(500_000)).toBe(TARGET_TOKENS);
	});

	it("fires just before native on windows near the target", () => {
		// window - margin wins when it is below the target
		expect(computeCompactThreshold(200_000)).toBe(200_000 - RESERVE_MARGIN);
		expect(computeCompactThreshold(100_000)).toBe(100_000 - RESERVE_MARGIN);
	});

	it("never returns the target when it would exceed window - margin", () => {
		const window = 210_000;
		expect(computeCompactThreshold(window)).toBe(Math.min(TARGET_TOKENS, window - RESERVE_MARGIN));
	});

	it("uses a separate hard ceiling on large windows", () => {
		expect(computeHardCompactThreshold(1_000_000)).toBe(HARD_TARGET_TOKENS);
	});

	it("collapses both ceilings to the reserve boundary on smaller windows", () => {
		expect(computeCompactThreshold(200_000)).toBe(168_000);
		expect(computeHardCompactThreshold(200_000)).toBe(168_000);
	});
});

describe("compaction scheduling", () => {
	it("defers at the soft ceiling until the agent settles", () => {
		expect(shouldCompactAtBoundary(210_000, 1_000_000, false, true)).toBe(false);
		expect(shouldCompactAtBoundary(210_000, 1_000_000, true, false)).toBe(true);
	});

	it("interrupts a continuing run at the hard ceiling", () => {
		expect(shouldCompactAtBoundary(260_000, 1_000_000, false, true)).toBe(true);
	});

	it("lets a text-only hard-ceiling turn settle before compacting", () => {
		expect(shouldCompactAtBoundary(260_000, 1_000_000, false, false)).toBe(false);
	});
});

describe("isCompactionReady", () => {
	const user = entry("user", null, { role: "user", content: "Implement the change" });
	const toolCall = entry("assistant-tool", "user", {
		role: "assistant",
		content: [{ type: "toolCall", id: "call-1", name: "mcp", arguments: {} }],
		stopReason: "toolUse",
	});
	const oversizedResult = entry("tool-result", "assistant-tool", {
		role: "toolResult",
		toolCallId: "call-1",
		toolName: "mcp",
		content: [{ type: "text", text: "x".repeat(40_000) }],
		isError: false,
	});

	it("rejects an oversized trailing tool result with no legal cut point", () => {
		expect(isCompactionReady([user, toolCall, oversizedResult] as never[], 8_000)).toBe(false);
	});

	it("accepts the same history after a subsequent assistant boundary", () => {
		const nextAssistant = entry("assistant-next", "tool-result", {
			role: "assistant",
			content: [{ type: "text", text: "Continuing after the tool result" }],
			stopReason: "stop",
		});
		expect(isCompactionReady([user, toolCall, oversizedResult, nextAssistant] as never[], 8_000)).toBe(true);
	});

	it.each([
		{
			type: "custom_message",
			customType: "resume",
			content: "Continue",
			display: false,
		},
		{
			type: "branch_summary",
			fromId: "tool-result",
			summary: "Continue from the retained branch",
		},
	])("accepts retained $type boundaries after the oversized result", (boundary) => {
		const retainedBoundary = {
			...boundary,
			id: "retained-boundary",
			parentId: "tool-result",
			timestamp: "2026-07-17T00:00:00.000Z",
		};
		expect(isCompactionReady([user, toolCall, oversizedResult, retainedBoundary] as never[], 8_000)).toBe(
			true,
		);
	});
});

describe("extension scheduling", () => {
	afterEach(() => vi.restoreAllMocks());

	function harness(entries: never[], tokens: number) {
		const handlers = new Map<string, (event: any, ctx: any) => void>();
		const sendMessage = vi.fn();
		compactAdvisor({
			on: (event: string, handler: (event: any, ctx: any) => void) => handlers.set(event, handler),
			sendMessage,
		} as never);

		let idle = true;
		let pending = false;
		let callbacks: { onComplete?: () => void; onError?: (error: Error) => void } | undefined;
		const compact = vi.fn((options) => {
			callbacks = options;
		});
		const ctx = {
			cwd: "/tmp/project",
			hasUI: false,
			compact,
			getContextUsage: () => ({ tokens, contextWindow: 1_000_000, percent: tokens / 10_000 }),
			hasPendingMessages: () => pending,
			isIdle: () => idle,
			isProjectTrusted: () => true,
			sessionManager: { getBranch: () => entries },
		};

		vi.spyOn(SettingsManager, "create").mockReturnValue({
			getCompactionSettings: () => ({ enabled: true, reserveTokens: 16_384, keepRecentTokens: 8_000 }),
		} as never);

		return {
			callbacks: () => callbacks,
			compact,
			ctx,
			handlers,
			sendMessage,
			setIdle: (value: boolean) => {
				idle = value;
			},
			setPending: (value: boolean) => {
				pending = value;
			},
		};
	}

	const compactableEntries = [
		entry("user", null, { role: "user", content: "Implement the change" }),
		entry("assistant-old", "user", {
			role: "assistant",
			content: [{ type: "text", text: "x".repeat(40_000) }],
			stopReason: "stop",
		}),
		entry("user-next", "assistant-old", { role: "user", content: "Continue" }),
	] as never[];

	it("defers at 200k and compacts once the run settles", () => {
		const h = harness(compactableEntries, 210_000);
		h.handlers.get("turn_end")?.({ toolResults: [{}] }, h.ctx);
		expect(h.compact).not.toHaveBeenCalled();

		h.handlers.get("agent_settled")?.({}, h.ctx);
		expect(h.compact).toHaveBeenCalledOnce();
	});

	it("does not compact if another settled handler already started work", () => {
		const h = harness(compactableEntries, 210_000);
		h.setIdle(false);
		h.handlers.get("agent_settled")?.({}, h.ctx);
		expect(h.compact).not.toHaveBeenCalled();
	});

	it("does not compact if another settled handler queued work", () => {
		const h = harness(compactableEntries, 210_000);
		h.setPending(true);
		h.handlers.get("agent_settled")?.({}, h.ctx);
		expect(h.compact).not.toHaveBeenCalled();
	});

	it("compacts and resumes a continuing run at 250k", () => {
		const h = harness(compactableEntries, 260_000);
		h.handlers.get("turn_end")?.({ toolResults: [{ toolCallId: "call-1" }] }, h.ctx);
		expect(h.compact).toHaveBeenCalledOnce();

		h.callbacks()?.onComplete?.();
		expect(h.sendMessage).toHaveBeenCalledOnce();
	});

	it("lets an all-terminating tool batch settle before compacting", () => {
		const h = harness(compactableEntries, 260_000);
		h.handlers.get("turn_start")?.({}, h.ctx);
		h.handlers.get("tool_execution_end")?.(
			{ toolCallId: "call-1", result: { content: [], terminate: true } },
			h.ctx,
		);
		h.handlers.get("turn_end")?.({ toolResults: [{ toolCallId: "call-1" }] }, h.ctx);
		expect(h.compact).not.toHaveBeenCalled();

		h.handlers.get("agent_settled")?.({}, h.ctx);
		expect(h.compact).toHaveBeenCalledOnce();
		h.callbacks()?.onComplete?.();
		expect(h.sendMessage).not.toHaveBeenCalled();
	});

	it("resumes if Pi still rejects a preflighted mid-task compaction", () => {
		const h = harness(compactableEntries, 260_000);
		h.handlers.get("turn_end")?.({ toolResults: [{ toolCallId: "call-1" }] }, h.ctx);
		h.callbacks()?.onError?.(new Error("Nothing to compact (session too small)"));
		expect(h.sendMessage).toHaveBeenCalledOnce();
	});

	it("does not call compact until an oversized tool result has a legal boundary", () => {
		const user = entry("user", null, { role: "user", content: "Implement the change" });
		const toolCall = entry("assistant-tool", "user", {
			role: "assistant",
			content: [{ type: "toolCall", id: "call-1", name: "mcp", arguments: {} }],
			stopReason: "toolUse",
		});
		const result = entry("tool-result", "assistant-tool", {
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "mcp",
			content: [{ type: "text", text: "x".repeat(40_000) }],
			isError: false,
		});
		const entries = [user, toolCall, result] as never[];
		const h = harness(entries, 260_000);

		h.handlers.get("turn_end")?.({ toolResults: [{}] }, h.ctx);
		expect(h.compact).not.toHaveBeenCalled();

		entries.push(
			entry("assistant-next", "tool-result", {
				role: "assistant",
				content: [{ type: "text", text: "Continuing" }],
				stopReason: "toolUse",
			}) as never,
		);
		h.handlers.get("turn_end")?.({ toolResults: [{}] }, h.ctx);
		expect(h.compact).toHaveBeenCalledOnce();
	});
});
