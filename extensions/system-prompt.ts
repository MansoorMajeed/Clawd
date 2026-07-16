import { readFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const SYSTEM_PROMPT = readFileSync(new URL("../system-prompt.md", import.meta.url), "utf8").trim();

export default function (pi: ExtensionAPI) {
	pi.on("before_agent_start", (event) => ({
		systemPrompt: `${SYSTEM_PROMPT}\n\n${event.systemPrompt}`,
	}));
}
