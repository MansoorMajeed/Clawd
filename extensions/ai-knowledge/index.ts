/**
 * AI-Knowledge — Per-task agent memory in a configured markdown vault.
 *
 * Default-off. Activates only when ~/.pi/agent/ai-knowledge.json contains a
 * valid rootPath pointing at an existing directory. Otherwise registers a
 * single inert /task command that explains how to enable.
 *
 * See .scratch/plans/2026-05-05-ai-knowledge-extension.md for the design.
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { loadConfig, getConfigPath } from "./config.js";
import { runPicker } from "./picker.js";
import { registerTools } from "./tools.js";
import { clearCurrentTask, getCurrentTask } from "./state.js";

export default async function (pi: ExtensionAPI) {
	const result = await loadConfig();

	if (result.kind === "missing") {
		registerInertCommand(
			pi,
			`AI-Knowledge inactive. Create ${getConfigPath()} with { "rootPath": "/path/to/vault" } and reload.`,
		);
		return;
	}

	if (result.kind === "error") {
		const msg = `AI-Knowledge config error: ${result.message}`;
		// Surface the problem at session start, where ctx.ui is available;
		// also keep /task working so the user can re-read the message.
		pi.on("session_start", async (_event, ctx) => {
			ctx.ui.notify(msg, "warning");
		});
		registerInertCommand(pi, msg);
		return;
	}

	const config = result.config;
	registerTools(pi, config);

	pi.on("session_start", async (event, ctx) => {
		// Only prompt at user-visible boundaries — startup, new session,
		// resume, fork. Skip silent reloads to avoid pestering.
		if (event.reason === "reload") return;
		ctx.ui.notify(`AI-Knowledge: ${config.rootPath}`, "info");
		await runPicker({ pi, config, ctx });
	});

	pi.on("session_shutdown", async () => {
		clearCurrentTask();
	});

	pi.registerCommand("task", {
		description: "Pick or switch the current AI-Knowledge task",
		handler: async (_args, ctx) => {
			const before = getCurrentTask();
			const after = await runPicker({ pi, config, ctx });
			if (!after) {
				if (before) {
					ctx.ui.notify("Current task unchanged", "info");
				}
				return;
			}
			ctx.ui.notify(`Current task: ${after.project}/${after.task}`, "info");
		},
	});
}

function registerInertCommand(pi: ExtensionAPI, message: string): void {
	pi.registerCommand("task", {
		description: "AI-Knowledge: configure rootPath to enable",
		handler: async (_args, ctx) => {
			ctx.ui.notify(message, "info");
		},
	});
}
