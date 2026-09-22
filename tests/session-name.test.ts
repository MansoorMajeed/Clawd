import { beforeEach, describe, expect, it, vi } from "vitest";
import registerSessionName from "../extensions/session-name";

function userMessage(content: string | Array<{ type: string; text?: string }>) {
	return { type: "message", message: { role: "user", content, timestamp: Date.now() } };
}

function setup(options: {
	currentName?: string;
	entries?: any[];
	editedName?: string;
	model?: any;
	response?: string;
} = {}) {
	let command: any;
	const setSessionName = vi.fn();
	const notify = vi.fn();
	const editor = vi.fn().mockResolvedValue(options.editedName ?? "Improve session naming");
	const complete = vi.fn().mockResolvedValue({
		content: [{ type: "text", text: options.response ?? "Improve Session Naming" }],
	});
	const model = options.model === undefined
		? { id: "test-model", provider: "test", api: "openai-responses", reasoning: true }
		: options.model;
	const ctx = {
		hasUI: true,
		model,
		modelRegistry: { complete },
		sessionManager: {
			getBranch: () => options.entries ?? [userMessage("Make session names easier to see and organize")],
		},
		ui: { editor, notify },
	};
	registerSessionName({
		registerCommand: (name: string, definition: any) => {
			if (name === "suggest-name") command = definition;
		},
		getSessionName: () => options.currentName,
		setSessionName,
	} as any);
	return { command, complete, ctx, editor, notify, setSessionName };
}

describe("suggest-name command", () => {
	beforeEach(() => vi.clearAllMocks());

	it("generates from the first user request and sets the edited suggestion", async () => {
		const h = setup({
			currentName: "Old name",
			entries: [
				userMessage([{ type: "image" }, { type: "text", text: "  Organize my Pi sessions  " }]),
				userMessage("Ignore this later request"),
			],
			editedName: "Organize\nPi sessions",
			response: "\"Pi Session Organization\"\n",
		});

		await h.command.handler("", h.ctx);

		expect(h.complete).toHaveBeenCalledWith(
			h.ctx.model,
			expect.objectContaining({ messages: [expect.objectContaining({ role: "user" })] }),
			expect.objectContaining({ maxTokens: 32, cacheRetention: "none" }),
		);
		expect(h.complete.mock.calls[0][1].messages[0].content[0].text).toContain("Organize my Pi sessions");
		expect(h.editor).toHaveBeenCalledWith("Rename session", "Pi Session Organization");
		expect(h.setSessionName).toHaveBeenCalledWith("Organize Pi sessions");
		expect(h.notify).toHaveBeenCalledWith("Session named: Organize Pi sessions", "info");
	});

	it("leaves the session unchanged when editing is cancelled", async () => {
		const h = setup();
		h.editor.mockResolvedValue(undefined);

		await h.command.handler("", h.ctx);

		expect(h.setSessionName).not.toHaveBeenCalled();
		expect(h.notify).toHaveBeenCalledWith("Session naming cancelled", "info");
	});

	it("reports missing input, missing models, and model failures without changing the name", async () => {
		const noInput = setup({ entries: [] });
		await noInput.command.handler("", noInput.ctx);
		expect(noInput.notify).toHaveBeenCalledWith("Send a request before suggesting a session name", "warning");
		expect(noInput.complete).not.toHaveBeenCalled();

		const noModel = setup({ model: null });
		await noModel.command.handler("", noModel.ctx);
		expect(noModel.notify).toHaveBeenCalledWith("No active model available", "warning");

		for (const stopReason of ["error", "aborted"] as const) {
			const resolvedFailure = setup();
			resolvedFailure.complete.mockResolvedValue({
				stopReason,
				errorMessage: "provider unavailable",
				content: [{ type: "text", text: "Partial Bad Name" }],
			});
			await resolvedFailure.command.handler("", resolvedFailure.ctx);
			expect(resolvedFailure.notify).toHaveBeenCalledWith("Could not suggest a session name: provider unavailable", "error");
			expect(resolvedFailure.editor).not.toHaveBeenCalled();
			expect(resolvedFailure.setSessionName).not.toHaveBeenCalled();
		}

		const rejected = setup();
		rejected.complete.mockRejectedValue(new Error("request setup failed"));
		await rejected.command.handler("", rejected.ctx);
		expect(rejected.notify).toHaveBeenCalledWith("Could not suggest a session name: request setup failed", "error");
		expect(rejected.setSessionName).not.toHaveBeenCalled();
	});
});
