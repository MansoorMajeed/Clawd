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
		/** Open composers keyed by "new:<n>" or "thread:<id>", value is the draft text. */
		composers: new Map(),
		/** What a new comment is about, keyed like composers: { blockId, quote, context?, label? }. */
		pending: new Map(),
		nextNew: 0,
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

	const normalizeText = (text) => text.replace(/\s+/g, " ").trim();
	const blockIdOf = (el) => el.closest("[data-block]")?.dataset.block;

	/** Text nodes under root, skipping callout titles and the thread/composer UI placed inside the document. */
	function textNodes(root) {
		const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
			acceptNode: (n) =>
				n.parentElement?.closest(".thread, .composer, .callout-title") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
		});
		const out = [];
		for (let n = walker.nextNode(); n; n = walker.nextNode()) out.push(n);
		return out;
	}

	/** Wrap the quote (located via its context when possible) in <mark>; returns the first mark. */
	function highlight(root, quote, context) {
		const map = [];
		let norm = "";
		for (const node of textNodes(root)) {
			for (let i = 0; i < node.data.length; i++) {
				if (/\s/.test(node.data[i])) {
					if (norm && !norm.endsWith(" ")) {
						norm += " ";
						map.push([node, i]);
					}
				} else {
					norm += node.data[i];
					map.push([node, i]);
				}
			}
		}
		const q = normalizeText(quote);
		let start = -1;
		if (context) {
			const c = normalizeText(context);
			const ci = norm.indexOf(c);
			const qi = ci >= 0 ? norm.indexOf(q, ci) : -1;
			if (qi >= 0 && qi + q.length <= ci + c.length) start = qi;
		}
		if (start < 0) start = norm.indexOf(q);
		if (start < 0 || !q) return undefined;
		const segments = new Map();
		for (let k = start; k < start + q.length; k++) {
			const [node, i] = map[k];
			const seg = segments.get(node) ?? [i, i];
			segments.set(node, [Math.min(seg[0], i), Math.max(seg[1], i)]);
		}
		let first;
		for (const [node, [from, to]] of segments) {
			const middle = node.splitText(from);
			middle.splitText(to - from + 1);
			const mark = h("mark", { class: "hl" });
			middle.replaceWith(mark);
			mark.append(middle);
			first ??= mark;
		}
		return first;
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
		state.pending.delete(key);
		render();
	}

	function openNew(anchor) {
		if (!anchor.blockId || !anchor.quote) return;
		const key = `new:${++state.nextNew}`;
		state.pending.set(key, anchor);
		window.getSelection()?.removeAllRanges();
		openComposer(key);
	}

	async function submit(key, sendNow) {
		const text = (state.composers.get(key) ?? "").trim();
		if (!text) return;
		const [kind, id] = key.split(":");
		await act(async () => {
			const body = kind === "new" ? { ...state.pending.get(key), text } : { threadId: Number(id), text };
			const { threadId } = await api(`/api/doc/${docId}/comments`, body);
			state.composers.delete(key);
			state.pending.delete(key);
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
		const anchor = state.pending.get(key);
		return h(
			"div",
			{ class: "composer" },
			anchor && h("div", { class: "thread-quote" }, (anchor.label ? "Diagram label: " : "") + anchor.quote),
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
			t.attachment.status === "section" && h("span", { class: "badge badge-outdated" }, "Text changed"),
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
			t.quote && h("div", { class: "thread-quote" }, (t.diagram ? "Diagram label: " : "") + t.quote),
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
		const body = h("div", { class: "block-body" });
		body.innerHTML = b.html; // Server-rendered with raw HTML escaped.
		const section = h("section", { class: `block block-${b.kind}${threads.length ? " has-threads" : ""}`, "data-block": b.id }, body);
		for (const t of threads) {
			const el = thread(t);
			const mark = t.attachment.status === "exact" && !t.diagram && t.status !== "resolved" ? highlight(body, t.quote, t.context) : undefined;
			const host = mark && (mark.closest("li") ?? mark.closest("p, h1, h2, h3, h4, h5, h6, pre"));
			if (host?.tagName === "LI") host.append(el);
			else if (host && !host.closest("table")) host.after(el);
			else section.append(el);
		}
		for (const [key, anchor] of state.pending) if (anchor.blockId === b.id) section.append(composer(key, "Comment…"));
		return section;
	}

	// ---------- choosing what to comment on ----------

	const COMMENTABLE = "p, li, tr, h1, h2, h3, h4, h5, h6, pre";
	let lineTarget;
	let selection;
	const lineAdd = h("button", { class: "line-add", title: "Comment on this", "aria-label": "Comment on this", hidden: true, onclick: () => commentOnLine() }, "+");
	const selAdd = h("button", { class: "btn btn-primary sel-add", hidden: true, onmousedown: (e) => e.preventDefault(), onclick: () => selection && openNew(selection) }, "Comment");

	function commentable(target) {
		if (!(target instanceof Element) || target.closest(".thread, .composer, pre.mermaid")) return undefined;
		const el = target.closest(COMMENTABLE);
		return el?.closest(".block-body") ? el : undefined;
	}

	/** An element's own text: list items without their nested lists, table rows as "a | b". */
	function ownText(el) {
		if (el.tagName === "TR") return [...el.cells].map((c) => normalizeText(c.textContent)).join(" | ");
		const clone = el.cloneNode(true);
		clone.querySelectorAll("ul, ol, .thread, .composer").forEach((n) => n.remove());
		return normalizeText(clone.textContent);
	}

	function commentOnLine() {
		if (lineTarget) openNew({ blockId: blockIdOf(lineTarget), quote: ownText(lineTarget) });
	}

	function docOffset(rect) {
		const doc = app.querySelector(".doc").getBoundingClientRect();
		return { top: rect.top - doc.top, bottom: rect.bottom - doc.top, left: rect.left - doc.left, right: rect.right - doc.left };
	}

	app.addEventListener("mousemove", (e) => {
		if (e.target === lineAdd) return;
		const el = commentable(e.target);
		if (el === lineTarget) return;
		lineTarget = el;
		lineAdd.hidden = !el;
		if (el) lineAdd.style.top = `${docOffset(el.getBoundingClientRect()).top}px`;
	});

	app.addEventListener("mouseleave", () => {
		lineTarget = undefined;
		lineAdd.hidden = true;
	});

	function updateSelection() {
		selection = undefined;
		selAdd.hidden = true;
		const sel = window.getSelection();
		if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
		const range = sel.getRangeAt(0).cloneRange();
		const startEl = range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement;
		if (!startEl || startEl.closest(".thread, .composer, pre.mermaid")) return;
		const body = startEl.closest(".block-body");
		if (!body) return;
		if (!body.contains(range.endContainer)) range.setEnd(body, body.childNodes.length);
		const raw = range.toString();
		const quote = normalizeText(raw);
		if (!quote) return;
		let full = "";
		let offset = 0;
		for (const node of textNodes(body)) {
			if (node === range.startContainer) offset = full.length + range.startOffset;
			full += node.data;
		}
		const context = normalizeText(full.slice(Math.max(0, offset - 80), offset + raw.length + 80));
		selection = { blockId: blockIdOf(body), quote, context };
		const rects = range.getClientRects();
		const last = docOffset(rects[rects.length - 1] ?? range.getBoundingClientRect());
		selAdd.style.top = `${last.bottom + 6}px`;
		selAdd.style.left = `${Math.max(0, last.right - 40)}px`;
		selAdd.hidden = false;
	}

	document.addEventListener("mouseup", () => setTimeout(updateSelection));
	document.addEventListener("keyup", (e) => e.shiftKey && updateSelection());

	app.addEventListener("click", (e) => {
		const svg = e.target instanceof Element && e.target.closest("pre.mermaid svg");
		if (!svg) return;
		const label = e.target.closest("text, .nodeLabel, .edgeLabel, .label, foreignObject");
		const quote = label && normalizeText(label.textContent);
		if (quote && quote.length <= 200) openNew({ blockId: blockIdOf(svg), quote, label: true });
	});

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
		lineTarget = undefined;
		lineAdd.hidden = true;
		selAdd.hidden = true;
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
						h("article", { class: "doc" }, doc.blocks.map((b) => block(b, byBlock.get(b.id) ?? [])), lineAdd, selAdd),
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
