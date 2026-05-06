import type { CurrentTask } from "./types.js";

let current: CurrentTask | null = null;

export function getCurrentTask(): CurrentTask | null {
	return current;
}

export function setCurrentTask(task: CurrentTask): void {
	current = task;
}

export function clearCurrentTask(): void {
	current = null;
}
