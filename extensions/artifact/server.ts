import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, watch, type FSWatcher } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { attach } from "./anchor";
import { formatSendMessage } from "./message";
import { escapeHtml, renderDocument } from "./render";
import { ThreadStore, threadStatus } from "./store";

export interface ArtifactServerOptions {
	/** Global state directory (threads, server registry). */
	root: string;
	/** Session working directory, used to show short document paths. */
	cwd: string;
	/** Deliver a user message into the session. */
	send: (text: string) => void;
}

interface OpenDoc {
	id: string;
	path: string;
	store: ThreadStore;
	watcher?: FSWatcher;
	timer?: ReturnType<typeof setTimeout>;
	clients: Set<ServerResponse>;
}

const ASSETS_DIR = fileURLToPath(new URL("./assets/", import.meta.url));
const ASSETS: Record<string, { file: () => string; type: string }> = {
	"style.css": { file: () => join(ASSETS_DIR, "style.css"), type: "text/css; charset=utf-8" },
	"app.js": { file: () => join(ASSETS_DIR, "app.js"), type: "text/javascript; charset=utf-8" },
	"mermaid.js": {
		file: () => createRequire(import.meta.url).resolve("mermaid/dist/mermaid.min.js"),
		type: "text/javascript; charset=utf-8",
	},
};

const SECURITY_HEADERS = {
	"content-security-policy":
		"default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' https: data:; font-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
	"referrer-policy": "no-referrer",
	"x-content-type-options": "nosniff",
	"cache-control": "no-store",
};

const MAX_BODY = 64 * 1024;

class HttpError extends Error {
	constructor(readonly status: number, message: string) {
		super(message);
	}
}

export class ArtifactServer {
	readonly token = randomBytes(32).toString("hex");
	port = 0;
	private server?: Server;
	private readonly docs = new Map<string, OpenDoc>();

	constructor(private readonly options: ArtifactServerOptions) {}

	get running(): boolean {
		return this.server !== undefined;
	}

