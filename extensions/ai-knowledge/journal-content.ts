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

function lastSubheading(text: string): string | null {
	const re = /^##\s+(\S.*?)\s*$/gm;
	let last: string | null = null;
	let m: RegExpExecArray | null;
	while ((m = re.exec(text)) !== null) {
		last = m[1] ?? null;
	}
	return last;
}
