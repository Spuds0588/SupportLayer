# SupportLayer — Task List

Status legend: `[x]` done, `[~]` in progress, `[ ]` not started.
Mirrors PRD Part 3 plus the launch/hosting work.

**v2 is built, published, and green: 119/119 end-to-end checks pass in headless and headed
Chromium, locally *and* against the live GitHub Pages origin.** Live at
https://spuds0588.github.io/SupportLayer/. Remaining work is the explicit backlog.

v2 collapsed the two-page design into one: the agent no longer has a page of their own.

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

## Phase 5 — Agent experience  ✅ done (v2: same page, `?sl_role=agent`)
- [x] ~~Scaffold a separate dashboard page~~ — **deleted in v2.** The agent loads the customer's
      own URL with `?sl_role=agent&peer=<id>`; the widget mounts the agent view instead of the FAB.
- [x] URL parameter parsing for `sl_role` / `peer` (+ `sl-demo`). A bare `role=` is ignored.
- [x] PeerJS connect, data channel, answer/receive the customer's stream.
- [x] Coordinate normalization with `object-fit: contain` letterboxing (and full-screen
      capture offset from client window geometry).
- [x] Floating bottom tool dock: **Point / Click / Draw / Clear**, swatches, **Chat**,
      **Report**, **End** — the Zoom-style annotation bar, not a dashboard.
- [x] A coach line of shortcuts on connect that fades away and returns on dock hover.
- [x] Dock height published as `--sl-dock-h` so the toast and coach line clear it.
- [x] Draw points batched per animation frame (~60fps) and flushed on mouse-up.
- [x] Screenshots removed from the agent's face: full-bleed customer stage + transcript only.

## Phase 6 — Landing page (GitHub Pages)  ✅ done
- [x] `index.html` in the Layer-family visual language (Bulma, floating SVG field).
- [x] Hero, install snippet (jsDelivr + GH Pages), animated request→resolve flow.
- [x] Feature grid pulled from PRD §1.4.
- [x] **Simulated demo**: full-viewport mock customer app + the *same app in the agent role* +
      mock webhook inspector, wired through the loopback transport.
- [x] MailLayer Embedded and PhoneLayer Embedded loaded live into the page, with their own
      demo buttons in a Sisters section and in the footer.
- [x] Docs section: attributes table, headless API, webhook schema, agent URL contract.
- [x] `test.html` integration harness.
- [x] `serve.js` / `package.json` / `.gitignore` / `favicon.svg`.

## Phase 7 — Verification  ✅ done
- [x] Headless Chromium end-to-end pass (console clean, zero network errors).
- [x] Headed Chromium pass (rendering, focus, real interaction).
- [x] Coordinate accuracy check: agent click → laser lands within ±12px of the target.
- [x] Privacy blur round-trip: DOM identical after `removePrivacyBlur()`.
- [x] Rate limiter + honeypot behave on second submit.
- [x] Desktop + mobile layout sanity (no horizontal overflow, FAB inside the viewport).

## Phase 8 — Ship  ✅ done
- [x] Push `main` checkpoints as work landed.
- [x] GitHub Pages live on `main` / root: https://spuds0588.github.io/SupportLayer/
      (`index.html`, `supportlayer.js`, `test.html`, `demo-app.html`,
      `favicon.svg`, `INTEGRATION.md` all return 200).
- [x] `npm run test:live` — the full suite runs against the deployed origin (headless and
      headed), so the published artifact is verified, not assumed.
- [x] `INTEGRATION.md` — consumer-facing guide for integrators and coding agents.
- [x] `live_session_url` no longer points at a CDN: static-file CDNs serve `.html` as
      `text/plain`, so `defaultLiveBase()` fell back to the Pages console (87 checks).
      **Obsolete in v2** — the link is now the customer's own `location.href`, so there is no
      `.html` anywhere in the flow and the branch was deleted with the console page.

## Phase 9 — v2 restructure (one file, two roles)  ✅ done
- [x] Delete `agent.html`; the agent role lives in `supportlayer.js`. (`git rm`.)
- [x] `?sl_role=agent&peer=<id>` boots the agent view; `liveSessionUrl()` is built from
      `location.href`, so the link works on any route the host app already serves.
- [x] The request panel **becomes** the session: chat thread, or a two-way audio/video call
      in the same surface, per `data-mode`.
- [x] Two-way media: `audio` and `video` stream in both directions, not just agent → user.
- [x] Removed the in-session channel switcher after review — **the mode is the developer's
      call at install time**; neither the customer nor the agent may change it mid-session.
- [x] Agent surface is a video-meeting-style experience: full-bleed customer view + floating
      annotation dock, no payload panes or dashboards.
- [x] Landing-page demo runs the same app in both roles instead of two different pages.
- [x] Suite grew from 87 to 119 checks: role isolation, dock geometry (toast/coach line above
      the dock, dock above the stage floor), FAB inside the customer viewport, unparameterised
      pages staying customer-role, and "there is no agent page to fetch".

## Backlog (explicitly not in v2)
- [ ] Multiparty sessions / multiple agents per session.
- [ ] A real two-browser WebRTC pass: `getDisplayMedia` permission flow and live agent media
      have only been exercised over the loopback bus. The media stack itself is unverified.
- [ ] Optional `data-position` placement attribute for the FAB.
- [ ] Webhook retry queue for offline submissions.
- [ ] Auto-fit the agent dock on very short viewports (it wraps, but a <360px-tall stage is
      cramped).
