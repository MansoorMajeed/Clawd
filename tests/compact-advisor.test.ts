import { describe, expect, it } from "vitest";
import { computeCompactThreshold, TARGET_TOKENS, RESERVE_MARGIN } from "../extensions/compact-advisor";

describe("computeCompactThreshold", () => {
	it("uses the target ceiling on large windows", () => {
		expect(computeCompactThreshold(1_000_000)).toBe(TARGET_TOKENS);
		expect(computeCompactThreshold(500_000)).toBe(TARGET_TOKENS);
	});

	it("fires just before native on windows near the target", () => {
		// window - margin wins when it is below the target
		expect(computeCompactThreshold(200_000)).toBe(200_000 - RESERVE_MARGIN);
		expect(computeCompactThreshold(100_000)).toBe(100_000 - RESERVE_MARGIN);
	});

	it("never returns the target when it would exceed window - margin", () => {
		const window = 210_000;
		expect(computeCompactThreshold(window)).toBe(Math.min(TARGET_TOKENS, window - RESERVE_MARGIN));
	});
});
