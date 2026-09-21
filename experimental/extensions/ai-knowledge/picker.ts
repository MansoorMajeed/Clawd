import {
	DynamicBorder,
	type ExtensionAPI,
	type ExtensionContext,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import {
	Container,
	type Focusable,
	Input,
	Spacer,
	Text,
	TUI,
	type KeybindingsManager,
} from "@earendil-works/pi-tui";
import { loadRegistry, saveRegistry } from "./registry.js";
import { addProject, addTask, validateSlug } from "./registry-pure.js";
import { gitCommit } from "./git.js";
import { setCurrentTask } from "./state.js";
import { timestampForFilename } from "./journal.js";
import { registryPath } from "./paths.js";
import type { Config, CurrentTask, ProjectEntry, TaskEntry } from "./types.js";
import {
	buildProjectRows,
	buildRows,
	filterProjectRows,
	filterRows,
	sluggify,
	sortByRecency,
	type ProjectRow,
	type TaskRow,
} from "./picker-pure.js";
import { loadRecency } from "./recency.js";

const MAX_FILTERED_ROWS = 50;
const MAX_VISIBLE_ROWS = 12;

type PickerResult =
	| { kind: "existing"; row: TaskRow }
	| { kind: "new"; proposedSlug?: string }
	| null;

type ProjectPickerResult =
	| { kind: "existing"; project: ProjectEntry }
	| { kind: "new"; proposedSlug?: string }
	| null;

export interface PickerDeps {
	pi: ExtensionAPI;
	config: Config;
	ctx: ExtensionContext;
}

export async function runPicker(deps: PickerDeps): Promise<CurrentTask | null> {
	const { ctx, config } = deps;
	if (!ctx.hasUI) return null;

	const reg = await loadRegistry(config.rootPath);
	const recency = await loadRecency(config.rootPath, reg);
	const rows = sortByRecency(buildRows(reg, recency));

	const result = await ctx.ui.custom<PickerResult>(
		(tui, theme, keybindings, done) =>
			new TaskPickerComponent(
				tui,
				theme,
				keybindings,
				rows,
				(row) => done({ kind: "existing", row }),
				(proposedSlug) => done({ kind: "new", proposedSlug }),
				() => done(null),
			),
		{
			overlay: true,
			overlayOptions: { width: "80%", maxHeight: "80%", anchor: "center" },
		},
	);

	if (!result) return null;
	if (result.kind === "new") {
		return await runNewTaskFlow(deps, result.proposedSlug);
	}

	const current: CurrentTask = {
		project: result.row.project,
		task: result.row.task.slug,
		sessionFile: timestampForFilename(),
	};
	setCurrentTask(current);
	ctx.ui.setStatus("ai-knowledge", `${current.project}/${current.task}`);
	return current;
}

class ProjectPickerComponent extends Container implements Focusable {
	private searchInput: Input;
	private listContainer: Container;
	private headerText: Text;
	private hintText: Text;
	private filteredRows: ProjectRow[];
	private selectedIndex = 0;
	private _focused = false;

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.searchInput.focused = value;
	}

	constructor(
		private tui: TUI,
		private theme: Theme,
		private keybindings: KeybindingsManager,
		private rows: ProjectRow[],
		private onExisting: (project: ProjectEntry) => void,
		private onNew: (proposedSlug?: string) => void,
		private onCancel: () => void,
	) {
		super();
		this.filteredRows = rows;

		this.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
		this.addChild(new Spacer(1));

		this.headerText = new Text("", 1, 0);
		this.addChild(this.headerText);
		this.addChild(new Spacer(1));

		this.searchInput = new Input();
		this.searchInput.onSubmit = () => this.selectCurrent();
		this.addChild(this.searchInput);

		this.addChild(new Spacer(1));
		this.listContainer = new Container();
		this.addChild(this.listContainer);

		this.addChild(new Spacer(1));
		this.hintText = new Text("", 1, 0);
		this.addChild(this.hintText);
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

		this.updateHeader();
		this.applyFilter("");
	}

	private applyFilter(query: string): void {
		this.filteredRows = filterProjectRows(this.rows, query);
		this.selectedIndex = Math.min(
			this.selectedIndex,
			Math.max(0, this.itemCount() - 1),
		);
		this.updateList();
		this.updateHints();
	}

	private cappedRows(): ProjectRow[] {
		return this.filteredRows.slice(0, MAX_FILTERED_ROWS);
	}

	private itemCount(): number {
		return this.cappedRows().length + 1;
	}

	private updateHeader(): void {
		const count = this.rows.length;
		const title = `AI-Knowledge — pick a project (${count} ${count === 1 ? "project" : "projects"})`;
		this.headerText.setText(this.theme.fg("accent", this.theme.bold(title)));
	}

	private updateHints(): void {
		const shown = Math.min(this.filteredRows.length, MAX_FILTERED_ROWS);
		const prefix =
			this.filteredRows.length > shown
				? `Showing ${shown} of ${this.filteredRows.length} • `
				: "";
		this.hintText.setText(
			this.theme.fg(
				"dim",
				`${prefix}Type to search • ↑↓ select • Enter use • Esc cancel`,
			),
		);
	}

	private updateList(): void {
		this.listContainer.clear();
		const rows = this.cappedRows();
		const itemCount = rows.length + 1;
		const startIndex = Math.max(
			0,
			Math.min(
				this.selectedIndex - Math.floor(MAX_VISIBLE_ROWS / 2),
				itemCount - MAX_VISIBLE_ROWS,
			),
		);
		const endIndex = Math.min(startIndex + MAX_VISIBLE_ROWS, itemCount);

		for (let i = startIndex; i < endIndex; i += 1) {
			const selected = i === this.selectedIndex;
			const row = rows[i];
			this.listContainer.addChild(
				new Text(row ? this.renderProjectRow(row, selected) : this.renderNewRow(selected), 0, 0),
			);
		}

		if (startIndex > 0 || endIndex < itemCount) {
			this.listContainer.addChild(
				new Text(
					this.theme.fg("dim", `  (${this.selectedIndex + 1}/${itemCount})`),
					0,
					0,
				),
			);
		}
	}

	private renderProjectRow(row: ProjectRow, selected: boolean): string {
		const prefix = selected ? this.theme.fg("accent", "→ ") : "  ";
		const color = selected ? "accent" : "text";
		return `${prefix}${this.theme.fg(color, row.project.slug)} ${this.theme.fg("dim", "—")} ${this.theme.fg(color, row.project.name)}`;
	}

	private renderNewRow(selected: boolean): string {
		const query = this.searchInput.getValue().trim();
		const label = query ? `+ New project ("${query}")` : "+ New project";
		const prefix = selected ? this.theme.fg("accent", "→ ") : "  ";
		const color = selected ? "accent" : "success";
		return `${prefix}${this.theme.fg(color, label)}`;
	}

	private selectCurrent(): void {
		const row = this.cappedRows()[this.selectedIndex];
		if (row) {
			this.onExisting(row.project);
			return;
		}
		const proposedSlug = sluggify(this.searchInput.getValue()) || undefined;
		this.onNew(proposedSlug);
	}

	handleInput(keyData: string): void {
		if (this.keybindings.matches(keyData, "tui.select.up")) {
			const count = this.itemCount();
			this.selectedIndex = this.selectedIndex === 0 ? count - 1 : this.selectedIndex - 1;
			this.updateList();
			this.tui.requestRender();
			return;
		}
		if (this.keybindings.matches(keyData, "tui.select.down")) {
			const count = this.itemCount();
			this.selectedIndex = this.selectedIndex === count - 1 ? 0 : this.selectedIndex + 1;
			this.updateList();
			this.tui.requestRender();
			return;
		}
		if (this.keybindings.matches(keyData, "tui.select.confirm")) {
			this.selectCurrent();
			return;
		}
		if (this.keybindings.matches(keyData, "tui.select.cancel")) {
			this.onCancel();
			return;
		}
		this.searchInput.handleInput(keyData);
		this.applyFilter(this.searchInput.getValue());
		this.tui.requestRender();
	}

	override invalidate(): void {
		super.invalidate();
		this.updateHeader();
		this.updateHints();
		this.updateList();
	}
}

