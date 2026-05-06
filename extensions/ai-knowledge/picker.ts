import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { loadRegistry, saveRegistry } from "./registry.js";
import { addProject, addTask, listActiveTasks, validateSlug } from "./registry-pure.js";
import { gitCommit } from "./git.js";
import { setCurrentTask } from "./state.js";
import { timestampForFilename } from "./journal.js";
import { registryPath } from "./paths.js";
import type { Config, CurrentTask } from "./types.js";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

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
		const slug = await ctx.ui.input("New project slug (lowercase-hyphens):");
		if (!slug) return null;
		try {
			validateSlug(slug);
		} catch (e) {
			ctx.ui.notify((e as Error).message, "error");
			return null;
		}
		const name = await ctx.ui.input("Project display name:");
		if (!name) return null;
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
	const taskSlug = await ctx.ui.input("New task slug (lowercase-hyphens):");
	if (!taskSlug) return null;
	try {
		validateSlug(taskSlug);
	} catch (e) {
		ctx.ui.notify((e as Error).message, "error");
		return null;
	}
	const taskName = await ctx.ui.input("Task display name:");
	if (!taskName) return null;
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

function isoDate(d: Date = new Date()): string {
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
