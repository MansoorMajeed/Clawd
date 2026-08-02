import { describe, expect, it, vi } from "vitest";
import journalAdvisor from "../extensions/journal-advisor";

vi.mock("../extensions/ai-knowledge/state", () => ({
	getCurrentTask: () => ({ project: "project", task: "task" }),
}));

describe("journal advisor", () => {
	it("can fire again after compaction resets context usage", async () => {
		const handlers = new Map<string, (event: any, ctx: any) => unknown>();
		journalAdvisor({
			on: (event: string, handler: (event: any, ctx: any) => unknown) =>
				handlers.set(event, handler),
		} as never);

		let tokens = 50_000;
		const ctx = { getContextUsage: () => ({ tokens }) };

		expect(await handlers.get("before_agent_start")?.({}, ctx)).toBeDefined();

		tokens = 1_000;
		await handlers.get("session_compact")?.({}, ctx);
		tokens = 51_000;

		expect(await handlers.get("before_agent_start")?.({}, ctx)).toBeDefined();
	});
});
