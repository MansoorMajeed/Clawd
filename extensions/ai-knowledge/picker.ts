import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { loadRegistry, saveRegistry } from "./registry.js";
import { addProject, addTask, listActiveTasks, validateSlug } from "./registry-pure.js";
import { gitCommit } from "./git.js";
import { setCurrentTask } from "./state.js";
import { timestampForFilename } from "./journal.js";
import { registryPath } from "./paths.js";
import type { Config, CurrentTask } from "./types.js";

const SKIP = "Skip (no task)";
const NEW_TASK = "+ New task...";
const NEW_PROJECT = "+ New project...";
const CANCEL = "Cancel";

export interface PickerDeps {
	pi: ExtensionAPI;
	config: Config;
	ctx: ExtensionContext;
}

export async function runPicker(deps: PickerDeps): Promise<CurrentTask | null> {
	const { ctx, config } = deps;
	const reg = await loadRegistry(config.rootPath);
	const active = listActiveTasks(reg);

	const labels = active.map(
		(a) => `${a.project}/${a.task.slug} — ${a.task.name}`,
	);
	const items = [...labels, NEW_TASK, SKIP];

	const choice = await ctx.ui.select("AI-Knowledge: pick a task", items);
	if (!choice || choice === SKIP) return null;

	if (choice === NEW_TASK) {
		return await runNewTaskFlow(deps);
	}

	// Look up by index, not by parsing the label — keeps labels free to
	// evolve (status icons, paused tags, etc.) without breaking selection.
	const idx = labels.indexOf(choice);
	if (idx < 0) return null;
	const ref = active[idx];
	if (!ref) return null;

	const current: CurrentTask = {
		project: ref.project,
		task: ref.task.slug,
		sessionFile: timestampForFilename(),
	};
	setCurrentTask(current);
	ctx.ui.setStatus("ai-knowledge", `${current.project}/${current.task}`);
	return current;
}

async function runNewTaskFlow(deps: PickerDeps): Promise<CurrentTask | null> {
	const { pi, ctx, config } = deps;
	let reg = await loadRegistry(config.rootPath);

	// Pick project (or create new).
	const projectLabels = reg.projects.map((p) => `${p.slug} — ${p.name}`);
	const projectItems = [...projectLabels, NEW_PROJECT, CANCEL];

	const projectChoice = await ctx.ui.select(
		"AI-Knowledge: pick a project",
		projectItems,
	);
	if (!projectChoice || projectChoice === CANCEL) return null;

	let projectSlug: string;
	if (projectChoice === NEW_PROJECT) {
		const slug = await promptSlug(ctx, "New project slug (lowercase-hyphens):");
		if (slug === undefined) return null;
		const name = await promptOptionalName(
			ctx,
			"Project display name (Enter to use slug):",
			slug,
		);
		if (name === undefined) return null;
		try {
			reg = addProject(reg, slug, name);
		} catch (e) {
			ctx.ui.notify((e as Error).message, "error");
			return null;
		}
		projectSlug = slug;
	} else {
		const idx = projectLabels.indexOf(projectChoice);
		if (idx < 0) return null;
		const proj = reg.projects[idx];
		if (!proj) return null;
		projectSlug = proj.slug;
	}

	// Task slug + name.
	const taskSlug = await promptSlug(ctx, "New task slug (lowercase-hyphens):");
	if (taskSlug === undefined) return null;
	const taskName = await promptOptionalName(
		ctx,
		"Task display name (Enter to use slug):",
		taskSlug,
	);
	if (taskName === undefined) return null;
	const ticket = await ctx.ui.input("Ticket URL (optional, leave blank to skip):");

	const today = isoDate();
	try {
		reg = addTask(reg, projectSlug, taskSlug, taskName, {
			created: today,
			ticket: ticket?.trim() ? ticket.trim() : undefined,
		});
	} catch (e) {
		ctx.ui.notify((e as Error).message, "error");
		return null;
	}

	await saveRegistry(config.rootPath, reg);
	await gitCommit({
		pi,
		root: config.rootPath,
		autoCommit: config.autoCommit,
		paths: [registryPath(config.rootPath)],
		message: `register: ${projectSlug}/${taskSlug}`,
		notify: ctx.ui.notify.bind(ctx.ui),
	});

	const current: CurrentTask = {
		project: projectSlug,
		task: taskSlug,
		sessionFile: timestampForFilename(),
	};
	setCurrentTask(current);
	ctx.ui.setStatus("ai-knowledge", `${current.project}/${current.task}`);
	ctx.ui.notify(`Registered ${projectSlug}/${taskSlug}`, "info");
	return current;
}

/**
 * Prompt for a slug. Trims input. Re-prompts on empty or invalid format with
 * an inline error notification. Returns the trimmed slug, or undefined if the
 * user cancels (Esc).
 */
async function promptSlug(
	ctx: ExtensionContext,
	title: string,
): Promise<string | undefined> {
	while (true) {
		const raw = await ctx.ui.input(title);
		if (raw === undefined) return undefined;
		const trimmed = raw.trim();
		if (trimmed.length === 0) {
			ctx.ui.notify("Slug is required (or press Esc to cancel)", "error");
			continue;
		}
		try {
			validateSlug(trimmed);
		} catch (e) {
			ctx.ui.notify((e as Error).message, "error");
			continue;
		}
		return trimmed;
	}
}

/**
 * Prompt for a display name. Empty submit defaults to a slug-derived name
 * (`first-task` -> `first task`). Returns undefined only if the user cancels
 * with Esc.
 */
async function promptOptionalName(
	ctx: ExtensionContext,
	title: string,
	slug: string,
): Promise<string | undefined> {
	const raw = await ctx.ui.input(title);
	if (raw === undefined) return undefined;
	const trimmed = raw.trim();
	if (trimmed.length === 0) return slug.replace(/-/g, " ");
	return trimmed;
}

function isoDate(d: Date = new Date()): string {
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
