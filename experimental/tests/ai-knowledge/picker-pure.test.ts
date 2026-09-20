import { describe, expect, it } from "vitest";
import {
	buildProjectRows,
	buildRows,
	filterProjectRows,
	filterRows,
	sluggify,
	sortByRecency,
} from "../../extensions/ai-knowledge/picker-pure.js";
import type { Registry } from "../../extensions/ai-knowledge/types.js";

const registry: Registry = {
	projects: [
		{
			slug: "proj-b",
			name: "Project B",
			tasks: [
				{
					slug: "fix-ddos-bug",
					name: "Fix DDoS Bug",
					status: "active",
					ticket: "PROJ-123",
					created: "2026-05-01",
					updated: "2026-05-01",
				},
				{
					slug: "pause-me",
					name: "Paused Task",
					status: "paused",
					created: "2026-05-03",
					updated: "2026-05-03",
				},
			],
		},
		{
			slug: "proj-a",
			name: "Project A",
			tasks: [
				{
					slug: "done-task",
					name: "Done Task",
					status: "done",
					created: "2026-05-02",
					updated: "2026-05-02",
				},
				{
					slug: "alphabet",
					name: "Alphabet Soup",
					status: "active",
					created: "2026-05-04",
					updated: "2026-05-04",
				},
			],
		},
	],
};

describe("sluggify", () => {
	it.each([
		["Fix DDoS bug", "fix-ddos-bug"],
		["  --foo  ", "foo"],
		["!!!", ""],
		["Build v2 thing 123", "build-v2-thing-123"],
	])("turns %j into %j", (raw, expected) => {
		expect(sluggify(raw)).toBe(expected);
	});
});

describe("buildRows", () => {
	it("combines registry tasks with recency map and falls back to created", () => {
		const rows = buildRows(
			registry,
			new Map([
				["proj-b/fix-ddos-bug", "2026-05-12-1015"],
				["proj-a/done-task", "2026-05-11-0900"],
			]),
		);

		expect(rows.map((row) => `${row.project}/${row.task.slug}`)).toEqual([
			"proj-b/fix-ddos-bug",
			"proj-b/pause-me",
			"proj-a/done-task",
			"proj-a/alphabet",
		]);
		expect(rows[0]?.projectName).toBe("Project B");
		expect(rows[0]?.recency).toBe("2026-05-12-1015");
		expect(rows[1]?.recency).toBe("2026-05-03");
	});
});

describe("sortByRecency", () => {
	it("sorts newest first and ties by project/task", () => {
		const rows = buildRows(
			registry,
			new Map([
				["proj-b/fix-ddos-bug", "2026-05-12-1015"],
				["proj-b/pause-me", "2026-05-12-1015"],
				["proj-a/done-task", "2026-05-11-0900"],
			]),
		);

		expect(sortByRecency(rows).map((row) => `${row.project}/${row.task.slug}`)).toEqual([
			"proj-b/fix-ddos-bug",
			"proj-b/pause-me",
			"proj-a/done-task",
			"proj-a/alphabet",
		]);
	});

	it("handles an empty list", () => {
		expect(sortByRecency([])).toEqual([]);
	});
});

describe("buildProjectRows", () => {
	it("builds rows in registry order", () => {
		expect(buildProjectRows(registry).map((row) => row.project.slug)).toEqual([
			"proj-b",
			"proj-a",
		]);
	});
});

describe("filterProjectRows", () => {
	const rows = buildProjectRows({
		projects: [
			{ slug: "playback", name: "Playback Infra", tasks: [] },
			{ slug: "consumer-insights", name: "Consumer Insights", tasks: [] },
			{ slug: "device-lab", name: "Device Lab", tasks: [] },
		],
	});

	it("returns rows unchanged for an empty query", () => {
		expect(filterProjectRows(rows, "   ")).toBe(rows);
	});

	it("requires every query token to match", () => {
		expect(filterProjectRows(rows, "consumer insights").map((row) => row.project.slug)).toEqual([
			"consumer-insights",
		]);
		expect(filterProjectRows(rows, "consumer zzzz")).toEqual([]);
	});

	it("matches slug and display name case-insensitively", () => {
		expect(filterProjectRows(rows, "PLAYBACK").map((row) => row.project.slug)).toEqual([
			"playback",
		]);
		expect(filterProjectRows(rows, "device").map((row) => row.project.slug)).toEqual([
			"device-lab",
		]);
	});

	it("sorts by fuzzy score and keeps existing order for score ties", () => {
		const scoreRows = buildProjectRows({
			projects: [
				{ slug: "same-a", name: "Same", tasks: [] },
				{ slug: "q-x-z", name: "Q X Z", tasks: [] },
				{ slug: "qz", name: "QZ", tasks: [] },
				{ slug: "same-b", name: "Same", tasks: [] },
			],
		});

		expect(filterProjectRows(scoreRows, "qz").map((row) => row.project.slug)).toEqual([
			"qz",
			"q-x-z",
		]);
		expect(filterProjectRows(scoreRows, "same").map((row) => row.project.slug)).toEqual([
			"same-a",
			"same-b",
		]);
	});
});

describe("filterRows", () => {
	const rows = sortByRecency(
		buildRows(
			registry,
			new Map([
				["proj-b/fix-ddos-bug", "2026-05-12-1015"],
				["proj-b/pause-me", "2026-05-11-0900"],
				["proj-a/done-task", "2026-05-10-0900"],
				["proj-a/alphabet", "2026-05-09-0900"],
			]),
		),
	);

	it("returns rows unchanged for an empty query", () => {
		expect(filterRows(rows, "   ")).toBe(rows);
	});

	it("requires every query token to match", () => {
		expect(filterRows(rows, "fix bug").map((row) => row.task.slug)).toEqual([
			"fix-ddos-bug",
		]);
		expect(filterRows(rows, "fix missing")).toEqual([]);
	});

	it("matches ticket and status text case-insensitively", () => {
		expect(filterRows(rows, "proj-123").map((row) => row.task.slug)).toEqual([
			"fix-ddos-bug",
		]);
		expect(filterRows(rows, "PAUSED").map((row) => row.task.slug)).toEqual([
			"pause-me",
		]);
	});

	it("sorts matches by fuzzy score and keeps existing order for score ties", () => {
		const scoreRows = sortByRecency(
			buildRows(
				{
					projects: [
						{
							slug: "p1",
							name: "P1",
							tasks: [
								{
									slug: "qz",
									name: "QZ",
									status: "active",
									created: "2026-05-03",
									updated: "2026-05-03",
								},
							],
						},
						{
							slug: "p2",
							name: "P2",
							tasks: [
								{
									slug: "same-a",
									name: "Same",
									status: "active",
									created: "2026-05-02",
									updated: "2026-05-02",
								},
								{
									slug: "q-x-z",
									name: "Q X Z",
									status: "active",
									created: "2026-05-01",
									updated: "2026-05-01",
								},
							],
						},
						{
							slug: "p3",
							name: "P3",
							tasks: [
								{
									slug: "same-b",
									name: "Same",
									status: "active",
									created: "2026-05-04",
									updated: "2026-05-04",
								},
							],
						},
					],
				},
				new Map(),
			),
		);

		expect(filterRows(scoreRows, "qz").map((row) => row.task.slug)).toEqual([
			"qz",
			"q-x-z",
		]);
		expect(filterRows(scoreRows, "same").map((row) => row.task.slug)).toEqual([
			"same-b",
			"same-a",
		]);
	});
});
