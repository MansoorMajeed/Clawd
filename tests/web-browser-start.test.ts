import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	buildChromeArgs,
	classifyListenerCommands,
} from "../skills/web-browser/scripts/start.js";

const startScript = readFileSync(
	fileURLToPath(new URL("../skills/web-browser/scripts/start.js", import.meta.url)),
	"utf8",
);

describe("web-browser startup safety", () => {
	it("does not terminate Chrome or copy the user's Chrome data", () => {
		expect(startScript).not.toMatch(/\bkillall\b/);
		expect(startScript).not.toMatch(/\brsync\b/);
		expect(startScript).not.toContain("Library/Application Support/Google/Chrome");
	});

	it("launches a separate Chrome instance with a dedicated profile", () => {
		const profileDir = "/tmp/agent-web/chrome-profile";

		expect(buildChromeArgs(profileDir)).toEqual([
			"-n",
			"-a",
			"Google Chrome",
			"--args",
			"--remote-debugging-port=9222",
			`--user-data-dir=${profileDir}`,
			"--profile-directory=Default",
			"--disable-search-engine-choice-screen",
			"--no-first-run",
		]);
	});

	it("only trusts a CDP listener using the dedicated Chrome profile", () => {
		const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
		const profileDir = "/tmp/agent-web/chrome-profile";
		const dedicated = `${chrome} --remote-debugging-port=9222 --user-data-dir=${profileDir}`;

		expect(classifyListenerCommands([], profileDir)).toBe("free");
		expect(classifyListenerCommands([dedicated], profileDir)).toBe("dedicated");
		expect(
			classifyListenerCommands(
				[`${chrome} --remote-debugging-port=9222`],
				profileDir,
			),
		).toBe("foreign");
		expect(
			classifyListenerCommands(
				[`${chrome} --user-data-dir=/tmp/another-profile`],
				profileDir,
			),
		).toBe("foreign");
		expect(
			classifyListenerCommands(
				[`${chrome} --user-data-dir=${profileDir}-other`],
				profileDir,
			),
		).toBe("foreign");
	});
});
