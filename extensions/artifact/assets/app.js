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
		expanded: new Map(),
		railScroll: 0,
		selected: undefined,
		editor: undefined,
		loadingSource: false,
		focus: undefined,
		/** A document the agent asked to show while a comment was being typed. */
		showLater: undefined,
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
	/** Whitespace-collapsed text of root, with each character's source [node, offset]. */
	function normalizedText(root) {
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
		return { norm, map };
	}

	function highlight(root, quote, context, cls = "hl", occurrence, threadId) {
		const { norm, map } = normalizedText(root);
		const q = normalizeText(quote);
		let start = -1;
		if (q && occurrence !== undefined) {
			for (let n = 0, p = norm.indexOf(q); p >= 0; n++, p = norm.indexOf(q, p + 1)) {
				if (n === occurrence) {
					start = p;
					break;
				}
			}
		}
		if (start < 0 && context) {
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
			const mark = h("mark", {
				class: cls,
				"data-thread-anchor": threadId,
				...(threadId === undefined ? {} : { role: "button", tabindex: "0", "aria-label": `Show thread #${threadId}` }),
			});
			middle.replaceWith(mark);
			mark.append(middle);
			first ??= mark;
		}
		return first;
	}

	// ---------- theme ----------

	const systemDark = matchMedia("(prefers-color-scheme: dark)");
	const currentTheme = () => document.documentElement.dataset.theme || (systemDark.matches ? "dark" : "light");

	function toggleTheme() {
		const next = currentTheme() === "dark" ? "light" : "dark";
		document.documentElement.dataset.theme = next;
		// A cookie, not localStorage: cookies ignore the port, so every session's viewer shares it.
		document.cookie = `artifact-theme=${next}; Max-Age=31536000; Path=/; SameSite=Strict`;
		render();
	}

	systemDark.addEventListener("change", () => !document.documentElement.dataset.theme && render());

	// ---------- data ----------

	async function load() {
		try {
			const doc = await api(`/api/doc/${docId}`);
			for (const t of doc.threads) {
				if (t.status === "resolved" && state.doc?.threads.find((previous) => previous.id === t.id)?.status !== "resolved") state.expanded.delete(t.id);
			}
			state.doc = doc;
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
		events.addEventListener("show", (e) => {
			const { url } = JSON.parse(e.data);
			if (!/^http:\/\/127\.0\.0\.1:\d+\/doc\//.test(url)) return;
			if (state.editor || state.loadingSource || hasUnsavedText()) {
				state.showLater = url;
				render();
			} else location.href = url;
		});
		events.addEventListener("error", () => {
			state.connected = false;
			renderStatus();
			// The browser retries dropped connections itself, but gives up on an error response
			// (e.g. a restarted session that hasn't reopened this document yet).
			if (events.readyState === EventSource.CLOSED) setTimeout(connect, 3000);
		});
	}

	// ---------- actions ----------

	function hasUnsavedText() {
		return (state.editor && state.editor.source !== state.editor.original) || [...state.composers.values()].some((text) => text.length > 0);
	}

	let navigationConfirmed = false;
	function guardNavigation(event) {
		if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || !hasUnsavedText()) return;
		if (window.confirm("Leave this document and discard unsaved text?")) navigationConfirmed = true;
		else event.preventDefault();
	}

	window.addEventListener("beforeunload", (event) => {
		if (navigationConfirmed) {
			navigationConfirmed = false;
			return;
		}
		if (!hasUnsavedText()) return;
		event.preventDefault();
		event.returnValue = "";
	});

	async function editSource() {
		state.loadingSource = true;
		render();
		try {
			const { source, version } = await api(`/api/doc/${docId}/source`);
			state.editor = { source, original: source, version, saving: false, error: undefined };
			state.focus = "source";
		} catch (error) {
			toast(error.message);
		} finally {
			state.loadingSource = false;
			render();
		}
	}

	async function saveSource() {
		const editor = state.editor;
		if (!editor || editor.saving) return;
		editor.saving = true;
		editor.error = undefined;
		render();
		try {
			await api(`/api/doc/${docId}/source`, { source: editor.source, version: editor.version });
			state.editor = undefined;
			await load();
		} catch (error) {
			editor.saving = false;
			editor.error = error.message;
			state.focus = "source";
			render();
		}
	}

	function sourceEditor() {
		const editor = state.editor;
		const textarea = h("textarea", {
			id: "markdown-source",
			"data-source-editor": true,
			spellcheck: "false",
			readonly: editor.saving,
			"aria-describedby": editor.error ? "source-help source-error" : "source-help",
			oninput: (event) => { editor.source = event.target.value; },
		});
		textarea.value = editor.source;
		return h("section", { class: "source-editor", "aria-label": "Edit Markdown" },
			h("div", { class: "source-heading" }, h("label", { for: "markdown-source" }, "Markdown source")),
			h("p", { id: "source-help", class: "source-help" }, "You’re editing the source. Take turns: while you write, the agent reviews without editing."),
			textarea,
			editor.error && h("p", { id: "source-error", class: "source-error", role: "alert" }, editor.error),
			h("div", { class: "source-actions" },
				h("button", { class: "btn btn-primary", disabled: editor.saving, onclick: saveSource }, editor.saving ? "Saving…" : "Save"),
				h("button", { class: "btn", disabled: editor.saving, onclick: () => { state.editor = undefined; render(); } }, "Cancel"),
			),
		);
	}

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
			if (resolved) state.expanded.set(id, false);
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

	const STATUS_LABEL = { draft: "Draft", sent: "Waiting for reply", review: "Review comment", replied: "Replied", resolved: "Resolved" };

	function updateSelected() {
		app.querySelectorAll("[data-thread]").forEach((el) => el.classList.toggle("selected", Number(el.dataset.thread) === state.selected));
		app.querySelectorAll("[data-thread-anchor]").forEach((el) => el.classList.toggle("selected", Number(el.dataset.threadAnchor) === state.selected));
		const selected = state.doc?.threads.find((t) => t.id === state.selected);
		app.querySelectorAll(".block").forEach((el) => el.classList.toggle("selected", el.dataset.block === selected?.attachment.blockId));
	}

	function selectThread(id, destination) {
		state.selected = id;
		if (destination === "thread") {
			const card = app.querySelector(`[data-thread="${id}"]`);
			if (card?.classList.contains("collapsed")) {
				state.expanded.set(id, true);
				render();
			}
		}
		updateSelected();
		const anchor = app.querySelector(`[data-thread-anchor="${id}"]`);
		const attachment = state.doc?.threads.find((t) => t.id === id)?.attachment;
		const passage = anchor ?? (attachment?.blockId && app.querySelector(`[data-block="${CSS.escape(attachment.blockId)}"] .block-body`));
		const target = destination === "thread" ? app.querySelector(`[data-thread="${id}"]`) : passage;
		if (destination === "passage" && target && !anchor) target.setAttribute("tabindex", "-1");
		const focusTarget = destination === "thread" ? target?.querySelector("[data-thread-toggle]") : target;
		focusTarget?.focus({ preventScroll: true });
		target?.scrollIntoView({ block: destination === "thread" ? "start" : "center", inline: "nearest" });
		const rail = target?.closest(".comment-rail");
		if (rail) state.railScroll = rail.scrollTop;
	}

	function thread(t) {
		const collapsed = !(state.expanded.get(t.id) ?? t.status !== "resolved");
		const head = h(
			"div",
			{ class: "thread-head" },
			h("strong", {}, `#${t.id}`),
			h("span", { class: `badge badge-${t.status}` }, STATUS_LABEL[t.status]),
			t.attachment.status === "section" && h("span", { class: "badge badge-outdated" }, "Text changed"),
			t.attachment.status === "outdated" && h("span", { class: "badge badge-outdated" }, "Outdated"),
			h("span", { class: "spacer" }),
			h("button", {
				class: "btn btn-quiet thread-toggle",
				"data-thread-toggle": t.id,
				"aria-expanded": String(!collapsed),
				"aria-controls": `thread-body-${t.id}`,
				"aria-label": `${collapsed ? "Expand" : "Collapse"} thread #${t.id}`,
				onclick: () => { state.expanded.set(t.id, collapsed); state.selected = t.id; render(); },
			}, collapsed ? "Expand" : "Collapse"),
		);
		const replyKey = `thread:${t.id}`;
		const hasDrafts = t.status === "draft";
		return h(
			"div",
			{
				class: `thread${collapsed ? " collapsed" : ""}`,
				"data-thread": t.id,
				onclick: (event) => {
					if (!event.target.closest("button, a, textarea, .composer")) selectThread(t.id, "passage");
				},
			},
			head,
			h("div", { id: `thread-body-${t.id}`, hidden: collapsed },
				t.quote && h("div", { class: "thread-quote" }, (t.diagram ? "Diagram label: " : "") + t.quote),
				t.attachment.status !== "outdated" && h("button", {
					class: "btn btn-quiet thread-anchor-link",
					onclick: () => selectThread(t.id, "passage"),
					"aria-label": `Show passage for thread #${t.id}`,
				}, "Show passage ↗"),
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
			),
		);
	}

	function block(b, threads) {
		const body = h("div", { class: "block-body" });
		body.innerHTML = b.html; // Server-rendered with raw HTML escaped.
		const comments = h("aside", { class: "block-comments", "data-comment-block": b.id, "aria-label": "Comments on this passage" });
		for (const t of threads) {
			if (t.attachment.status === "exact" && !t.diagram) highlight(body, t.highlight ?? t.quote, t.context, "hl", t.occurrence, t.id);
			comments.append(thread(t));
		}
		for (const [key, anchor] of state.pending) {
			if (anchor.blockId !== b.id) continue;
			if (!anchor.label) highlight(body, anchor.quote, anchor.context, "hl hl-pending", anchor.occurrence);
			comments.append(composer(key, "Comment…"));
		}
		return h("section", { class: `block block-${b.kind}${threads.length ? " has-threads" : ""}`, "data-block": b.id }, body, comments);
	}

	const wideComments = matchMedia("(min-width: 1200px)");

	function placeComments() {
		const doc = app.querySelector(".doc");
		if (!doc) return;
		const rail = doc.querySelector(".comment-rail");
		const focused = document.activeElement;
		const inputScroll = focused instanceof HTMLTextAreaElement ? [focused.scrollTop, focused.scrollLeft] : undefined;
		const scroll = [window.scrollX, window.scrollY];
		if (wideComments.matches && rail.children.length) state.railScroll = rail.scrollTop;
		for (const group of doc.querySelectorAll(".block-comments")) {
			if (!group.children.length) continue;
			const parent = wideComments.matches ? rail : doc.querySelector(`[data-block="${CSS.escape(group.dataset.commentBlock)}"]`);
			if (group.parentElement !== parent) parent.append(group);
		}
		if (wideComments.matches) rail.scrollTop = state.railScroll;
		if (focused?.isConnected && focused !== document.activeElement) focused.focus({ preventScroll: true });
		if (inputScroll) [focused.scrollTop, focused.scrollLeft] = inputScroll;
		window.scrollTo(...scroll);
	}

	wideComments.addEventListener("change", placeComments);

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

	/** An element's own text: list items without their nested lists, table cells joined by spaces. */
	function ownText(el) {
		if (el.tagName === "TR") return [...el.cells].map((c) => normalizeText(c.textContent)).join(" ");
		const clone = el.cloneNode(true);
		clone.querySelectorAll("ul, ol, .thread, .composer").forEach((n) => n.remove());
		return normalizeText(clone.textContent);
	}

	/** Text around a span of the block, and which copy of the quote it is, so repeated text can be told apart. */
	function locate(body, quote, startNode, startOffset, length) {
		let full = "";
		let offset = 0;
		for (const node of textNodes(body)) {
			if (node === startNode) offset = full.length + startOffset;
			full += node.data;
		}
		const { norm, map } = normalizedText(body);
		let at = map.findIndex(([node, i]) => node === startNode && i >= startOffset);
		if (at < 0) at = norm.length;
		let occurrence = 0;
		for (let p = norm.indexOf(quote); p >= 0 && p < at; p = norm.indexOf(quote, p + 1)) occurrence++;
		return { context: normalizeText(full.slice(Math.max(0, offset - 80), offset + length + 80)), occurrence };
	}

	function commentOnLine() {
		if (!lineTarget) return;
		const own = textNodes(lineTarget).filter((n) => lineTarget.tagName !== "LI" || n.parentElement.closest("li") === lineTarget);
		const body = lineTarget.closest(".block-body");
		const length = own.reduce((sum, n) => sum + n.data.length, 0);
		const quote = ownText(lineTarget);
		openNew({ blockId: blockIdOf(lineTarget), quote, ...(own.length && body ? locate(body, quote, own[0], 0, length) : {}) });
	}

	function docOffset(rect) {
		const doc = app.querySelector(".doc").getBoundingClientRect();
		return { top: rect.top - doc.top, bottom: rect.bottom - doc.top, left: rect.left - doc.left, right: rect.right - doc.left };
	}

	app.addEventListener("mousemove", (e) => {
		if (e.target === lineAdd) return;
		const el = commentable(e.target);
		// Over margins and gaps (e.g. on the way to the +), keep the current line; hide only over other UI.
		if (!el && !(e.target instanceof Element && e.target.closest(".thread, .composer, .topbar, .sidebar, .outdated"))) return;
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
		// Build the quote from document text only, skipping threads placed between lines.
		let raw = "";
		let startNode;
		let startOffset = 0;
		for (const node of textNodes(body)) {
			if (!range.intersectsNode(node)) continue;
			const from = node === range.startContainer ? range.startOffset : 0;
			const to = node === range.endContainer ? range.endOffset : node.data.length;
			if (!startNode) [startNode, startOffset] = [node, from];
			raw += node.data.slice(from, to);
		}
		const quote = normalizeText(raw);
		if (!quote) return;
		selection = { blockId: blockIdOf(body), quote, ...locate(body, quote, startNode, startOffset, raw.length) };
		const rects = range.getClientRects();
		const last = docOffset(rects[rects.length - 1] ?? range.getBoundingClientRect());
		selAdd.style.top = `${last.bottom + 6}px`;
		selAdd.style.left = `${Math.max(0, last.right - 40)}px`;
		selAdd.hidden = false;
	}

	document.addEventListener("mouseup", () => setTimeout(updateSelection));
	document.addEventListener("keyup", (e) => e.shiftKey && updateSelection());

	function activateAnchor(event) {
		if (!(event.target instanceof Element)) return;
		let mark = event.target.closest("[data-thread-anchor]");
		if (!mark) return;
		if (event.type === "keydown" && event.key !== "Enter" && event.key !== " ") return;
		if (event.type === "click" && !window.getSelection()?.isCollapsed) return;
		event.preventDefault();
		const ids = [];
		while (mark) {
			ids.unshift(Number(mark.dataset.threadAnchor));
			mark = mark.parentElement?.closest("[data-thread-anchor]");
		}
		selectThread(ids[(ids.indexOf(state.selected) + 1) % ids.length], "thread");
	}

	app.addEventListener("click", activateAnchor);
	app.addEventListener("keydown", activateAnchor);

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
					docs.map((d) => h("a", { href: d.url, onclick: guardNavigation, class: d.id === docId && !d.session ? "current" : undefined }, d.path)),
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
		const focused = document.activeElement;
		const active = focused?.dataset?.composer;
		const activeSource = focused?.hasAttribute("data-source-editor");
		const activeToggle = focused?.dataset?.threadToggle;
		const caret = active ? [focused.selectionStart, focused.selectionEnd, focused.selectionDirection] : undefined;
		const inputScroll = active ? [focused.scrollTop, focused.scrollLeft] : undefined;
		const source = app.querySelector("[data-source-editor]");
		if (source && state.editor) {
			state.editor.caret = [source.selectionStart, source.selectionEnd, source.selectionDirection];
			state.editor.scroll = [source.scrollTop, source.scrollLeft];
		}
		const scroll = window.scrollY;
		const rail = app.querySelector(".comment-rail");
		if (wideComments.matches && rail?.children.length) state.railScroll = rail.scrollTop;

		const doc = state.doc;
		if (doc) document.title = doc.title;
		lineTarget = undefined;
		lineAdd.hidden = true;
		selAdd.hidden = true;
		const drafts = doc ? doc.threads.filter((t) => t.status === "draft").length : 0;

		const byBlock = new Map();
		const outdated = [];
		const blockIds = new Set(doc?.blocks.map((b) => b.id));
		const stranded = [...state.pending].filter(([, anchor]) => !blockIds.has(anchor.blockId));
		for (const t of doc?.threads ?? []) {
			if (t.attachment.status === "outdated") outdated.push(t);
			else {
				if (!byBlock.has(t.attachment.blockId)) byBlock.set(t.attachment.blockId, []);
				byBlock.get(t.attachment.blockId).push(t);
			}
		}

		const main = state.editor
			? sourceEditor()
			: state.error
			? h("div", { class: "error-page" }, state.error)
			: !doc
				? h("div", { class: "empty" }, "Loading…")
				: [
						h("article", { class: "doc" },
							h("div", { class: "doc-prose" }, doc.blocks.map((b) => block(b, byBlock.get(b.id) ?? []))),
							h("aside", {
								class: "comment-rail", "aria-label": "Document comments", tabindex: "0",
								onscroll: (event) => { if (wideComments.matches) state.railScroll = event.currentTarget.scrollTop; },
							}),
							lineAdd, selAdd,
						),
						stranded.length > 0 &&
							h(
								"section",
								{ class: "outdated" },
								h("h2", {}, "Comments in progress on text that changed"),
								stranded.map(([key]) => composer(key, "Comment…")),
							),
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
						state.showLater && h("a", { class: "btn btn-quiet", href: state.showLater, onclick: guardNavigation }, "New document opened · view"),
						!state.editor && h("button", { class: "btn", onclick: editSource, disabled: !doc || state.loadingSource }, state.loadingSource ? "Loading…" : "Edit"),
						h("button", { class: "btn btn-quiet", onclick: toggleTheme }, currentTheme() === "dark" ? "Light mode" : "Dark mode"),
						h("button", { class: "btn btn-primary", disabled: drafts === 0, onclick: sendAll }, `Send all (${drafts})`),
					),
					main,
				),
			),
		);
		placeComments();
		renderStatus();
		updateSelected();

		if (doc?.hasMermaid && !state.editor) renderMermaid();
		window.scrollTo(0, scroll);
		const requestedFocus = state.focus;
		const focusKey = requestedFocus ?? (activeSource ? "source" : active);
		state.focus = undefined;
		const editorInput = app.querySelector("[data-source-editor]");
		if (editorInput) {
			if (focusKey === "source") editorInput.focus({ preventScroll: true });
			if (state.editor.caret) editorInput.setSelectionRange(...state.editor.caret);
			if (state.editor.scroll) [editorInput.scrollTop, editorInput.scrollLeft] = state.editor.scroll;
		}
		if (focusKey && focusKey !== "source") {
			const el = app.querySelector(`[data-composer="${CSS.escape(focusKey)}"]`);
			if (el && !el.closest("[hidden]")) {
				el.focus({ preventScroll: true });
				if (requestedFocus && el.closest(".comment-rail")) el.scrollIntoView({ block: "nearest", inline: "nearest" });
				if (caret && focusKey === active) {
					el.setSelectionRange(...caret);
					[el.scrollTop, el.scrollLeft] = inputScroll;
				}
			}
		} else if (!focusKey && activeToggle) {
			app.querySelector(`[data-thread-toggle="${activeToggle}"]`)?.focus({ preventScroll: true });
		}
	}

	// ---------- mermaid ----------

	let mermaidReady;
	function renderMermaid() {
		mermaidReady ??= new Promise((resolve, reject) => {
			const script = document.createElement("script");
			script.src = `/assets/mermaid.js?token=${encodeURIComponent(token)}`;
			script.onload = () => resolve(window.mermaid);
			script.onerror = () => reject(new Error("Could not load Mermaid"));
			document.head.append(script);
		});
		mermaidReady
			.then((mermaid) => {
				mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: currentTheme() === "dark" ? "dark" : "neutral" });
				return mermaid.run({ nodes: document.querySelectorAll("pre.mermaid:not([data-processed])") });
			})
			.catch((error) => toast(`Diagram error: ${error.message}`));
	}

	load();
	connect();
})();
