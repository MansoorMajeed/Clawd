import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { closeSync, existsSync, fchmodSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { createServer, request, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { attach, type Anchor } from "./anchor";
import { formatSendMessage } from "./message";
import { liveEntries, removeEntry, writeEntry, type RegistryEntry } from "./registry";
import { escapeHtml, normalize, renderDocument } from "./render";
import { ThreadStore, threadStatus } from "./store";

export interface ArtifactServerOptions {
	/** Global state directory (threads, server registry). */
	root: string;
	/** Session working directory, used to show short document paths. */
	cwd: string;
	/** Deliver a user message into the session. */
	send: (text: string) => void;
	/** Ports to try before a random one. Defaults to PREFERRED_PORTS. */
	ports?: number[];
}

/** A stable address lets an open tab reconnect after the session restarts. */
export const PREFERRED_PORTS = Array.from({ length: 20 }, (_, i) => 47821 + i);

const VIEWER_URL = /^http:\/\/127\.0\.0\.1:\d+\/doc\/[0-9a-f]+\?token=[0-9a-f]+$/;

/** One token per user, saved so restarted servers accept already-open tabs. */
function savedToken(root: string): string {
	const file = join(root, "token");
	const read = () => {
		try {
			const token = readFileSync(file, "utf8").trim();
			return /^[0-9a-f]{64}$/.test(token) ? token : undefined;
		} catch {
			return undefined;
		}
	};
	const existing = read();
	if (existing) return existing;
	mkdirSync(root, { recursive: true, mode: 0o700 });
	const token = randomBytes(32).toString("hex");
	try {
		writeFileSync(file, token, { mode: 0o600, flag: "wx" });
	} catch {
		// Another session created it first (or the file is unreadable: use an unsaved token).
		return read() ?? token;
	}
	return token;
}

/** Ask another session's server to show url in one of its tabs. */
function postShow(entry: RegistryEntry, url: string): Promise<boolean> {
	return new Promise((resolve) => {
		const req = request(
			{
				host: "127.0.0.1",
				port: entry.port,
				path: "/api/show",
				method: "POST",
				headers: { host: `127.0.0.1:${entry.port}`, "x-artifact-token": entry.token, "content-type": "application/json" },
				timeout: 500,
			},
			(res) => {
				let body = "";
				res.on("data", (c) => (body += c));
				res.on("end", () => {
					try {
						resolve(res.statusCode === 200 && JSON.parse(body).shown === true);
					} catch {
						resolve(false);
					}
				});
			},
		);
		req.on("timeout", () => req.destroy());
		req.on("error", () => resolve(false));
		req.end(JSON.stringify({ url }));
	});
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
const MAX_SOURCE_BODY = 1024 * 1024;
const MAX_QUOTE = 1000;

class HttpError extends Error {
	constructor(readonly status: number, message: string) {
		super(message);
	}
}

export class ArtifactServer {
	readonly token: string;
	port = 0;
	private server?: Server;
	private starting?: Promise<void>;
	private readonly docs = new Map<string, OpenDoc>();
	/** Connected viewer tabs, oldest first. */
	private tabs: ServerResponse[] = [];

	constructor(private readonly options: ArtifactServerOptions) {
		this.token = savedToken(options.root);
	}

	get running(): boolean {
		return this.server !== undefined;
	}

	start(): Promise<void> {
		if (this.server) return Promise.resolve();
		this.starting ??= this.listen().finally(() => {
			this.starting = undefined;
		});
		return this.starting;
	}

	private async listen(): Promise<void> {
		const server = createServer((req, res) => {
			this.handle(req, res).catch((error: unknown) => {
				const status = error instanceof HttpError ? error.status : 500;
				if (!res.headersSent) this.json(res, status, { error: error instanceof Error ? error.message : String(error) });
				else res.end();
			});
		});
		for (const port of [...(this.options.ports ?? PREFERRED_PORTS), 0]) {
			try {
				await new Promise<void>((resolve, reject) => {
					server.once("error", reject);
					server.listen(port, "127.0.0.1", () => {
						server.off("error", reject);
						resolve();
					});
				});
				break;
			} catch (error) {
				if (port === 0 || (error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
			}
		}
		const address = server.address();
		this.port = typeof address === "object" && address ? address.port : 0;
		this.server = server;
		this.register();
	}

	async stop(): Promise<void> {
		await this.starting?.catch(() => {});
		const server = this.server;
		this.server = undefined;
		for (const doc of this.docs.values()) {
			doc.watcher?.close();
			if (doc.timer) clearTimeout(doc.timer);
			for (const client of doc.clients) client.end();
		}
		this.docs.clear();
		this.tabs = [];
		if (!server) return;
		removeEntry(this.options.root, process.pid, this.port);
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
				doc.watcher.on("error", () => {
					doc.watcher?.close();
					doc.watcher = undefined;
				});
			} catch {
				// The page still works; it just won't refresh on its own.
			}
			this.docs.set(id, doc);
			this.register();
		}
		return { id, url: this.url(id) };
	}

	url(id: string): string {
		return `http://127.0.0.1:${this.port}/doc/${id}?token=${this.token}`;
	}

	/** Number of viewer tabs currently connected to a document. */
	viewers(path: string): number {
		return [...this.docs.values()].find((d) => d.path === path)?.clients.size ?? 0;
	}

	documents(): Array<{ id: string; path: string; url: string }> {
		return [...this.docs.values()].map((d) => ({ id: d.id, path: d.path, url: this.url(d.id) }));
	}

	/**
	 * Ask the most recently connected viewer tab, this session's or another
	 * session's, to show url. Returns false when no tab is open anywhere.
	 */
	async showInTab(url: string): Promise<boolean> {
		if (this.showHere(url)) return true;
		const others = await liveEntries(this.options.root, { self: { pid: process.pid, port: this.port } });
		for (const entry of others) if (await postShow(entry, url)) return true;
		return false;
	}

	private showHere(url: string): boolean {
		const tab = this.tabs.at(-1);
		if (!tab) return false;
		tab.write(`event: show\ndata: ${JSON.stringify({ url })}\n\n`);
		return true;
	}

	comment(path: string, quote: string, text: string, section?: string): number {
		quote = normalize(quote);
		text = text.trim();
		if (!quote) throw new Error("Nothing selected");
		if (!text) throw new Error("Empty comment");
		const { blocks } = renderDocument(readFileSync(path, "utf8"));
		const scope = section === undefined ? undefined : normalize(section);
		const matches = blocks.filter((b) => b.plain.includes(quote) &&
			(scope === undefined || b.path === scope || b.heading === scope));
		if (matches.length === 0) throw new Error("Quote not found in the requested document section");
		const block = matches[0];
		const first = block.plain.indexOf(quote);
		if (matches.length !== 1 || block.plain.indexOf(quote, first + 1) !== -1) {
			throw new Error("Ambiguous quote: include more text or specify a unique section");
		}
		const anchor: Anchor = { section: block.heading, path: block.path, blockId: block.id, quote };
		if (block.kind === "mermaid") {
			anchor.diagramSource = (block.source ?? "").split("\n")
				.filter((line) => normalize(line).includes(quote)).slice(0, 3).map((line) => line.trim()).join(" / ");
		}
		const doc = this.doc(this.open(path).id);
		const thread = doc.store.addReview({ anchor, text });
		this.notify(doc);
		return thread.id;
	}

	/** Returns false when the document is not open in this server. */
	reply(path: string, threadId: number, text: string, movedTo?: string): boolean {
		const doc = [...this.docs.values()].find((d) => d.path === path);
		if (!doc) return false;
		doc.store.addReply(threadId, text, movedTo);
		this.notify(doc);
		return true;
	}

	private displayPath(path: string, cwd = this.options.cwd): string {
		const rel = relative(cwd, path);
		return rel.startsWith("..") ? path : rel;
	}

	private register(): void {
		if (!this.server) return;
		writeEntry(this.options.root, {
			pid: process.pid,
			port: this.port,
			token: this.token,
			cwd: this.options.cwd,
			docs: [...this.docs.values()].map((d) => ({ id: d.id, path: d.path })),
		});
	}

	/** This server's documents plus those of other live sessions (with a session label). */
	private async allDocuments() {
		const own = this.documents().map((d) => ({ id: d.id, path: this.displayPath(d.path), url: d.url }));
		const others = await liveEntries(this.options.root, { self: { pid: process.pid, port: this.port } });
		return [
			...own,
			...others.flatMap((e) =>
				e.docs.map((d) => ({
					id: d.id,
					path: this.displayPath(d.path, e.cwd),
					url: `http://127.0.0.1:${e.port}/doc/${d.id}?token=${e.token}`,
					session: `${basename(e.cwd)} (pid ${e.pid})`,
				})),
			),
		];
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
			res.end(this.shell(doc, /(?:^|;\s*)artifact-theme=(light|dark)(?:;|$)/.exec(req.headers.cookie ?? "")?.[1]));
			return;
		}
		if (method === "GET" && url.pathname === "/api/ping") {
			this.json(res, 200, { ok: true });
			return;
		}
		if (method === "GET" && url.pathname === "/api/docs") {
			this.json(res, 200, { docs: await this.allDocuments() });
			return;
		}
		if (method === "GET" && url.pathname === "/api/events") {
			const doc = this.doc(url.searchParams.get("doc") ?? "");
			res.writeHead(200, { ...SECURITY_HEADERS, "content-type": "text/event-stream", connection: "keep-alive" });
			res.write(": connected\n\n");
			doc.clients.add(res);
			this.tabs.push(res);
			req.on("close", () => {
				doc.clients.delete(res);
				this.tabs = this.tabs.filter((t) => t !== res);
			});
			return;
		}
		if (method === "POST" && url.pathname === "/api/show") {
			const target = (await readJson(req)).url;
			if (typeof target !== "string" || !VIEWER_URL.test(target)) throw new HttpError(400, "Not a viewer page");
			this.json(res, 200, { shown: this.showHere(target) });
			return;
		}
		if (parts[0] === "api" && parts[1] === "doc" && parts[2]) {
			const doc = this.doc(parts[2]);
			const action = parts.slice(3);
			if (action[0] === "source" && action.length === 1) {
				if (method === "GET") {
					this.json(res, 200, this.source(doc));
					return;
				}
				if (method === "POST") {
					const body = await readJson(req, MAX_SOURCE_BODY);
					if (typeof body.source !== "string" || typeof body.version !== "string") {
						throw new HttpError(400, "Source and version must be strings");
					}
					if (this.source(doc).version !== body.version) {
						throw new HttpError(409, "The document changed. Reload the source before saving again.");
					}
					// Resolve symlinks so replacement changes their target, not the document link.
					const target = realpathSync(doc.path);
					const mode = statSync(target).mode & 0o7777;
					const temporary = join(dirname(target), `.artifact-${randomBytes(12).toString("hex")}.tmp`);
					const fd = openSync(temporary, "wx", 0o600);
					let replaced = false;
					try {
						try {
							writeFileSync(fd, body.source, "utf8");
							// Creation applies umask; restore the original permissions after writing.
							fchmodSync(fd, mode);
						} finally {
							closeSync(fd);
						}
						if (this.source(doc).version !== body.version || realpathSync(doc.path) !== target) {
							throw new HttpError(409, "The document changed. Reload the source before saving again.");
						}
						renameSync(temporary, target);
						replaced = true;
					} finally {
						if (!replaced) unlinkSync(temporary);
					}
					this.notify(doc);
					this.json(res, 200, { version: createHash("sha256").update(body.source, "utf8").digest("hex") });
					return;
				}
			}
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
			const quote = typeof body.quote === "string" ? normalize(body.quote).slice(0, MAX_QUOTE) : "";
			if (!quote) throw new HttpError(400, "Nothing selected");
			const { blocks } = renderDocument(readFileSync(doc.path, "utf8"));
			// The block's ID changes when its text is edited while the comment is being written.
			const block = blocks.find((b) => b.id === blockId) ?? blocks.find((b) => b.plain.includes(quote));
			if (!block) throw new HttpError(409, "The text you commented on changed. Copy your comment and try again.");
			const anchor: Anchor = { section: block.heading, path: block.path, blockId: block.id, quote };
			if (body.label === true && block.kind === "mermaid") {
				anchor.diagramSource = (block.source ?? "")
					.split("\n").filter((l) => normalize(l).includes(quote))
					.slice(0, 3)
					.map((l) => l.trim())
					.join(" / ");
			} else if (typeof body.context === "string" && normalize(body.context)) {
				anchor.context = normalize(body.context).slice(0, MAX_QUOTE);
			}
			if (Number.isInteger(body.occurrence) && body.occurrence > 0 && body.occurrence < 1000) anchor.occurrence = body.occurrence;
			return { threadId: doc.store.addComment({ anchor, text }).id };
		}
		if (action[0] === "send" && action.length === 1) {
			const drafts = doc.store.takeDrafts(threadId, (d) => this.options.send(formatSendMessage(this.displayPath(doc.path), d)));
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

	private source(doc: OpenDoc): { source: string; version: string } {
		if (!existsSync(doc.path)) throw new HttpError(404, `${this.displayPath(doc.path)} no longer exists`);
		const source = readFileSync(doc.path, "utf8");
		return { source, version: createHash("sha256").update(source, "utf8").digest("hex") };
	}

	private payload(doc: OpenDoc) {
		if (!existsSync(doc.path)) throw new HttpError(404, `${this.displayPath(doc.path)} no longer exists`);
		const rendered = renderDocument(readFileSync(doc.path, "utf8"));
		return {
			path: this.displayPath(doc.path),
			title: rendered.title,
			hasMermaid: rendered.hasMermaid,
			blocks: rendered.blocks.map(({ id, kind, html }) => ({ id, kind, html })),
			threads: doc.store.threads().map((t) => {
				const attachment = attach(t.anchor, rendered.blocks);
				const unchanged = !t.anchor.movedTo && attachment.blockId === t.anchor.blockId;
				return {
				id: t.id,
				status: threadStatus(t),
				attachment,
				quote: t.anchor.quote,
				highlight: t.anchor.movedTo ?? t.anchor.quote,
				context: t.anchor.movedTo ? undefined : t.anchor.context,
				occurrence: unchanged ? t.anchor.occurrence : undefined,
				diagram: t.anchor.diagramSource !== undefined,
				messages: t.messages,
				};
			}),
		};
	}

	private shell(doc: OpenDoc, theme?: string): string {
		const q = `token=${this.token}`;
		return `<!doctype html>
<html lang="en"${theme ? ` data-theme="${theme}"` : ""}>
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

async function readJson(req: IncomingMessage, limit = MAX_BODY): Promise<Record<string, unknown>> {
	let size = 0;
	const chunks: Buffer[] = [];
	for await (const chunk of req) {
		size += (chunk as Buffer).length;
		if (size > limit) throw new HttpError(413, "Body too large");
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