class TaskPickerComponent extends Container implements Focusable {
	private searchInput: Input;
	private listContainer: Container;
	private headerText: Text;
	private hintText: Text;
	private filteredRows: TaskRow[];
	private selectedIndex = 0;
	private _focused = false;

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.searchInput.focused = value;
	}

	constructor(
		private tui: TUI,
		private theme: Theme,
		private keybindings: KeybindingsManager,
		private rows: TaskRow[],
		private onExisting: (row: TaskRow) => void,
		private onNew: (proposedSlug?: string) => void,
		private onCancel: () => void,
	) {
		super();
		this.filteredRows = rows;

		this.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
		this.addChild(new Spacer(1));

		this.headerText = new Text("", 1, 0);
		this.addChild(this.headerText);
		this.addChild(new Spacer(1));

		this.searchInput = new Input();
		this.searchInput.onSubmit = () => this.selectCurrent();
		this.addChild(this.searchInput);

		this.addChild(new Spacer(1));
		this.listContainer = new Container();
		this.addChild(this.listContainer);

		this.addChild(new Spacer(1));
		this.hintText = new Text("", 1, 0);
		this.addChild(this.hintText);
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

		this.updateHeader();
		this.applyFilter("");
	}

	private applyFilter(query: string): void {
		this.filteredRows = filterRows(this.rows, query);
		this.selectedIndex = Math.min(
			this.selectedIndex,
			Math.max(0, this.itemCount() - 1),
		);
		this.updateList();
		this.updateHints();
	}

	private cappedRows(): TaskRow[] {
		return this.filteredRows.slice(0, MAX_FILTERED_ROWS);
	}

	private itemCount(): number {
		return this.cappedRows().length + 1;
	}

	private updateHeader(): void {
		const counts = countStatuses(this.rows);
		const title = `AI-Knowledge — pick a task (${counts.active} active, ${counts.paused} paused, ${counts.done} done)`;
		this.headerText.setText(this.theme.fg("accent", this.theme.bold(title)));
	}

	private updateHints(): void {
		const shown = Math.min(this.filteredRows.length, MAX_FILTERED_ROWS);
		const prefix =
			this.filteredRows.length > shown
				? `Showing ${shown} of ${this.filteredRows.length} • `
				: "";
		this.hintText.setText(
			this.theme.fg(
				"dim",
				`${prefix}Type to search • ↑↓ select • Enter use • Esc skip`,
			),
		);
	}

	private updateList(): void {
		this.listContainer.clear();
		const rows = this.cappedRows();
		const itemCount = rows.length + 1;
		const startIndex = Math.max(
			0,
			Math.min(
				this.selectedIndex - Math.floor(MAX_VISIBLE_ROWS / 2),
				itemCount - MAX_VISIBLE_ROWS,
			),
		);
		const endIndex = Math.min(startIndex + MAX_VISIBLE_ROWS, itemCount);

		for (let i = startIndex; i < endIndex; i += 1) {
			const selected = i === this.selectedIndex;
			const row = rows[i];
			this.listContainer.addChild(
				new Text(row ? this.renderTaskRow(row, selected) : this.renderNewRow(selected), 0, 0),
			);
		}

		if (startIndex > 0 || endIndex < itemCount) {
			this.listContainer.addChild(
				new Text(
					this.theme.fg("dim", `  (${this.selectedIndex + 1}/${itemCount})`),
					0,
					0,
				),
			);
		}
	}

	private renderTaskRow(row: TaskRow, selected: boolean): string {
		const prefix = selected ? this.theme.fg("accent", "→ ") : "  ";
		const icon = renderStatusIcon(this.theme, row.task.status);
		const keyColor = selected ? "accent" : row.task.status === "done" ? "muted" : "text";
		const suffix = renderStatusSuffix(this.theme, row.task.status);
		return `${prefix}${icon} ${this.theme.fg(keyColor, `${row.project}/${row.task.slug}`)} ${this.theme.fg("dim", "—")} ${this.theme.fg(keyColor, row.task.name)}${suffix}`;
	}

	private renderNewRow(selected: boolean): string {
		const query = this.searchInput.getValue().trim();
		const label = query ? `+ New task ("${query}")` : "+ New task";
		const prefix = selected ? this.theme.fg("accent", "→ ") : "  ";
		const color = selected ? "accent" : "success";
		return `${prefix}${this.theme.fg(color, label)}`;
	}

	private selectCurrent(): void {
		const row = this.cappedRows()[this.selectedIndex];
		if (row) {
			this.onExisting(row);
			return;
		}
		const proposedSlug = sluggify(this.searchInput.getValue()) || undefined;
		this.onNew(proposedSlug);
	}

	handleInput(keyData: string): void {
		if (this.keybindings.matches(keyData, "tui.select.up")) {
			const count = this.itemCount();
			this.selectedIndex = this.selectedIndex === 0 ? count - 1 : this.selectedIndex - 1;
			this.updateList();
			this.tui.requestRender();
			return;
		}
		if (this.keybindings.matches(keyData, "tui.select.down")) {
			const count = this.itemCount();
			this.selectedIndex = this.selectedIndex === count - 1 ? 0 : this.selectedIndex + 1;
			this.updateList();
			this.tui.requestRender();
			return;
		}
		if (this.keybindings.matches(keyData, "tui.select.confirm")) {
			this.selectCurrent();
			return;
		}
		if (this.keybindings.matches(keyData, "tui.select.cancel")) {
			this.onCancel();
			return;
		}
		this.searchInput.handleInput(keyData);
		this.applyFilter(this.searchInput.getValue());
		this.tui.requestRender();
	}

	override invalidate(): void {
		super.invalidate();
		this.updateHeader();
		this.updateHints();
		this.updateList();
	}
}

