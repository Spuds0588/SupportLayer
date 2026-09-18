# SupportLayer — Agent Guide

SupportLayer is a **zero-backend, drop-in diagnostic and live P2P support widget** for web
applications, and a sibling in the Layer family (MailLayer, PhoneLayer, ZipLayer). Repo is a
**static site + one single-file deliverable**: no build step, no bundler, no runtime
dependencies, no framework.

## Files

- `supportlayer.js` — the product, **both roles**. Vanilla JS IIFE, one global
  `window.SupportLayer`. There is no agent page: the agent loads the *customer's own URL*
  with `?sl_role=agent&peer=<id>` and this same script boots the agent view instead of
  the request button. Do not reintroduce a second HTML deliverable.
- `index.html` — landing page: a **value-first hero**, a **scripted storyboard** (`.story`), and a pointer at
  `INTEGRATION.md`. Deliberately *not* the configuration reference and deliberately *not* an
  interactive demo. The MailLayer and PhoneLayer scripts are still loaded — a `mailto:` or `tel:`
  link on the page still gets upgraded, silently — but only one quiet footer line names the sister
  projects (MailLayer, PhoneLayer, ZipLayer; ZipLayer is a link, not a script).
- `room.html` — dev fixture: `demo-app.html` loaded twice, once per role, for manual and automated
  two-role runs. See “Two roles, one document” below.
- `test.html` — integration harness: loads the widget in every mode against a local
  webhook catcher, and links out to a real agent-role session.
- `serve.js` — zero-dependency static dev server (`npm start`).
- `tests/e2e.mjs` — Puppeteer driver for the headless/headed smoke + interaction suite.
- `favicon.svg` — hand-written, no external asset dependencies.
- `PRD-SupportLayer.md` — the master dev document (PRD + implementation guide + task list).
  **Still present in-repo; treat it as the source of truth for scope.**
- `INTEGRATION.md` — the **consumer-facing** guide (install, attributes, webhook contract,
  framework recipes, verification checklist, troubleshooting). Written for an integrator or a
  coding agent dropping the widget into *another* app. Keep it in sync with the attribute
  table whenever config changes — it is the file people actually follow.
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
   pixels. The agent view must first size its shared surface to the customer's reported
   viewport aspect ratio, scale it proportionally inside the agent window, and normalize
   against that rendered surface (including any remaining `object-fit: contain`
   letterboxing). When the shared surface is the whole screen, offset by the client's
   reported window geometry. Getting this wrong silently misaligns clicks — it is the #1
   regression risk in this repo.
6. **Shadow DOM isolation, host-document privacy.** Widget UI lives in a shadow root so
   host CSS cannot reach it. Privacy blur is the opposite: it is applied to the **host
   `document.body`** (injected `<style>` + `TreeWalker` text wrapping). `removePrivacyBlur()`
   must unwrap every node and delete every injected tag — a leak here breaks the host app.

## Deliverable surface (`supportlayer.js`)

- **Config** comes from `document.currentScript.dataset`: `webhook`, `mode`
  (`none|chat|video`, with `audio` a deprecated alias for `video`), `theme`, `headless`,
  `blur-selectors`, `blur-regex`,
  `fields` (JSON, `try/catch` parsed, defaults to a single `textarea`), `demo`,
  `peer-cdn`, `live-base`, `color`, `label`/`title`/`chat-label`.
- **Role is a URL param, not an attribute.** `?sl_role=agent` (or `data-role="agent"`) flips
  `role` to `agent`. A bare `role=` param is deliberately ignored — host apps use that name
  for their own permissions and the widget must not hijack it.
- **The communication channel is the developer's decision, fixed at install time.**
  `data-mode` / `?sl_mode=` selects it and the customer's request panel simply *becomes* the
  chat thread or the call. There is intentionally **no in-session switcher**: neither the user
  nor the agent can turn a chat into a call. Do not add one.
