import path from "node:path";
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

	it("blocks an unread complete top-level edit combined with multi-edit", () => {
		const seenFiles = recordSeenFile(new Set(), cwd, "extensions/seen.ts");

		expect(
			findUnreadEditPath(seenFiles, cwd, {
				path: "extensions/unread.ts",
				oldText: "before",
				newText: "after",
				multi: [{ path: "extensions/seen.ts" }],
			}),
		).toBe("extensions/unread.ts");
	});

	it("blocks the first unseen path in a mixed multi-edit", () => {
		const seenFiles = recordSeenFile(new Set(), cwd, "extensions/seen.ts");

		expect(
			findUnreadEditPath(seenFiles, cwd, {
				multi: [
					{ path: "./extensions/seen.ts" },
					{ path: path.join(cwd, "extensions/unseen.ts") },
				],
			}),
		).toBe(path.join(cwd, "extensions/unseen.ts"));
	});

	it("blocks a previously seen file after reset", () => {
		const seenFiles = recordSeenFile(new Set(), cwd, "extensions/foo.ts");
		const resetFiles = resetSeenFiles(seenFiles);

		expect(findUnreadEditPath(resetFiles, cwd, { path: "extensions/foo.ts" })).toBe(
			"extensions/foo.ts",
		);
	});
});
