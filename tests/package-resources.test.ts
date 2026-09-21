import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { InMemoryCredentialStore, type Model } from "@earendil-works/pi-ai";
import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const activeExtensions = [
	"extensions/btw.ts",
	"extensions/chatgpt-limit-status.ts",
	"extensions/clear.ts",
	"extensions/context/index.ts",
	"extensions/footer.ts",
	"extensions/git-status.ts",
	"extensions/internet-search.ts",
	"extensions/notify.ts",
	"extensions/permission-guard/index.ts",
	"extensions/read-before-edit.ts",
	"extensions/review.ts",
	"extensions/session-breakdown.ts",
	"extensions/session-meter.ts",
	"extensions/split-fork.ts",
	"extensions/system-prompt.ts",
	"extensions/token-tps.ts",
];

const activeSkills = [
	"skills/address-review/SKILL.md",
	"skills/commit/SKILL.md",
	"skills/debug/SKILL.md",
	"skills/frontend-design/SKILL.md",
	"skills/implement-plan/SKILL.md",
	"skills/improve-skill/SKILL.md",
	"skills/irreversible-action-checklist/SKILL.md",
	"skills/librarian/SKILL.md",
	"skills/mermaid/SKILL.md",
	"skills/plan/SKILL.md",
	"skills/plan-init/SKILL.md",
	"skills/research/SKILL.md",
	"skills/review/SKILL.md",
	"skills/save-session/SKILL.md",
	"skills/ship/SKILL.md",
	"skills/summarize/SKILL.md",
	"skills/tmux/SKILL.md",
	"skills/update-docs/SKILL.md",
	"skills/web-browser/SKILL.md",
];

const archivedExtensions = [
	"experimental/extensions/ai-knowledge/index.ts",
	"experimental/extensions/answer.ts",
	"experimental/extensions/continue.ts",
	"experimental/extensions/control.ts",
	"experimental/extensions/handoff.ts",
	"experimental/extensions/journal-advisor.ts",
	"experimental/extensions/loop.ts",
	"experimental/extensions/prompt-editor.ts",
	"experimental/extensions/todos-status.ts",
	"experimental/extensions/todos.ts",
];

const offlineModel: Model<"openai-completions"> = {
	id: "offline-fixture",
	name: "Offline fixture",
	api: "openai-completions",
	provider: "offline-fixture",
	baseUrl: "http://127.0.0.1:1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 4096,
	maxTokens: 1024,
};

function packagePath(path: string): string {
	return relative(packageRoot, path).replaceAll("\\", "/");
}

describe("active package resources", () => {
	let tempRoot: string;
	let loader: DefaultResourceLoader;

	beforeAll(async () => {
		tempRoot = await mkdtemp(join(tmpdir(), "clawd-package-resources-"));
		await mkdir(join(tempRoot, "project"));
		const settingsManager = SettingsManager.inMemory({}, { projectTrusted: true });
		loader = new DefaultResourceLoader({
			cwd: join(tempRoot, "project"),
			agentDir: join(tempRoot, "agent"),
			settingsManager,
			additionalExtensionPaths: [packageRoot],
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
		});
		await loader.reload();
	}, 30_000);

	afterAll(async () => {
		await rm(tempRoot, { recursive: true, force: true });
	});

	it("loads only the active manifest resources", async () => {
		const extensions = loader
			.getExtensions()
			.extensions.map((extension) => packagePath(extension.resolvedPath));
		const skills = loader.getSkills().skills.map((skill) => packagePath(skill.filePath));

		await Promise.all(archivedExtensions.map((path) => access(join(packageRoot, path))));

		expect(extensions).toEqual(activeExtensions);
		expect(skills).toEqual(activeSkills);
		expect(archivedExtensions).toHaveLength(10);
		expect(extensions.filter((path) => archivedExtensions.includes(path))).toEqual([]);
		expect(loader.getExtensions().errors).toEqual([]);
		expect(loader.getSkills().diagnostics).toEqual([]);
	});

	it("keeps edit as Pi's native tool and binds every active extension without errors", async () => {
		const runtimeErrors: unknown[] = [];
		const settingsManager = SettingsManager.inMemory({}, { projectTrusted: true });
		const modelRuntime = await ModelRuntime.create({
			credentials: new InMemoryCredentialStore(),
			modelsPath: null,
			allowModelNetwork: false,
			refreshOnCreate: false,
		});
		const { session } = await createAgentSession({
			cwd: join(tempRoot, "project"),
			agentDir: join(tempRoot, "agent"),
			model: offlineModel,
			modelRuntime,
			resourceLoader: loader,
			sessionManager: SessionManager.inMemory(join(tempRoot, "project")),
			settingsManager,
		});

		try {
			await session.bindExtensions({
				mode: "print",
				onError: (error) => runtimeErrors.push(error),
			});
			const edit = session.getAllTools().find((tool) => tool.name === "edit");
			expect(edit?.sourceInfo).toMatchObject({
				path: "<builtin:edit>",
				source: "builtin",
			});
			expect(runtimeErrors).toEqual([]);
		} finally {
			session.dispose();
		}
	}, 30_000);
});
