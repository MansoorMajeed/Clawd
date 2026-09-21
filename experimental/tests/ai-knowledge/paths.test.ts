import { describe, it, expect } from "vitest";
import {
	registryPath,
	projectDir,
	taskDir,
	taskIndexPath,
	sessionsDir,
	sessionPath,
	wikiDir,
	wikiEntryPath,
} from "../../extensions/ai-knowledge/paths.js";

const ROOT = "/vault";

describe("paths", () => {
	it("registryPath", () => {
		expect(registryPath(ROOT)).toBe("/vault/registry.yaml");
	});

	it("projectDir", () => {
		expect(projectDir(ROOT, "alpha")).toBe("/vault/alpha");
	});

	it("taskDir", () => {
		expect(taskDir(ROOT, "alpha", "first-task")).toBe("/vault/alpha/first-task");
	});

	it("taskIndexPath", () => {
		expect(taskIndexPath(ROOT, "p", "t")).toBe("/vault/p/t/INDEX.md");
	});

	it("sessionsDir", () => {
		expect(sessionsDir(ROOT, "p", "t")).toBe("/vault/p/t/sessions");
	});

	it("sessionPath", () => {
		expect(sessionPath(ROOT, "p", "t", "2026-05-05-1930")).toBe(
			"/vault/p/t/sessions/2026-05-05-1930.md",
		);
	});

	it("wikiDir", () => {
		expect(wikiDir(ROOT)).toBe("/vault/llm-wiki");
	});

	it("wikiEntryPath", () => {
		expect(wikiEntryPath(ROOT, "escaping-rules")).toBe(
			"/vault/llm-wiki/escaping-rules.md",
		);
	});
});
