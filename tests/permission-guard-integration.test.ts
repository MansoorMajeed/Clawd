import {
	createAgentSession,
	createReadToolDefinition,
	DefaultResourceLoader,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import permissionGuard from "../extensions/permission-guard/index.js";

type HarnessOptions = {
	trusted?: boolean;
	yolo?: boolean;
	mode?: "tui" | "rpc";
	projectGrant?: boolean;
	select?: (title: string, options: string[]) => Promise<string | undefined>;
};

async function withHarness(
	options: HarnessOptions,
	run: (harness: {
		cwd: string;
		root: string;
		runner: ReturnType<typeof createAgentSession> extends Promise<infer R>
			? R["session"]["extensionRunner"]
			: never;
		select: ReturnType<typeof vi.fn>;
		custom: ReturnType<typeof vi.fn>;
	}) => Promise<void>,
) {
	const root = await mkdtemp(join(tmpdir(), "permission-guard-integration-"));
	const cwd = join(root, "project");
	const home = join(root, "home");
	const agentDir = join(home, ".pi", "agent");
	await mkdir(cwd, { recursive: true });
	await mkdir(agentDir, { recursive: true });
	if (options.projectGrant) {
		await mkdir(join(cwd, ".pi"), { recursive: true });
		await writeFile(join(cwd, ".pi", "permissions.json"), JSON.stringify({ readWritePaths: [root] }));
	}

	const previousHome = process.env.HOME;
	process.env.HOME = home;
	const settingsManager = SettingsManager.inMemory({}, { projectTrusted: options.trusted ?? true });
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		extensionFactories: [permissionGuard],
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
	});

	let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
	try {
		await resourceLoader.reload();
		({ session } = await createAgentSession({
			cwd,
			agentDir,
			resourceLoader,
			settingsManager,
			sessionManager: SessionManager.inMemory(cwd),
			tools: [],
		}));
		if (options.yolo) session.extensionRunner.setFlagValue("yolo", true);

		const select = vi.fn(options.select ?? (async () => "Deny"));
		const custom = vi.fn(async () => undefined);
		await session.bindExtensions({
			mode: options.mode ?? "rpc",
			uiContext: {
				select,
				custom,
				notify: vi.fn(),
				input: vi.fn(async () => undefined),
			} as any,
		});

		await run({ cwd, root, runner: session.extensionRunner, select, custom });
	} finally {
		session?.dispose();
		process.env.HOME = previousHome;
		await rm(root, { recursive: true, force: true });
	}
}

function toolCall(toolName: string, input: Record<string, unknown>) {
	return { type: "tool_call", toolCallId: "test-call", toolName, input } as any;
}