	async start(): Promise<void> {
		if (this.server) return;
		const server = createServer((req, res) => {
			this.handle(req, res).catch((error: unknown) => {
				const status = error instanceof HttpError ? error.status : 500;
				if (!res.headersSent) this.json(res, status, { error: error instanceof Error ? error.message : String(error) });
				else res.end();
			});
		});
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", () => resolve());
		});
		const address = server.address();
		this.port = typeof address === "object" && address ? address.port : 0;
		this.server = server;
	}

	async stop(): Promise<void> {
		const server = this.server;
		this.server = undefined;
		for (const doc of this.docs.values()) {
			doc.watcher?.close();
			if (doc.timer) clearTimeout(doc.timer);
			for (const client of doc.clients) client.end();
		}
		this.docs.clear();
		if (!server) return;
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}

	/** Register a document (absolute path) and return its page URL. */
	open(path: string): { id: string; url: string } {
		const id = createHash("sha1").update(path).digest("hex").slice(0, 12);
		if (!this.docs.has(id)) {
			const doc: OpenDoc = { id, path, store: new ThreadStore(this.options.root, path), clients: new Set() };
			const name = basename(path);
			try {
				// Watch the directory: editors that save by rename replace the file's inode.
				doc.watcher = watch(dirname(path), (_event, file) => {
					if (file && file.toString() !== name) return;
					if (doc.timer) clearTimeout(doc.timer);
					doc.timer = setTimeout(() => this.notify(doc), 150);
				});
			} catch {
				// The page still works; it just won't refresh on its own.
			}
			this.docs.set(id, doc);
		}
		return { id, url: this.url(id) };
	}

	url(id: string): string {
		return `http://127.0.0.1:${this.port}/doc/${id}?token=${this.token}`;
	}

	documents(): Array<{ id: string; path: string; url: string }> {
		return [...this.docs.values()].map((d) => ({ id: d.id, path: d.path, url: this.url(d.id) }));
	}

	/** Returns false when the document is not open in this server. */
	reply(path: string, threadId: number, text: string): boolean {
		const doc = [...this.docs.values()].find((d) => d.path === path);
		if (!doc) return false;
		doc.store.addReply(threadId, text);
		this.notify(doc);
		return true;
	}

	private displayPath(path: string): string {
		const rel = relative(this.options.cwd, path);
		return rel.startsWith("..") ? path : rel;
	}

	private notify(doc: OpenDoc): void {
		for (const client of doc.clients) client.write("event: changed\ndata: {}\n\n");
	}

	private authorized(req: IncomingMessage, url: URL): boolean {
		const host = req.headers.host;
		if (host !== `127.0.0.1:${this.port}` && host !== `localhost:${this.port}`) return false;
		const given = url.searchParams.get("token") ?? req.headers["x-artifact-token"];
		if (typeof given !== "string" || given.length !== this.token.length) return false;
		return timingSafeEqual(Buffer.from(given), Buffer.from(this.token));
	}

	private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const url = new URL(req.url ?? "/", "http://127.0.0.1");
		if (!this.authorized(req, url)) throw new HttpError(403, "Forbidden");
		const parts = url.pathname.split("/").filter(Boolean);
		const method = req.method ?? "GET";

		if (method === "GET" && parts.length === 0) {
			const first = this.docs.keys().next().value;
			if (!first) throw new HttpError(404, "No documents open");
			res.writeHead(302, { ...SECURITY_HEADERS, location: this.url(first) });
			res.end();
			return;
		}
		if (method === "GET" && parts[0] === "assets" && parts.length === 2 && ASSETS[parts[1]]) {
			const asset = ASSETS[parts[1]];
			res.writeHead(200, { ...SECURITY_HEADERS, "content-type": asset.type });
			res.end(readFileSync(asset.file()));
			return;
		}
		if (method === "GET" && parts[0] === "doc" && parts.length === 2) {
			const doc = this.doc(parts[1]);
			res.writeHead(200, { ...SECURITY_HEADERS, "content-type": "text/html; charset=utf-8" });
			res.end(this.shell(doc));
			return;
		}
		if (method === "GET" && url.pathname === "/api/docs") {
			this.json(res, 200, { docs: this.documents().map((d) => ({ ...d, path: this.displayPath(d.path) })) });
			return;
		}
		if (method === "GET" && url.pathname === "/api/events") {
			const doc = this.doc(url.searchParams.get("doc") ?? "");
			res.writeHead(200, { ...SECURITY_HEADERS, "content-type": "text/event-stream", connection: "keep-alive" });
			res.write(": connected\n\n");
			doc.clients.add(res);
			req.on("close", () => doc.clients.delete(res));
			return;
		}
		if (parts[0] === "api" && parts[1] === "doc" && parts[2]) {
			const doc = this.doc(parts[2]);
			const action = parts.slice(3);
			if (method === "GET" && action.length === 0) {
				this.json(res, 200, this.payload(doc));
				return;
			}
			if (method === "POST") {
				const body = await readJson(req);
				const result = this.mutate(doc, action, body);
				this.notify(doc);
				this.json(res, 200, result);
				return;
			}
		}
		throw new HttpError(404, "Not found");
	}

	private mutate(doc: OpenDoc, action: string[], body: Record<string, unknown>): Record<string, unknown> {
		const text = typeof body.text === "string" ? body.text.trim() : "";
		const threadId = typeof body.threadId === "number" ? body.threadId : undefined;
		if (action[0] === "comments" && action.length === 1) {
			if (!text) throw new HttpError(400, "Empty comment");
			if (threadId !== undefined) {
				return { threadId: doc.store.addComment({ threadId, text }).id };
			}
			const blockId = typeof body.blockId === "string" ? body.blockId : "";
			const block = renderDocument(readFileSync(doc.path, "utf8")).blocks.find((b) => b.id === blockId);
			if (!block) throw new HttpError(409, "That section changed; reload and try again");
			return { threadId: doc.store.addComment({ anchor: { heading: block.heading, text: block.text }, text }).id };
		}
		if (action[0] === "send" && action.length === 1) {
			const drafts = doc.store.takeDrafts(threadId);
			if (drafts.length > 0) this.options.send(formatSendMessage(this.displayPath(doc.path), drafts));
			return { sent: drafts.length };
		}
		if (action[0] === "threads" && action.length === 3) {
			const id = Number(action[1]);
			if (action[2] === "discard") {
				doc.store.discardDrafts(id);
				return { ok: true };
			}
			if (action[2] === "resolve") {
				doc.store.setResolved(id, body.resolved !== false);
				return { ok: true };
			}
		}
		throw new HttpError(404, "Not found");
	}

	private doc(id: string): OpenDoc {
		const doc = this.docs.get(id);
		if (!doc) throw new HttpError(404, "Unknown document");
		return doc;
	}

	private payload(doc: OpenDoc) {
		if (!existsSync(doc.path)) throw new HttpError(404, `${this.displayPath(doc.path)} no longer exists`);
		const rendered = renderDocument(readFileSync(doc.path, "utf8"));
		return {
			path: this.displayPath(doc.path),
			title: rendered.title,
			hasMermaid: rendered.hasMermaid,
			blocks: rendered.blocks.map(({ id, kind, html }) => ({ id, kind, html })),
			threads: doc.store.threads().map((t) => ({
				id: t.id,
				status: threadStatus(t),
				attachment: attach(t.anchor, rendered.blocks),
				quote: t.anchor.text,
				messages: t.messages,
			})),
		};
	}

	private shell(doc: OpenDoc): string {
		const q = `token=${this.token}`;
		return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(basename(doc.path))}</title>
<link rel="icon" href="data:,">
<link rel="stylesheet" href="/assets/style.css?${q}">
</head>
<body data-doc="${doc.id}">
<div id="app"></div>
<script src="/assets/app.js?${q}"></script>
</body>
</html>`;
	}

	private json(res: ServerResponse, status: number, body: unknown): void {
		res.writeHead(status, { ...SECURITY_HEADERS, "content-type": "application/json; charset=utf-8" });
		res.end(JSON.stringify(body));
	}
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
	let size = 0;
	const chunks: Buffer[] = [];
	for await (const chunk of req) {
		size += (chunk as Buffer).length;
		if (size > MAX_BODY) throw new HttpError(413, "Body too large");
		chunks.push(chunk as Buffer);
	}
	if (chunks.length === 0) return {};
	try {
		const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
		return parsed && typeof parsed === "object" ? parsed : {};
	} catch {
		throw new HttpError(400, "Invalid JSON");
	}
}
