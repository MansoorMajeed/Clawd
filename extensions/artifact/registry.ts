import { chmodSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";

/** One running viewer server, so other sessions can list its documents. */
export interface RegistryEntry {
	pid: number;
	port: number;
	token: string;
	cwd: string;
	docs: Array<{ id: string; path: string }>;
}

function serversDir(root: string): string {
	return join(root, "servers");
}

function entryFile(root: string, pid: number, port: number): string {
	return join(serversDir(root), `${pid}-${port}.json`);
}

export function writeEntry(root: string, entry: RegistryEntry): void {
	const dir = serversDir(root);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const file = entryFile(root, entry.pid, entry.port);
	const tmp = `${file}.tmp`;
	writeFileSync(tmp, JSON.stringify(entry), { mode: 0o600 });
	chmodSync(tmp, 0o600);
	renameSync(tmp, file);
}

export function removeEntry(root: string, pid: number, port: number): void {
	rmSync(entryFile(root, pid, port), { force: true });
}

function processAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

function pingServer(entry: RegistryEntry): Promise<boolean> {
	return new Promise((resolve) => {
		const req = request(
			{
				host: "127.0.0.1",
				port: entry.port,
				path: `/api/ping?token=${entry.token}`,
				headers: { host: `127.0.0.1:${entry.port}` },
				timeout: 300,
			},
			(res) => {
				res.resume();
				resolve(res.statusCode === 200);
			},
		);
		req.on("timeout", () => req.destroy());
		req.on("error", () => resolve(false));
		req.end();
	});
}

/**
 * Other live servers. Entries whose process is gone are deleted; entries that
 * don't answer (e.g. a reused pid) are skipped but left alone.
 */
export async function liveEntries(
	root: string,
	options: {
		self: { pid: number; port: number };
		isAlive?: (pid: number) => boolean;
		ping?: (entry: RegistryEntry) => Promise<boolean>;
	},
): Promise<RegistryEntry[]> {
	const isAlive = options.isAlive ?? processAlive;
	const ping = options.ping ?? pingServer;
	let files: string[];
	try {
		files = readdirSync(serversDir(root)).filter((f) => f.endsWith(".json"));
	} catch {
		return [];
	}
	const candidates: RegistryEntry[] = [];
	for (const file of files) {
		const path = join(serversDir(root), file);
		let entry: RegistryEntry;
		try {
			entry = JSON.parse(readFileSync(path, "utf8")) as RegistryEntry;
		} catch {
			rmSync(path, { force: true });
			continue;
		}
		if (entry.pid === options.self.pid && entry.port === options.self.port) continue;
		if (!isAlive(entry.pid)) {
			rmSync(path, { force: true });
			continue;
		}
		candidates.push(entry);
	}
	const reachable = await Promise.all(candidates.map(ping));
	return candidates.filter((_, i) => reachable[i]);
}
