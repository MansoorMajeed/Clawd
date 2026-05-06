export interface NowStamp {
	/** YYYY-MM-DD */
	date: string;
	/** HH:MM (24h) */
	hhmm: string;
}

/**
 * Pure: given existing session-file content (possibly empty), append text
 * with section folding rules:
 * - Empty existing -> emit `# <date> <hhmm> — <task>\n\n## <hhmm>\n` then bullets.
 * - Last `## HH:MM` heading matches `now.hhmm` -> append bullets directly.
 * - Otherwise -> start a new `## <now.hhmm>` subheading and emit bullets.
 *
 * Bullet rules per line of `text`:
 * - Empty lines are skipped.
 * - Lines already starting with `- ` or `* ` are kept as-is.
 * - Lines starting with whitespace are kept as-is (continuation).
 * - All other non-empty lines become `- <line>`.
 */
export function foldAppend(
	existing: string,
	text: string,
	now: NowStamp,
	taskName: string,
): string {
	const bullets = renderBullets(text);
	if (bullets.length === 0) return existing;

	if (existing.length === 0) {
		const header = `# ${now.date} ${now.hhmm} — ${taskName}`;
		return `${header}\n\n## ${now.hhmm}\n${bullets.join("")}`;
	}

	const trimmed = existing.endsWith("\n") ? existing : existing + "\n";
	const lastSub = lastSubheading(trimmed);
	if (lastSub === now.hhmm) {
		return trimmed + bullets.join("");
	}
	return trimmed + `\n## ${now.hhmm}\n` + bullets.join("");
}

function renderBullets(text: string): string[] {
	const out: string[] = [];
	for (const raw of text.split("\n")) {
		if (raw.length === 0) continue;
		if (raw.startsWith("- ") || raw.startsWith("* ")) {
			out.push(raw + "\n");
			continue;
		}
		if (/^\s/.test(raw)) {
			out.push(raw + "\n");
			continue;
		}
		out.push(`- ${raw}\n`);
	}
	return out;
}

/**
 * Pure: filter to .md files and return the lexicographically-newest N filenames.
 * Session filenames follow the pattern `YYYY-MM-DD-HHMM.md` so lex-desc == time-desc.
 * `n` is clamped to a minimum of 1.
 */
export function pickRecentSessions(filenames: string[], n: number): string[] {
	const md = filenames.filter((f) => f.endsWith(".md"));
	md.sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
	const k = Math.max(1, n);
	return md.slice(0, k);
}

/**
 * Pure: render a list of session files as a single string with blank-line
 * separators between sessions. Empty list returns a stable placeholder so
 * callers can show something rather than nothing.
 */
export function formatSessions(
	sessions: ReadonlyArray<{ name: string; content: string }>,
): string {
	if (sessions.length === 0) return "(no journal entries yet)";
	return sessions
		.map((s) => (s.content.endsWith("\n") ? s.content : s.content + "\n"))
		.join("\n");
}

function lastSubheading(text: string): string | null {
	const re = /^##\s+(\S.*?)\s*$/gm;
	let last: string | null = null;
	let m: RegExpExecArray | null;
	while ((m = re.exec(text)) !== null) {
		last = m[1] ?? null;
	}
	return last;
}