async function runNewTaskFlow(
	deps: PickerDeps,
	proposedSlug?: string,
): Promise<CurrentTask | null> {
	const { pi, ctx, config } = deps;
	let reg = await loadRegistry(config.rootPath);

	const projectChoice = await ctx.ui.custom<ProjectPickerResult>(
		(tui, theme, keybindings, done) =>
			new ProjectPickerComponent(
				tui,
				theme,
				keybindings,
				buildProjectRows(reg),
				(project) => done({ kind: "existing", project }),
				(projectSlug) => done({ kind: "new", proposedSlug: projectSlug }),
				() => done(null),
			),
		{
			overlay: true,
			overlayOptions: { width: "70%", maxHeight: "70%", anchor: "center" },
		},
	);
	if (!projectChoice) return null;

	let projectSlug: string;
	if (projectChoice.kind === "new") {
		const slug = await promptSlug(
			ctx,
			"New project slug (lowercase-hyphens):",
			projectChoice.proposedSlug,
		);
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
		projectSlug = projectChoice.project.slug;
	}

	const taskSlug = await promptSlug(
		ctx,
		"New task slug (lowercase-hyphens):",
		proposedSlug,
	);
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

async function promptSlug(
	ctx: ExtensionContext,
	title: string,
	proposedSlug?: string,
): Promise<string | undefined> {
	while (true) {
		const raw = await ctx.ui.input(
			proposedSlug ? `${title} (Enter to use "${proposedSlug}")` : title,
			proposedSlug,
		);
		if (raw === undefined) return undefined;
		const trimmed = raw.trim() || proposedSlug || "";
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

function countStatuses(rows: TaskRow[]): Record<TaskEntry["status"], number> {
	return rows.reduce(
		(counts, row) => {
			counts[row.task.status] += 1;
			return counts;
		},
		{ active: 0, paused: 0, done: 0 },
	);
}

function renderStatusIcon(theme: Theme, status: TaskEntry["status"]): string {
	if (status === "active") return theme.fg("success", "●");
	if (status === "paused") return theme.fg("warning", "◐");
	return theme.fg("muted", "○");
}

function renderStatusSuffix(theme: Theme, status: TaskEntry["status"]): string {
	if (status === "paused") return theme.fg("dim", " (paused)");
	if (status === "done") return theme.fg("dim", " (done)");
	return "";
}

function isoDate(d: Date = new Date()): string {
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
