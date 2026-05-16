import { describe, expect, it } from "vitest";
import { formatDirty, isDirty, parseStatus } from "../extensions/git-status";

describe("parseStatus", () => {
	it("counts modified, added, deleted, untracked with index/worktree codes", () => {
		const out = [
			" M src/a.ts",
			"M  src/b.ts",
			"A  src/c.ts",
			" D src/d.ts",
			"?? src/e.ts",
		].join("\n");
		expect(parseStatus(out)).toEqual({
			modified: 2,
			added: 1,
			deleted: 1,
			untracked: 1,
			unmerged: 0,
		});
	});

	it("treats rename, copy, and type-change codes as modified", () => {
		const out = [
			"R  old.ts -> new.ts",
			"C  src.ts -> copy.ts",
			"T  link.ts",
		].join("\n");
		expect(parseStatus(out)).toEqual({
			modified: 3,
			added: 0,
			deleted: 0,
			untracked: 0,
			unmerged: 0,
		});
	});

	it("flags unmerged conflicts including UU, AA, DD, AU, DU", () => {
		const out = [
			"UU src/a.ts",
			"AA src/b.ts",
			"DD src/c.ts",
			"AU src/d.ts",
			"DU src/e.ts",
		].join("\n");
		expect(parseStatus(out)).toEqual({
			modified: 0,
			added: 0,
			deleted: 0,
			untracked: 0,
			unmerged: 5,
		});
	});

	it("ignores ignored entries (!!)", () => {
		const out = ["!! build/", " M src/a.ts"].join("\n");
		expect(parseStatus(out)).toEqual({
			modified: 1,
			added: 0,
			deleted: 0,
			untracked: 0,
			unmerged: 0,
		});
	});

	it("renders dirty=true for a staged-only rename and for a UU conflict", () => {
		// Regression for review finding #1: previously parseStatus only counted
		// M/A/D/??, so a `R ` rename or `UU` conflict rendered as clean.
		expect(isDirty(parseStatus("R  old.ts -> new.ts"))).toBe(true);
		expect(isDirty(parseStatus("UU src/a.ts"))).toBe(true);
	});

	it("returns clean counts for empty output", () => {
		expect(isDirty(parseStatus(""))).toBe(false);
	});
});

describe("formatDirty", () => {
	it("emits compact buckets in stable order with the U conflict marker", () => {
		expect(
			formatDirty({
				modified: 3,
				added: 1,
				deleted: 2,
				untracked: 4,
				unmerged: 1,
			}),
		).toBe("3M 1A 2D 4? 1U");
	});

	it("skips empty buckets", () => {
		expect(
			formatDirty({
				modified: 0,
				added: 0,
				deleted: 0,
				untracked: 2,
				unmerged: 0,
			}),
		).toBe("2?");
	});
});
