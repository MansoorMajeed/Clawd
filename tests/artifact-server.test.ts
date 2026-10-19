import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createArtifactExtension } from "../extensions/artifact/index";
import { ArtifactServer } from "../extensions/artifact/server";

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

/** Resolves with the first SSE event name received after `trigger` runs. */
function nextEvent(port: number, path: string, trigger: () => unknown): Promise<string> {
	return new Promise((resolve, reject) => {
		const req = request({ host: "127.0.0.1", port, path, headers: { host: `127.0.0.1:${port}` } }, (res) => {
			let buf = "";
			res.on("data", (chunk) => {
				buf += chunk;
				if (buf.includes(": connected")) {
					buf = "";
					trigger();
					return;
				}
				const match = /event: (\w+)/.exec(buf);
				if (match) {
					req.destroy();
					resolve(match[1]);
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
	await server.stop();
	rmSync(dir, { recursive: true, force: true });
});

async function blocks() {
	const res = await call(server.port, `/api/doc/${docId}?${q}`);
	return JSON.parse(res.body).blocks as Array<{ id: string; kind: string }>;
}

describe("ArtifactServer", () => {
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
		expect(event).toBe("changed");
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
		expect(event).toBe("changed");
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
});
