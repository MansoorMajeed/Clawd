import { afterEach, describe, expect, it, vi } from "vitest";
import registerTokenTps from "../extensions/token-tps";

function setup() {
	const handlers = new Map<string, (event: any, ctx: any) => void>();
	let nowMs = 0;
	vi.spyOn(performance, "now").mockImplementation(() => nowMs);
	const setStatus = vi.fn();
	const ctx = {
		hasUI: true,
		ui: { setStatus, theme: { fg: (_color: string, text: string) => text } },
	};
	registerTokenTps({
		on: (name: string, handler: (event: any, ctx: any) => void) => handlers.set(name, handler),
	} as any);
	const emit = (name: string, event = {}) => handlers.get(name)?.(event, ctx);
	const finish = (output: number | undefined, stopReason = "stop", content: unknown[] = []) =>
		emit("message_end", { message: { role: "assistant", usage: { output }, stopReason, content } });
	return { emit, finish, setStatus, ctx, at: (time: number) => { nowMs = time; } };
}

afterEach(() => vi.restoreAllMocks());

describe("provider-reported TPS", () => {
	it("includes initial waiting time and uses provider counts rather than streamed characters", () => {
		const h = setup();
		h.emit("session_start");
		h.emit("before_provider_request");
		h.at(1000);
		h.emit("message_start", { message: { role: "assistant" } });
		h.emit("message_update", { assistantMessageEvent: { type: "text_delta", delta: "hello" } });
		h.at(2000);
		h.finish(100);
		expect(h.setStatus).toHaveBeenLastCalledWith("token-tps", "Speed 50.0 tok/s · avg 50.0 tok/s");
	});

	it("weights session average by response duration and excludes tool execution and idle time", () => {
		const h = setup();
		h.emit("before_provider_request");
		h.at(2000);
		h.finish(100, "toolUse", [{ type: "toolCall", arguments: { path: "x" } }]);
		expect(h.setStatus).toHaveBeenLastCalledWith("token-tps", "Speed 50.0 tok/s · avg 50.0 tok/s");
		h.at(60_000);
		h.emit("message_end", { message: { role: "toolResult" } });
		h.emit("before_provider_request");
		h.at(61_000);
		h.finish(100);
		expect(h.setStatus).toHaveBeenLastCalledWith("token-tps", "Speed 100.0 tok/s · avg 66.7 tok/s");
	});

	it("keeps completed values visible while streaming and counts completion only once", () => {
		const h = setup();
		h.emit("before_provider_request");
		h.at(1000);
		h.finish(20);
		h.setStatus.mockClear();
		h.emit("before_provider_request");
		h.emit("message_start", { message: { role: "assistant" } });
		h.at(2000);
		h.emit("message_update", { assistantMessageEvent: { type: "thinking_delta", delta: "thinking" } });
		h.emit("message_update", { assistantMessageEvent: { type: "done", message: { usage: { output: 80 } } } });
		expect(h.setStatus).not.toHaveBeenCalled();
		h.at(3000);
		h.finish(80);
		h.finish(80);
		expect(h.setStatus).toHaveBeenCalledTimes(1);
		expect(h.setStatus).toHaveBeenLastCalledWith("token-tps", "Speed 40.0 tok/s · avg 33.3 tok/s");
	});

	it.each([undefined, 0, -1, NaN, Infinity])("skips unusable output count %s without adding its duration", (output) => {
		const h = setup();
		h.emit("before_provider_request");
		h.at(5000);
		h.finish(output);
		expect(h.setStatus).not.toHaveBeenCalled();
		h.emit("before_provider_request");
		h.at(6000);
		h.finish(30);
		expect(h.setStatus).toHaveBeenLastCalledWith("token-tps", "Speed 30.0 tok/s · avg 30.0 tok/s");
	});

	it.each(["error", "aborted"])("excludes %s responses", (reason) => {
		const h = setup();
		h.emit("before_provider_request");
		h.at(1000);
		h.finish(100, reason);
		expect(h.setStatus).not.toHaveBeenCalled();
	});

	it("ignores untimed completions and zero-duration responses", () => {
		const h = setup();
		h.finish(100);
		h.emit("before_provider_request");
		h.finish(100);
		expect(h.setStatus).not.toHaveBeenCalled();
	});

	it("resets totals and pending timing on session start and clears status on shutdown", () => {
		const h = setup();
		h.emit("before_provider_request");
		h.at(1000);
		h.finish(100);
		h.emit("before_provider_request");
		h.emit("session_start");
		expect(h.setStatus).toHaveBeenLastCalledWith("token-tps", undefined);
		h.setStatus.mockClear();
		h.at(2000);
		h.finish(100);
		expect(h.setStatus).not.toHaveBeenCalled();
		h.emit("before_provider_request");
		h.at(3000);
		h.finish(20);
		expect(h.setStatus).toHaveBeenLastCalledWith("token-tps", "Speed 20.0 tok/s · avg 20.0 tok/s");
		h.emit("session_shutdown");
		expect(h.setStatus).toHaveBeenLastCalledWith("token-tps", undefined);
	});
});
