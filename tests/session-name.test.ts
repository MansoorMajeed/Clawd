import { beforeEach, describe, expect, it, vi } from "vitest";
import registerSessionName from "../extensions/session-name";

function namedResult(name: string) {
	return {
		type: "message",
		message: { role: "toolResult", toolName: "set_session_name", details: { name }, isError: false, timestamp: Date.now() },
	};
}

function setup(options: { currentName?: string; entries?: any[] } = {}) {
	let command: any;
	let sessionStart: any;
	const tools: any[] = [];
	let currentName = options.currentName;
	const setSessionName = vi.fn((name: string) => { currentName = name; });
	const sendMessage = vi.fn();
	const notify = vi.fn();
	const ctx = (mode = "tui") => ({
		mode,
		hasUI: mode !== "print",
		sessionManager: { getBranch: () => options.entries ?? [] },
		ui: { notify },
	});
	registerSessionName({
		registerCommand: (name: string, definition: any) => {
			if (name === "suggest-name") command = definition;
		},
		registerTool: (definition: any) => tools.push(definition),
		on: (event: string, handler: any) => {
			if (event === "session_start") sessionStart = handler;
		},
		getSessionName: () => currentName,
		setSessionName,
		sendMessage,
	} as any);
	const run = (params: any, mode = "tui") => tools[0].execute("call-1", params, undefined, undefined, ctx(mode));
	return { command, sessionStart, tools, ctx, run, setSessionName, sendMessage, notify };
}

describe("set_session_name tool", () => {
	beforeEach(() => vi.clearAllMocks());

	it("registers only for interactive TUI sessions, once", async () => {
		const h = setup();
		await h.sessionStart({}, h.ctx("print"));
		await h.sessionStart({}, h.ctx("rpc"));
		expect(h.tools).toHaveLength(0);

		await h.sessionStart({}, h.ctx("tui"));
		await h.sessionStart({}, h.ctx("tui"));
		expect(h.tools).toHaveLength(1);
		expect(h.tools[0].name).toBe("set_session_name");
		expect(h.tools[0].promptGuidelines.join(" ")).toContain("set_session_name");
	});

	it("names an unnamed session and cleans up the name", async () => {
		const h = setup();
		await h.sessionStart({}, h.ctx());

		const result = await h.run({ name: "  \"Auto Session\nNaming\"  " });

		expect(h.setSessionName).toHaveBeenCalledWith("Auto Session Naming");
		expect(result.isError).toBeFalsy();
		expect(result.details).toEqual({ name: "Auto Session Naming" });
	});

	it("renames a session it named earlier, even after a resume", async () => {
		const h = setup({ currentName: "Old Auto Name", entries: [namedResult("Old Auto Name")] });
		await h.sessionStart({}, h.ctx());

		await h.run({ name: "New Focus" });

		expect(h.setSessionName).toHaveBeenCalledWith("New Focus");
	});

	it("refuses to overwrite a name the user set", async () => {
		const h = setup({ currentName: "My Name", entries: [namedResult("Something Else")] });
		await h.sessionStart({}, h.ctx());

		const result = await h.run({ name: "Agent Name" });

		expect(h.setSessionName).not.toHaveBeenCalled();
		expect(result.isError).toBe(true);
	});

	it("rejects an empty name", async () => {
		const h = setup();
		await h.sessionStart({}, h.ctx());

		const result = await h.run({ name: " \"\" " });

		expect(h.setSessionName).not.toHaveBeenCalled();
		expect(result.isError).toBe(true);
	});
});

describe("suggest-name command", () => {
	beforeEach(() => vi.clearAllMocks());

	it("asks the main agent to name the session and allows one override of a user name", async () => {
		const h = setup({ currentName: "My Name" });
		await h.sessionStart({}, h.ctx());

		await h.command.handler("", h.ctx());

		expect(h.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({ customType: "suggest-name", content: expect.stringContaining("set_session_name") }),
			{ triggerTurn: true, deliverAs: "followUp" },
		);

		await h.run({ name: "Agent Name" });
		expect(h.setSessionName).toHaveBeenCalledWith("Agent Name");
	});

	it("consumes the override after one call", async () => {
		const h = setup({ currentName: "My Name" });
		await h.sessionStart({}, h.ctx());
		await h.command.handler("", h.ctx());

		await h.run({ name: "Agent Name" });
		h.setSessionName.mockClear();
		// The user renames again manually; the earlier override must not carry over.
		h.setSessionName("User Again");
		h.setSessionName.mockClear();
		const result = await h.run({ name: "Another Agent Name" });

		expect(h.setSessionName).not.toHaveBeenCalled();
		expect(result.isError).toBe(true);
	});

	it("does nothing outside interactive TUI sessions", async () => {
		const h = setup();
		await h.command.handler("", h.ctx("rpc"));

		expect(h.sendMessage).not.toHaveBeenCalled();
		expect(h.notify).toHaveBeenCalledWith(expect.stringContaining("interactive"), "warning");
	});
});
