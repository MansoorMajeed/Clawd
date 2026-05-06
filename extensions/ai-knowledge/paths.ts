import { join } from "node:path";

export function registryPath(root: string): string {
	return join(root, "registry.yaml");
}

export function projectDir(root: string, project: string): string {
	return join(root, project);
}

export function taskDir(root: string, project: string, task: string): string {
	return join(root, project, task);
}

export function taskIndexPath(root: string, project: string, task: string): string {
	return join(root, project, task, "INDEX.md");
}

export function sessionsDir(root: string, project: string, task: string): string {
	return join(root, project, task, "sessions");
}

export function sessionPath(
	root: string,
	project: string,
	task: string,
	timestamp: string,
): string {
	return join(root, project, task, "sessions", `${timestamp}.md`);
}

export function wikiDir(root: string): string {
	return join(root, "llm-wiki");
}

export function wikiEntryPath(root: string, slug: string): string {
	return join(root, "llm-wiki", `${slug}.md`);
}
