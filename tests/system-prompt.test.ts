import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import systemPromptExtension from "../extensions/system-prompt";

describe("system prompt extension", () => {
	it("prepends the tracked prompt without intercepting user input", async () => {
		const handlers = new Map<string, (event: any) => any>();
		const pi = {
			on(eventName: string, handler: (event: any) => any) {
				handlers.set(eventName, handler);
			},
		};

		systemPromptExtension(pi as any);

		expect([...handlers.keys()]).toEqual(["before_agent_start"]);
		const result = await handlers.get("before_agent_start")?.({ systemPrompt: "PI BASE" });
		const prompt = readFileSync(new URL("../system-prompt.md", import.meta.url), "utf8").trim();
		expect(result).toEqual({ systemPrompt: `${prompt}\n\nPI BASE` });
	});
});