describe("permission guard Pi integration", () => {
	it("guards the same outside target that native read resolves from @ and file URL paths", async () => {
		await withHarness({}, async ({ cwd, root, runner, select }) => {
			const outside = join(root, "outside.txt");
			await writeFile(outside, "outside\n");

			const nativeRead = createReadToolDefinition(cwd);
			for (const rawPath of [`@${outside}`, pathToFileURL(outside).href]) {
				const nativeResult = await nativeRead.execute("native-read", { path: rawPath }, undefined, undefined, { cwd } as any);
				expect(nativeResult.content[0]).toMatchObject({ type: "text", text: "outside\n" });

				const decision = await runner.emitToolCall(toolCall("read", { path: rawPath }));
				expect(decision).toMatchObject({ block: true });
			}
			expect(select).toHaveBeenCalledTimes(2);
		});
	});

	it("prompts instead of approving rm after a cwd-changing shell segment", async () => {
		await withHarness({}, async ({ root, runner, select }) => {
			const decision = await runner.emitToolCall(
				toolCall("bash", { command: `cd ${join(root, "outside")} && rm -rf child` }),
			);

			expect(decision).toMatchObject({ block: true });
			expect(select).toHaveBeenCalledOnce();
			expect(select.mock.calls[0]?.[0]).toContain("Recursive rm target requires confirmation");
		});
	});

	it("still allows a known in-scope recursive rm without prompting", async () => {
		await withHarness({}, async ({ runner, select }) => {
			expect(await runner.emitToolCall(toolCall("bash", { command: "rm -rf build" }))).toBeUndefined();
			expect(select).not.toHaveBeenCalled();
		});
	});

	it("hard-blocks a later .git rm target before offering an overridable prompt", async () => {
		await withHarness({ yolo: true }, async ({ cwd, root, runner, select }) => {
			const decision = await runner.emitToolCall(
				toolCall("bash", { command: `rm -rf ${join(root, "outside")} ${join(cwd, ".git")}` }),
			);

			expect(decision).toMatchObject({ block: true, reason: expect.stringContaining("Delete .git path") });
			expect(select).not.toHaveBeenCalled();
		});
	});

	it("still hard-blocks an absolute .git target after cwd becomes unknown", async () => {
		await withHarness({ yolo: true }, async ({ cwd, root, runner, select }) => {
			const decision = await runner.emitToolCall(
				toolCall("bash", {
					command: `cd ${join(root, "outside")} && rm -rf ${join(cwd, ".git")}`,
				}),
			);

			expect(decision).toMatchObject({ block: true, reason: expect.stringContaining("Delete .git path") });
			expect(select).not.toHaveBeenCalled();
		});
	});

	it("still hard-blocks an explicit relative .git target after cwd becomes unknown", async () => {
		await withHarness({ yolo: true }, async ({ root, runner, select }) => {
			const decision = await runner.emitToolCall(
				toolCall("bash", {
					command: `cd ${join(root, "outside")} && rm -rf nested/.git`,
				}),
			);

			expect(decision).toMatchObject({ block: true, reason: expect.stringContaining("Delete .git path") });
			expect(select).not.toHaveBeenCalled();
		});
	});

	it.each(["objects", "."])(
		"blocks unresolved recursive rm of %s after cd .git under yolo",
		async (target) => {
			await withHarness({ yolo: true }, async ({ cwd, runner, select }) => {
				await mkdir(join(cwd, ".git"), { recursive: true });

				const decision = await runner.emitToolCall(
					toolCall("bash", { command: `cd .git && rm -rf ${target}` }),
				);

				expect(decision).toMatchObject({
					block: true,
					reason: expect.stringContaining("cannot be resolved after a cwd-changing command"),
				});
				expect(select).not.toHaveBeenCalled();
			});
		},
	);

	it("ignores project-local grants when the project is untrusted", async () => {
		await withHarness({ trusted: false, projectGrant: true }, async ({ root, runner, select }) => {
			const outside = join(root, "outside.txt");

			const decision = await runner.emitToolCall(toolCall("write", { path: outside, content: "no" }));
			expect(decision).toMatchObject({ block: true });
			expect(select).toHaveBeenCalledOnce();
		});
	});

	it("honors project-local grants when the project is trusted", async () => {
		await withHarness({ trusted: true, projectGrant: true }, async ({ root, runner, select }) => {
			const outside = join(root, "outside.txt");

			expect(await runner.emitToolCall(toolCall("write", { path: outside, content: "yes" }))).toBeUndefined();
			expect(select).not.toHaveBeenCalled();
		});
	});

	it("reads the hydrated yolo flag at tool-call time while retaining hard blocks", async () => {
		await withHarness({ yolo: true }, async ({ root, runner, select }) => {
			expect(
				await runner.emitToolCall(toolCall("write", { path: join(root, "outside.txt"), content: "yes" })),
			).toBeUndefined();
			expect(select).not.toHaveBeenCalled();

			const hardBlock = await runner.emitToolCall(toolCall("bash", { command: "rm -rf .git" }));
			expect(hardBlock).toMatchObject({ block: true, reason: expect.stringContaining("HARD BLOCKED") });
		});
	});

	it("uses RPC-supported selection instead of custom TUI components", async () => {
		await withHarness(
			{ mode: "rpc", select: async () => "Allow once" },
			async ({ root, runner, select, custom }) => {
				const decision = await runner.emitToolCall(toolCall("read", { path: join(root, "outside.txt") }));

				expect(decision).toBeUndefined();
				expect(select).toHaveBeenCalledOnce();
				expect(custom).not.toHaveBeenCalled();
			},
		);
	});
});
