export interface Config {
	rootPath: string;
	autoCommit: boolean;
}

export interface CurrentTask {
	project: string;
	task: string;
	sessionFile: string;
}

export interface ProjectEntry {
	slug: string;
	name: string;
	updated?: string;
	tasks: TaskEntry[];
}

export interface TaskEntry {
	slug: string;
	name: string;
	status: "active" | "paused" | "done";
	ticket?: string;
	created: string;
	updated: string;
}

export interface Registry {
	projects: ProjectEntry[];
}
