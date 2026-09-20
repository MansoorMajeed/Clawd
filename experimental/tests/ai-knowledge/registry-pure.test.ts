import { describe, it, expect } from "vitest";
import {
	parseRegistry,
	serializeRegistry,
	validateSlug,
	validateName,
	addProject,
	addTask,
	findTask,
	listActiveTasks,
	bumpUpdated,
} from "../../extensions/ai-knowledge/registry-pure.js";
import type { Registry } from "../../extensions/ai-knowledge/types.js";

describe("validateSlug", () => {
	it.each(["a", "ab", "team-alpha", "p1", "task-beta-v2", "x9-y9"])(
		"accepts %s",
		(s) => expect(() => validateSlug(s)).not.toThrow(),
	);

	it.each([
		"",
		"-foo",
		"foo-",
		"--foo",
		"foo--bar",
		"Foo",
		"foo bar",
		"foo_bar",
		"foo.bar",
		"foo/bar",
	])("rejects %s", (s) => expect(() => validateSlug(s)).toThrow());
});

describe("validateName", () => {
	it.each(["a", "Hello", "Project With Spaces", "x".repeat(200)])(
		"accepts %s",
		(s) => expect(() => validateName(s)).not.toThrow(),
	);

	it.each([
		["", /empty/i],
		["   ", /empty/i],
		["a\nb", /newline/i],
		["a\rb", /newline/i],
		["x".repeat(201), /too long/i],
	])("rejects %j with %s", (s, msg) =>
		expect(() => validateName(s as string)).toThrow(msg),
	);
});

describe("addProject name handling", () => {
	it("trims whitespace around the name", () => {
		const reg = addProject({ projects: [] }, "alpha", "  Alpha  ");
		expect(reg.projects[0]?.name).toBe("Alpha");
	});

	it("rejects empty / whitespace-only name", () => {
		expect(() => addProject({ projects: [] }, "alpha", "")).toThrow(/empty/i);
		expect(() => addProject({ projects: [] }, "alpha", "   ")).toThrow(/empty/i);
	});

	it("rejects names with newlines", () => {
		expect(() => addProject({ projects: [] }, "alpha", "a\nb")).toThrow(/newline/i);
	});
});

describe("addTask name handling", () => {
	const seeded = (): Registry =>
		addProject({ projects: [] }, "alpha", "Alpha");

	it("trims whitespace around the name", () => {
		const reg = addTask(seeded(), "alpha", "t1", "  Task One  ", {
			created: "2026-05-05",
		});
		expect(reg.projects[0]?.tasks[0]?.name).toBe("Task One");
	});

	it("rejects empty name", () => {
		expect(() =>
			addTask(seeded(), "alpha", "t1", "", { created: "2026-05-05" }),
		).toThrow(/empty/i);
	});
});

describe("parseRegistry name safety", () => {
	it("drops projects with empty / whitespace-only name", () => {
		const yaml = `projects:
  - slug: a
    name: ""
    tasks: []
  - slug: b
    name: "   "
    tasks: []
  - slug: c
    name: Good
    tasks: []
`;
		const reg = parseRegistry(yaml);
		expect(reg.projects.map((p) => p.slug)).toEqual(["c"]);
	});

	it("drops tasks with empty name but keeps siblings", () => {
		const yaml = `projects:
  - slug: a
    name: A
    tasks:
      - slug: bad
        name: ""
        status: active
        created: "2026-05-05"
        updated: "2026-05-05"
      - slug: ok
        name: OK
        status: active
        created: "2026-05-05"
        updated: "2026-05-05"
`;
		const reg = parseRegistry(yaml);
		expect(reg.projects[0]?.tasks.map((t) => t.slug)).toEqual(["ok"]);
	});
});

describe("parseRegistry", () => {
	it("treats empty / missing as empty registry", () => {
		expect(parseRegistry("")).toEqual({ projects: [] });
		expect(parseRegistry("\n")).toEqual({ projects: [] });
		expect(parseRegistry("projects:")).toEqual({ projects: [] });
	});

	it("parses a populated registry", () => {
		const yaml = `projects:
  - slug: alpha
    name: Alpha
    tasks:
      - slug: first-task
        name: First Task
        status: active
        created: "2026-05-05"
        updated: "2026-05-05"
`;
		const reg = parseRegistry(yaml);
		expect(reg.projects).toHaveLength(1);
		expect(reg.projects[0]?.slug).toBe("alpha");
		expect(reg.projects[0]?.tasks[0]?.status).toBe("active");
	});
});

describe("parseRegistry slug safety", () => {
	it("drops projects with invalid slugs", () => {
		const yaml = `projects:
  - slug: "../etc"
    name: bad
    tasks: []
  - slug: good
    name: good
    tasks: []
`;
		const reg = parseRegistry(yaml);
		expect(reg.projects.map((p) => p.slug)).toEqual(["good"]);
	});

	it("drops tasks with invalid slugs but keeps the project", () => {
		const yaml = `projects:
  - slug: p
    name: P
    tasks:
      - slug: "../escape"
        name: bad
        status: active
        created: "2026-05-05"
        updated: "2026-05-05"
      - slug: ok
        name: ok
        status: active
        created: "2026-05-05"
        updated: "2026-05-05"
`;
		const reg = parseRegistry(yaml);
		expect(reg.projects).toHaveLength(1);
		expect(reg.projects[0]?.tasks.map((t) => t.slug)).toEqual(["ok"]);
	});

	it.each(["Foo", "p p", "p/q", "..", "-x", "x-"])(
		"rejects slug %s on load",
		(bad) => {
			const yaml = `projects:
  - slug: "${bad}"
    name: x
    tasks: []
`;
			expect(parseRegistry(yaml).projects).toEqual([]);
		},
	);
});

