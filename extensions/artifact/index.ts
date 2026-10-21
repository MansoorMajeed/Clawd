import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { ArtifactServer } from "./server";
import { defaultRoot, ThreadStore } from "./store";

interface Deps {
	root: string;
	openBrowser: (url: string) => void;
}

interface SessionContext {
	cwd: string;
	isIdle(): boolean;
}

function openInBrowser(url: string): void {
	const command = process.platform === "darwin" ? "open" : "xdg-open";
	const child = spawn(command, [url], { detached: true, stdio: "ignore" });
	child.on("error", () => {});
	child.unref();
}

function text(value: string) {
	return { content: [{ type: "text" as const, text: value }], details: {} };
}

export function createArtifactExtension(deps: Deps) {
	return function artifact(pi: ExtensionAPI) {
		let server: ArtifactServer | undefined;
		let session: SessionContext | undefined;

		function send(message: string): void {
			if (!session || session.isIdle()) pi.sendUserMessage(message);
			else pi.sendUserMessage(message, { deliverAs: "followUp" });
		}

		/** Show the document in an open viewer tab if there is one, else open a browser tab. */
		async function open(ctx: SessionContext, path: string): Promise<{ url: string; reused: boolean }> {
			session = ctx;
			const abs = resolve(ctx.cwd, path);
			if (!existsSync(abs) || !statSync(abs).isFile()) throw new Error(`Not a file: ${abs}`);
			if (!server) server = new ArtifactServer({ root: deps.root, cwd: ctx.cwd, send });
			await server.start();
			const { url } = server.open(abs);
			const reused = await server.showInTab(url);
			if (!reused) deps.openBrowser(url);
			return { url, reused };
		}

		const opened = (path: string, { url, reused }: { url: string; reused: boolean }) =>
			reused ? `Showing ${path} in the open viewer tab: ${url}` : `Opened ${path} in a new browser tab: ${url}`;

		async function close(): Promise<void> {
			const current = server;
			server = undefined;
			await current?.stop();
		}

		pi.registerTool({
			name: "artifact_open",
			label: "Open artifact",
			description:
				"Open a Markdown document (plan, explanation) in the user's browser as a rendered page where they can comment on sections. Their comments arrive later as user messages tagged [artifact viewer · <file> · thread #N].",
			parameters: Type.Object({
				path: Type.String({ description: "Markdown file path, relative to the working directory or absolute" }),
			}),
			async execute(_id, params, _signal, _onUpdate, ctx) {
				return text(opened(params.path, await open(ctx, params.path)));
			},
		});

		pi.registerTool({
			name: "artifact_reply",
			label: "Reply in artifact thread",
			description:
				"Reply to a comment thread from the artifact viewer. The reply appears under the user's comment in the browser. For comments received from the artifact viewer, put the substantive response here. Do not repeat or paraphrase it in terminal chat; use at most a brief acknowledgment. Plain text only. Edit the document itself separately when it should change.",
			parameters: Type.Object({
				file: Type.String({ description: "Document path as shown in the thread header" }),
				thread: Type.Number({ description: "Thread number from the header" }),
				text: Type.String({ description: "Reply text (plain text, no Markdown or HTML rendering)" }),
				moved_to: Type.Optional(
					Type.String({
						description:
							"If you rewrote the text this thread points at, the exact new text (as it reads on the page) so the thread stays attached to it",
					}),
				),
			}),
			async execute(_id, params, _signal, _onUpdate, ctx) {
				const abs = resolve(ctx.cwd, params.file);
				if (!server?.reply(abs, params.thread, params.text, params.moved_to)) {
					new ThreadStore(deps.root, abs).addReply(params.thread, params.text, params.moved_to);
				}
				return text(`Replied to thread #${params.thread} on ${params.file}.`);
			},
		});

		pi.registerCommand("artifact", {
			description: "Open a Markdown file in the browser viewer (/artifact <file>), list open ones (/artifact), or stop it (/artifact close)",
			handler: async (args, ctx) => {
				const arg = args.trim();
				if (arg === "close") {
					await close();
					ctx.ui.notify("Artifact viewer stopped.", "info");
					return;
				}
				if (!arg) {
					const docs = server?.documents() ?? [];
					ctx.ui.notify(docs.length ? docs.map((d) => `${d.path}\n  ${d.url}`).join("\n") : "No artifacts open.", "info");
					return;
				}
				try {
					ctx.ui.notify(opened(arg, await open(ctx, arg)), "info");
				} catch (error) {
					ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				}
			},
		});

		pi.on("session_shutdown", async () => {
			await close();
		});
	};
}

export default createArtifactExtension({ root: defaultRoot(), openBrowser: openInBrowser });
