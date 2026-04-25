/**
 * Continue Extension — Preserve context and start fresh in the same window
 *
 * When context is getting full mid-task, /continue writes a distilled
 * continuation file to .scratch/sessions/ and starts a new session.
 * The new session reads the file on demand — keeping it out of the
 * conversation token budget.
 *
 * Usage:
 *   /continue           — agent writes continuation file, starts new session
 *   /continue <slug>    — use a custom slug for the filename
 */

import type { ExtensionAPI, SessionEntry } from "@mariozechner/pi-coding-agent";
import { complete, type Message } from "@mariozechner/pi-ai";
import { BorderedLoader, convertToLlm, serializeConversation } from "@mariozechner/pi-coding-agent";

const SYSTEM_PROMPT = `You are a session continuity assistant. Given a conversation history, write a concise continuation file that a fresh coding agent session can read to pick up where this one left off.

Write ONLY the markdown content. No preamble.

Format:

# Continue: <short task description>

## What We're Doing
<1-3 sentences: the task, goal, and current approach>

## Key Decisions
<bullet list of decisions made and why — only include ones that matter for continuing>

## Current State
<what's done, what's in progress, what's broken. Be specific — file names, function names>

## Files Involved
<bullet list of file paths that are relevant>

## Next Steps
<exactly what to do next, ordered. Specific enough to act on immediately>

## Gotchas
<anything discovered that's non-obvious and would waste time if rediscovered>

Rules:
- Be concise. This is a reference doc, not a narrative.
- Only include information needed to continue the work.
- File paths must be exact.
- Skip any section that has nothing useful to say.`;

export default function (pi: ExtensionAPI) {
	pi.registerCommand("continue", {
		description: "Write continuation file to .scratch/sessions/ and start fresh",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("/continue requires interactive mode", "error");
				return;
			}

			if (!ctx.model) {
				ctx.ui.notify("No model selected", "error");
				return;
			}

			const branch = ctx.sessionManager.getBranch();
			const messages = branch
				.filter((entry): entry is SessionEntry & { type: "message" } => entry.type === "message")
				.map((entry) => entry.message);

			if (messages.length === 0) {
				ctx.ui.notify("No conversation to continue from", "error");
				return;
			}

			const llmMessages = convertToLlm(messages);
			const conversationText = serializeConversation(llmMessages);

			// Generate continuation file content
			const result = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
				const loader = new BorderedLoader(tui, theme, "Writing continuation file...");
				loader.onAbort = () => done(null);

				const doGenerate = async () => {
					const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model!);
					if (!auth.ok) {
						throw new Error(auth.error);
					}

					const userMessage: Message = {
						role: "user",
						content: [
							{
								type: "text",
								text: `## Conversation History\n\n${conversationText}`,
							},
						],
						timestamp: Date.now(),
					};

					const response = await complete(
						ctx.model!,
						{ systemPrompt: SYSTEM_PROMPT, messages: [userMessage] },
						{ apiKey: auth.apiKey, headers: auth.headers, signal: loader.signal },
					);

					if (response.stopReason === "aborted") {
						return null;
					}

					return response.content
						.filter((c): c is { type: "text"; text: string } => c.type === "text")
						.map((c) => c.text)
						.join("\n");
				};

				doGenerate()
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

			// Build filename
			const date = new Date().toISOString().slice(0, 10);
			const slug = args.trim() || `${Date.now()}`;
			const safeSlug = slug.replace(/[^a-zA-Z0-9-_]/g, "-").replace(/-+/g, "-").toLowerCase();
			const filename = `continue-${date}-${safeSlug}.md`;
			const filepath = `.scratch/sessions/${filename}`;

			// Write the file
			const { writeFileSync, mkdirSync } = await import("fs");
			mkdirSync(".scratch/sessions", { recursive: true });
			writeFileSync(filepath, result, "utf-8");

			ctx.ui.notify(`Wrote ${filepath}`, "info");

			// Start new session
			const currentSessionFile = ctx.sessionManager.getSessionFile();
			const newSessionResult = await ctx.newSession({
				parentSession: currentSessionFile,
				withSession: async (newCtx) => {
					newCtx.ui.setEditorText(`Read \`${filepath}\` and continue where we left off.`);
					newCtx.ui.notify("Ready — submit to continue.", "info");
				},
			});

			if (newSessionResult.cancelled) {
				ctx.ui.notify("New session cancelled — continuation file is still at " + filepath, "info");
				return;
			}
		},
	});
}
