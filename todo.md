# SupportLayer — Task List

Status legend: `[x]` done, `[~]` in progress, `[ ]` not started.
Mirrors PRD Part 3 plus the launch/hosting work.

**v2 is built, published, and green: 188/188 end-to-end checks pass in headless and headed
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
- [x] `index.html` in the Layer-family visual language (Bulma, teal accent, animated field behind it).
- [x] Hero, install snippet (jsDelivr + GH Pages).
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

## Phase 10 — Consistency sweep (docs · homepage · demo)  ✅ done
- [x] Every reference document restated in the v2 vocabulary. `agent.html` now survives only where
      it *should*: the PRD amendment, the `agents.md` prohibition, and the `todo.md` deletion note.
- [x] `PRD-SupportLayer.md` §2.1 rewritten from "two primary components" to one component with two
      roles, and `agent.html` struck through inline — not just flagged in the top banner, because a
      reader scanning the deliverables section never sees the banner.
- [x] PRD Phase 5 checklist ("Scaffold `agent.html`") converted to *delivered as one script, two
      roles*, so it cannot be read as outstanding work.
- [x] Homepage mode table corrected from the v1 one-way wording (`audio` = "agent mic",
      `video` = "agent camera") to **two-way** in both directions.
- [x] Homepage now states outright that **the mode is the developer's decision** and the user never
      gets a chat/audio/video switcher.
- [x] Homepage attribute table completed: `data-color`, `data-label`, `data-title`,
      `data-chat-label`, `data-live-base`, `data-peer-cdn`, `?sl_mode=`, `?sl_color=`.
