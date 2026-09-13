# SupportLayer — Agent Guide

SupportLayer is a **zero-backend, drop-in diagnostic and live P2P support widget** for web
applications, and the third sibling in the Layer family (MailLayer, PhoneLayer,
SupportLayer). Repo is a **static site + two single-file deliverables**: no build step, no
bundler, no runtime dependencies, no framework.

## Files

- `supportlayer.js` — the product. Vanilla JS IIFE, one global `window.SupportLayer`.
- `agent.html` — the support agent dashboard. Single self-contained HTML file (inline
  CSS/JS), loads PeerJS from CDN only when it is not running in simulated mode.
- `index.html` — landing page + **simulated demo** (mock customer app, embedded agent
  dashboard, mock webhook inspector, MailLayer + PhoneLayer live demos).
- `test.html` — integration harness: loads the widget in every mode against a local
  webhook catcher, and links out to a real `agent.html` session.
- `serve.js` — zero-dependency static dev server (`npm start`).
- `tests/e2e.mjs` — Puppeteer driver for the headless/headed smoke + interaction suite.
- `favicon.svg` — hand-written, no external asset dependencies.
- `PRD-SupportLayer.md` — the master dev document (PRD + implementation guide + task list).
  **Still present in-repo; treat it as the source of truth for scope.**
- `README.md` — public docs.
- `todo.md` — live task list. **Update it as work lands.**
- `history.md` — chronological dev log. **Append an entry for every meaningful change.**

## Architecture rules (from PRD Part 4 — treated as law)

1. **Fully client-centric.** No middleware, no WebSocket relay, no S3 bucket, no Node
   backend. The client POSTs straight to the customer's webhook and WebRTC stays P2P.
   Do not propose adding infrastructure to the architecture.
2. **Strict YAGNI.** Prefer a native browser API over a library. Never add `rrweb`,
   `html2canvas`, `html2pdf`, screenshot services, or a DOM serializer. Use
   `getDisplayMedia` + `<canvas>`.
3. **No synthetic keystroke streams.** Never attempt to defeat an SPA framework by
   dispatching `KeyboardEvent` sequences. Use **Directed Typing**: insert through the
   native value setter (React/Vue-safe) *and* always surface the copy/paste tooltip as the
   guaranteed path.
4. **State mirroring.** Every state change is mirrored to
   `localStorage['supportlayer_session']`. Because WebRTC cannot survive a reload,
   rehydrating into `WAITING`/`CONNECTED` without a live peer **must** show the
   `view-resume` UI. Never auto-reconnect without a user gesture — browsers block
   automated media capture.
5. **Coordinate math.** Every coordinate on the wire is **normalized `0.0`–`1.0`**, never
   pixels. The agent dashboard must normalize against the *rendered video* geometry
   (accounting for `object-fit: contain` letterboxing) and, when the shared surface is the
   whole screen, offset by the client's reported window geometry. Getting this wrong
   silently misaligns clicks — it is the #1 regression risk in this repo.
6. **Shadow DOM isolation, host-document privacy.** Widget UI lives in a shadow root so
   host CSS cannot reach it. Privacy blur is the opposite: it is applied to the **host
   `document.body`** (injected `<style>` + `TreeWalker` text wrapping). `removePrivacyBlur()`
   must unwrap every node and delete every injected tag — a leak here breaks the host app.

## Deliverable surface (`supportlayer.js`)

- **Config** comes from `document.currentScript.dataset`: `webhook`, `mode`
  (`none|chat|audio|video`), `theme`, `headless`, `blur-selectors`, `blur-regex`,
  `fields` (JSON, `try/catch` parsed, defaults to a single `textarea`).
- **States:** `IDLE` → `WAITING` → `CONNECTED`, plus `SENDING` internals and
  `status: open|cancelled|completed` on the webhook payload.
- **Events:** `support_request` on first submit, `support_update` on resume / cancel /
  complete.
- **Headless API:** `window.SupportLayer.requestHelp()`, `.endSession()`, `.getState()`,
  plus `.reset()` (clears local + session storage, for demos and tests).
- **Anti-spam:** honeypot field, 60s `sessionStorage` rate limit, `isTrusted` click
  requirement on submit.
- **Transport:** PeerJS loaded by dynamic script injection. Client is the *callee* — the
  agent opens the data channel and announces `{t:'hello', agentPeerId}`, then the client
  calls back with its screen stream. This keeps one stable URL parameter (`?peer=<client>`).
