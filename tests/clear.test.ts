import { describe, expect, it, vi } from "vitest";
import clearExtension from "../extensions/clear";

describe("clear reminder", () => {
	it("only notifies users to use /new and preserves the current session", async () => {
		let command:
			| {
					description: string;
					handler: (args: string, ctx: any) => Promise<void> | void;
			  }
			| undefined;
		const pi = {
			registerCommand: vi.fn((name: string, options: typeof command) => {
				expect(name).toBe("clear");
				command = options;
			}),
		};
		const notify = vi.fn();
		const newSession = vi.fn();

		clearExtension(pi as any);

		expect(command?.description).toBe("Use /new to start a fresh session");
		await command?.handler("", { newSession, ui: { notify } });
		expect(notify).toHaveBeenCalledOnce();
		expect(notify).toHaveBeenCalledWith(
			"Use /new to start a fresh session. Your current session is preserved.",
			"info",
		);
		expect(newSession).not.toHaveBeenCalled();
	});
});
