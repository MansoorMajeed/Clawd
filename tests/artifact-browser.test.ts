import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ArtifactServer } from "../extensions/artifact/server";

const chrome = process.env.CHROME_BIN ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const browserTests = process.env.ARTIFACT_BROWSER_TESTS === "1" ? describe : describe.skip;
const pause = () => new Promise((resolve) => setTimeout(resolve, 30));

class Page {
	private next = 0;
	private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
	constructor(private socket: WebSocket) {
		socket.addEventListener("message", (event) => {
			const message = JSON.parse(String(event.data));
			const callback = this.pending.get(message.id);
			if (!callback) return;
			this.pending.delete(message.id);
			if (message.error) callback.reject(new Error(message.error.message));
			else callback.resolve(message.result);
		});
	}
	command(method: string, params: Record<string, unknown> = {}): Promise<any> {
		const id = ++this.next;
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			this.socket.send(JSON.stringify({ id, method, params }));
		});
	}
	async evaluate(expression: string): Promise<any> {
		const result = await this.command("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
		if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
		return result.result.value;
	}
	async until(expression: string): Promise<any> {
		const end = Date.now() + 3500;
		while (Date.now() < end) {
			const value = await this.evaluate(expression);
			if (value) return value;
			await pause();
		}
		throw new Error(`Browser condition timed out: ${expression}`);
	}
	async click(label: string) {
		const found = await this.evaluate(`(() => {const b = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(label)}); if (!b) return false; b.click(); return true;})()`);
		expect(found, `button ${label}`).toBe(true);
	}
	close() { this.socket.close(); }
}

