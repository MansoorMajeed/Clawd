import type { SentDrafts } from "./store";

const QUOTE_LIMIT = 300;

function clip(text: string): string {
	return text.length > QUOTE_LIMIT ? `${text.slice(0, QUOTE_LIMIT)}…` : text;
}

/** The user message sent into the session when comments are sent from the browser. */
export function formatSendMessage(displayPath: string, sent: SentDrafts[]): string {
	const sections = sent.map(({ thread, texts }) => {
		const { path, quote, context, diagramSource } = thread.anchor;
		const lines = [`[artifact viewer · ${displayPath} · thread #${thread.id}]`];
		if (path) lines.push(`Section: ${path}`);
		if (diagramSource !== undefined) {
			lines.push(`Diagram label: "${clip(quote)}"`);
			if (diagramSource) lines.push(`Mermaid source: ${diagramSource}`);
		} else {
			lines.push(`Selected: "${clip(quote)}"`);
			if (context && context !== quote) lines.push(`Context: "…${clip(context)}…"`);
		}
		return [...lines, "", texts.join("\n\n")].join("\n");
	});
	return [
		...sections,
		`Reply to each thread with artifact_reply (file: "${displayPath}"). Edit the file if the document should change.`,
	].join("\n\n");
}
