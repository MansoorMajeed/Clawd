import { parse as yamlParse, stringify as yamlStringify } from "yaml";
import type { ProjectEntry, Registry, TaskEntry } from "./types.js";

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

export function isValidSlug(s: unknown): s is string {
	if (typeof s !== "string" || s.length === 0) return false;
	if (s.includes("--")) return false;
	return SLUG_RE.test(s);
}

export function validateSlug(s: string): void {
	if (typeof s !== "string" || s.length === 0) {
		throw new Error(`Invalid slug: empty`);
	}
	if (s.includes("--")) {
		throw new Error(`Invalid slug "${s}": no consecutive hyphens`);
	}
	if (!SLUG_RE.test(s)) {
		throw new Error(
			`Invalid slug "${s}": lowercase letters, digits, hyphens; no leading/trailing hyphen`,
		);
	}
}

const NAME_MAX = 200;

export function isValidName(s: unknown): s is string {
	if (typeof s !== "string") return false;
	const trimmed = s.trim();
	if (trimmed.length === 0) return false;
	if (trimmed.length > NAME_MAX) return false;
	if (/[\n\r]/.test(trimmed)) return false;
	return true;
}

/**
 * Validate a display name. Caller is responsible for trimming if they want
 * lenient behavior on leading/trailing whitespace; this function permits
 * whitespace so long as the trimmed result is non-empty and bounded.
 */
export function validateName(s: string): void {
	if (typeof s !== "string" || s.trim().length === 0) {
		throw new Error("Name is empty");
	}
	const trimmed = s.trim();
	if (/[\n\r]/.test(trimmed)) {
		throw new Error("Name contains newline characters");
	}
	if (trimmed.length > NAME_MAX) {
		throw new Error(`Name too long (max ${NAME_MAX} characters)`);
	}
}

export function parseRegistry(text: string): Registry {
	if (!text || !text.trim()) return { projects: [] };
	let parsed: unknown;
	try {
		parsed = yamlParse(text);
	} catch (e) {
		throw new Error(`Invalid registry YAML: ${(e as Error).message}`);
	}
	if (!parsed || typeof parsed !== "object") return { projects: [] };
	const obj = parsed as { projects?: unknown };
	const projects = Array.isArray(obj.projects) ? obj.projects : [];
	return {
		projects: projects.map(coerceProject).filter((p): p is ProjectEntry => p !== null),
	};
}

function coerceProject(raw: unknown): ProjectEntry | null {
	if (!raw || typeof raw !== "object") return null;
	const o = raw as Record<string, unknown>;
	// Drop entries whose slug fails validation. Slugs flow into path.join
	// for session/wiki paths; an invalid slug like "../foo" would let writes
	// escape the vault. Enforce on load symmetrically with addProject/addTask.
	if (!isValidSlug(o.slug)) return null;
	if (!isValidName(o.name)) return null;
	const tasks = Array.isArray(o.tasks) ? o.tasks : [];
	return {
		slug: o.slug,
		name: (o.name as string).trim(),
		updated: typeof o.updated === "string" ? o.updated : undefined,
		tasks: tasks.map(coerceTask).filter((t): t is TaskEntry => t !== null),
	};
}

function coerceTask(raw: unknown): TaskEntry | null {
	if (!raw || typeof raw !== "object") return null;
	const o = raw as Record<string, unknown>;
	if (!isValidSlug(o.slug)) return null;
	if (!isValidName(o.name)) return null;
	const status =
		o.status === "paused" || o.status === "done" ? o.status : "active";
	return {
		slug: o.slug,
		name: (o.name as string).trim(),
		status,
		ticket: typeof o.ticket === "string" ? o.ticket : undefined,
		created: typeof o.created === "string" ? o.created : "",
		updated: typeof o.updated === "string" ? o.updated : "",
	};
}

export function serializeRegistry(reg: Registry): string {
	// Strip undefined fields for clean YAML.
	const projects = reg.projects.map((p) => {
		const out: Record<string, unknown> = {
			slug: p.slug,
			name: p.name,
		};
		if (p.updated) out.updated = p.updated;
		out.tasks = p.tasks.map((t) => {
			const task: Record<string, unknown> = {
				slug: t.slug,
				name: t.name,
				status: t.status,
			};
			if (t.ticket) task.ticket = t.ticket;
			task.created = t.created;
			task.updated = t.updated;
			return task;
		});
		return out;
	});
	return yamlStringify({ projects });
}

export function addProject(reg: Registry, slug: string, name: string): Registry {
	validateSlug(slug);
	validateName(name);
	const trimmedName = name.trim();
	if (reg.projects.some((p) => p.slug === slug)) {
		throw new Error(`Duplicate project slug "${slug}"`);
	}
	return {
		projects: [...reg.projects, { slug, name: trimmedName, tasks: [] }],
	};
}

export interface AddTaskOpts {
	created: string;
	ticket?: string;
	status?: TaskEntry["status"];
}

export function addTask(
	reg: Registry,
	project: string,
	slug: string,
	name: string,
	opts: AddTaskOpts,
): Registry {
	validateSlug(slug);
	validateName(name);
	const trimmedName = name.trim();
	const projects = reg.projects.map((p) => {
		if (p.slug !== project) return p;
		if (p.tasks.some((t) => t.slug === slug)) {
			throw new Error(`Duplicate task slug "${slug}" in project "${project}"`);
		}
		const task: TaskEntry = {
			slug,
			name: trimmedName,
			status: opts.status ?? "active",
			ticket: opts.ticket,
			created: opts.created,
			updated: opts.created,
		};
		return { ...p, tasks: [...p.tasks, task] };
	});
	if (!projects.some((p) => p.slug === project)) {
		throw new Error(`Unknown project "${project}"`);
	}
	return { projects };
}

export function findTask(
	reg: Registry,
	project: string,
	task: string,
): TaskEntry | undefined {
	return reg.projects.find((p) => p.slug === project)?.tasks.find((t) => t.slug === task);
}

export interface ActiveTaskRef {
	project: string;
	projectName: string;
	task: TaskEntry;
}

export function listActiveTasks(reg: Registry): ActiveTaskRef[] {
	const out: ActiveTaskRef[] = [];
	for (const p of reg.projects) {
		for (const t of p.tasks) {
			if (t.status === "active") {
				out.push({ project: p.slug, projectName: p.name, task: t });
			}
		}
	}
	return out;
}

export function bumpUpdated(
	reg: Registry,
	project: string,
	task: string,
	date: string,
): Registry {
	let touched = false;
	const projects = reg.projects.map((p) => {
		if (p.slug !== project) return p;
		const tasks = p.tasks.map((t) => {
			if (t.slug !== task) return t;
			touched = true;
			return { ...t, updated: date };
		});
		return { ...p, updated: touched ? date : p.updated, tasks };
	});
	if (!touched) {
		throw new Error(`Unknown task "${project}/${task}"`);
	}
	return { projects };
}
