---
name: web-browser
description: "Allows to interact with web pages by performing actions such as clicking buttons, filling out forms, and navigating links. It works by remote controlling Google Chrome or Chromium browsers using the Chrome DevTools Protocol (CDP). When Claude needs to browse the web, it can use this skill to do so."
license: Stolen from Mario
---

# Web Browser Skill

Minimal CDP tools for collaborative site exploration.

## Prerequisites and targeting limits

- The bundled launcher currently supports macOS Google Chrome and uses `open`; it is not a cross-platform Chromium launcher.
- Install the nested script dependency from `scripts/` with `npm install` before first use if `ws` is unavailable. Package installation needs explicit approval because it may use the network.
- The helpers select the last page target returned by CDP, not the focused tab. Keep exactly one eligible page open in the dedicated automation profile; if several page tabs exist, resolve that ambiguity before navigation, evaluation, screenshots, picking, or cookie actions.

## Start Chrome

```bash
./scripts/start.js
```

Start or reuse Chrome on `:9222` with remote debugging. The browser uses a
persistent, dedicated profile at `~/.cache/agent-web/chrome-profile`; it does
not close Chrome or copy data from your normal profiles. Sign in once in the
automation profile when a site requires authentication.

## Navigate

```bash
./scripts/nav.js https://example.com
./scripts/nav.js https://example.com --new
```

Navigate the selected page target or open a new tab. `Page.navigate` returning is not proof that the page loaded successfully. Before the next action, use `eval.js` to verify `location.href` and a bounded readiness condition such as `document.readyState`; do not chain a sensitive action immediately after `nav.js`.

## Evaluate JavaScript

```bash
./scripts/eval.js 'document.title'
./scripts/eval.js 'document.querySelectorAll("a").length'
./scripts/eval.js 'JSON.stringify(Array.from(document.querySelectorAll("a")).map(a => ({ text: a.textContent.trim(), href: a.href })).filter(link => !link.href.startsWith("https://")))'
```

Execute JavaScript in active tab (async context).  Be careful with string escaping, best to use single quotes.

## Screenshot

```bash
./scripts/screenshot.js
```

Screenshot current viewport, returns temp file path

## Pick Elements

```bash
./scripts/pick.js "Click the submit button"
```

Interactive element picker. Click to select, Cmd/Ctrl+Click for multi-select, Enter to finish.

## Dismiss Cookie Dialogs

```bash
./scripts/dismiss-cookies.js          # Accept cookies
./scripts/dismiss-cookies.js --reject # Reject cookies (where possible)
```

Dismisses positively identified EU cookie consent dialogs. If no known consent UI is found, it returns without clicking rather than guessing from page-wide button text.

Run only after navigation readiness has been verified:
```bash
./scripts/nav.js https://example.com
./scripts/eval.js 'JSON.stringify({href: location.href, readyState: document.readyState})'
./scripts/dismiss-cookies.js
```

## Background Logging (Console + Errors + Network)

Automatically started by `start.js` and writes JSONL logs to:

```
~/.cache/agent-web/logs/YYYY-MM-DD/<targetId>.jsonl
```

Manually start:
```bash
./scripts/watch.js
```

Tail latest log:
```bash
./scripts/logs-tail.js           # dump current log and exit
./scripts/logs-tail.js --follow  # keep following
```

Summarize network responses:
```bash
./scripts/net-summary.js
```
