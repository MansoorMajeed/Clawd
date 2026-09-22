import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";

function textContent(content: unknown): string {
	if (typeof content === "string") return content.trim();
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is { type: "text"; text: string } =>
			part != null && typeof part === "object" && part.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("\n")
		.trim();
}

function firstUserRequest(entries: SessionEntry[]): string | undefined {
	for (const entry of entries) {
		if (entry.type !== "message" || entry.message.role !== "user") continue;
		const text = textContent(entry.message.content);
		if (text) return text;
	}
	return undefined;
}

function suggestedName(content: unknown): string {
	if (!Array.isArray(content)) return "";
	const text = content
		.filter((part): part is { type: "text"; text: string } =>
			part != null && typeof part === "object" && part.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join(" ")
		.trim();
	const firstLine = text.split(/\r?\n/).find((line) => line.trim())?.trim() ?? "";
	return firstLine
		.replace(/^session name:\s*/i, "")
		.replace(/^["'`]+|["'`]+$/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("suggest-name", {
		description: "Suggest and set a short name for the current session",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) return;
			const request = firstUserRequest(ctx.sessionManager.getBranch());
			if (!request) {
				ctx.ui.notify("Send a request before suggesting a session name", "warning");
				return;
			}
			if (!ctx.model) {
				ctx.ui.notify("No active model available", "warning");
				return;
			}

			ctx.ui.notify("Suggesting a session name...", "info");
			try {
				const response = await ctx.modelRegistry.complete(
					ctx.model,
					{
						messages: [{
							role: "user",
							content: [{
								type: "text",
								text: [
									"Create a concise 3-6 word session name for this request.",
									"Return only the name, with no quotes, prefix, or punctuation.",
									"",
									"<request>",
									request.slice(0, 2000),
									"</request>",
								].join("\n"),
							}],
							timestamp: Date.now(),
						}],
					},
					{ maxTokens: 32, cacheRetention: "none" },
				);
				const suggestion = suggestedName(response.content);
				if (!suggestion) throw new Error("model returned an empty suggestion");

				const name = (await ctx.ui.editor(pi.getSessionName() ? "Rename session" : "Name session", suggestion))?.trim();
				if (!name) {
					ctx.ui.notify("Session naming cancelled", "info");
					return;
				}
				pi.setSessionName(name);
				ctx.ui.notify(`Session named: ${name}`, "info");
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Could not suggest a session name: ${message}`, "error");
			}
		},
	});
}