- [x] "Agent console" retired everywhere in favour of **"agent view"** (source comments, the boot
      log line, `test.html`, the harness dropdown, the suite's assertion labels).
- [x] `test.html` mode options relabelled to "two-way voice" / "two-way voice + video".
- [x] New `mode is dev-fixed` group: no channel switcher in the customer panel or the agent dock,
      and the mode indicator must be an inert `<span>`, never a control.
- [x] New `mode matrix` group: `data-mode` honoured for all four modes, with each mode's panel
      heading, submit label, and channel-specific copy asserted.
- [x] Suite 119 → 142 checks; green headless and headed, locally and live.

## Phase 11 — Homepage refocus (sell it, don't teach it)  ✅ done
- [x] Cut the “Layer family” showcase section outright. MailLayer and PhoneLayer are now one quiet
      line at the very bottom of the footer — named, linked, unexplained.
- [x] Removed the footer's “Get in touch” / “Call the demo line” buttons, which existed to show off
      the sister layers. The embeds stay, so a `mailto:`/`tel:` link on the page is still upgraded
      silently; nothing on the page advertises that.
- [x] Deleted the homepage's reference material: the headless-API block, the 18-row attribute
      table, the full webhook payload JSON, and the coordinate-contract essay. All of it already
      lived in `INTEGRATION.md`, and the homepage now says where to go instead.
- [x] “Documentation” → **“Getting started”**: the install snippet, one paragraph on what
      `data-mode` buys you, and a single button through to the integration guide.
- [x] Feature grid cut from six technical boxes to four short selling points; demo walkthrough cut
      from six steps to four.
- [x] Lede buttons and nav renamed to match (“How it's installed”, “Getting started”).
- [x] Page now reads: hero → why → demo → install → footer.
- [x] Added **ZipLayer** to the family links (`spuds0588.github.io/ZipLayer/`), and corrected
      `agents.md`, which still called SupportLayer “the third sibling” and still described
      MailLayer/PhoneLayer “live demos” on a homepage that no longer has them.

## Phase 12 — The demo plays itself  ✅ done
- [x] Removed the interactive demo from the homepage: two live iframes, nine control buttons, a payload
      inspector, live status chips, and a six-step tutorial. It asked a visitor to follow instructions
      before they had decided to care, and it duplicated `INTEGRATION.md`.
- [x] Replaced it with `#story`, a scripted storyboard: seven steps, one caption each, and a Replay button.
      It starts on scroll via `IntersectionObserver` and jumps to the finished story under
      `prefers-reduced-motion`. *(Its two side-by-side windows became one perspective-cutting stage in
      Phase 13.)*
- [x] The story shows the report arriving **where the team already works** (a channel card with the
      redacted snapshot), not in a bespoke support dashboard — which is how a solo founder would wire
      an MVP. Then the agent joins the customer's own URL and annotates it.
- [x] Steps are pure DOM state (`data-step` + `.on`), so the suite asserts on state, never on timing.
      `window.__story` is the test seam.
- [x] `room.html`: a dev fixture that loads the same page twice, once per role. The suite drives it
      instead of the marketing page, so a homepage redesign can no longer break widget tests.
- [x] Fixed two real bugs the storyboard surfaced: hidden steps used `visibility` (which keeps the box,
      silently padding the widget panel), and the `1fr` grid track refused to shrink below the frame
      bar's nowrap URL — 466px of frame inside a 358px column on a 390px phone.
- [x] Suite 142 → 157 checks: the storyboard plays itself to the end, replays deterministically,
      ends on the customer's own URL, and stacks to one column on mobile.

## Phase 13 — One stage, two perspectives  ✅ done
- [x] Stopped showing the demo as two windows side by side: the stage now **cuts between the customer's view
      and the agent's**, so each beat is seen from the side that experiences it — the report arriving in the
      agent's channel, then the highlight landing on the customer's own screen. `data-side` says which is live.
- [x] Found a latent bug the old suite had pinned in place: seven steps but only six captions, so the payoff
      frame cleared the caption line and sat there blank. Both are seven now.
- [x] The cut is a cross-fade between two stacked layers, so the reader's eye stays in one place while the
      perspective changes underneath it.
- [x] Fixed two real bugs found by reading the frames: the punchline toast ("Your agent just highlighted
      something") and the `Get support` button were painted in **frame one**, before there was any agent — both
      now belong to the beat that earns them. Also wired up `.js-redact`, whose `.on` class no hook was styled
      for, and gave the reveal a beat of its own.
- [x] Suite 157 → 171 checks. The visibility oracle is now `checkVisibility({ opacityProperty: true })`: the old
      computed-style read reported the agent's chrome as visible on the customer's side, because a child can set
      `visibility: visible` inside a parent that is cross-faded to `opacity: 0`. The captions are now asserted
      against the story's own step count rather than a literal, so a step without a caption fails.
- [x] Steps are read only after they settle (700ms), since the views cross-fade over 450ms and the redaction
      reveal lands at 400ms — a short wait was asserting against a frame that lasts half a second.

## Phase 12 — three modes and a session-scoped screen share  ✅ done
- [x] Dropped the voice-only `audio` mode. `MODES` is now `none | chat | video`; `audio` maps to
      `video` with a one-line console warning, so an existing tag keeps the call it asked for instead
      of silently degrading to a report-only widget.
- [x] The customer's screen share is **session-scoped**: it starts in the submit handler (the click's
      gesture is what `getDisplayMedia` needs) and ends only with the session. Every stop control is
      gone from the panel — waiting view, live view, and the call bar.
- [x] One capture, not two. In a live mode `getScreenSnapshot()` reuses the share stream for the
      report's one-frame JPEG, so the customer sees a single permission prompt.
- [x] The contract is stated on the request form *before* consent, and again in the live panel.
- [x] `onShareLost()` handles a track that dies underneath us (the browser's own capture bar): both
      sides are told, the session survives, and a gesture-gated "Share my screen again" can restore it.
- [x] Agent side stays honest: the badge reports the share state (`Connected · video call · screen
      live`), and a connected-but-pictureless stage says "Connected — waiting for their screen…".
- [x] Homepage storyboard gained a beat for the share (8 steps) that shows the chip on the customer's
      panel and then proves it survives the cut back to their side.
- [x] Suite 171 → 182 checks: the no-stop-control invariant (runtime *and* source-level), the share
      contract on the form per mode, and a `audio mode is retired` group asserting the alias.

## Phase 14 — Hero sells the outcome, background asks for help  ✅ done
- [x] Rewrote the hero around the value instead of the mechanism: **one line of code and your app has real
      support built in**, wired to the webhook you already run. The old headline described the snapshot, the blur
      pass and the role parameters; that detail now lives only in `INTEGRATION.md`.
- [x] Deleted the five-step `sl-flow` strip (report → blur → POST → `?sl_role=agent` → draw) so nothing above the
      fold explains the machinery, and reframed the four feature boxes as outcomes: support by default, their
      secrets stay theirs, wired to your tools, show don't explain.
- [x] Retitled the page, description, and OG/Twitter cards to match the value framing.
- [x] Replaced the floating-lifebuoy background with **hands popping up, waving for attention, and fading out** —
      one hand spawned on a timer at a random spot, risen, waved, removed. Spawned over time, not looped forever,
      so the rhythm never reads as a heartbeat. Drawn from primitives in SupportLayer's own teal (MailLayer is
      red-orange, PhoneLayer purple, ZipLayer pink — no collision).
- [x] The background is silent under `prefers-reduced-motion` (hidden in CSS *and* never spawned in JS),
      pointer-transparent, and pauses in a hidden tab.
- [x] Suite 183 → 188 checks: the hands group samples the spawner over ~3.5s (spawned / painted / self-clearing /
      no pointer events) and a reduced-motion group emulates the media feature and asserts silence. That group
      failed twice before it was right, both times because of the environment rather than the code: headless saw
      43 spawns but zero hands (the suite's page is backgrounded by then, and the spawner pauses when hidden), and
      headed saw zero spawns at all (this host's desktop reports `prefers-reduced-motion: reduce`). It now forces
      the motion-allowed branch — reloading so the JS guard re-reads the query — and calls `bringToFront()` first.

### Live path  ✅ done (the old "unverified" backlog item)
- [x] `tests/live-session.mjs` (`npm run live:check` / `live:session`): a real customer session in a
      real browser, dialled by a second peer over real PeerJS, asserting a real screen track arrives
      *and decodes a frame*. This was the repo's biggest untested surface.
- [x] `flagParam()` + `?sl-demo=0`, so a page shipping `data-demo="true"` can be tested for real.
      (`?demo=0` used to turn demo mode **on** — any value of the legacy param was truthy.)
- [x] **Bug fixed:** the `hello` handshake advertised `AGENT_ID` (a per-page random) instead of the
      broker-registered peer id, so every real deployment left the agent's stage permanently blank —
      `peer-unavailable`, silently swallowed. `selfPeerId()` fixes it; the demo suite passes either
      way because the loopback bus ignores ids.
- [x] VERSION / package.json / docs at **2.1.0**, with the two breaking changes named in INTEGRATION §13.

## Phase 15 — Single-file interactive demo  ✅ done
- [x] Added `demo.html` as the recommended manual experience: one customer document with `?sl_role=agent` switching it into the agent view.
- [x] Customer support submission now becomes a simulated webhook notification with ticket details and an **Open support portal** action.
- [x] The handoff opens the same demo URL in a second tab with `peer` and `sl-demo=1`; both tabs stay synchronized over the same-origin loopback bus.
- [x] The agent tab connects to the room, shows the matching blurred Sunny Bakery checkout feed, keeps communication open, and can use the existing realtime tools.
- [x] Added end-to-end checks for the notification, handoff URL, connection, feed, always-open communication, and realtime chat.
- [x] Updated the homepage and README links so `demo.html` is the recommended interactive demo; `room.html` remains the automated fixture.

## Phase 16 — Customer-ratio agent surface ✅ done
- [x] Agent feed and interaction canvas lock to the customer's reported viewport aspect ratio and scale proportionally inside the agent stage.
- [x] Coordinate normalization now uses the rendered customer-ratio surface rather than the full agent viewport.
- [x] Added regression checks for aspect matching, containment, and normalized coordinate round trips.
- [x] Updated the integration guide, architecture rules, and public docs with the customer-ratio contract.

## Backlog (explicitly not in v2)
- [ ] Multiparty sessions / multiple agents per session.
- [ ] Optional `data-position` placement attribute for the FAB.
- [ ] Webhook retry queue for offline submissions.
- [ ] Auto-fit the agent dock on very short viewports (it wraps, but a <360px-tall stage is
      cramped).