browserTests("artifact viewer in Chrome", () => {
	let dir: string;
	let profile: string;
	let child: ChildProcess;
	let port: number;
	let page: Page;
	let targetId: string;
	let server: ArtifactServer;
	let file: string;
	let id: string;
	let send: ReturnType<typeof vi.fn>;
	let errors: string[];

	beforeAll(async () => {
		if (!existsSync(chrome)) throw new Error("Set CHROME_BIN to an installed Chrome/Chromium executable.");
		profile = mkdtempSync(join(tmpdir(), "artifact-chrome-"));
		child = spawn(chrome, ["--headless=new", "--no-first-run", "--no-default-browser-check", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
		const deadline = Date.now() + 10000;
		const active = join(profile, "DevToolsActivePort");
		while (Date.now() < deadline) {
			try {
				port = Number(readFileSync(active, "utf8").split("\n")[0]);
				if (port > 0 && (await fetch(`http://127.0.0.1:${port}/json/version`)).ok) return;
			} catch {}
			await pause();
		}
		throw new Error("Chrome did not start its debugging endpoint within 10 seconds.");
	}, 15000);

	beforeEach(async () => {
		errors = [];
		targetId = "";
		dir = mkdtempSync(join(tmpdir(), "artifact-browser-"));
		file = join(dir, "draft.md");
		writeFileSync(file, "# A shared draft\n\n## Proposal\n\nKeep the document readable while discussing it.\n\nAnother passage to review.\n");
		send = vi.fn();
		server = new ArtifactServer({ root: join(dir, "state"), cwd: dir, send, ports: [] });
		await server.start();
		id = server.open(file).id;
		const target = await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(server.url(id))}`, { method: "PUT" })).json();
		targetId = target.id;
		const socket = new WebSocket(target.webSocketDebuggerUrl);
		await new Promise<void>((resolve, reject) => { socket.onopen = () => resolve(); socket.onerror = () => reject(new Error("CDP connection failed")); });
		page = new Page(socket);
		errors = [];
		socket.addEventListener("message", (event) => {
			const message = JSON.parse(String(event.data));
			if (message.method === "Runtime.exceptionThrown") errors.push(JSON.stringify(message.params));
		});
		await page.command("Runtime.enable");
		await page.until(`document.querySelector('.doc h1')?.textContent === 'A shared draft'`);
	});

	afterEach(async () => {
		page?.close();
		if (targetId) await fetch(`http://127.0.0.1:${port}/json/close/${targetId}`);
		await server?.stop();
		if (dir) rmSync(dir, { recursive: true, force: true });
		expect(errors).toEqual([]);
	});

	afterAll(async () => {
		if (child && child.exitCode === null) {
			const exited = new Promise((resolve) => child.once("exit", resolve));
			child.kill("SIGTERM");
			await exited;
		}
		if (profile) rmSync(profile, { recursive: true, force: true });
	});

	async function post(action: string, body: unknown) {
		const result = await fetch(`http://127.0.0.1:${server.port}/api/doc/${id}/${action}?token=${server.token}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
		expect(result.status).toBe(200);
		return result.json();
	}

	it("edits Markdown source and returns to the rendered document", async () => {
		await page.click("Edit");
		await page.until(`!!document.querySelector('[data-source-editor]')`);
		if (process.env.ARTIFACT_SCREENSHOTS === "1") writeFileSync(".scratch/artifact-editor.png", Buffer.from((await page.command("Page.captureScreenshot")).data, "base64"));
		await page.evaluate(`(() => {const e = document.querySelector('[data-source-editor]'); e.value = '# Revised together\\n\\nSaved from the browser.\\n'; e.dispatchEvent(new Event('input', {bubbles:true}));})()`);
		await page.click("Save");
		await page.until(`document.querySelector('.doc h1')?.textContent === 'Revised together'`);
		expect(readFileSync(file, "utf8")).toBe("# Revised together\n\nSaved from the browser.\n");
	});

	it("preserves a source draft on external updates and stale saves, and Cancel reloads the file", async () => {
		await page.click("Edit");
		await page.until(`!!document.querySelector('[data-source-editor]')`);
		await page.evaluate(`(() => {const e = document.querySelector('[data-source-editor]'); e.value = '# My unsaved version'; e.dispatchEvent(new Event('input', {bubbles:true}));})()`);
		writeFileSync(file, "# Outside revision\n");
		await page.click("Save");
		await page.until(`document.body.textContent.toLowerCase().includes('changed') || document.body.textContent.toLowerCase().includes('conflict')`);
		expect(await page.evaluate(`document.querySelector('[data-source-editor]').value`)).toBe("# My unsaved version");
		expect(readFileSync(file, "utf8")).toBe("# Outside revision\n");
		// Confirm discarding the draft without requiring an interactive test runner.
		await page.evaluate("window.confirm = () => true");
		await page.click("Cancel");
		await page.until(`document.querySelector('.doc h1')?.textContent === 'Outside revision'`);
	});

	it("recovers from a stale save by overwriting or reloading", async () => {
		const typeDraft = (text: string) => page.evaluate(`(() => {const e = document.querySelector('[data-source-editor]'); e.value = ${JSON.stringify(text)}; e.dispatchEvent(new Event('input', {bubbles:true}));})()`);
		await page.evaluate("window.confirm = () => true");
		await page.click("Edit");
		await page.until(`!!document.querySelector('[data-source-editor]')`);
		await typeDraft("# Mine\n");
		writeFileSync(file, "# Theirs\n");
		await page.click("Save");
		await page.until(`!![...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Overwrite with my version')`);
		await page.click("Overwrite with my version");
		await page.until(`document.querySelector('.doc h1')?.textContent === 'Mine'`);
		expect(readFileSync(file, "utf8")).toBe("# Mine\n");

		await page.click("Edit");
		await page.until(`!!document.querySelector('[data-source-editor]')`);
		await typeDraft("# Discard me\n");
		writeFileSync(file, "# Newest\n");
		await page.click("Save");
		await page.until(`!![...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Reload document')`);
		await page.click("Reload document");
		await page.until(`document.querySelector('[data-source-editor]')?.value === '# Newest\\n'`);
		expect(readFileSync(file, "utf8")).toBe("# Newest\n");
	});

	it("keeps CRLF line endings when saving an edit", async () => {
		writeFileSync(file, "# A shared draft\r\n\r\nFirst line.\r\n");
		await page.until(`!document.body.textContent.includes('Another passage')`);
		await page.click("Edit");
		await page.until(`!!document.querySelector('[data-source-editor]')`);
		await page.evaluate(`(() => {const e = document.querySelector('[data-source-editor]'); e.value = e.value.replace('First', 'Edited'); e.dispatchEvent(new Event('input', {bubbles:true}));})()`);
		await page.click("Save");
		await page.until(`document.body.textContent.includes('Edited line.')`);
		expect(readFileSync(file, "utf8")).toBe("# A shared draft\r\n\r\nEdited line.\r\n");
	});

	it("leaves resolved threads unhighlighted and links inside highlights clickable", async () => {
		writeFileSync(file, "# A shared draft\n\nRead [the spec](#spec) first.\n\nAnother passage to review.\n");
		await page.until(`!!document.querySelector('.doc a[href="#spec"]')`);
		server.comment(file, "the spec", "Link a specific section");
		server.comment(file, "Another passage to review.", "Already handled");
		await page.until(`document.querySelectorAll('[data-thread-anchor]').length === 2`);
		expect(await page.evaluate(`document.querySelector('a[href="#spec"] [data-thread-anchor="1"]').dispatchEvent(new MouseEvent('click', {bubbles:true, cancelable:true}))`), "link click must not be cancelled").toBe(true);
		await post("threads/2/resolve", { resolved: true });
		await page.until(`!document.querySelector('[data-thread-anchor="2"]')`);
		expect(await page.evaluate(`!!document.querySelector('[data-thread-anchor="1"]')`)).toBe(true);
	});

	it("does not jump to the passage when selecting text inside a thread card", async () => {
		server.comment(file, "Another passage to review.", "Copy this review text");
		await page.until(`!!document.querySelector('[data-thread="1"]')`);
		await page.evaluate(`(() => {
			const card = document.querySelector('[data-thread="1"]');
			const walker = document.createTreeWalker(card, NodeFilter.SHOW_TEXT);
			let node; while ((node = walker.nextNode()) && !node.textContent.includes('Copy this review')) {}
			const range = document.createRange(); range.setStart(node, 0); range.setEnd(node, 4);
			getSelection().removeAllRanges(); getSelection().addRange(range);
			node.parentElement.dispatchEvent(new MouseEvent('click', {bubbles:true}));
		})()`);
		await pause();
		expect(await page.evaluate(`!!document.querySelector('[data-thread="1"].selected')`)).toBe(false);
	});

	it("collapses threads and moves them out of the prose on wide screens, inline on narrow screens", async () => {
		const payload = await (await fetch(`http://127.0.0.1:${server.port}/api/doc/${id}?token=${server.token}`)).json();
		const block = payload.blocks.find((b: any) => b.kind === "paragraph");
		await post("comments", { blockId: block.id, quote: "document readable", text: "First review point" });
		await post("comments", { blockId: block.id, quote: "discussing it", text: "Second review point" });
		await page.until(`document.querySelectorAll('[data-thread]').length === 2`);
		await page.command("Emulation.setDeviceMetricsOverride", { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
		await page.until(`(() => {const t = document.querySelector('[data-thread]'); const p = document.querySelector('.block-body'); return t.getBoundingClientRect().left >= p.getBoundingClientRect().right;})()`);
		expect(await page.evaluate(`(() => {const ts = [...document.querySelectorAll('[data-thread]')]; return ts[1].getBoundingClientRect().top >= ts[0].getBoundingClientRect().bottom;})()`)).toBe(true);
		if (process.env.ARTIFACT_SCREENSHOTS === "1") writeFileSync(".scratch/artifact-wide.png", Buffer.from((await page.command("Page.captureScreenshot")).data, "base64"));
		expect(await page.evaluate(`(() => {const ps = [...document.querySelectorAll('.block-body p')]; return ps[1].getBoundingClientRect().top - ps[0].getBoundingClientRect().bottom;})()`), "side comments must not push the next paragraph down").toBeLessThan(100);
		await page.evaluate(`document.querySelector('[data-thread] button[aria-expanded]').click()`);
		await page.until(`document.querySelector('[data-thread] button[aria-expanded]').getAttribute('aria-expanded') === 'false'`);
		await page.evaluate(`document.querySelector('[data-thread] button[aria-expanded]').click()`);
		await page.until(`document.querySelector('[data-thread] button[aria-expanded]').getAttribute('aria-expanded') === 'true'`);
		await page.command("Emulation.setDeviceMetricsOverride", { width: 720, height: 1000, deviceScaleFactor: 1, mobile: false });
		await page.until(`!!document.querySelector('.doc [data-thread]')?.closest('.block')`);
		expect(await page.evaluate("document.documentElement.scrollWidth <= innerWidth")).toBe(true);
		expect(await page.evaluate(`(() => {const t = document.querySelector('[data-thread]'); const b = t.closest('.block'); return t.getBoundingClientRect().top >= b.querySelector('.block-body').getBoundingClientRect().bottom;})()`)).toBe(true);
		if (process.env.ARTIFACT_SCREENSHOTS === "1") writeFileSync(".scratch/artifact-narrow.png", Buffer.from((await page.command("Page.captureScreenshot")).data, "base64"));
	});

	it("sends a selected passage as a comment and preserves a reply draft across refresh", async () => {
		await page.evaluate(`(() => {const p = [...document.querySelectorAll('.block-body p')].find(p => p.textContent.includes('Keep the document')); const r = document.createRange(); r.setStart(p.firstChild, 9); r.setEnd(p.firstChild, 26); const s = getSelection(); s.removeAllRanges(); s.addRange(r); document.dispatchEvent(new MouseEvent('mouseup', {bubbles:true}));})()`);
		await page.until(`!document.querySelector('.sel-add').hidden`);
		await page.click("Comment");
		await page.evaluate(`(() => {const e = document.querySelector('[data-composer]'); e.value = 'Please explain this passage'; e.dispatchEvent(new Event('input', {bubbles:true}));})()`);
		await page.click("Send now");
		await page.until(`!!document.querySelector('[data-thread="1"]')`);
		expect(send).toHaveBeenCalledWith(expect.stringContaining('Selected: "document readable"'));
		await page.click("Reply");
		await page.evaluate(`(() => {const e = document.querySelector('[data-composer="thread:1"]'); e.value = 'An unfinished thought'; e.dispatchEvent(new Event('input', {bubbles:true})); e.focus(); e.setSelectionRange(3, 7);})()`);
		server.reply(file, 1, "A live response");
		await page.until(`document.body.textContent.includes('A live response')`);
		expect(await page.evaluate(`(() => {const e = document.querySelector('[data-composer="thread:1"]'); return [e.value, document.activeElement === e, e.selectionStart, e.selectionEnd];})()`)).toEqual(["An unfinished thought", true, 3, 7]);
		await page.evaluate("window.confirm = () => false");
		const other = join(dir, "sidebar.md");
		writeFileSync(other, "# Sidebar target\n");
		server.open(other);
		server.reply(file, 1, "Refresh document list");
		await page.until(`!![...document.querySelectorAll('.sidebar a')].find(a => a.textContent.includes('sidebar.md'))`);
		await page.evaluate(`document.querySelectorAll('.sidebar a')[1].click()`);
		expect(await page.evaluate("location.href")).toBe(server.url(id));
		expect(await page.evaluate(`document.querySelector('[data-composer="thread:1"]').value`)).toBe("An unfinished thought");
	});

	it("shows an agent review and sends the user's response with review context", async () => {
		server.comment(file, "Another passage to review.", "Could you make this more specific?");
		await page.until(`document.querySelector('[data-thread="1"]')?.textContent.includes('Review comment')`);
		expect(send).not.toHaveBeenCalled();
		expect(await page.evaluate(`document.querySelector('[data-thread="1"]').textContent.includes('Waiting for reply')`)).toBe(false);
		await page.evaluate(`document.querySelector('[data-thread-anchor="1"]').click()`);
		await page.until(`!!document.querySelector('[data-thread="1"].selected')`);
		await page.click("Reply");
		await page.evaluate(`(() => {const e = document.querySelector('[data-composer="thread:1"]'); e.value = 'Yes, I will add an example'; e.dispatchEvent(new Event('input', {bubbles:true}));})()`);
		await page.click("Send now");
		await page.until(`document.querySelector('[data-thread="1"]')?.textContent.includes('Waiting for reply')`);
		expect(send).toHaveBeenCalledWith(expect.stringContaining("Could you make this more specific?"));
		expect(send).toHaveBeenCalledWith(expect.stringContaining("Yes, I will add an example"));
		server.reply(file, 1, "Thanks, that will clarify it.");
		await page.until(`document.querySelector('[data-thread="1"]')?.textContent.includes('Replied')`);
		await page.click("Resolve");
		await page.until(`document.querySelector('[data-thread="1"] button[aria-expanded]')?.getAttribute('aria-expanded') === 'false'`);
	});

	it("retains Mermaid label comments and outdated threads", async () => {
		writeFileSync(file, '# A shared draft\n\n## Flow\n\n```mermaid\ngraph TD\n  A[Writer] --> B[Reviewer]\n```\n');
		await page.until(`!!document.querySelector('pre.mermaid svg')`);
		await page.evaluate(`[...document.querySelectorAll('pre.mermaid .nodeLabel')].find(e => e.textContent === 'Writer').dispatchEvent(new MouseEvent('click', {bubbles:true}))`);
		await page.until(`!!document.querySelector('[data-composer]')`);
		await page.evaluate(`(() => {const e = document.querySelector('[data-composer]'); e.value = 'Review this role'; e.dispatchEvent(new Event('input', {bubbles:true}));})()`);
		await page.click("Send now");
		await page.until(`!!document.querySelector('[data-thread="1"]')`);
		expect(send).toHaveBeenCalledWith(expect.stringContaining('Diagram label: "Writer"'));
		writeFileSync(file, "# Completely replaced\n\nNo diagram remains.\n");
		await page.until(`!!document.querySelector('.outdated [data-thread="1"]')`);
		expect(await page.evaluate(`document.querySelector('.outdated').textContent`)).toContain("Review this role");
	});

	it("preserves the same reply composer and caret while moving between rail and inline layouts", async () => {
		server.comment(file, "Another passage to review.", "A review to answer");
		await page.until(`!!document.querySelector('[data-thread="1"]')`);
		await page.click("Reply");
		await page.evaluate(`(() => {const e = document.querySelector('[data-composer]'); window.savedComposer = e; e.value = 'My draft\\n'.repeat(60); e.dispatchEvent(new Event('input', {bubbles:true})); e.focus(); e.setSelectionRange(3, 7, 'backward'); e.scrollTop = 150;})()`);
		const snapshot = `(() => {const e = window.savedComposer; return [e.value, e.selectionStart, e.selectionEnd, e.selectionDirection, e.scrollTop];})()`;
		const before = await page.evaluate(snapshot);
		for (const width of [1600, 720, 1600]) {
			await page.command("Emulation.setDeviceMetricsOverride", { width, height: 1000, deviceScaleFactor: 1, mobile: false });
			await page.until(width < 1200 ? `!!window.savedComposer.closest('.block')` : `!!window.savedComposer.closest('.comment-rail')`);
			expect(await page.evaluate(`document.activeElement === window.savedComposer`)).toBe(true);
			expect(await page.evaluate(snapshot)).toEqual(before);
			expect(await page.evaluate(`document.querySelectorAll('[data-composer]').length`)).toBe(1);
		}
	});

	it("moves keyboard focus between a passage and collapsed or expanded threads", async () => {
		server.comment(file, "Another passage to review.", "A keyboard-accessible review");
		await page.until(`!!document.querySelector('[data-thread="1"]')`);
		await page.evaluate(`document.querySelector('[data-thread="1"] button[aria-expanded]').click()`);
		const enter = async () => {
			await page.command("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
			await page.command("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
		};
		for (let attempt = 0; attempt < 2; attempt++) {
			await page.evaluate(`document.querySelector('[data-thread-anchor="1"]').focus()`);
			await enter();
			await page.until(`document.querySelector('[data-thread="1"] button[aria-expanded]').getAttribute('aria-expanded') === 'true'`);
			expect(await page.evaluate(`document.activeElement.closest('[data-thread]')?.dataset.thread`)).toBe("1");
			await page.evaluate(`document.querySelector('[data-thread="1"] .thread-anchor-link').focus()`);
			await enter();
			expect(await page.evaluate(`document.activeElement.matches('[data-thread-anchor="1"]')`), await page.evaluate("document.activeElement.outerHTML")).toBe(true);
		}
		writeFileSync(file, "# A shared draft\n\n## Proposal\n\nThe original passage was replaced.\n");
		await page.until(`document.querySelector('[data-thread="1"]').textContent.includes('Text changed')`);
		await page.evaluate(`document.querySelector('[data-thread="1"] .thread-anchor-link').focus()`);
		await enter();
		expect(await page.evaluate(`document.activeElement.matches('.block-heading .block-body')`)).toBe(true);
	});

	it("does not navigate an editing tab away when another document is opened", async () => {
		await page.click("Edit");
		await page.until(`!!document.querySelector('[data-source-editor]')`);
		const other = join(dir, "other.md");
		writeFileSync(other, "# Other\n");
		const next = server.open(other);
		expect(await server.showInTab(next.url)).toBe(true);
		await page.until(`!![...document.querySelectorAll('a')].find(a => a.textContent.includes('New document'))`);
		expect(await page.evaluate("location.href")).toBe(server.url(id));
		expect(await page.evaluate(`!!document.querySelector('[data-source-editor]')`)).toBe(true);
	});
});
