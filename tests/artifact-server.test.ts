import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createArtifactExtension } from "../extensions/artifact/index";
import { ArtifactServer } from "../extensions/artifact/server";

vi.mock("node:fs", async (importOriginal) => {
	const fs = await importOriginal<typeof import("node:fs")>();
	return { ...fs, writeFileSync: vi.fn(fs.writeFileSync), renameSync: vi.fn(fs.renameSync) };
});

interface Res {
	status: number;
	headers: Record<string, string | string[] | undefined>;
	body: string;
}

function call(port: number, path: string, opts: { method?: string; body?: unknown; host?: string; cookie?: string } = {}): Promise<Res> {
	return new Promise((resolve, reject) => {
		const payload = opts.body === undefined ? undefined : JSON.stringify(opts.body);
		const req = request(
			{
				host: "127.0.0.1",
				port,
				path,
				// Test servers reuse the same preferred port; never reuse a socket from a stopped one.
				agent: false,
				method: opts.method ?? "GET",
				headers: {
					host: opts.host ?? `127.0.0.1:${port}`,
					...(opts.cookie ? { cookie: opts.cookie } : {}),
					...(payload ? { "content-type": "application/json" } : {}),
				},
			},
			(res) => {
				let body = "";
				res.on("data", (c) => (body += c));
				res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body }));
			},
		);
		req.on("error", reject);
		req.end(payload);
	});
}

function freePort(): Promise<number> {
	return new Promise((resolve) => {
		const probe = createNetServer().listen(0, "127.0.0.1", () => {
			const { port } = probe.address() as { port: number };
			probe.close(() => resolve(port));
		});
	});
}

/** Resolves with the first SSE event name (and its data) received after `trigger` runs. */
function nextEvent(port: number, path: string, trigger: () => unknown): Promise<{ name: string; data: string }> {
	return new Promise((resolve, reject) => {
		const req = request({ host: "127.0.0.1", port, path, headers: { host: `127.0.0.1:${port}` } }, (res) => {
			let buf = "";
			res.on("data", (chunk) => {
				buf += chunk;
				if (buf.includes(": connected")) {
					buf = "";
					Promise.resolve().then(trigger).catch((error) => {
						req.destroy();
						reject(error);
					});
					return;
				}
				const match = /event: (\w+)\ndata: (.*)\n\n/.exec(buf);
				if (match) {
					req.destroy();
					resolve({ name: match[1], data: match[2] });
				}
			});
		});
		req.on("error", (e) => (e.message.includes("aborted") || e.message.includes("socket hang up") ? undefined : reject(e)));
		req.end();
	});
}

let dir: string;
let docPath: string;
let server: ArtifactServer;
let send: ReturnType<typeof vi.fn>;
let docId: string;
let q: string;

beforeEach(async () => {
	dir = mkdtempSync(join(tmpdir(), "artifact-server-"));
	docPath = join(dir, "plan.md");
	writeFileSync(docPath, "# Plan\n\n## Decisions\n\n> [!DECISION]\n> 1. Pick A.\n");
	send = vi.fn();
	server = new ArtifactServer({ root: join(dir, "state"), cwd: dir, send });
	await server.start();
	docId = server.open(docPath).id;
	q = `token=${server.token}`;
});

afterEach(async () => {
	vi.mocked(writeFileSync).mockReset();
	vi.mocked(renameSync).mockReset();
	await server.stop();
	rmSync(dir, { recursive: true, force: true });
});

async function blocks() {
	const res = await call(server.port, `/api/doc/${docId}?${q}`);
	return JSON.parse(res.body).blocks as Array<{ id: string; kind: string }>;
}

