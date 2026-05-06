import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { appendEntry } from "./journal.js";
import { gitCommit } from "./git.js";
import { getCurrentTask } from "./state.js";
import type { Config } from "./types.js";

export function registerTools(pi: ExtensionAPI, config: Config): void {
	pi.registerTool({
		name: "journal_append",
		label: "Journal append",
		description:
			"Append bullets to the current task's session journal. " +
			"Refuses if no current task is set. " +
			"Each line of `text` becomes its own bullet. " +
			"Capture decisions, surprises, and dead-ends — not narration.",
		promptSnippet:
			"journal_append(text) — append bullets to the current task journal.",
		promptGuidelines: [
			"Use journal_append after substantive work: a decision made, a surprise found, a dead-end ruled out.",
			"One thought per call is fine; multi-line text becomes multiple bullets.",
			"Do not mirror what the user can see — capture what a future agent would need to resume the task.",
		],
		parameters: Type.Object({
			text: Type.String({
				description: "Bullet content. Multi-line allowed (each non-empty line becomes a bullet).",
			}),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const current = getCurrentTask();
			if (!current) {
				return {
					content: [
						{
							type: "text",
							text: "No current task. Run /task to pick or create one before journaling.",
						},
					],
					isError: true,
				};
			}

			const file = await appendEntry(config.rootPath, current, params.text);
			const firstLine = params.text.split("\n").find((l) => l.trim().length > 0) ?? "";
			await gitCommit({
				pi,
				root: config.rootPath,
				autoCommit: config.autoCommit,
				paths: [file],
				message: `journal: ${current.project}/${current.task} — ${truncate(firstLine, 60)}`,
				notify: ctx.ui.notify.bind(ctx.ui),
			});

			return {
				content: [
					{
						type: "text",
						text: `Appended to ${current.project}/${current.task} (${current.sessionFile}.md).`,
					},
				],
			};
		},
	});

	pi.registerTool({
		name: "current_task",
		label: "Current task",
		description: "Return the in-memory current task, or null if none is set.",
		promptSnippet: "current_task() — return the active task or null.",
		parameters: Type.Object({}),
		async execute() {
			const t = getCurrentTask();
			return {
				content: [{ type: "text", text: t ? JSON.stringify(t) : "null" }],
			};
		},
	});
}

function truncate(s: string, n: number): string {
	const trimmed = s.trim();
	return trimmed.length > n ? trimmed.slice(0, n - 1) + "…" : trimmed;
}
