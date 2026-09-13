# SupportLayer — Task List

Status legend: `[x]` done, `[~]` in progress, `[ ]` not started.
Mirrors PRD Part 3 plus the launch/hosting work.

## Phase 0 — Repo & docs  ✅ done
- [x] Read `PRD-SupportLayer.md`; confirm scope with the maintainer's brief.
- [x] `agents.md` (architecture law, coordinate math, testing policy).
- [x] `todo.md` (this file).
- [x] `history.md` (chronological dev log).

## Phase 1 — Core initialization & UI (`supportlayer.js`)
- [ ] Parse configuration from `document.currentScript.dataset`.
- [ ] `try/catch` JSON parse of `data-fields`, fall back to a default `textarea`.
- [ ] Shadow DOM container for CSS encapsulation.
- [ ] Theme via CSS custom properties from `data-theme`, hover states via `color-mix`.
- [ ] Dynamic form renderer from parsed `fields`.
- [ ] State machine (`IDLE`, `WAITING`, `CONNECTED`) mirrored to `localStorage`.
- [ ] View toggling: Initial Request, Resume Prompt, Waiting, Connected.

## Phase 2 — Privacy & capture layer
- [ ] `applyPrivacyBlur()` — injected `<style>` for `data-blur-selectors`.
- [ ] `applyPrivacyBlur()` — `TreeWalker` wrapping of `data-blur-regex` text nodes.
- [ ] `removePrivacyBlur()` — unwrap text nodes, remove injected style, normalize.
- [ ] `getScreenSnapshot()` — `getDisplayMedia` → hidden canvas → 70% JPEG, tracks killed.
- [ ] Cancel/black-frame paths return `null` instead of throwing.

## Phase 3 — Networking & anti-spam
- [ ] Webhook POST logic with `keepalive`, JSON body, `support_request`/`support_update`.
- [ ] 60-second rate limiter backed by `sessionStorage`.
- [ ] Honeypot field check (silent fake-success).
- [ ] `isTrusted` click requirement on submit.
- [ ] Dynamic PeerJS script injection.
- [ ] Peer id saved to local state and appended to `live_session_url`.
- [ ] State recovery: `support_update` with the identical `session_id` on resume.

## Phase 4 — Agent control (client side)
- [ ] DataChannel listeners for `click`, `type`, `draw`, `clear`, `hello`.
- [ ] `handleRemoteClick(x, y)` — percentage → pixels, laser pointer, `.focus()`/`.click()`.
- [ ] `handleRemoteType(x, y, text)` — outline target, tooltip with Copy, safe insertion.
- [ ] `handleRemoteDraw(lines)` — overlay canvas, blocking `pointer-events`, 3s auto-clear.

## Phase 5 — Agent dashboard (`agent.html`)
- [ ] Scaffold with CSS grid/flex dashboard UI.
- [ ] URL parameter parsing for `peer` (+ `demo`).
- [ ] PeerJS connect, data channel, answer/receive video stream.
- [ ] Coordinate normalization with `object-fit: contain` letterboxing (and full-screen
      capture offset from client window geometry).
- [ ] Mouse mapping per toolbar state (Laser / Type / Draw).
- [ ] Draw points batched per animation frame (~60fps) and flushed on mouse-up.

## Phase 6 — Landing page (GitHub Pages)
- [ ] `index.html` in the Layer-family visual language (Bulma, floating SVG field).
- [ ] Hero, install snippet (jsDelivr + GH Pages), animated request→resolve flow.
- [ ] Feature grid pulled from PRD §1.4.
- [ ] **Simulated demo**: full-viewport mock customer app + embedded agent dashboard +
      mock webhook inspector, wired through the loopback transport.
- [ ] MailLayer Embedded and PhoneLayer Embedded loaded live into the page, with their own
      demo buttons in a Sisters section and in the footer.
- [ ] Docs section: attributes table, headless API, webhook schema, agent URL.
- [ ] `test.html` integration harness.
- [ ] `serve.js` / `package.json` / `.gitignore` / `favicon.svg`.

## Phase 7 — Verification
- [ ] Headless Chromium end-to-end pass (console clean, zero network errors).
- [ ] Headed Chromium pass (rendering, focus, real interaction).
- [ ] Coordinate accuracy check: agent click → laser lands within tolerance of target.
- [ ] Privacy blur round-trip: DOM identical after `removePrivacyBlur()`.
- [ ] Rate limiter + honeypot behave on second submit.

## Phase 8 — Ship
- [ ] Push `main` checkpoints as work landed.
- [ ] Enable GitHub Pages on `main` and confirm the live URL serves both `index.html` and
      `supportlayer.js`.

## Backlog (explicitly not in v1)
- [ ] Multiparty sessions / multiple agents per session.
- [ ] Voice-only and video-mode annotation parity (audio mode ships with data channel
      only in v1).
- [ ] Optional `data-position` placement attribute for the FAB.
- [ ] Webhook retry queue for offline submissions.
