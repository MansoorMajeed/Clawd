import type { SentDrafts } from "./store";

/** The user message sent into the session when comments are sent from the browser. */
export function formatSendMessage(displayPath: string, sent: SentDrafts[]): string {
	const sections = sent.map(({ thread, texts }) => {
		const { path, quote, context, diagramSource } = thread.anchor;
		const lines = [`[artifact viewer · ${displayPath} · thread #${thread.id}]`];
		if (path) lines.push(`Section: ${path}`);
		if (diagramSource !== undefined) {
			lines.push(`Diagram label: "${quote}"`);
			if (diagramSource) lines.push(`Mermaid source: ${diagramSource}`);
		} else if (quote) {
			lines.push(`Selected: "${quote}"`);
			if (context && context !== quote) lines.push(`Context: "…${context}…"`);
		}
		return [...lines, "", texts.join("\n\n")].join("\n");
	});
	return [
		...sections,
		`Reply to each thread with artifact_reply (file: "${displayPath}"). Edit the file if the document should change; if you rewrite the text a thread points at, pass moved_to with the new text.`,
	].join("\n\n");
}
