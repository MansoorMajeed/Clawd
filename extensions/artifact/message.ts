import type { SentDrafts } from "./store";

const QUOTE_LIMIT = 300;

/** The user message sent into the session when comments are sent from the browser. */
export function formatSendMessage(displayPath: string, sent: SentDrafts[]): string {
	const sections = sent.map(({ thread, texts }) => {
		const quote = thread.anchor.text.length > QUOTE_LIMIT ? `${thread.anchor.text.slice(0, QUOTE_LIMIT)}…` : thread.anchor.text;
		return [`[artifact viewer · ${displayPath} · thread #${thread.id}]`, `> ${quote}`, "", texts.join("\n\n")].join("\n");
	});
	return [
		...sections,
		`Reply to each thread with artifact_reply (file: "${displayPath}"). Edit the file if the document should change.`,
	].join("\n\n");
}
