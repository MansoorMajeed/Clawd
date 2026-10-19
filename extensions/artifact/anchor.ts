import type { Block } from "./render";

/** What a thread remembers about the block it was attached to. */
export interface Anchor {
	heading: string;
	text: string;
}

export type Attachment =
	| { status: "exact"; blockId: string }
	| { status: "heading"; blockId: string }
	| { status: "outdated" };

/**
 * Re-attach a thread after the document changed: the same text under the same
 * heading, else the heading itself (the block may be outdated), else nothing.
 */
export function attach(anchor: Anchor, blocks: Block[]): Attachment {
	const exact = blocks.find((b) => b.heading === anchor.heading && b.text === anchor.text);
	if (exact) return { status: "exact", blockId: exact.id };
	const heading = anchor.heading && blocks.find((b) => b.kind === "heading" && b.heading === anchor.heading);
	if (heading) return { status: "heading", blockId: heading.id };
	return { status: "outdated" };
}
