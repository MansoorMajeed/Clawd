import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { liveEntries, writeEntry, type RegistryEntry } from "../extensions/artifact/registry";
import { ArtifactServer } from "../extensions/artifact/server";

let root: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "artifact-registry-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const entry = (pid: number, port: number): RegistryEntry => ({
	pid,
	port,
	token: "t",
	cwd: "/work/repo",
	docs: [{ id: "abc", path: "/work/repo/plan.md" }],
});

describe("registry", () => {
	it("writes entries readable only by the owner", () => {
		writeEntry(root, entry(10, 5000));
		const file = join(root, "servers", "10-5000.json");
		expect(statSync(file).mode & 0o777).toBe(0o600);
	});

	it("prunes dead sessions, skips unreachable ones, and excludes itself", async () => {
		writeEntry(root, entry(1, 1001)); // dead pid
		writeEntry(root, entry(2, 1002)); // alive, ping fails
		writeEntry(root, entry(3, 1003)); // alive, reachable
		writeEntry(root, entry(4, 1004)); // self
		writeFileSync(join(root, "servers", "junk.json"), "{not json");
		const ping = vi.fn(async (e: RegistryEntry) => e.port === 1003);
		const live = await liveEntries(root, { self: { pid: 4, port: 1004 }, isAlive: (pid) => pid !== 1, ping });
		expect(live.map((e) => e.pid)).toEqual([3]);
		expect(readdirSync(join(root, "servers")).sort()).toEqual(["2-1002.json", "3-1003.json", "4-1004.json"]);
		expect(ping).toHaveBeenCalledTimes(2);
	});
});

function get(port: number, path: string): Promise<any> {
	return new Promise((resolve, reject) => {
		request({ host: "127.0.0.1", port, path, headers: { host: `127.0.0.1:${port}` } }, (res) => {
			let body = "";
			res.on("data", (c) => (body += c));
			res.on("end", () => resolve(JSON.parse(body)));
		})
			.on("error", reject)
			.end();
	});
}

describe("server registration", () => {
	it("registers open documents, lists other sessions, and unregisters on stop", async () => {
		const docA = join(root, "a.md");
		const docB = join(root, "b.md");
		writeFileSync(docA, "# A\n");
		writeFileSync(docB, "# B\n");
		const a = new ArtifactServer({ root, cwd: root, send: () => {} });
		const b = new ArtifactServer({ root, cwd: root, send: () => {} });
		await a.start();
		await b.start();
		try {
			a.open(docA);
			b.open(docB);
			const fileA = join(root, "servers", `${process.pid}-${a.port}.json`);
			expect(existsSync(fileA)).toBe(true);

			const { docs } = await get(a.port, `/api/docs?token=${a.token}`);
			expect(docs.map((d: any) => [d.path, d.session === undefined])).toEqual([
				["a.md", true],
				["b.md", false],
			]);
			expect(docs[1].url).toBe(b.url(b.documents()[0].id));

			await b.stop();
			const after = await get(a.port, `/api/docs?token=${a.token}`);
			expect(after.docs.map((d: any) => d.path)).toEqual(["a.md"]);
			await a.stop();
			expect(existsSync(fileA)).toBe(false);
		} finally {
			await a.stop();
			await b.stop();
		}
	});
});
