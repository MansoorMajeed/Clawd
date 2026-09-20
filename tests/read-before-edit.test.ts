import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
	findUnreadEditPath,
	recordSeenFile,
	resetSeenFiles,
} from "../extensions/read-before-edit";

const cwd = "/tmp/project";

describe("read-before-edit path tracking", () => {
	it("allows an absolute edit after reading the relative path", () => {
		const seenFiles = recordSeenFile(new Set(), cwd, "extensions/foo.ts");

		expect(
			findUnreadEditPath(seenFiles, cwd, { path: path.join(cwd, "extensions/foo.ts") }),
		).toBeUndefined();
	});

	it("blocks an unseen file", () => {
		expect(findUnreadEditPath(new Set(), cwd, { path: "extensions/foo.ts" })).toBe(
			"extensions/foo.ts",
		);
	});

	it("normalizes the leading @ prefix like the native edit tool", () => {
		const file = path.join(cwd, "extensions/foo.ts");
		const seenFiles = recordSeenFile(new Set(), cwd, "extensions/foo.ts");

		expect(findUnreadEditPath(seenFiles, cwd, { path: `@${file}`, edits: [] })).toBeUndefined();
	});

	it("normalizes file URLs and Unicode spaces like native file tools", () => {
		const seenFiles = recordSeenFile(new Set(), cwd, "extensions/foo bar.ts");

		expect(
			findUnreadEditPath(seenFiles, cwd, {
				path: pathToFileURL(path.join(cwd, "extensions/foo bar.ts")).href,
			}),
		).toBeUndefined();
		expect(findUnreadEditPath(seenFiles, cwd, { path: "extensions/foo\u202fbar.ts" })).toBeUndefined();
	});

	it("blocks a previously seen file after reset", () => {
		const seenFiles = recordSeenFile(new Set(), cwd, "extensions/foo.ts");
		const resetFiles = resetSeenFiles(seenFiles);

		expect(findUnreadEditPath(resetFiles, cwd, { path: "extensions/foo.ts" })).toBe(
			"extensions/foo.ts",
		);
	});
});
