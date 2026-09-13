# SupportLayer — Task List

Status legend: `[x]` done, `[~]` in progress, `[ ]` not started.
Mirrors PRD Part 3 plus the launch/hosting work.

**v1 is built and green: 84/84 end-to-end checks pass in both headless and headed
Chromium.** Remaining work is publishing (Phase 8) and the explicit backlog.

## Phase 0 — Repo & docs  ✅ done
- [x] Read `PRD-SupportLayer.md`; confirm scope with the maintainer's brief.
- [x] `agents.md` (architecture law, coordinate math, testing policy).
- [x] `todo.md` (this file).
- [x] `history.md` (chronological dev log).

## Phase 1 — Core initialization & UI (`supportlayer.js`)  ✅ done
- [x] Parse configuration from `document.currentScript.dataset`.
- [x] `try/catch` JSON parse of `data-fields`, fall back to a default `textarea`.
- [x] Shadow DOM container for CSS encapsulation.
- [x] Theme via CSS custom properties from `data-theme`, hover states via `color-mix`.
- [x] Dynamic form renderer from parsed `fields`.
- [x] State machine (`IDLE`, `SENDING`, `WAITING`, `CONNECTED`) mirrored to `localStorage`.
- [x] View toggling: Initial Request, Resume Prompt, Waiting, Connected.

## Phase 2 — Privacy & capture layer  ✅ done
- [x] `applyPrivacyBlur()` — injected `<style>` for `data-blur-selectors`.
- [x] `applyPrivacyBlur()` — `TreeWalker` wrapping of `data-blur-regex` text nodes.
- [x] `removePrivacyBlur()` — unwrap text nodes, remove injected style, normalize.
- [x] `splitPatterns()` — comma split that respects `{}`, `()`, `[]` (and JSON arrays),
      so `{2,}` quantifiers and `:is(.a, .b)` selectors survive.
- [x] `getScreenSnapshot()` — `getDisplayMedia` → hidden canvas → 70% JPEG, tracks killed.
- [x] Cancel/black-frame paths return `null` instead of throwing.

## Phase 3 — Networking & anti-spam  ✅ done
- [x] Webhook POST logic with `keepalive`, JSON body, `support_request`/`support_update`.
- [x] 60-second rate limiter backed by `sessionStorage`.
- [x] Honeypot field check (silent fake-success).
- [x] `isTrusted` click requirement on submit.
- [x] Dynamic PeerJS script injection.
- [x] Peer id saved to local state and appended to `live_session_url`.
- [x] State recovery: `support_update` with the identical `session_id` on resume.

## Phase 4 — Agent control (client side)  ✅ done
- [x] DataChannel listeners for `click`, `type`, `draw`, `clear`, `hello`.
- [x] `handleRemoteClick(x, y)` — percentage → pixels, laser pointer, `.focus()`/`.click()`.
- [x] `handleRemoteType(x, y, text)` — outline target, tooltip with Copy, safe insertion
      through the native value setter for React/Vue inputs.
- [x] `handleRemoteDraw(lines)` — overlay canvas, blocking `pointer-events`, 3s auto-clear.
- [x] Agent overlay chrome is fully out of layout while idle (canvas is `display: none`
      until a stroke arrives), so an idle page shows nothing but the FAB.

## Phase 5 — Agent dashboard (`agent.html`)  ✅ done
- [x] Scaffold with CSS grid/flex dashboard UI.
- [x] URL parameter parsing for `peer` (+ `demo`).
- [x] PeerJS connect, data channel, answer/receive video stream.
- [x] Coordinate normalization with `object-fit: contain` letterboxing (and full-screen
      capture offset from client window geometry).
- [x] Mouse mapping per toolbar state (Laser / Type / Draw).
- [x] Draw points batched per animation frame (~60fps) and flushed on mouse-up.

## Phase 6 — Landing page (GitHub Pages)  ✅ done
- [x] `index.html` in the Layer-family visual language (Bulma, floating SVG field).
- [x] Hero, install snippet (jsDelivr + GH Pages), animated request→resolve flow.
- [x] Feature grid pulled from PRD §1.4.
- [x] **Simulated demo**: full-viewport mock customer app + embedded agent dashboard +
      mock webhook inspector, wired through the loopback transport.
- [x] MailLayer Embedded and PhoneLayer Embedded loaded live into the page, with their own
      demo buttons in a Sisters section and in the footer.
- [x] Docs section: attributes table, headless API, webhook schema, agent URL.
- [x] `test.html` integration harness.
- [x] `serve.js` / `package.json` / `.gitignore` / `favicon.svg`.

## Phase 7 — Verification  ✅ done
- [x] Headless Chromium end-to-end pass (console clean, zero network errors).
- [x] Headed Chromium pass (rendering, focus, real interaction).
- [x] Coordinate accuracy check: agent click → laser lands within ±12px of the target.
- [x] Privacy blur round-trip: DOM identical after `removePrivacyBlur()`.
- [x] Rate limiter + honeypot behave on second submit.
- [x] Desktop + mobile layout sanity (no horizontal overflow, FAB inside the viewport).

## Phase 8 — Ship  ⏳
- [x] Push `main` checkpoints as work landed.
- [ ] Enable GitHub Pages on `main` and confirm the live URL serves both `index.html` and
      `supportlayer.js`.

## Backlog (explicitly not in v1)
- [ ] Multiparty sessions / multiple agents per session.
- [ ] Voice-only and video-mode annotation parity (audio mode ships with data channel
      only in v1).
- [ ] Optional `data-position` placement attribute for the FAB.
- [ ] Webhook retry queue for offline submissions.
