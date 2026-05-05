/**
 * Continue Extension — Preserve context and start fresh in the same window
 *
 * /continue is /compact + forward intent + clean-slate handoff.
 *
 * Flow:
 *   1. User: /continue <focus>
 *   2. Side LLM call refines the focus using the conversation as context
 *   3. Editable confirmation TUI (pre-filled with refined text) — accept / edit / cancel
 *   4. Accepted focus → fed to Pi's generateSummary as customInstructions
 *   5. Summary written to .scratch/sessions/, new session opens with read-and-continue prompt
 *
 * Requires a focus arg. No focus = error (use /compact for plain summarization).
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { complete, type Message } from "@mariozechner/pi-ai";
import {
	BorderedLoader,
	buildSessionContext,
	convertToLlm,
	DEFAULT_COMPACTION_SETTINGS,
	ExtensionInputComponent,
	generateSummary,
} from "@mariozechner/pi-coding-agent";

const REFINE_SYSTEM_PROMPT = `You are helping a user prepare a session handoff. Given the conversation history and the user's stated focus for the next session, produce ONE concise sentence describing what the next session should work on.

Be specific — reference file paths, function names, branch names, or step numbers from the conversation when relevant. The next session is a fresh agent with no memory of this conversation.

Output ONLY the refined focus sentence. No preamble, no quotes, no formatting.`;

export default function (pi: ExtensionAPI) {
	pi.registerCommand("continue", {
		description: "Refine focus, write continuation file, start fresh session",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("/continue requires interactive mode", "error");
				return;
			}

			if (!ctx.model) {
				ctx.ui.notify("No model selected", "error");
				return;
			}

			const focus = args.trim();
			if (!focus) {
				ctx.ui.notify(
					"/continue requires a focus arg — describe what next session should work on. Usage: /continue <focus>. Or use /compact for plain summarization.",
					"error",
				);
				return;
			}

			const branch = ctx.sessionManager.getBranch();
			const messages = buildSessionContext(branch).messages;

			if (messages.length === 0) {
				ctx.ui.notify("No conversation to continue from", "error");
				return;
			}

			// Step 1: refine the focus using the model + conversation context
			const refined = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
				const loader = new BorderedLoader(tui, theme, "Refining focus...");
				loader.onAbort = () => done(null);

				(async () => {
					const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model!);
					if (!auth.ok) throw new Error(auth.error);

					const llmMessages = convertToLlm(messages);
					const userMessage: Message = {
						role: "user",
						content: [{ type: "text", text: `User's stated focus for the next session: ${focus}` }],
						timestamp: Date.now(),
					};

					const response = await complete(
						ctx.model!,
						{ systemPrompt: REFINE_SYSTEM_PROMPT, messages: [...llmMessages, userMessage] },
						{ apiKey: auth.apiKey ?? "", headers: auth.headers, signal: loader.signal },
					);

					if (response.stopReason === "aborted") return null;

					const text = response.content
						.filter((c): c is { type: "text"; text: string } => c.type === "text")
						.map((c) => c.text)
						.join("\n")
						.trim();

					return text || null;
				})()
					.then(done)
					.catch((err) => {
						console.error("Focus refinement failed:", err);
						done(null);
					});

				return loader;
			});

			// Fall back to raw focus if refinement aborted/failed.
			// Notify only on actual failure — abort is silent.
			const refinedFocus = refined ?? focus;
			if (refined === null) {
				ctx.ui.notify("Focus refinement skipped — using raw input.", "info");
			}

			// Step 2: editable confirmation. Pre-fill input with the refined text.
			const acceptedFocus = await ctx.ui.custom<string | null>((_tui, _theme, _kb, done) => {
				const inputComp = new ExtensionInputComponent(
					"Refined focus (edit if needed, Enter to accept, Esc to cancel)",
					undefined,
					(value: string) => done(value.trim() || null),
					() => done(null),
				);
				// Pre-fill the underlying Input. ExtensionInputComponent doesn't expose a
				// pre-fill API; the field is TS-private but accessible at runtime.
				const inputField = (inputComp as unknown as { input?: { setValue?: (v: string) => void } }).input;
				inputField?.setValue?.(refinedFocus);
				return inputComp;
			});

			if (acceptedFocus === null) {
				ctx.ui.notify("Cancelled", "info");
				return;
			}

			// Step 3: heavy compaction via Pi's generateSummary
			const result = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
				const loader = new BorderedLoader(tui, theme, "Writing continuation file...");
				loader.onAbort = () => done(null);

				(async () => {
					const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model!);
					if (!auth.ok) throw new Error(auth.error);

					return await generateSummary(
						messages,
						ctx.model!,
						DEFAULT_COMPACTION_SETTINGS.reserveTokens,
						auth.apiKey ?? "",
						auth.headers,
						loader.signal,
						acceptedFocus,
						undefined,
					);
				})()
					.then(done)
					.catch((err) => {
						console.error("Continue generation failed:", err);
						done(null);
					});

				return loader;
			});

			if (result === null) {
				ctx.ui.notify("Cancelled", "info");
				return;
			}

			// Step 4: write file + start new session
			const date = new Date().toISOString().slice(0, 10);
			const safeFocus = acceptedFocus
				.toLowerCase()
				.replace(/[^a-z0-9-_ ]/g, "")
				.trim()
				.replace(/\s+/g, "-")
				.slice(0, 40)
				.replace(/-+$/, "");
			const filename = `continue-${date}-${safeFocus || Date.now()}.md`;
			const filepath = `.scratch/sessions/${filename}`;

			const { writeFileSync, mkdirSync } = await import("node:fs");
			mkdirSync(".scratch/sessions", { recursive: true });
			writeFileSync(filepath, result, "utf-8");

			ctx.ui.notify(`Wrote ${filepath}`, "info");

			const currentSessionFile = ctx.sessionManager.getSessionFile();
			const newSessionResult = await ctx.newSession({
				parentSession: currentSessionFile,
				withSession: async (newCtx) => {
					newCtx.ui.setEditorText(`Read \`${filepath}\` and continue where we left off.`);
					newCtx.ui.notify("Ready — submit to continue.", "info");
				},
			});

			if (newSessionResult.cancelled) {
				ctx.ui.notify(`New session cancelled — continuation file is still at ${filepath}`, "info");
			}
		},
	});
}
