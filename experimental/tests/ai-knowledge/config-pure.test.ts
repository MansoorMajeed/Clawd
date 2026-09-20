import { describe, it, expect } from "vitest";
import { validateConfig } from "../../extensions/ai-knowledge/config-pure.js";

describe("validateConfig", () => {
	it("returns null for null/undefined", () => {
		expect(validateConfig(null)).toBeNull();
		expect(validateConfig(undefined)).toBeNull();
	});

	it("returns null for non-object input", () => {
		expect(validateConfig("string")).toBeNull();
		expect(validateConfig(42)).toBeNull();
		expect(validateConfig(true)).toBeNull();
		expect(validateConfig([])).toBeNull();
	});

	it("returns null when rootPath is missing", () => {
		expect(validateConfig({})).toBeNull();
		expect(validateConfig({ autoCommit: false })).toBeNull();
	});

	it("returns null when rootPath is not a string", () => {
		expect(validateConfig({ rootPath: 42 })).toBeNull();
		expect(validateConfig({ rootPath: null })).toBeNull();
		expect(validateConfig({ rootPath: "" })).toBeNull();
	});

	it("returns Config with autoCommit defaulted to true when valid rootPath provided", () => {
		expect(validateConfig({ rootPath: "/tmp/vault" })).toEqual({
			rootPath: "/tmp/vault",
			autoCommit: true,
		});
	});

	it("respects explicit autoCommit: false", () => {
		expect(validateConfig({ rootPath: "/tmp/vault", autoCommit: false })).toEqual({
			rootPath: "/tmp/vault",
			autoCommit: false,
		});
	});

	it("ignores non-boolean autoCommit and falls back to default", () => {
		expect(
			validateConfig({ rootPath: "/tmp/vault", autoCommit: "yes" }),
		).toEqual({
			rootPath: "/tmp/vault",
			autoCommit: true,
		});
	});

	it("does not perform tilde expansion or directory checks (pure)", () => {
		// Caller is responsible for these. Pure layer just types & defaults.
		expect(validateConfig({ rootPath: "~/vault" })).toEqual({
			rootPath: "~/vault",
			autoCommit: true,
		});
	});
});