describe("serializeRegistry round-trip", () => {
	it("parse -> serialize -> parse stable", () => {
		const reg: Registry = {
			projects: [
				{
					slug: "p1",
					name: "Project One",
					tasks: [
						{
							slug: "t1",
							name: "Task One",
							status: "active",
							created: "2026-05-05",
							updated: "2026-05-05",
						},
					],
				},
			],
		};
		expect(parseRegistry(serializeRegistry(reg))).toEqual(reg);
	});
});

describe("addProject", () => {
	const fresh = (): Registry => ({ projects: [] });

	it("adds a new project", () => {
		const reg = addProject(fresh(), "alpha", "Alpha");
		expect(reg.projects[0]?.slug).toBe("alpha");
		expect(reg.projects[0]?.name).toBe("Alpha");
		expect(reg.projects[0]?.tasks).toEqual([]);
	});

	it("rejects duplicate slug", () => {
		const reg = addProject(fresh(), "alpha", "Alpha");
		expect(() => addProject(reg, "alpha", "Other")).toThrow(/duplicate/i);
	});

	it("rejects invalid slug", () => {
		expect(() => addProject(fresh(), "Bad Slug", "x")).toThrow();
	});
});

describe("addTask", () => {
	const seeded = (): Registry =>
		addProject({ projects: [] }, "alpha", "Alpha");

	it("adds a new task with defaults", () => {
		const reg = addTask(seeded(), "alpha", "first-task", "First Task", {
			created: "2026-05-05",
		});
		const t = reg.projects[0]?.tasks[0];
		expect(t?.slug).toBe("first-task");
		expect(t?.name).toBe("First Task");
		expect(t?.status).toBe("active");
		expect(t?.created).toBe("2026-05-05");
		expect(t?.updated).toBe("2026-05-05");
	});

	it("preserves optional ticket", () => {
		const reg = addTask(seeded(), "alpha", "x", "X", {
			created: "2026-05-05",
			ticket: "https://example.com/X-1",
		});
		expect(reg.projects[0]?.tasks[0]?.ticket).toBe("https://example.com/X-1");
	});

	it("rejects unknown project", () => {
		expect(() =>
			addTask(seeded(), "no-such", "x", "X", { created: "2026-05-05" }),
		).toThrow(/unknown project/i);
	});

	it("rejects duplicate task slug within project", () => {
		const reg = addTask(seeded(), "alpha", "x", "X", { created: "2026-05-05" });
		expect(() =>
			addTask(reg, "alpha", "x", "Y", { created: "2026-05-05" }),
		).toThrow(/duplicate/i);
	});

	it("rejects invalid slug", () => {
		expect(() =>
			addTask(seeded(), "alpha", "Bad Slug", "x", { created: "2026-05-05" }),
		).toThrow();
	});
});

describe("findTask", () => {
	const reg = addTask(
		addProject({ projects: [] }, "p", "P"),
		"p",
		"t",
		"T",
		{ created: "2026-05-05" },
	);

	it("returns the task when present", () => {
		expect(findTask(reg, "p", "t")?.slug).toBe("t");
	});

	it("returns undefined when project missing", () => {
		expect(findTask(reg, "x", "t")).toBeUndefined();
	});

	it("returns undefined when task missing", () => {
		expect(findTask(reg, "p", "x")).toBeUndefined();
	});
});

describe("listActiveTasks", () => {
	it("returns only active tasks across projects, with project slug", () => {
		let reg: Registry = { projects: [] };
		reg = addProject(reg, "p1", "P1");
		reg = addProject(reg, "p2", "P2");
		reg = addTask(reg, "p1", "a", "A", { created: "2026-05-05" });
		reg = addTask(reg, "p1", "b", "B", { created: "2026-05-05" });
		reg = addTask(reg, "p2", "c", "C", { created: "2026-05-05" });
		// mutate one to paused, one to done
		reg.projects[0]!.tasks[1]!.status = "paused";
		reg.projects[1]!.tasks[0]!.status = "done";

		const active = listActiveTasks(reg);
		expect(active.map((x) => `${x.project}/${x.task.slug}`)).toEqual(["p1/a"]);
	});
});

describe("bumpUpdated", () => {
	it("updates the task and project updated fields", () => {
		let reg: Registry = addTask(
			addProject({ projects: [] }, "p", "P"),
			"p",
			"t",
			"T",
			{ created: "2026-05-05" },
		);
		reg = bumpUpdated(reg, "p", "t", "2026-05-06");
		expect(reg.projects[0]?.tasks[0]?.updated).toBe("2026-05-06");
		expect(reg.projects[0]?.updated).toBe("2026-05-06");
	});

	it("throws on unknown task", () => {
		const reg: Registry = { projects: [] };
		expect(() => bumpUpdated(reg, "p", "t", "2026-05-06")).toThrow();
	});
});
