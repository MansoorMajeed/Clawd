import type { AssistantMessage } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

export type TokenTpsSample = {
	atMs: number;
	tokens: number;
};

export type TokenTpsState = {
	active: boolean;
	startedAtMs: number | undefined;
	lastUpdatedAtMs: number | undefined;
	generatedText: string;
	estimatedTokens: number;
	samples: TokenTpsSample[];
	currentTps: number;
	peakTps: number;
	averageTps: number;
};

const STATUS_KEY = "token-tps";
const WINDOW_MS = 1000;
const MIN_ELAPSED_MS = 250;

export function estimateOutputTokens(text: string): number {
	if (text.length === 0) return 0;
	return Math.max(1, Math.ceil(text.length / 4));
}

export function createTokenTpsState(): TokenTpsState {
	return {
		active: false,
		startedAtMs: undefined,
		lastUpdatedAtMs: undefined,
		generatedText: "",
		estimatedTokens: 0,
		samples: [],
		currentTps: 0,
		peakTps: 0,
		averageTps: 0,
	};
}

export function recordGeneratedText(
	state: TokenTpsState,
	delta: string,
	nowMs: number,
	windowMs = WINDOW_MS,
): TokenTpsState {
	const generatedText = state.generatedText + delta;
	const estimatedTokens = estimateOutputTokens(generatedText);
	const tokenDelta = Math.max(0, estimatedTokens - state.estimatedTokens);
	const startedAtMs = state.startedAtMs ?? (tokenDelta > 0 ? nowMs : undefined);
	const samples = pruneSamples(
		tokenDelta > 0 ? [...state.samples, { atMs: nowMs, tokens: tokenDelta }] : state.samples,
		nowMs,
		windowMs,
	);
	const currentTps = sumTokens(samples) / (windowMs / 1000);
	const averageTps = averageTokensPerSecond(estimatedTokens, startedAtMs, nowMs);

	return {
		active: true,
		startedAtMs,
		lastUpdatedAtMs: nowMs,
		generatedText,
		estimatedTokens,
		samples,
		currentTps,
		peakTps: Math.max(state.peakTps, currentTps),
		averageTps,
	};
}

export function finalizeTokenTpsState(
	state: TokenTpsState,
	nowMs: number,
	actualOutputTokens?: number,
): TokenTpsState {
	const elapsedAverage = averageTokensPerSecond(state.estimatedTokens, state.startedAtMs, nowMs);
	const finalized = {
		...state,
		active: false,
		lastUpdatedAtMs: nowMs,
		averageTps: elapsedAverage,
	};

	if (!actualOutputTokens || actualOutputTokens <= 0 || state.estimatedTokens <= 0) {
		return finalized;
	}

	const scale = actualOutputTokens / state.estimatedTokens;
	return {
		...finalized,
		estimatedTokens: actualOutputTokens,
		currentTps: finalized.currentTps * scale,
		peakTps: finalized.peakTps * scale,
		averageTps: averageTokensPerSecond(actualOutputTokens, state.startedAtMs, nowMs),
	};
}

export function finalOutputTokens(message: AssistantMessage): number | undefined {
	if (message.content.some((block) => block.type === "toolCall")) return undefined;
	const output = Number(message.usage?.output ?? 0);
	return Number.isFinite(output) && output > 0 ? output : undefined;
}

function pruneSamples(samples: TokenTpsSample[], nowMs: number, windowMs: number): TokenTpsSample[] {
	const cutoff = nowMs - windowMs;
	return samples.filter((sample) => sample.atMs >= cutoff);
}

function sumTokens(samples: TokenTpsSample[]): number {
	return samples.reduce((total, sample) => total + sample.tokens, 0);
}

function averageTokensPerSecond(tokens: number, startedAtMs: number | undefined, nowMs: number): number {
	if (startedAtMs === undefined || tokens <= 0) return 0;
	const elapsedMs = Math.max(MIN_ELAPSED_MS, nowMs - startedAtMs);
	return tokens / (elapsedMs / 1000);
}

function formatNumber(value: number): string {
	if (!Number.isFinite(value) || value < 0) return "0.0";
	return value.toFixed(1);
}

function formatStatus(state: TokenTpsState, ctx: ExtensionContext): string {
	const theme = ctx.ui.theme;
	const current = formatNumber(state.currentTps);
	const peak = formatNumber(state.peakTps);
	const average = formatNumber(state.averageTps);
	const separator = theme.fg("dim", "·");

	if (state.active) {
		return [
			theme.fg("accent", "● tok/s"),
			theme.fg("accent", current),
			theme.fg("muted", "now"),
			separator,
			theme.fg("warning", `↑${peak} peak`),
			separator,
			theme.fg("muted", `${average} avg`),
		].join(" ");
	}

	return [
		theme.fg("dim", "tok/s last"),
		theme.fg("dim", current),
		theme.fg("dim", "now"),
		separator,
		theme.fg("dim", `↑${peak} peak`),
		separator,
		theme.fg("dim", `${average} avg`),
	].join(" ");
}

function updateStatus(ctx: ExtensionContext, state: TokenTpsState | undefined): void {
	if (!ctx.hasUI || !state || state.estimatedTokens <= 0) return;
	ctx.ui.setStatus(STATUS_KEY, formatStatus(state, ctx));
}

export default function (pi: ExtensionAPI) {
	let state: TokenTpsState | undefined;

	const reset = () => {
		state = createTokenTpsState();
	};

	const finalize = (ctx: ExtensionContext, message?: AssistantMessage) => {
		if (!state || state.estimatedTokens <= 0) return;
		state = finalizeTokenTpsState(state, Date.now(), message ? finalOutputTokens(message) : undefined);
		updateStatus(ctx, state);
	};

	pi.on("message_start", (event) => {
		if (event.message.role === "assistant") reset();
	});

	pi.on("message_update", (event, ctx) => {
		const streamEvent = event.assistantMessageEvent;

		if (streamEvent.type === "text_delta" || streamEvent.type === "thinking_delta") {
			state ??= createTokenTpsState();
			state = recordGeneratedText(state, streamEvent.delta, Date.now());
			updateStatus(ctx, state);
			return;
		}

		if (streamEvent.type === "done") {
			finalize(ctx, streamEvent.message);
		} else if (streamEvent.type === "error") {
			finalize(ctx, streamEvent.error);
		}
	});

	pi.on("message_end", (event, ctx) => {
		if (event.message.role === "assistant") finalize(ctx, event.message as AssistantMessage);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
	});
}