describe("ArtifactServer", () => {
	it("creates and persists an agent review, notifies viewers, and sends only the user's response", async () => {
		const decision = (await blocks()).find((b) => b.kind === "decision")!;
		const event = await nextEvent(server.port, `/api/events?doc=${docId}&${q}`, () =>
			server.comment(docPath, "  Pick\n A  ", "Explain this choice.", "Decisions"),
		);
		expect(event.name).toBe("changed");
		const threads = async () => JSON.parse((await call(server.port, `/api/doc/${docId}?${q}`)).body).threads;
		expect((await threads())[0]).toMatchObject({
			id: 1, status: "review", quote: "Pick A", attachment: { status: "exact", blockId: decision.id },
			messages: [{ author: "agent", text: "Explain this choice.", sent: true }],
		});
		expect(send).not.toHaveBeenCalled();
		const post = (action: string, body: unknown) => call(server.port, `/api/doc/${docId}/${action}?${q}`, { method: "POST", body });
		expect(JSON.parse((await post("send", {})).body)).toEqual({ sent: 0 });
		expect(send).not.toHaveBeenCalled();
		await post("comments", { threadId: 1, text: "A costs less." });
		expect((await threads())[0].status).toBe("draft");
		expect(send).not.toHaveBeenCalled();
		expect(JSON.parse((await post("send", { threadId: 1 })).body)).toEqual({ sent: 1 });
		expect(send).toHaveBeenCalledTimes(1);
		expect(send.mock.calls[0][0]).toContain("Agent review:\nExplain this choice.");
		expect(send.mock.calls[0][0]).toContain("User response:\nA costs less.");
		expect((await threads())[0].status).toBe("sent");
		await server.stop();
		server = new ArtifactServer({ root: join(dir, "state"), cwd: dir, send });
		await server.start();
		docId = server.open(docPath).id;
		expect((await threads())[0].messages).toHaveLength(2);
	});

	it("matches rendered agent quotes and rejects missing or ambiguous anchors", async () => {
		writeFileSync(docPath, "# Plan\n\n## First\n\nSome *styled* text.\n\n## Second\n\nSome *styled* text.\n\nEcho Echo.\n");
		expect(() => server.comment(docPath, "styled text", "unclear")).toThrow(/ambiguous/i);
		expect(() => server.comment(docPath, "Echo", "unclear", "Second")).toThrow(/ambiguous/i);
		expect(() => server.comment(docPath, "not present", "missing")).toThrow(/not found/i);
		expect(() => server.comment(docPath, "styled text", "wrong section", "Missing")).toThrow(/not found/i);
		expect(() => server.comment(docPath, "  ", "empty quote")).toThrow();
		expect(() => server.comment(docPath, "styled text", "  ", "First")).toThrow();
		expect(server.comment(docPath, "styled text", "A specific point.", "Second")).toBe(1);
		const payload = JSON.parse((await call(server.port, `/api/doc/${docId}?${q}`)).body);
		expect(payload.threads).toHaveLength(1);
		expect(payload.threads[0].attachment).toMatchObject({ status: "exact", blockId: payload.blocks[4].id });
	});

	it("returns exact Markdown source and a SHA256 version and preserves source bytes and mode on save", async () => {
		const original = "# Plan\r\n\r\nCafé.\r\n";
		writeFileSync(docPath, original);
		chmodSync(docPath, 0o640);
		const endpoint = `/api/doc/${docId}/source?${q}`;
		const before = await call(server.port, endpoint);
		expect(before.status).toBe(200);
		const version = createHash("sha256").update(original, "utf8").digest("hex");
		expect(JSON.parse(before.body)).toEqual({ source: original, version });
		const source = "# Plan\r\n\r\nUpdated café.";
		const saved = await call(server.port, endpoint, { method: "POST", body: { source, version } });
		expect(saved.status).toBe(200);
		expect(JSON.parse(saved.body)).toEqual({ version: createHash("sha256").update(source, "utf8").digest("hex") });
		expect(readFileSync(docPath)).toEqual(Buffer.from(source, "utf8"));
		expect(statSync(docPath).mode & 0o777).toBe(0o640);
		expect(JSON.parse((await call(server.port, endpoint)).body).source).toBe(source);
		const rendered = JSON.parse((await call(server.port, `/api/doc/${docId}?${q}`)).body);
		expect(rendered.blocks.at(-1).html).toContain("Updated café.");
	});

	it("preserves the original bytes and removes staging files after a partial source write fails", async () => {
		const endpoint = `/api/doc/${docId}/source?${q}`;
		const original = readFileSync(docPath);
		const files = readdirSync(dir).sort();
		const { version } = JSON.parse((await call(server.port, endpoint)).body);
		const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
		let partialWrite = false;
		vi.mocked(writeFileSync).mockImplementationOnce((file, source, options) => {
			fs.writeFileSync(file, String(source).slice(0, 8), options);
			partialWrite = true;
			throw new Error("ENOSPC: partial source write");
		});
		const saved = await call(server.port, endpoint, { method: "POST", body: { source: "# Replacement\n\nNew content.\n", version } });
		expect(saved.status).toBe(500);
		expect(JSON.parse(saved.body).error).toBe("ENOSPC: partial source write");
		expect(partialWrite).toBe(true);
		expect(readFileSync(docPath)).toEqual(original);
		expect(readdirSync(dir).sort()).toEqual(files);
	});

	it("preserves source permissions even when the process umask is more restrictive", async () => {
		chmodSync(docPath, 0o664);
		const endpoint = `/api/doc/${docId}/source?${q}`;
		const { version } = JSON.parse((await call(server.port, endpoint)).body);
		const files = readdirSync(dir).sort();
		const mask = process.umask(0o077);
		try {
			const saved = await call(server.port, endpoint, { method: "POST", body: { source: "# Saved\n", version } });
			expect(saved.status).toBe(200);
			expect(readFileSync(docPath, "utf8")).toBe("# Saved\n");
			expect(statSync(docPath).mode & 0o777).toBe(0o664);
			expect(readdirSync(dir).sort()).toEqual(files);
		} finally {
			process.umask(mask);
		}
	});

	it("saves through a document symlink without replacing the link and stages beside its target", async () => {
		const targetDir = join(dir, "target");
		mkdirSync(targetDir);
		const targetPath = join(targetDir, "actual.md");
		writeFileSync(targetPath, "# Target\n");
		chmodSync(targetPath, 0o640);
		unlinkSync(docPath);
		symlinkSync("target/actual.md", docPath);
		const endpoint = `/api/doc/${docId}/source?${q}`;
		const { version } = JSON.parse((await call(server.port, endpoint)).body);
		const saved = await call(server.port, endpoint, { method: "POST", body: { source: "# Changed target\n", version } });
		expect(saved.status).toBe(200);
		expect(lstatSync(docPath).isSymbolicLink()).toBe(true);
		expect(readlinkSync(docPath)).toBe("target/actual.md");
		expect(readFileSync(targetPath, "utf8")).toBe("# Changed target\n");
		expect(statSync(targetPath).mode & 0o777).toBe(0o640);
		const replacement = vi.mocked(renameSync).mock.calls.at(-1)!;
		expect(dirname(String(replacement[0]))).toBe(dirname(realpathSync(targetPath)));
		expect(replacement[1]).toBe(realpathSync(targetPath));
		expect(readdirSync(targetDir)).toEqual(["actual.md"]);
	});

	it("preserves external edits made while staging source and removes the staged file", async () => {
		const endpoint = `/api/doc/${docId}/source?${q}`;
		const { version } = JSON.parse((await call(server.port, endpoint)).body);
		const files = readdirSync(dir).sort();
		const external = "# External edit during staging\n";
		const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
		vi.mocked(renameSync).mockClear();
		vi.mocked(writeFileSync).mockImplementationOnce((file, source, options) => {
			fs.writeFileSync(file, source, options);
			fs.writeFileSync(docPath, external);
		});
		const saved = await call(server.port, endpoint, { method: "POST", body: { source: "Browser draft", version } });
		expect(saved.status).toBe(409);
		expect(JSON.parse(saved.body).error).toMatch(/changed/i);
		expect(readFileSync(docPath, "utf8")).toBe(external);
		expect(readdirSync(dir).sort()).toEqual(files);
		expect(renameSync).not.toHaveBeenCalled();
	});

	it("preserves the original bytes and removes staging files when source replacement fails", async () => {
		const endpoint = `/api/doc/${docId}/source?${q}`;
		const { version } = JSON.parse((await call(server.port, endpoint)).body);
		const original = readFileSync(docPath);
		const files = readdirSync(dir).sort();
		vi.mocked(renameSync).mockImplementationOnce(() => {
			throw new Error("EACCES: source replacement failed");
		});
		const saved = await call(server.port, endpoint, { method: "POST", body: { source: "Browser draft", version } });
		expect(saved.status).toBe(500);
		expect(JSON.parse(saved.body).error).toBe("EACCES: source replacement failed");
		expect(readFileSync(docPath)).toEqual(original);
		expect(readdirSync(dir).sort()).toEqual(files);
	});

	it("notifies connected viewers after a source save", async () => {
		const endpoint = `/api/doc/${docId}/source?${q}`;
		const { version } = JSON.parse((await call(server.port, endpoint)).body);
		let saved: Promise<Res>;
		const event = await nextEvent(server.port, `/api/events?doc=${docId}&${q}`, () => {
			saved = call(server.port, endpoint, { method: "POST", body: { source: "# Changed\n", version } });
		});
		expect(event.name).toBe("changed");
		expect((await saved!).status).toBe(200);
	});

	it("rejects stale saves without overwriting external edits or automatically merging", async () => {
		const endpoint = `/api/doc/${docId}/source?${q}`;
		const { version } = JSON.parse((await call(server.port, endpoint)).body);
		const external = "# External edit\n";
		writeFileSync(docPath, external);
		const stale = await call(server.port, endpoint, { method: "POST", body: { source: "Browser draft", version } });
		expect(stale.status).toBe(409);
		expect(JSON.parse(stale.body).error).toMatch(/changed/i);
		expect(readFileSync(docPath, "utf8")).toBe(external);
	});

	it("accepts only one of two saves against the same version", async () => {
		const endpoint = `/api/doc/${docId}/source?${q}`;
		const { version } = JSON.parse((await call(server.port, endpoint)).body);
		const results = await Promise.all(["First", "Second"].map((source) =>
			call(server.port, endpoint, { method: "POST", body: { source, version } }),
		));
		expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
		expect(readFileSync(docPath, "utf8")).toBe(results[0].status === 200 ? "First" : "Second");
	});

	it("restricts source access to registered documents and rejects invalid saves", async () => {
		const endpoint = `/api/doc/${docId}/source?${q}`;
		const original = readFileSync(docPath, "utf8");
		const { version } = JSON.parse((await call(server.port, endpoint)).body);
		for (const body of [{ source: "x" }, { version }, { source: 3, version }, { source: "x", version: 3 }]) {
			expect((await call(server.port, endpoint, { method: "POST", body })).status).toBe(400);
		}
		const other = join(dir, "unregistered.md");
		writeFileSync(other, "Untouched");
		for (const method of ["GET", "POST"]) {
			expect((await call(server.port, `/api/doc/unknown/source?${q}`, { method, body: method === "POST" ? { source: "x", version, path: other } : undefined })).status).toBe(404);
		}
		expect((await call(server.port, endpoint, { method: "POST", body: { source: original, version, path: other } })).status).toBe(200);
		expect(readFileSync(other, "utf8")).toBe("Untouched");
		expect(readFileSync(docPath, "utf8")).toBe(original);
		expect((await call(server.port, `/api/doc/${docId}/source`)).status).toBe(403);
		unlinkSync(docPath);
		expect((await call(server.port, endpoint)).status).toBe(404);
		expect((await call(server.port, endpoint, { method: "POST", body: { source: "x", version } })).status).toBe(404);
	});

	it("allows source requests up to 1 MiB while retaining the 64 KiB comment cap", async () => {
		const endpoint = `/api/doc/${docId}/source?${q}`;
		const { version } = JSON.parse((await call(server.port, endpoint)).body);
		const source = "# Large\n\n" + "é".repeat(60 * 1024);
		expect((await call(server.port, endpoint, { method: "POST", body: { source, version } })).status).toBe(200);
		expect(readFileSync(docPath, "utf8")).toBe(source);
		const tooLarge = await call(server.port, endpoint, { method: "POST", body: { source: "é".repeat(512 * 1024), version } });
		expect(tooLarge.status).toBe(413);
		expect(readFileSync(docPath, "utf8")).toBe(source);
		const comment = await call(server.port, `/api/doc/${docId}/comments?${q}`, { method: "POST", body: { quote: "Large", text: "x".repeat(64 * 1024) } });
		expect(comment.status).toBe(413);
	});

	it("rejects missing or wrong tokens and foreign Host headers", async () => {
		expect((await call(server.port, `/doc/${docId}`)).status).toBe(403);
		expect((await call(server.port, `/doc/${docId}?token=nope`)).status).toBe(403);
		expect((await call(server.port, `/doc/${docId}?${q}`, { host: "evil.example:80" })).status).toBe(403);
		expect((await call(server.port, `/doc/${docId}?${q}`)).status).toBe(200);
	});

	it("serves pages with a strict CSP and no referrer", async () => {
		const res = await call(server.port, `/doc/${docId}?${q}`);
		expect(res.headers["content-security-policy"]).toContain("script-src 'self'");
		expect(res.headers["content-security-policy"]).toContain("default-src 'none'");
		expect(res.headers["referrer-policy"]).toBe("no-referrer");
	});

	it("applies a saved theme cookie before the page renders", async () => {
		const page = (cookie?: string) => call(server.port, `/doc/${docId}?${q}`, { cookie }).then((r) => r.body);
		expect(await page("other=1; artifact-theme=dark")).toContain('<html lang="en" data-theme="dark">');
		expect(await page("artifact-theme=light")).toContain('<html lang="en" data-theme="light">');
		expect(await page("artifact-theme=<script>")).toContain('<html lang="en">');
		expect(await page()).toContain('<html lang="en">');
	});

	it("sends all drafts as one combined message, then one at a time", async () => {
		const decision = (await blocks()).find((b) => b.kind === "decision")!;
		for (const text of ["first", "second", "third"]) {
			await call(server.port, `/api/doc/${docId}/comments?${q}`, { method: "POST", body: { blockId: decision.id, quote: "Pick A", text } });
		}
		await call(server.port, `/api/doc/${docId}/send?${q}`, { method: "POST", body: { threadId: 2 } });
		expect(send).toHaveBeenCalledTimes(1);
		expect(send.mock.calls[0][0]).toContain("[artifact viewer · plan.md · thread #2]");
		expect(send.mock.calls[0][0]).not.toContain("thread #1");

		await call(server.port, `/api/doc/${docId}/send?${q}`, { method: "POST", body: {} });
		expect(send).toHaveBeenCalledTimes(2);
		expect(send.mock.calls[1][0]).toMatch(/thread #1\][\s\S]*first[\s\S]*thread #3\][\s\S]*third/);

		const res = await call(server.port, `/api/doc/${docId}/send?${q}`, { method: "POST", body: {} });
		expect(JSON.parse(res.body)).toEqual({ sent: 0 });
		expect(send).toHaveBeenCalledTimes(2);
	});

	it("pushes a change event when the agent replies", async () => {
		const decision = (await blocks()).find((b) => b.kind === "decision")!;
		await call(server.port, `/api/doc/${docId}/comments?${q}`, { method: "POST", body: { blockId: decision.id, quote: "Pick A", text: "q" } });
		const event = await nextEvent(server.port, `/api/events?doc=${docId}&${q}`, () => server.reply(docPath, 1, "answer"));
		expect(event.name).toBe("changed");
		const threads = JSON.parse((await call(server.port, `/api/doc/${docId}?${q}`)).body).threads;
		expect(threads[0]).toMatchObject({ id: 1, status: "draft", attachment: { status: "exact", blockId: decision.id } });
		expect(threads[0].messages.at(-1)).toMatchObject({ author: "agent", text: "answer" });
	});

	it("records the section and selection, and looks up Mermaid source for diagram labels", async () => {
		writeFileSync(docPath, "# Plan\n\n## Flow\n\n```mermaid\nsequenceDiagram\n  Browser->>Session: user message\n  Session-->>Browser: reply\n```\n\nSome *styled* text here.\n");
		const all = await blocks();
		const diagram = all.find((b) => b.kind === "mermaid")!;
		const para = all.at(-1)!;
		const post = (body: unknown) => call(server.port, `/api/doc/${docId}/comments?${q}`, { method: "POST", body });
		await post({ blockId: para.id, quote: "styled text", context: "Some styled text here.", text: "a" });
		await post({ blockId: diagram.id, quote: "user message", label: true, text: "b" });
		expect((await post({ blockId: para.id, quote: "  ", text: "c" })).status).toBe(400);
		await call(server.port, `/api/doc/${docId}/send?${q}`, { method: "POST", body: {} });
		const message = send.mock.calls[0][0];
		expect(message).toContain('Section: Flow\nSelected: "styled text"\nContext: "…Some styled text here.…"');
		expect(message).toContain('Diagram label: "user message"\nMermaid source: Browser->>Session: user message');
	});

	it("keeps which copy of repeated text was chosen until the block changes", async () => {
		const decision = (await blocks()).find((b) => b.kind === "decision")!;
		await call(server.port, `/api/doc/${docId}/comments?${q}`, { method: "POST", body: { blockId: decision.id, quote: "Pick", occurrence: 1, text: "x" } });
		const threads = async () => JSON.parse((await call(server.port, `/api/doc/${docId}?${q}`)).body).threads;
		expect((await threads())[0].occurrence).toBe(1);
		writeFileSync(docPath, readFileSync(docPath, "utf8").replace("Pick A", "Pick A first"));
		await new Promise((r) => setTimeout(r, 50));
		expect((await threads())[0].occurrence).toBeUndefined();
	});

	it("re-finds the block by its quote when the block changed before the comment was saved", async () => {
		const stale = (await blocks()).find((b) => b.kind === "decision")!;
		writeFileSync(docPath, "# Plan\n\n## Decisions\n\n> [!DECISION]\n> 1. Pick A, probably.\n");
		const post = (quote: string) =>
			call(server.port, `/api/doc/${docId}/comments?${q}`, { method: "POST", body: { blockId: stale.id, quote, text: "x" } });
		expect((await post("Pick A")).status).toBe(200);
		expect((await post("Pick Z")).status).toBe(409);
	});

	it("pushes a change event when the file is edited", async () => {
		const event = await nextEvent(server.port, `/api/events?doc=${docId}&${q}`, () =>
			writeFileSync(docPath, "# Plan\n\nEdited.\n"),
		);
		expect(event.name).toBe("changed");
	});

	it("uses the preferred port and falls back when it is taken", async () => {
		const port = await freePort();
		const first = new ArtifactServer({ root: join(dir, "ports"), cwd: dir, send, ports: [port] });
		const second = new ArtifactServer({ root: join(dir, "ports"), cwd: dir, send, ports: [port] });
		await first.start();
		await second.start();
		expect(first.port).toBe(port);
		expect(second.port).not.toBe(port);
		expect(second.port).toBeGreaterThan(0);
		await first.stop();
		await second.stop();
	});

	it("keeps one saved token so restarted servers accept open tabs", () => {
		const again = new ArtifactServer({ root: join(dir, "state"), cwd: dir, send });
		expect(again.token).toBe(server.token);
		expect(statSync(join(dir, "state", "token")).mode & 0o777).toBe(0o600);
	});

	it("asks an open tab to show a document, including a tab from another session", async () => {
		const target = server.url(docId);
		expect(await server.showInTab(target)).toBe(false);

		let delivered: boolean | undefined;
		const own = await nextEvent(server.port, `/api/events?doc=${docId}&${q}`, async () => {
			delivered = await server.showInTab(target);
		});
		expect(own).toEqual({ name: "show", data: JSON.stringify({ url: target }) });
		expect(delivered).toBe(true);

		const other = new ArtifactServer({ root: join(dir, "state"), cwd: dir, send, ports: [] });
		await other.start();
		const otherUrl = other.url(other.open(docPath).id);
		const remote = await nextEvent(server.port, `/api/events?doc=${docId}&${q}`, () => other.showInTab(otherUrl));
		expect(remote).toEqual({ name: "show", data: JSON.stringify({ url: otherUrl }) });
		await other.stop();
	});

	it("refuses to point a tab at anything but a viewer page", async () => {
		const res = await call(server.port, `/api/show?${q}`, { method: "POST", body: { url: "https://example.com/" } });
		expect(res.status).toBe(400);
	});

	it("shares one listener between concurrent starts", async () => {
		const fresh = new ArtifactServer({ root: join(dir, "race"), cwd: dir, send });
		await Promise.all([fresh.start(), fresh.start()]);
		fresh.open(docPath);
		expect(readdirSync(join(dir, "race", "servers"))).toHaveLength(1);
		await fresh.stop();
		expect(readdirSync(join(dir, "race", "servers"))).toHaveLength(0);
	});

	it("survives file-watcher errors", async () => {
		const watcher = (server as any).docs.get(docId).watcher;
		expect(() => watcher.emit("error", new Error("EIO"))).not.toThrow();
		expect((await call(server.port, `/api/doc/${docId}?${q}`)).status).toBe(200);
	});

	it("stops idempotently", async () => {
		await server.stop();
		await server.stop();
	});
});

describe("artifact extension", () => {
	it("registers artifact_comment and starts its document lazily without browser navigation or user input", async () => {
		const tools: Record<string, any> = {};
		const handlers: Record<string, any> = {};
		const pi = { registerTool: (t: any) => (tools[t.name] = t), registerCommand: vi.fn(), on: (n: string, h: any) => (handlers[n] = h), sendUserMessage: vi.fn() };
		const root = join(dir, "review-state");
		const openBrowser = vi.fn();
		createArtifactExtension({ root, openBrowser })(pi as any);
		const ctx = { cwd: dir, isIdle: () => false };
		expect(tools.artifact_comment).toBeDefined();
		expect(tools.artifact_comment.parameters.required).toEqual(["file", "quote", "text"]);
		expect(Object.keys(tools.artifact_comment.parameters.properties)).toEqual(["file", "quote", "text", "section"]);
		try {
			const result = await tools.artifact_comment.execute("1", { file: "plan.md", quote: "Pick A", text: "Explain this.", section: "Decisions" }, undefined, undefined, ctx);
			expect(result.content[0].text).toContain("thread #1");
			expect(result.content[0].text).toMatch(/http:\/\/127\.0\.0\.1:\d+\/doc\//);
			expect(result.content[0].text).toContain("No viewer tab is showing this document");
			expect(openBrowser).not.toHaveBeenCalled();
			expect(pi.sendUserMessage).not.toHaveBeenCalled();
			const entry = JSON.parse(readFileSync(join(root, "servers", readdirSync(join(root, "servers"))[0]), "utf8"));
			expect(entry.docs).toHaveLength(1);
			const id = entry.docs[0].id;
			const token = entry.token;
			const event = await nextEvent(entry.port, `/api/events?doc=${id}&token=${token}`, () =>
				tools.artifact_comment.execute("2", { file: "plan.md", quote: "Pick A", text: "A second review." }, undefined, undefined, ctx),
			);
			expect(event.name).toBe("changed");
			expect(openBrowser).not.toHaveBeenCalled();
			expect(pi.sendUserMessage).not.toHaveBeenCalled();
			const payload = JSON.parse((await call(entry.port, `/api/doc/${id}?token=${token}`)).body);
			expect(payload.threads.map((t: any) => t.status)).toEqual(["review", "review"]);
		} finally {
			await handlers.session_shutdown({}, ctx);
		}
	});

	it("queues sent comments as follow-ups while the agent is busy", async () => {
		const tools: Record<string, any> = {};
		const handlers: Record<string, any> = {};
		const pi = {
			registerTool: (t: any) => (tools[t.name] = t),
			registerCommand: vi.fn(),
			on: (name: string, h: any) => (handlers[name] = h),
			sendUserMessage: vi.fn(),
		};
		const openBrowser = vi.fn();
		createArtifactExtension({ root: join(dir, "ext-state"), openBrowser })(pi as any);
		let idle = false;
		const ctx = { cwd: dir, isIdle: () => idle };

		const result = await tools.artifact_open.execute("1", { path: "plan.md" }, undefined, undefined, ctx);
		const url = new URL(openBrowser.mock.calls[0][0]);
		expect(result.content[0].text).toContain(url.toString());
		const port = Number(url.port);
		const token = url.searchParams.get("token");
		const id = url.pathname.split("/").pop();
		const doc = JSON.parse((await call(port, `/api/doc/${id}?token=${token}`)).body);
		const blockId = doc.blocks[1].id;

		await call(port, `/api/doc/${id}/comments?token=${token}`, { method: "POST", body: { blockId, quote: "Decisions", text: "busy" } });
		await call(port, `/api/doc/${id}/send?token=${token}`, { method: "POST", body: {} });
		expect(pi.sendUserMessage).toHaveBeenLastCalledWith(expect.stringContaining("busy"), { deliverAs: "followUp" });

		idle = true;
		await call(port, `/api/doc/${id}/comments?token=${token}`, { method: "POST", body: { blockId, quote: "Decisions", text: "idle" } });
		await call(port, `/api/doc/${id}/send?token=${token}`, { method: "POST", body: {} });
		expect(pi.sendUserMessage).toHaveBeenLastCalledWith(expect.stringContaining("idle"));

		const reply = await tools.artifact_reply.execute("2", { file: "plan.md", thread: 1, text: "done", moved_to: "Pick B" }, undefined, undefined, ctx);
		expect(reply.content[0].text).toContain("thread #1");
		const after = JSON.parse((await call(port, `/api/doc/${id}?token=${token}`)).body);
		expect(after.threads[0]).toMatchObject({ quote: "Decisions", highlight: "Pick B" });
		expect(after.threads[0].path).toBeUndefined();

		await handlers.session_shutdown({}, ctx);
		await expect(call(port, `/api/doc/${id}?token=${token}`)).rejects.toThrow();
	});

	it("opens a browser tab only when no viewer tab is open", async () => {
		const tools: Record<string, any> = {};
		const handlers: Record<string, any> = {};
		const pi = { registerTool: (t: any) => (tools[t.name] = t), registerCommand: vi.fn(), on: (n: string, h: any) => (handlers[n] = h), sendUserMessage: vi.fn() };
		const openBrowser = vi.fn();
		createArtifactExtension({ root: join(dir, "tab-state"), openBrowser })(pi as any);
		const ctx = { cwd: dir, isIdle: () => true };
		writeFileSync(join(dir, "other.md"), "# Other\n");

		await tools.artifact_open.execute("1", { path: "plan.md" }, undefined, undefined, ctx);
		expect(openBrowser).toHaveBeenCalledTimes(1);
		const url = new URL(openBrowser.mock.calls[0][0]);
		const events = `/api/events?doc=${url.pathname.split("/").pop()}&token=${url.searchParams.get("token")}`;
		let result: any;
		const shown = await nextEvent(Number(url.port), events, async () => {
			result = await tools.artifact_open.execute("2", { path: "other.md" }, undefined, undefined, ctx);
		});
		expect(shown.name).toBe("show");
		expect(openBrowser).toHaveBeenCalledTimes(1);
		expect(result.content[0].text).toContain("open viewer tab");
		await handlers.session_shutdown({}, ctx);
	});
});
