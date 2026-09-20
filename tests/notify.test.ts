import { afterEach, describe, expect, it, vi } from "vitest";
import notifyExtension from "../extensions/notify";

function setupExtension() {
	const handlers = new Map<string, (event: any, ctx: any) => Promise<void>>();
	notifyExtension({
		on: vi.fn((event: string, handler: (event: any, ctx: any) => Promise<void>) => {
			handlers.set(event, handler);
		}),
	} as any);
	return handlers;
}

const assistantMessages = [
	{
		role: "assistant",
		content: [{ type: "text", text: "Finished **cleanly**." }],
	},
];

describe("desktop notifications", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it.each(["rpc", "json", "print"])("writes no terminal bytes in %s mode", async (mode) => {
		const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		const handlers = setupExtension();

		await handlers.get("agent_end")?.({ messages: assistantMessages }, { mode });
		await handlers.get("agent_settled")?.({}, { mode });

		expect(write).not.toHaveBeenCalled();
	});

	it("notifies once after the final queued run settles", async () => {
		const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		const handlers = setupExtension();
		const ctx = { mode: "tui" };

		await handlers.get("agent_end")?.(
			{ messages: [{ role: "assistant", content: "Intermediate response" }] },
			ctx,
		);
		expect(write).not.toHaveBeenCalled();

		await handlers.get("agent_end")?.({ messages: assistantMessages }, ctx);
		expect(write).not.toHaveBeenCalled();

		await handlers.get("agent_settled")?.({}, ctx);
		expect(write).toHaveBeenCalledTimes(1);
		expect(write.mock.calls[0][0]).toContain("Finished cleanly.");
	});
});
