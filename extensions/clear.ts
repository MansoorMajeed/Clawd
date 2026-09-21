import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.registerCommand("clear", {
		description: "Use /new to start a fresh session",
		handler: async (_args, ctx) => {
			ctx.ui.notify("Use /new to start a fresh session. Your current session is preserved.", "info");
		},
	});
}
