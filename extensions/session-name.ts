import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";

const TOOL_NAME = "set_session_name";

function cleanName(name: string): string {
	return name
		.replace(/\s+/g, " ")
		.trim()
		.replace(/^["'`]+|["'`]+$/g, "")
		.trim();
}

// The last name this tool set, read from the session so it survives resume.
function lastToolName(entries: SessionEntry[]): string | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type !== "message") continue;
		const message = entry.message as { role: string; toolName?: string; isError?: boolean; details?: { name?: unknown } };
		if (message.role !== "toolResult" || message.toolName !== TOOL_NAME || message.isError) continue;
		if (typeof message.details?.name === "string") return message.details.name;
	}
	return undefined;
}

function failure(text: string) {
	return { content: [{ type: "text" as const, text }], details: {}, isError: true };
}

export default function (pi: ExtensionAPI) {
	let registered = false;
	let allowOverride = false;

	pi.on("session_start", async (_event, ctx) => {
		if (registered || ctx.mode !== "tui") return;
		registered = true;
		pi.registerTool({
			name: TOOL_NAME,
			label: "Set session name",
			description: "Set a short display name for the current session.",
			promptSnippet: "Set a short display name for the current session",
			promptGuidelines: [
				"Call set_session_name with a concise 3-6 word name once the user's task is clear. Do not call set_session_name for greetings or vague openers; wait until there is a real task.",
				"Call set_session_name again only when the session's focus has clearly changed. Do not mention session naming in replies unless the user asks.",
			],
			parameters: Type.Object({
				name: Type.String({ description: "Concise 3-6 word session name, no quotes or trailing punctuation" }),
			}),
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const name = cleanName(params.name);
				if (!name) return failure("Session name is empty.");

				const current = pi.getSessionName();
				const override = allowOverride;
				allowOverride = false;
				if (current && !override && current !== lastToolName(ctx.sessionManager.getBranch())) {
					return failure(`The user named this session "${current}". Do not rename it.`);
				}

				pi.setSessionName(name);
				return { content: [{ type: "text" as const, text: `Session named: ${name}` }], details: { name } };
			},
			renderCall(args, theme) {
				return new Text(theme.fg("toolTitle", theme.bold("session name ")) + theme.fg("accent", args.name ?? ""), 0, 0);
			},
			renderResult(result, _options, theme) {
				if (!result.isError) return new Container();
				const text = result.content[0]?.type === "text" ? result.content[0].text : "Failed";
				return new Text(theme.fg("error", text), 0, 0);
			},
		});
	});

	pi.registerCommand("suggest-name", {
		description: "Ask the agent to name the session from the conversation so far",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/suggest-name only works in interactive sessions", "warning");
				return;
			}
			allowOverride = true;
			pi.sendMessage(
				{
					customType: "suggest-name",
					content: `The user ran /suggest-name. Call ${TOOL_NAME} now with a concise 3-6 word name for this session based on the conversation so far, replacing any current name. Do nothing else.`,
					display: true,
				},
				{ triggerTurn: true, deliverAs: "followUp" },
			);
		},
	});
}
