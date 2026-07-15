import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import splitForkExtension from "../extensions/split-fork";

function setupExtension() {
	let handler: ((args: string, ctx: any) => Promise<void>) | undefined;
	const exec = vi.fn();
	const pi = {
		exec,
		registerCommand: vi.fn((_name: string, options: { handler: typeof handler }) => {
			handler = options.handler;
		}),
	};
	const notify = vi.fn();
	const ctx = {
		cwd: "/tmp/project with spaces",
		isIdle: () => true,
		sessionManager: {
			getSessionFile: () => undefined,
		},
		ui: { notify },
	};

	splitForkExtension(pi as any);
	if (!handler) throw new Error("split-fork command was not registered");

	return { exec, handler, notify, ctx };
}

describe("split-fork Herdr support", () => {
	let originalArgv1: string | undefined;

	beforeEach(() => {
		originalArgv1 = process.argv[1];
		process.argv[1] = "/definitely/missing/pi-script";
		vi.stubEnv("HERDR_ENV", "1");
		vi.stubEnv("ZELLIJ_SESSION_NAME", "");
		vi.stubEnv("TMUX", "");
	});

	afterEach(() => {
		if (originalArgv1 === undefined) {
			delete process.argv[1];
		} else {
			process.argv[1] = originalArgv1;
		}
		vi.unstubAllEnvs();
	});

	it("splits the calling pane and launches the forked Pi command", async () => {
		const { exec, handler, ctx } = setupExtension();
		exec
			.mockResolvedValueOnce({
				code: 0,
				stdout: '{"result":{"pane":{"pane_id":"w1:p2"}}}\n',
				stderr: "",
			})
			.mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" });

		await handler("review this", ctx);

		expect(exec).toHaveBeenNthCalledWith(1, "herdr", [
			"pane",
			"split",
			"--current",
			"--direction",
			"right",
			"--cwd",
			"/tmp/project with spaces",
			"--focus",
		]);
		expect(exec).toHaveBeenNthCalledWith(2, "herdr", [
			"pane",
			"run",
			"w1:p2",
			"'pi' '--' 'review this'",
		]);
	});

	it("reports malformed split output without trying to launch", async () => {
		const { exec, handler, notify, ctx } = setupExtension();
		exec.mockResolvedValueOnce({ code: 0, stdout: "{}\n", stderr: "" });

		await handler("", ctx);

		expect(exec).toHaveBeenCalledTimes(1);
		expect(notify).toHaveBeenCalledWith(
			"Failed to launch herdr split: Herdr split response did not include a pane ID.",
			"error",
		);
	});

	it("reports the created pane ID when launching Pi fails", async () => {
		const { exec, handler, notify, ctx } = setupExtension();
		exec
			.mockResolvedValueOnce({
				code: 0,
				stdout: '{"result":{"pane":{"pane_id":"w1:p2"}}}\n',
				stderr: "",
			})
			.mockResolvedValueOnce({ code: 1, stdout: "", stderr: "shell busy\n" });

		await handler("", ctx);

		expect(exec).toHaveBeenCalledTimes(2);
		expect(exec.mock.calls.some(([, args]) => args.includes("close"))).toBe(false);
		expect(notify).toHaveBeenCalledWith(
			"Failed to launch herdr split: shell busy (created pane w1:p2)",
			"error",
		);
	});
});
