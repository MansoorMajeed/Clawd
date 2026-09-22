import { homedir } from "node:os";
import { basename, sep } from "node:path";
import type { Usage } from "@earendil-works/pi-ai";
import { SettingsManager, type ExtensionAPI, type ExtensionContext, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

function formatTokens(tokens: number): string {
	if (tokens < 1000) return String(Math.round(tokens));
	if (tokens < 1_000_000) return `${Number((tokens / 1000).toFixed(1))}k`;
	return `${Number((tokens / 1_000_000).toFixed(2))}M`;
}

function sessionCost(entries: SessionEntry[]): number {
	let cost = 0;
	for (const entry of entries) {
		let source: { usage?: Usage } | undefined;
		if (entry.type === "message" && (entry.message.role === "assistant" || entry.message.role === "toolResult")) {
			source = entry.message as { usage?: Usage };
		} else if (entry.type === "compaction" || entry.type === "branch_summary") {
			source = entry as SessionEntry & { usage?: Usage };
		}
		cost += source?.usage?.cost.total ?? 0;
	}
	return cost;
}

function singleLine(text: string): string {
	return text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
}

function packRows(parts: string[], width: number, separator: string): string[] {
	const lines: string[] = [];
	let line = "";
	for (const part of parts) {
		if (!part) continue;
		const joined = line ? line + separator + part : part;
		if (visibleWidth(joined) <= width) {
			line = joined;
			continue;
		}
		if (line) lines.push(line);
		const wrapped = wrapTextWithAnsi(part, width);
		lines.push(...wrapped.slice(0, -1).map((text) => truncateToWidth(text, width)));
		line = truncateToWidth(wrapped.at(-1) ?? "", width);
	}
	if (line) lines.push(line);
	return lines;
}

export default function (pi: ExtensionAPI) {
	let settings: ReturnType<SettingsManager["getCompactionSettings"]>;
	let requestRender: (() => void) | undefined;

	function refreshSettings(ctx: ExtensionContext): void {
		settings = SettingsManager.create(ctx.cwd, undefined, {
			projectTrusted: ctx.isProjectTrusted(),
		}).getCompactionSettings();
	}

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		refreshSettings(ctx);
		ctx.ui.setFooter((tui, _theme, footerData) => {
			requestRender = () => tui.requestRender();
			const unsubscribe = footerData.onBranchChange(requestRender);
			return {
				invalidate() {},
				dispose() { unsubscribe(); requestRender = undefined; },
				render(width: number): string[] {
					if (width <= 0) return [];
					refreshSettings(ctx);
					const theme = ctx.ui.theme;
					const separator = theme.fg("dim", " · ");
					const home = homedir();
					let path = ctx.cwd === home ? "~" : ctx.cwd.startsWith(home + sep) ? "~" + ctx.cwd.slice(home.length) : ctx.cwd;
					const branch = footerData.getGitBranch();
					const name = ctx.sessionManager.getSessionName();
					const locationSuffix = branch ? ` (${branch})` : "";
					const sessionLabel = name ? ` · ${name}` : " · unnamed — /name <name> or /suggest-name";
					if (visibleWidth(path + locationSuffix + sessionLabel) > width) path = basename(ctx.cwd);
					const location = theme.fg("muted", singleLine(path + locationSuffix));
					const session = name
						? theme.fg("dim", " · ") + theme.fg("accent", theme.bold(singleLine(name)))
						: theme.fg("dim", " · ") + theme.fg("warning", "unnamed") + theme.fg("dim", " — /name <name> or /suggest-name");
					const lines = [truncateToWidth(location + session, width)];

					const usage = ctx.getContextUsage();
					const window = usage?.contextWindow ?? ctx.model?.contextWindow;
					const tokens = usage?.tokens;
					const known = tokens != null && window != null && window > 0;
					let context = `Context ${tokens == null ? "?" : formatTokens(tokens)} / ${window ? formatTokens(window) : "?"}`;
					if (known) context += ` (${Math.round(tokens / window * 100)}%)`;
					if (!settings.enabled) context += " · auto off";
					const threshold = window == null ? 0 : settings.enabled ? window - settings.reserveTokens : window;
					const fraction = known ? tokens / Math.max(1, threshold) : 0;
					const color = !known ? "muted" : fraction >= 0.95 ? "error" : fraction >= 0.8 ? "warning" : "text";
					const parts = [theme.fg("accent", ctx.model?.id ?? "No model")];
					if (ctx.model?.reasoning) {
						const thinking = pi.getThinkingLevel();
						parts.push(theme.fg("muted", thinking === "off" ? "thinking off" : thinking));
					}
					parts.push(theme.fg(color, context), theme.fg("muted", `Est. $${sessionCost(ctx.sessionManager.getEntries()).toFixed(2)}`));
					lines.push(...packRows(parts, width, separator));
					const statuses = [...footerData.getExtensionStatuses()]
						.sort(([a], [b]) => a.localeCompare(b))
						.map(([, text]) => singleLine(text));
					lines.push(...packRows(statuses, width, separator));
					return lines;
				},
			};
		});
	});

	const refreshFooter = (_event: unknown, ctx: ExtensionContext) => {
		if (ctx.mode !== "tui") return;
		refreshSettings(ctx);
		requestRender?.();
	};
	pi.on("turn_start", refreshFooter);
	pi.on("model_select", refreshFooter);
	pi.on("session_info_changed", refreshFooter);
	pi.on("thinking_level_select", () => requestRender?.());
	pi.on("session_shutdown", (_event, ctx) => {
		if (ctx.mode === "tui") ctx.ui.setFooter(undefined);
	});
}
