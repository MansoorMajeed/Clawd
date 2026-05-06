import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { parseRegistry, serializeRegistry } from "./registry-pure.js";
import { registryPath } from "./paths.js";
import type { Registry } from "./types.js";

export async function loadRegistry(root: string): Promise<Registry> {
	const path = registryPath(root);
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch {
		return { projects: [] };
	}
	return parseRegistry(text);
}

export async function saveRegistry(root: string, reg: Registry): Promise<void> {
	const path = registryPath(root);
	await mkdir(dirname(path), { recursive: true });
	const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
	await writeFile(tmp, serializeRegistry(reg), "utf8");
	await rename(tmp, path);
}
