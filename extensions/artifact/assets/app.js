// Artifact viewer client. Document HTML comes pre-escaped from the server;
// everything else (thread text, paths) is inserted with textContent only.
(() => {
	const token = new URLSearchParams(location.search).get("token") ?? "";
	const docId = document.body.dataset.doc;
	const app = document.getElementById("app");

	const state = {
		doc: undefined,
		docs: [],
		error: undefined,
		connected: true,
		/** Open composers keyed by "block:<id>" or "thread:<id>", value is the draft text. */
		composers: new Map(),
		expanded: new Set(),
		focus: undefined,
	};

	// ---------- helpers ----------

	function h(tag, attrs = {}, ...children) {
		const el = document.createElement(tag);
		for (const [key, value] of Object.entries(attrs)) {
			if (value === undefined || value === false) continue;
			if (key.startsWith("on")) el.addEventListener(key.slice(2), value);
			else if (key === "class") el.className = value;
			else el.setAttribute(key, value === true ? "" : String(value));
		}
		for (const child of children.flat()) {
			if (child === undefined || child === null || child === false) continue;
			el.append(child instanceof Node ? child : document.createTextNode(String(child)));
		}
		return el;
	}

	async function api(path, body) {
		const res = await fetch(path, {
			method: body === undefined ? "GET" : "POST",
			headers: { "x-artifact-token": token, ...(body === undefined ? {} : { "content-type": "application/json" }) },
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		const data = await res.json().catch(() => ({}));
		if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
		return data;
	}

	let toastTimer;
	function toast(message) {
		document.querySelector(".toast")?.remove();
		const el = h("div", { class: "toast", role: "status" }, message);
		document.body.append(el);
		clearTimeout(toastTimer);
		toastTimer = setTimeout(() => el.remove(), 3200);
	}

	async function act(fn) {
		try {
			await fn();
			await load();
		} catch (error) {
			toast(error.message);
		}
	}

	// ---------- data ----------

	async function load() {
		try {
			state.doc = await api(`/api/doc/${docId}`);
			state.error = undefined;
		} catch (error) {
			state.error = error.message;
		}
		try {
			state.docs = (await api("/api/docs")).docs;
		} catch {
			// Sidebar is optional.
		}
		render();
	}

	function connect() {
		const events = new EventSource(`/api/events?doc=${encodeURIComponent(docId)}&token=${encodeURIComponent(token)}`);
		events.addEventListener("open", () => {
			if (!state.connected) {
				state.connected = true;
				load();
			}
		});
		events.addEventListener("changed", () => load());
		events.addEventListener("error", () => {
			state.connected = false;
			renderStatus();
		});
	}

	// ---------- actions ----------

	function openComposer(key) {
		if (!state.composers.has(key)) state.composers.set(key, "");
		state.focus = key;
		render();
	}

	function closeComposer(key) {
		state.composers.delete(key);
		render();
	}

	async function submit(key, sendNow) {
		const text = (state.composers.get(key) ?? "").trim();
		if (!text) return;
		const [kind, id] = key.split(":");
		await act(async () => {
			const body = kind === "block" ? { blockId: id, text } : { threadId: Number(id), text };
			const { threadId } = await api(`/api/doc/${docId}/comments`, body);
			state.composers.delete(key);
			if (sendNow) await api(`/api/doc/${docId}/send`, { threadId });
		});
	}

	const sendThread = (id) => act(() => api(`/api/doc/${docId}/send`, { threadId: id }));
	const sendAll = () => act(() => api(`/api/doc/${docId}/send`, {}));
	const discard = (id) => act(() => api(`/api/doc/${docId}/threads/${id}/discard`, {}));
	const resolve = (id, resolved) =>
		act(async () => {
			await api(`/api/doc/${docId}/threads/${id}/resolve`, { resolved });
			if (resolved) state.expanded.delete(id);
		});

	// ---------- rendering ----------

	function composer(key, placeholder) {
		const textarea = h("textarea", {
			placeholder,
			"data-composer": key,
			oninput: (e) => state.composers.set(key, e.target.value),
			onkeydown: (e) => {
				if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
					e.preventDefault();
					submit(key, e.shiftKey);
				} else if (e.key === "Escape") {
					closeComposer(key);
				}
			},
		});
		textarea.value = state.composers.get(key) ?? "";
		return h(
			"div",
			{ class: "composer" },
			textarea,
			h(
				"div",
				{ class: "composer-actions" },
				h("button", { class: "btn btn-primary", onclick: () => submit(key, false) }, "Add draft"),
				h("button", { class: "btn", onclick: () => submit(key, true) }, "Send now"),
				h("button", { class: "btn btn-quiet", onclick: () => closeComposer(key) }, "Cancel"),
				h("span", { class: "hint" }, "⌘↵ draft · ⌘⇧↵ send"),
			),
		);
	}

	const STATUS_LABEL = { draft: "Draft", sent: "Waiting for reply", replied: "Replied", resolved: "Resolved" };

	function thread(t) {
		const collapsed = t.status === "resolved" && !state.expanded.has(t.id);
		const head = h(
			"div",
			{ class: "thread-head", onclick: collapsed ? () => (state.expanded.add(t.id), render()) : undefined },
			h("strong", {}, `#${t.id}`),
			h("span", { class: `badge badge-${t.status}` }, STATUS_LABEL[t.status]),
			t.attachment.status === "heading" && h("span", { class: "badge badge-outdated" }, "May be outdated"),
			t.attachment.status === "outdated" && h("span", { class: "badge badge-outdated" }, "Outdated"),
			h("span", { class: "spacer" }),
			collapsed && h("span", {}, `${t.messages.length} message${t.messages.length === 1 ? "" : "s"} · show`),
		);
		if (collapsed) return h("div", { class: "thread collapsed" }, head);

		const replyKey = `thread:${t.id}`;
		const hasDrafts = t.status === "draft";
		return h(
			"div",
			{ class: "thread" },
			head,
			t.attachment.status !== "exact" && h("div", { class: "thread-quote" }, t.quote),
			t.messages.map((m) =>
				h(
					"div",
					{ class: `message message-${m.author}${m.sent ? "" : " message-draft"}` },
					h("span", { class: "message-author" }, m.author === "agent" ? "Agent" : "You"),
					m.text,
				),
			),
			t.status === "sent" && h("div", { class: "waiting" }, "Sent to the session, waiting for a reply"),
			state.composers.has(replyKey)
				? composer(replyKey, "Reply…")
				: h(
						"div",
						{ class: "thread-actions" },
						hasDrafts && h("button", { class: "btn btn-primary", onclick: () => sendThread(t.id) }, "Send"),
						h("button", { class: "btn", onclick: () => openComposer(replyKey) }, "Reply"),
						hasDrafts && h("button", { class: "btn btn-quiet", onclick: () => discard(t.id) }, "Discard draft"),
						t.status === "resolved"
							? h("button", { class: "btn btn-quiet", onclick: () => resolve(t.id, false) }, "Reopen")
							: h("button", { class: "btn btn-quiet", onclick: () => resolve(t.id, true) }, "Resolve"),
					),
		);
	}

	function block(b, threads) {
		const key = `block:${b.id}`;
		const body = h("div", { class: "block-body" });
		body.innerHTML = b.html; // Server-rendered with raw HTML escaped.
		return h(
			"section",
			{ class: `block block-${b.kind}${threads.length ? " has-threads" : ""}`, "data-block": b.id },
			h("button", { class: "add-comment", title: "Comment on this", "aria-label": "Comment on this", onclick: () => openComposer(key) }, "+"),
			body,
			threads.map(thread),
			state.composers.has(key) && composer(key, "Comment on this section…"),
		);
	}

	function sidebar() {
		const groups = new Map();
		for (const d of state.docs) {
			const label = d.session ?? "This session";
			if (!groups.has(label)) groups.set(label, []);
			groups.get(label).push(d);
		}
		return h(
			"aside",
			{ class: "sidebar" },
			h("h2", {}, "Documents"),
			[...groups].map(([label, docs]) =>
				h(
					"div",
					{ class: "group" },
					groups.size > 1 && h("p", { class: "group-label" }, label),
					docs.map((d) => h("a", { href: d.url, class: d.id === docId && !d.session ? "current" : undefined }, d.path)),
				),
			),
		);
	}

	function renderStatus() {
		const dot = document.querySelector(".status-dot");
		if (!dot) return;
		dot.classList.toggle("offline", !state.connected);
		dot.title = state.connected ? "Live" : "Disconnected: the session may have ended";
	}

	function render() {
		const active = document.activeElement?.dataset?.composer;
		const caret = active ? [document.activeElement.selectionStart, document.activeElement.selectionEnd] : undefined;
		const scroll = window.scrollY;

		const doc = state.doc;
		if (doc) document.title = doc.title;
		const drafts = doc ? doc.threads.filter((t) => t.status === "draft").length : 0;

		const byBlock = new Map();
		const outdated = [];
		for (const t of doc?.threads ?? []) {
			if (t.attachment.status === "outdated") outdated.push(t);
			else {
				if (!byBlock.has(t.attachment.blockId)) byBlock.set(t.attachment.blockId, []);
				byBlock.get(t.attachment.blockId).push(t);
			}
		}

		const main = state.error
			? h("div", { class: "error-page" }, state.error)
			: !doc
				? h("div", { class: "empty" }, "Loading…")
				: [
						h("article", { class: "doc" }, doc.blocks.map((b) => block(b, byBlock.get(b.id) ?? []))),
						outdated.length > 0 &&
							h("section", { class: "outdated" }, h("h2", {}, "Outdated threads"), outdated.map(thread)),
					];

		app.replaceChildren(
			h(
				"div",
				{ class: "layout" },
				sidebar(),
				h(
					"main",
					{ class: "page" },
					h(
						"header",
						{ class: "topbar" },
						h("span", { class: "status-dot" }),
						h("span", { class: "path" }, doc?.path ?? ""),
						h("span", { class: "spacer" }),
						h("button", { class: "btn btn-primary", disabled: drafts === 0, onclick: sendAll }, `Send all (${drafts})`),
					),
					main,
				),
			),
		);
		renderStatus();

		if (doc?.hasMermaid) renderMermaid();
		window.scrollTo(0, scroll);
		const focusKey = state.focus ?? active;
		state.focus = undefined;
		if (focusKey) {
			const el = document.querySelector(`[data-composer="${CSS.escape(focusKey)}"]`);
			if (el) {
				el.focus({ preventScroll: true });
				if (caret && focusKey === active) el.setSelectionRange(caret[0], caret[1]);
			}
		}
	}

	// ---------- mermaid ----------

	let mermaidReady;
	function renderMermaid() {
		mermaidReady ??= new Promise((resolve, reject) => {
			const script = document.createElement("script");
			script.src = `/assets/mermaid.js?token=${encodeURIComponent(token)}`;
			script.onload = () => {
				const dark = matchMedia("(prefers-color-scheme: dark)").matches;
				window.mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: dark ? "dark" : "neutral" });
				resolve(window.mermaid);
			};
			script.onerror = () => reject(new Error("Could not load Mermaid"));
			document.head.append(script);
		});
		mermaidReady
			.then((mermaid) => mermaid.run({ nodes: document.querySelectorAll("pre.mermaid:not([data-processed])") }))
			.catch((error) => toast(`Diagram error: ${error.message}`));
	}

	load();
	connect();
})();