- **The screen share is session-scoped and the customer cannot stop it.** In a live mode
  `beginScreenShare()` runs from the submit handler (the click's gesture is what `getDisplayMedia`
  needs, and the click's promise chain must not await first) and its stream is reused by
  `getScreenSnapshot()` as the report's one-frame snapshot — one prompt, not two. It ends with
  `stopSharing()` and nowhere else. `onShareLost()` covers a track that dies underneath us (the
  browser's own capture control): it says so on both sides and offers a gesture-gated resume.
  Above all: **`paintShareState()` must never render a stop control**, and no "Share my screen" /
  "Stop sharing" toggle may come back. The agent guiding against a screen the customer can revoke is
  not this product. `audio` is a deprecated alias for `video` for the same reason — a mode that adds
  no capability is a branch that rots.
- **`liveSessionUrl(peerId)`** builds the agent link as the customer's own `location.href`
  plus `sl_role=agent&peer=<id>` (plus `sl-demo=1` in demo mode). `data-live-base` overrides
  the base. This is what lands in the webhook payload as `live_session_url`.
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
- **`selfPeerId()` — never a local random — is what goes in the `hello` handshake.** The agent tells
  the customer which id to dial with its screen (`agentPeerId`), and that call is a real PeerJS call
  to that string. `AGENT_ID` is a per-page random that no broker knows about; advertising it means
  the customer calls a peer that does not exist, PeerJS answers `peer-unavailable` (which the error
  handler deliberately swallows), and the agent's stage stays blank forever. The loopback bus ignores
  ids, so the whole demo suite passes either way — only `tests/live-session.mjs` can see it.
- **One file, two roles — never a second deliverable.** `agent.html` existed once and was removed:
  it duplicated the app shell, drifted from the widget, and broke on static-file CDNs (which serve
  `.html` as `text/plain`, so the console rendered as source code). The agent role now needs no page
  of its own, so a CDN install and a self-hosted install behave identically. Any change that adds a
  second HTML file, or that makes the agent link skip `location.href`, is a regression.
- **Reports, privacy blur and screen capture only ever run in the customer role.** The agent role
  must never POST a webhook or blur its own document. Guard new capture code on `!AGENT`.
- **The loopback announce loop must die with its transport.** It stops on connect, on
  `close()`, and after 200 tries, and it captures `peerId` locally instead of reading
  `session` — otherwise a timer fires after teardown and throws on a null session.

## Testing the live path (`tests/live-session.mjs`)

The demo suite (`tests/e2e.mjs`) runs the product over the loopback `BroadcastChannel` bus with
synthetic capture. That is honest about widget logic and coordinates and useless for three things:
PeerJS signalling, the `getDisplayMedia` permission flow, and a real media track. `live-session.mjs`
covers exactly those, in a real browser, with no `data-demo`:

```bash
npm run live:check      # two headless peers: verifies the path, then exits (exit 1 on failure)
npm run live:session    # opens a customer session and prints the agent URL, staying open
```

It turns the demo fixture into a real session with `demo-app.html?sl-demo=0` — which is why
`flagParam()` exists: an explicit `sl-demo=0` must be able to override `data-demo="true"`, or a page
that ships as a demo could never be tested for real. Run it before touching transport, media or the
role handshake.

**What it cannot tell you: whether the picture is right.** `--use-fake-device-for-media-stream`
supplies Chrome's synthetic test pattern, and on this host that is the only option — there is no window
manager, so capture selection only ever offers the DISPLAY (`displaySurface: monitor` even with
`--auto-select-desktop-capture-source`, `--auto-select-tab-capture-source-by-title` or
`preferCurrentTab`), and `--use-file-for-fake-video-capture` is ignored on the display path (frames
are byte-identical with and without it). Sharing the display would also put the operator's whole
desktop in front of the agent, which is never what a support session is for. So the tool proves
signalling, permission, track, decode and coordinates; for a picture the agent can actually read — and
to exercise the real capture picker — open `demo-app.html?sl-demo=0` in a normal browser and share
from there.

## Agent experience (`?sl_role=agent&peer=<clientPeerId>`)

The agent role is the same document with a param, so `AGENT` is true and `mountAgent()` replaces the
customer mount entirely: full-bleed stage, chat transcript, floating dock. `&sl-demo=1` selects the
loopback bus.

- **It should feel like a video meeting, not a dashboard.** One stage, one dock. No session lists,
  no metrics, no raw payload panes, no extra chrome — if a feature is not something the agent does
  *mid-call*, it does not belong on this surface.
- **The dock is a floating bottom bar of tools**, the way annotation works in Zoom/Meet: **Point**,
  **Click**, **Draw** (with colour swatches), **Clear**, **Chat**, **Report**, **End**. Point is the
  resting state; it moves a laser and clicks nothing, which is what makes it safe to leave armed.
- The dock publishes its measured height as `--sl-dock-h`; the toast and the coach line sit above
  `calc(var(--sl-dock-h) + 12px)`. Both overlapped the dock once, so the layout test now asserts they
  clear it — keep that assertion if you touch either.
- The mock feed in demo mode is drawn at the *client's* viewport aspect ratio, and the
  agent surface is scaled to that same ratio before interaction. Normalized coordinates
  therefore stay honest. It is labelled `SIMULATED FEED`; commands sent from it are real
  and land on the real page.

## The homepage demo is an animation, on purpose

`index.html` used to embed the widget twice and hand the visitor a control panel to drive it. That made the
landing page a worse copy of this repository: it carried a payload inspector, live status chips, four control
buttons, and a six-step tutorial, and it put a `getDisplayMedia`-shaped chore in front of someone who had not
decided to care yet.Now the homepage **sells** and the demo **plays**. `#story` is a scripted storyboard whose states are driven by
a single `data-step` attribute, with one caption per step and a Replay button. It starts itself via
`IntersectionObserver` when scrolled into view, and jumps straight to the finished story under
`prefers-reduced-motion`.

Rules for it:

- **One stage, two perspectives.** There is a single window; the story *cuts* between the customer's view and
the agent's view so each beat is seen from the side that experiences it. The two views are stacked layers that
cross-fade, and `data-side` says which one is live. **Do not go back to two windows side by side** — that
splits the reader's attention and reads as a comparison chart rather than a story.
- **Every step is a pure DOM state**, so the suite asserts on `data-step`, on `data-side` and on `.on` classes,
  never on timing. `window.__story` (`play`, `goto`, `step`, `last`) is the test seam — do not remove it.
- **Read visibility with `checkVisibility({ opacityProperty: true, visibilityProperty: true })`**, not with
  computed `visibility`. A child can set `visibility: visible` inside a hidden parent, and the inactive
  perspective keeps its subtree at `opacity: 0` — so reading computed style reports the agent's session as
  visible on the customer's side, which is not what anyone sees.
- **Let a beat settle before asserting on it** (`SETTLE` in the suite). The views cross-fade over 450ms and the
  redaction reveal lands at 400ms, so a short wait samples an in-between frame and fails on a frame that
  exists for less than half a second.
- Anything that must stop occupying layout when hidden uses `display`, not `visibility`. Visibility hides the
  paint but keeps the box, which silently padded the widget panel and left gaps in the chat.
- Overlay-only pieces (the report card, the session view, the pointer, the highlight) are absolutely
  positioned and may fade; the highlight and the pointer are anchored to the error banner itself so they land
  on the problem at any pane width.
- It must not grow into an interactive demo again. The interactive one lives in `demo.html`; `room.html` remains an automated fixture.

## The hero sells the outcome, and the background moves

Two parts of the landing page are easy to over-explain or over-build:

- **The hero is value, not mechanism.** The promise is one line of code and your app has support built in, wired
  to the webhook you already run. The install snippet — and *only* the snippet — carries configuration detail;
  the mechanism (one-frame snapshot, the blur pass, role parameters, transport) belongs in `INTEGRATION.md`, not
  in the headline. **Do not let the hero grow back into a description of how it works** — no attribute table, no
  step-by-step flow strip, no transport talk above the fold. There is no hero flow strip to reintroduce.
- **The background is hands.** Support requests are represented by a shuffled, spaced set of hands across the
  viewport. They remain visible while each hand independently waves on a long, delayed cycle, so waving feels like
  a surprise rather than a constant heartbeat. The hand is drawn from primitives (five `rect`s plus one motion arc,
  stroked by the `.hand-slot svg path` rule) in SupportLayer's own teal; MailLayer is
  red-orange, PhoneLayer purple, ZipLayer pink, so teal stays this project's. Two properties it must keep:
  - **It respects `prefers-reduced-motion` twice over** — the CSS hides `.hand-slot` *and* the JS returns before
    spawning anything. The suite asserts both, headless, by emulating the media feature.
  - **It takes no pointer events** (`#bg-canvas` is `pointer-events: none`). Reduced-motion users still get no
    animated hands; the test suite emulates both motion branches.

## Two roles, one document (`room.html`)

The one place outside the widget where both roles run side by side: the same page loaded twice, customer and
agent, over the `BroadcastChannel` loopback bus. It exists because the homepage no longer embeds the widget and
because `tests/e2e.mjs` needs a room it owns rather than one it borrows from marketing markup.

The customer frame is its own document on purpose: its viewport *is* the customer viewport, so the coordinates
the agent sends land exactly where the agent clicked. Do not move the demo app into the parent document — the
mapping breaks and the FAB/panel would cover the host page.

Both frames must share a **real origin**. An `about:blank` parent gives its frames an opaque storage context,
where `localStorage` throws `SecurityError` — which is what the widget mirrors its session to, so the
reload/resume path silently dies. The suite loads `room.html` over HTTP for exactly this reason.

## Testing

- `npm start` then `node tests/e2e.mjs` (headless) or `node tests/e2e.mjs --headed`.
- The suite must stay green in **both** modes on every change: 188 checks cover config parsing, the request flow,
  redaction round-trips, coordinate accuracy (±12px), drawing auto-clear, directed typing, reload/resume, teardown,
  the homepage storyboard (it plays itself to the end, cuts
  `customer,customer,customer,customer,agent,agent,customer,customer`, replays, and stacks on mobile), the
  waving-hands background (spawned/painted/self-clearing, pointer-transparent, silent under reduced motion), the
  two-role room, the mode matrix, the harness assertions, and desktop/mobile layout. Headed runs have historically caught bugs headless missed (a loopback timer firing after
  teardown, the always-visible draw hint).
- **Idle pages must show zero agent chrome.** The overlay elements (`canvas.sl-draw`,
  `.sl-laser`, `.sl-draw-hint`, `.sl-typing`) all default to hidden and are only revealed
  while an agent command is live; the layout test asserts this on an idle page.
- `PORT=0` is exported by some shells and means "unset" — both `serve.js` and the test runner treat it that way.
- `--base <url>` (or `SL_BASE`) runs the identical suite against an already-running origin and
  skips spawning `serve.js`. `npm run test:live` targets the deployed Pages site; **run it after
  every push to `main`** so the published artifact, not just the working tree, is verified.
- Both Chromium modes matter. Headless catches logic/console/network errors; **headed**
  catches rendering, `getDisplayMedia` permission flow, hover/focus behavior, and
  anything that depends on real window geometry.
- The suite must leave the console clean. Any `console.error` from the widget is a bug.
- Manual check before any release push: the homepage storyboard plays through and reads correctly, then
  `room.html` for the full two-role interaction (report → blur → webhook → agent connects → laser/type/draw
  land on the mock app), then `test.html` with two real browser windows for the actual WebRTC path.

## Release workflow

- Bump the version in the `supportlayer.js` header comment **and**
  `window.SupportLayer.version`.
- Commit, push `main`. Update `todo.md` + `history.md` in the same commit as the change
  they describe, not afterwards.
- CDN URLs advertised on the landing page:
  - jsDelivr: `https://cdn.jsdelivr.net/gh/Spuds0588/SupportLayer@main/supportlayer.js`
  - GitHub Pages: `https://spuds0588.github.io/SupportLayer/supportlayer.js`
