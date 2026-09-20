import { beforeEach, describe, expect, it, vi } from "vitest";

const { compatComplete } = vi.hoisted(() => ({ compatComplete: vi.fn() }));

vi.mock("@earendil-works/pi-ai", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@earendil-works/pi-ai")>();
	return { ...actual, complete: compatComplete };
});

import internetSearchExtension from "../extensions/internet-search";

function setupExtension() {
	let tool: any;
	internetSearchExtension({
		registerTool: vi.fn((definition) => {
			tool = definition;
		}),
	} as any);
	if (!tool) throw new Error("search tool was not registered");
	return tool;
}

describe("internet search extraction", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
		compatComplete.mockReset();
	});

	it("uses the configured model registry and exposes source URLs to extraction and the caller", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue({
			ok: true,
			json: async () => ({
				RelatedTopics: [
					{
						Text: "A documented fact",
						FirstURL: "https://example.invalid/source",
					},
				],
			}),
		} as Response);

		const response = {
			stopReason: "stop",
			content: [{ type: "text", text: "Extracted fact" }],
		};
		const registryComplete = vi.fn().mockResolvedValue(response);
		compatComplete.mockResolvedValue(response);
		const getApiKeyAndHeaders = vi.fn().mockResolvedValue({
			ok: true,
			apiKey: "test-key",
			baseUrl: "https://proxy.invalid/v1",
			env: { TEST_PROVIDER_ENV: "configured" },
		});
		const signal = new AbortController().signal;
		const model = { id: "configured-model", provider: "configured-provider" };
		const tool = setupExtension();

		const result = await tool.execute(
			"call-1",
			{ query: "documented fact", context: "Verify the fact" },
			signal,
			undefined,
			{
				model,
				modelRegistry: {
					complete: registryComplete,
					getApiKeyAndHeaders,
				},
			},
		);

		expect(registryComplete).toHaveBeenCalledWith(
			model,
			expect.objectContaining({
				messages: [
					expect.objectContaining({
						content: [
							expect.objectContaining({
								text: expect.stringContaining("https://example.invalid/source"),
							}),
						],
					}),
				],
			}),
			{ signal },
		);
		expect(getApiKeyAndHeaders).not.toHaveBeenCalled();
		expect(compatComplete).not.toHaveBeenCalled();
		expect(result.content[0].text).toContain("Extracted fact");
		expect(result.content[0].text).toContain("Sources:");
		expect(result.content[0].text).toContain("https://example.invalid/source");
	});
});
