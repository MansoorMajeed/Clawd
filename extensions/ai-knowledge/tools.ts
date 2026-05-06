import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { appendEntry, readRecentSessions } from "./journal.js";
import { gitCommit } from "./git.js";
import { loadRegistry } from "./registry.js";
import { findTask } from "./registry-pure.js";
import { getCurrentTask } from "./state.js";
import type { Config, CurrentTask } from "./types.js";

const MAX_SESSIONS = 10;
const DEFAULT_HISTORY_N = 2;

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

	pi.registerTool({
		name: "task_context",
		label: "Task context",
		description:
			"Load orientation for the current task: registry metadata + the most " +
			"recent session journal. Call this once when starting work on a task " +
			"to recover context from previous sessions. Refuses if no current task.",
		promptSnippet:
			"task_context() — load registry metadata + most recent journal for the current task.",
		promptGuidelines: [
			"Call task_context once at the start of work on a /task'd task to orient yourself.",
			"Do not call repeatedly within a session — the content does not change unless you journal_append.",
		],
		parameters: Type.Object({}),
		async execute() {
			const current = getCurrentTask();
			if (!current) {
				return errorResult(
					"No current task. Run /task to pick or create one.",
				);
			}
			const text = await renderTaskContext(config.rootPath, current);
			return { content: [{ type: "text", text }] };
		},
	});

	pi.registerTool({
		name: "journal_read",
		label: "Journal read",
		description:
			"Return the last `n` session journals for the current task, " +
			"concatenated. Use for explicit history lookup; for routine resume, " +
			`prefer task_context. Caps at ${MAX_SESSIONS}. Refuses if no current task.`,
		promptSnippet:
			"journal_read({n}) — read the last n session journals for the current task (default 2, max 10).",
		promptGuidelines: [
			"Use sparingly. task_context covers the routine resume case.",
			"Only reach for journal_read when the user asks about earlier history or you need older context.",
		],
		parameters: Type.Object({
			n: Type.Optional(
				Type.Integer({
					minimum: 1,
					maximum: MAX_SESSIONS,
					description: `Number of recent sessions to return (1..${MAX_SESSIONS}). Default ${DEFAULT_HISTORY_N}.`,
				}),
			),
		}),
		async execute(_id, params) {
			const current = getCurrentTask();
			if (!current) {
				return errorResult(
					"No current task. Run /task to pick or create one.",
				);
			}
			const n = clamp(params.n ?? DEFAULT_HISTORY_N, 1, MAX_SESSIONS);
			const text = await readRecentSessions(config.rootPath, current, n);
			return { content: [{ type: "text", text }] };
		},
	});
}

function clamp(n: number, lo: number, hi: number): number {
	return Math.max(lo, Math.min(hi, n));
}

function errorResult(text: string) {
	return {
		content: [{ type: "text" as const, text }],
		isError: true,
	};
}

async function renderTaskContext(
	root: string,
	current: CurrentTask,
): Promise<string> {
	const reg = await loadRegistry(root);
	const task = findTask(reg, current.project, current.task);
	const project = reg.projects.find((p) => p.slug === current.project);

	const meta: string[] = [];
	meta.push(`Task: ${current.project}/${current.task}`);
	if (task) {
		meta.push(`Name: ${task.name}`);
		meta.push(`Status: ${task.status}`);
		meta.push(`Created: ${task.created}`);
		if (task.ticket) meta.push(`Ticket: ${task.ticket}`);
	}
	if (project) meta.push(`Project: ${project.name}`);

	const journal = await readRecentSessions(root, current, 1);
	return `${meta.join("\n")}\n\n${journal}`;
}

function truncate(s: string, n: number): string {
	const trimmed = s.trim();
	return trimmed.length > n ? trimmed.slice(0, n - 1) + "…" : trimmed;
}