- **Simulated mode (`data-demo="true"`):** swaps the PeerJS transport for a
  `BroadcastChannel` loopback bus and `getDisplayMedia` for a synthetic canvas frame. This
  exists so `index.html` can show a full end-to-end flow with zero backend and zero
  permissions prompt. **Never let simulated mode leak into production behavior** — the
  widget must only enter it from an explicit attribute or `?sl-demo=1`.
- **`splitPatterns()` — not `String.split(',')` — parses `blur-selectors` / `blur-regex`:** it
  splits on commas outside `{}`, `()` and `[]` and also accepts a JSON array, so `{2,}`
  quantifiers and `:is(.a, .b)` selectors survive. A naive comma split silently disabled regex
  redaction once; do not regress it.
- **`[hidden] { display: none !important; }` is declared in the shadow stylesheet on purpose.**
  Without it, any overlay carrying its own `display` value (`.sl-draw-hint`) stays visible and
  blocks host clicks even while `hidden` is set.
- **The loopback announce loop must die with its transport.** It stops on connect, on
  `close()`, and after 200 tries, and it captures `peerId` locally instead of reading
  `session` — otherwise a timer fires after teardown and throws on a null session.

## Agent dashboard (`agent.html`)

- URL contract: `agent.html?peer=<clientPeerId>`; `&demo=1` selects the loopback bus.
- No tool selected → laser click. Tools: **Laser**, **Type**, **Draw**, **Clear**,
  **End session**.
- The mock feed in demo mode is drawn at the *client's* viewport aspect ratio so
  normalized coordinates stay honest. It is labelled `SIMULATED FEED`; commands sent from
  it are real and land on the real page.
- Keep the log pane honest: every outgoing command is echoed with a timestamp.

## Demo architecture (`index.html`)

The landing page's demo is three real pieces wired together, not a mock:

1. `demo-app.html` in an iframe — a genuine customer page running the genuine widget.
2. `agent.html?demo=1` in a second iframe — the genuine console, talking over the `BroadcastChannel` loopback bus.
3. A payload inspector in the parent page — fed by the demo app's `postMessage` bridge of
   `supportlayer:webhook`, plus polling of `SupportLayer.getState()` and `__AgentConsole.state()`.

The customer frame is its own document on purpose: its viewport *is* the customer viewport, so the coordinates the
agent sends land exactly where the agent clicked. Do not move the demo app into the parent document — the mapping
breaks and the FAB/panel would cover the marketing page.

## Testing

- `npm start` then `node tests/e2e.mjs` (headless) or `node tests/e2e.mjs --headed`.
- The suite must stay green in **both** modes on every change: 84 checks cover config parsing, the request flow,
  redaction round-trips, coordinate accuracy (±12px), drawing auto-clear, directed typing, reload/resume, teardown,
  the harness assertions, and desktop/mobile layout. Headed runs have historically caught bugs headless missed
  (a loopback timer firing after teardown, the always-visible draw hint).
- **Idle pages must show zero agent chrome.** The overlay elements (`canvas.sl-draw`,
  `.sl-laser`, `.sl-draw-hint`, `.sl-typing`) all default to hidden and are only revealed
  while an agent command is live; the layout test asserts this on an idle page.
- `PORT=0` is exported by some shells and means "unset" — both `serve.js` and the test runner treat it that way.
- Both Chromium modes matter. Headless catches logic/console/network errors; **headed**
  catches rendering, `getDisplayMedia` permission flow, hover/focus behavior, and
  anything that depends on real window geometry.
- The suite must leave the console clean. Any `console.error` from the widget is a bug.
- Manual check before any release push: `index.html` demo end-to-end (report → blur →
  webhook → agent connects → laser/type/draw land on the mock app), then `test.html` with
  two real browser windows for the actual WebRTC path.

## Release workflow

- Bump the version in the `supportlayer.js` header comment **and**
  `window.SupportLayer.version`.
- Commit, push `main`. Update `todo.md` + `history.md` in the same commit as the change
  they describe, not afterwards.
- CDN URLs advertised on the landing page:
  - jsDelivr: `https://cdn.jsdelivr.net/gh/Spuds0588/SupportLayer@main/supportlayer.js`
  - GitHub Pages: `https://spuds0588.github.io/SupportLayer/supportlayer.js`
