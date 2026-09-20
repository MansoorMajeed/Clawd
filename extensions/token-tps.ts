import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "token-tps";

export default function (pi: ExtensionAPI) {
	let startedAtMs: number | undefined;
	let totalOutputTokens = 0;
	let totalResponseMs = 0;

	const reset = (ctx: ExtensionContext) => {
		startedAtMs = undefined;
		totalOutputTokens = 0;
		totalResponseMs = 0;
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
	};

	pi.on("session_start", (_event, ctx) => reset(ctx));
	pi.on("session_shutdown", (_event, ctx) => reset(ctx));

	pi.on("before_provider_request", () => {
		startedAtMs = performance.now();
	});

	pi.on("message_end", (event, ctx) => {
		if (event.message.role !== "assistant" || startedAtMs === undefined) return;
		const elapsedMs = performance.now() - startedAtMs;
		startedAtMs = undefined;

		const message = event.message;
		const outputTokens = message.usage?.output;
		if (
			message.stopReason === "error" || message.stopReason === "aborted" ||
			typeof outputTokens !== "number" || !Number.isFinite(outputTokens) ||
			outputTokens <= 0 || elapsedMs <= 0
		) return;

		totalOutputTokens += outputTokens;
		totalResponseMs += elapsedMs;
		const last = (outputTokens * 1000 / elapsedMs).toFixed(1);
		const average = (totalOutputTokens * 1000 / totalResponseMs).toFixed(1);
		if (ctx.hasUI) {
			ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("dim", `Speed ${last} tok/s · avg ${average} tok/s`));
		}
	});
}
