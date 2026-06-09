import { describe, expect, it } from "vitest";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	createTokenTpsState,
	estimateOutputTokens,
	finalizeTokenTpsState,
	finalOutputTokens,
	recordGeneratedText,
} from "../extensions/token-tps";

describe("estimateOutputTokens", () => {
	it("estimates cumulatively instead of treating every stream chunk as a token", () => {
		expect(estimateOutputTokens("")).toBe(0);
		expect(estimateOutputTokens("a")).toBe(1);
		expect(estimateOutputTokens("abcd")).toBe(1);
		expect(estimateOutputTokens("abcde")).toBe(2);
	});
});

describe("recordGeneratedText", () => {
	it("computes current TPS from a rolling one-second window", () => {
		let state = createTokenTpsState();

		state = recordGeneratedText(state, "a".repeat(40), 0);
		expect(state.estimatedTokens).toBe(10);
		expect(state.currentTps).toBe(10);
		expect(state.peakTps).toBe(10);

		state = recordGeneratedText(state, "a".repeat(20), 500);
		expect(state.estimatedTokens).toBe(15);
		expect(state.currentTps).toBe(15);
		expect(state.peakTps).toBe(15);

		state = recordGeneratedText(state, "a".repeat(4), 1501);
		expect(state.estimatedTokens).toBe(16);
		expect(state.currentTps).toBe(1);
		expect(state.peakTps).toBe(15);
	});

	it("uses elapsed generation time for average TPS", () => {
		let state = createTokenTpsState();
		state = recordGeneratedText(state, "a".repeat(40), 1000);
		state = recordGeneratedText(state, "a".repeat(40), 2000);

		expect(state.estimatedTokens).toBe(20);
		expect(state.averageTps).toBe(20);
	});
});

describe("finalizeTokenTpsState", () => {
	it("freezes current TPS and corrects final values when usage is available", () => {
		let state = createTokenTpsState();
		state = recordGeneratedText(state, "a".repeat(40), 1000);
		state = recordGeneratedText(state, "a".repeat(40), 2000);

		const finalized = finalizeTokenTpsState(state, 3000, 30);

		expect(finalized.active).toBe(false);
		expect(finalized.estimatedTokens).toBe(30);
		expect(finalized.currentTps).toBe(30);
		expect(finalized.peakTps).toBe(30);
		expect(finalized.averageTps).toBe(15);
	});
});

describe("finalOutputTokens", () => {
	const baseMessage = {
		role: "assistant",
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude",
		stopReason: "stop",
		timestamp: 0,
		usage: {
			input: 0,
			output: 12,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 12,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	} satisfies Omit<AssistantMessage, "content">;

	it("uses provider output tokens for text-only assistant messages", () => {
		const message = {
			...baseMessage,
			content: [{ type: "text", text: "hello" }],
		} satisfies AssistantMessage;

		expect(finalOutputTokens(message)).toBe(12);
	});

	it("does not correct from final usage when tool-call JSON contributed to output tokens", () => {
		const message = {
			...baseMessage,
			content: [{ type: "toolCall", id: "1", name: "read", arguments: { path: "x" } }],
		} satisfies AssistantMessage;

		expect(finalOutputTokens(message)).toBeUndefined();
	});
});
