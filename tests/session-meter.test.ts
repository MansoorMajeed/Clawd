import { afterEach, describe, expect, it, vi } from "vitest";
import sessionMeter from "../extensions/session-meter";

afterEach(() => vi.restoreAllMocks());

describe("session duration", () => {
	it.each([[30_000, "30s"], [90_000, "1m"], [6_120_000, "1h42m"], [90_000_000, "1d1h"]])(
		"shows age at %i ms without an estimated burn rate",
		(age, expected) => {
			const start = Date.parse("2026-09-20T00:00:00Z");
			vi.spyOn(Date, "now").mockReturnValue(start + age);
			const handlers = new Map<string, (event: any, ctx: any) => void>();
			const setStatus = vi.fn();
			const ctx = {
				hasUI: true,
				sessionManager: { getHeader: () => ({ timestamp: new Date(start).toISOString() }) },
				ui: { setStatus, theme: { fg: (_color: string, text: string) => text } },
			};
			sessionMeter({ on: (name: string, handler: any) => handlers.set(name, handler) } as any);
			handlers.get("session_start")!({}, ctx);
			expect(setStatus).toHaveBeenLastCalledWith("session-meter", expected);
			handlers.get("session_shutdown")!({}, ctx);
			expect(setStatus).toHaveBeenLastCalledWith("session-meter", undefined);
		},
	);
});
