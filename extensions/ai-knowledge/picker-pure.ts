import { fuzzyMatch } from "@mariozechner/pi-tui";
import type { ProjectEntry, Registry, TaskEntry } from "./types.js";

export interface TaskRow {
	project: string;
	projectName: string;
	task: TaskEntry;
	recency: string;
}

export interface ProjectRow {
	project: ProjectEntry;
}

export function buildRows(
	reg: Registry,
	recencyByKey: Map<string, string>,
): TaskRow[] {
	const rows: TaskRow[] = [];
	for (const project of reg.projects) {
		for (const task of project.tasks) {
			const key = `${project.slug}/${task.slug}`;
			rows.push({
				project: project.slug,
				projectName: project.name,
				task,
				recency: recencyByKey.get(key) ?? task.created,
			});
		}
	}
	return rows;
}

export function sortByRecency(rows: TaskRow[]): TaskRow[] {
	return [...rows].sort((a, b) => {
		const byRecency = b.recency.localeCompare(a.recency);
		if (byRecency !== 0) return byRecency;
		return rowKey(a).localeCompare(rowKey(b));
	});
}

export function filterRows(rows: TaskRow[], query: string): TaskRow[] {
	const trimmed = query.trim();
	if (!trimmed) return rows;

	const tokens = trimmed
		.split(/\s+/)
		.map((token) => token.trim())
		.filter(Boolean);
	if (tokens.length === 0) return rows;

	const matches: Array<{ row: TaskRow; score: number; index: number }> = [];
	rows.forEach((row, index) => {
		const text = buildSearchText(row);
		let score = 0;
		for (const token of tokens) {
			const result = fuzzyMatch(token, text);
			if (!result.matches) return;
			score += result.score;
		}
		matches.push({ row, score, index });
	});

	return matches
		.sort((a, b) => {
			const byScore = a.score - b.score;
			if (byScore !== 0) return byScore;
			return a.index - b.index;
		})
		.map((match) => match.row);
}

export function buildProjectRows(reg: Registry): ProjectRow[] {
	return reg.projects.map((project) => ({ project }));
}

export function filterProjectRows(rows: ProjectRow[], query: string): ProjectRow[] {
	const trimmed = query.trim();
	if (!trimmed) return rows;

	const tokens = trimmed
		.split(/\s+/)
		.map((token) => token.trim())
		.filter(Boolean);
	if (tokens.length === 0) return rows;

	const matches: Array<{ row: ProjectRow; score: number; index: number }> = [];
	rows.forEach((row, index) => {
		const text = buildProjectSearchText(row);
		let score = 0;
		for (const token of tokens) {
			const result = fuzzyMatch(token, text);
			if (!result.matches) return;
			score += result.score;
		}
		matches.push({ row, score, index });
	});

	return matches
		.sort((a, b) => {
			const byScore = a.score - b.score;
			if (byScore !== 0) return byScore;
			return a.index - b.index;
		})
		.map((match) => match.row);
}

export function sluggify(raw: string): string {
	return raw
		.toLowerCase()
		.trim()
		.replace(/\s+/g, "-")
		.replace(/[^a-z0-9-]/g, "")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "");
}

function buildSearchText(row: TaskRow): string {
	const ticket = row.task.ticket ?? "";
	return `${row.project}/${row.task.slug} — ${row.task.name} (${row.task.status}) ${ticket}`.trim();
}

function rowKey(row: TaskRow): string {
	return `${row.project}/${row.task.slug}`;
}

function buildProjectSearchText(row: ProjectRow): string {
	return `${row.project.slug} — ${row.project.name}`;
}
