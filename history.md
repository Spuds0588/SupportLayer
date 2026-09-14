# SupportLayer — Development History

Chronological log of what actually landed. Newest entries at the bottom.
Append an entry for every meaningful change; do not rewrite past entries.

---

## 2026-09-13 — Session 1: bootstrap

**Context.** Repository `Spuds0588/SupportLayer` existed with only a README, LICENSE, an
`Index.html` placeholder, and `PRD-SupportLayer.md` (the master dev document: PRD,
implementation guide, task list, and agent directives). Working environment: Linux,
Node 20, system Chromium/Chrome at `/usr/bin/google-chrome`, `gh` authenticated as the
repo owner (so pushes to `main` are possible).

**Research.** Inspected the two sister projects to inherit the family conventions rather
than inventing new ones:

- `Spuds0588/MailLayer-Embedded` — Bulma 1.0 + FontAwesome from CDN, dark palette, a
  "floating envelopes" background animation, hero with a copyable one-line install
  snippet, six feature boxes, usage snippet, footer with a live MailLayer trigger.
- `Spuds0588/PhoneLayer-Embedded` — same language, one step further: CSS custom-property
  palette, animated hero flow chips, an icon-only provider carousel, a **live demo
  section** built from real triggers, `serve.js` static server, `package.json` with a
  single `start` script, `agents.md`, and Playwright as a dev-only dependency.

Decisions taken from that research: Bulma + FontAwesome via CDN, the same dark palette
structure and floating-SVG background, a `serve.js` dev server, `agents.md`, and a
landing page with a *real*, interactive demo rather than screenshots.

**Docs written.**

- `agents.md` — architecture law distilled from PRD Part 4 (client-centric only, strict
  YAGNI, no synthetic keystrokes, state mirroring to `localStorage`, normalized
  coordinates only, Shadow DOM for the widget vs host-document privacy blur), plus the
  deliverable surface, the agent dashboard contract, and the testing/release policy.
- `todo.md` — the PRD task list plus hosting/verification phases, with live status.
- `history.md` — this file.

**Environment facts recorded for later sessions.** `Index.html` (capital I) cannot serve
as a GitHub Pages entry point; it must be replaced by lowercase `index.html`.

---

## 2026-09-13 — Session 2: v1 built, verified, shipped to `main`

**Landed.** `supportlayer.js` (config, Shadow-DOM widget, privacy blur, snapshot capture,
webhook + anti-spam, PeerJS transport, agent commands), `agent.html` (video stage with
letterbox-aware coordinate mapping, laser/type/draw tools), `demo-app.html`, `index.html`
(hero, install snippet, feature grid, full simulated demo, LiveLayer Embeds, docs),
`test.html`, `serve.js`, `package.json`, `favicon.svg`, `.gitignore`, `README.md`.

**Verification.** `tests/e2e.mjs` (Puppeteer, `puppeteer-core` + system Chromium) grows to
84 checks: config parsing, request flow, redaction round-trip, ±12px coordinate accuracy,
draw auto-clear, directed typing, reload/resume, teardown, harness assertions, console
hygiene, and desktop/mobile layout. Green headless **and** headed.

**Bugs found and fixed this session.**

1. `splitPatterns()` — `data-blur-regex="{2,}"` was being torn apart by a naive
   `String.split(",")`, silently disabling redaction. The splitter now respects `{}`, `()`
   and `[]`, and also accepts a JSON array.
2. Puppeteer reports `console.warn` as `"warn"`, not `"warning"` — the harness's console
   filter was mislabelling the invalid-`data-fields` warning as an error.
3. Loopback `announce` timer fired after teardown and threw on a nulled session (headed-only
   failure). It now stops on connect, on `close()`, and after 200 tries, capturing `peerId`
   locally instead of reading `session`.
4. `.sl-draw-hint` set `display: inline-flex`, which beat the `hidden` attribute, so
   "The agent is drawing" was permanently visible and swallowed clicks. Fixed with an
   explicit `[hidden] { display: none !important; }` in the shadow stylesheet.
5. The overlay canvas itself was always in the layout (transparent but hit-testable and
   reported by the idle-page assertion). It is now `display: none` until a stroke arrives
   and is sized back to zero on `clearDrawing()`.
6. The "Copy" button overlapped the hero install snippet; the Copy control moved into the
   snippet's own bar.
7. MailLayer's jsDelivr path 404s — its canonical CDN is `embedded.maillayer.wiki`, so the
   embed tries that first and falls back.
8. `PORT=0` is exported by this shell; `serve.js` and the test runner now treat `0` as unset
   instead of binding a random port the tests can't find.

**Environment facts.** `DISPLAY=:1` is available, so `--headed` runs are real. `gh` is
authenticated as the repo owner. `Puppeteer` is pinned at 24.10.0 with
`PUPPETEER_EXECUTABLE_PATH` unset because the suite auto-detects `google-chrome`.

## 2026-09-13 — Session 2b: publish to GitHub Pages, then verify the *live* artifact

**Pages.** `main` / root was already wired as the Pages source; it finished its first
build and serves everything:
`/`, `/supportlayer.js`, `/agent.html`, `/test.html`, `/demo-app.html`, `/favicon.svg`,
`/README.md` — all HTTP 200 with the right content types. Live URL:
https://spuds0588.github.io/SupportLayer/

**New: `--base` / `SL_BASE` on the test runner.** The suite previously only ever tested the
working tree, which means a Pages misconfiguration (capital-I `Index.html`, a path that
404s once published, a stale deploy) would pass locally and fail in the wild. The runner
now accepts `--base <url>` (`npm run test:live`) to point the identical 84 checks at an
already-running origin and skip spawning `serve.js`.

**Result.** 84/84 headless **and** 84/84 headed against the live Pages origin, console clean,
zero failed same-origin requests. The published site is the same artifact that was tested.

## 2026-09-13 — Session 2c: integration docs + a CDN landmine they exposed

**`INTEGRATION.md` (new).** The repo had `agents.md` (rules for editing the widget) but nothing for
the person wiring it into *their* app. The new guide is written to be followed directly by a human or
a coding agent: delivery options, the complete attribute table, the `data-fields` schema, the exact
webhook contract **including the CORS preflight that a JSON POST forces** (a webhook that answers
`curl` still fails in a browser), routing recipes, privacy guidance, framework recipes
(plain HTML / Next.js App Router / Nuxt / SPA routing / headless self-driving), console usage,
a nine-step post-integration verification checklist, a troubleshooting table, and an explicit
scope/"do not" section. Linked from the README, the landing page docs box, and the footer.

**Bug the guide exposed — CDNs cannot host the agent console.** Writing the quick-start section
revealed that jsDelivr returns `agent.html` as `Content-Type: text/plain`. The browser then renders
the console as source code, so every CDN install would have shipped a `live_session_url` that does
not work. Fixed with `defaultLiveBase()`: if the widget's own script is served from a known
plain-text CDN (jsDelivr, fastly.jsdelivr, unpkg, cdnjs, raw.githubusercontent, githack) the payload
now points at the project's Pages console; a self-hosted copy still resolves `agent.html` beside the
script; `data-live-base` still overrides everything.

**Tests (84 → 87).** The CDN branch is asserted without touching the network — the suite intercepts
the jsDelivr URL and serves our own copy of `supportlayer.js` for it, so `script.src` is a CDN URL
while the running code is the local build. A companion check asserts the self-hosted default. Green
headless **and** headed, locally and against the live origin.

## 2026-09-14 — Session 3: the vision correction (v2, one file, two roles)

**The correction.** v1 shipped two deliverables: `supportlayer.js` for the customer and
`agent.html` as a separate agent dashboard. The brief was narrower than that: the agent goes to
**the same domain as the customer**, with parameters that select the support experience. So the
second page was wrong — it duplicated an app shell that didn't exist, drifted from the widget,
and needed its own hosting story. `agent.html` is now deleted (`git rm`).

**One script, two roles.** `?sl_role=agent&peer=<id>` flips `CFG.role` and `mountAgent()` replaces
the customer mount entirely. `liveSessionUrl(peerId)` is built by taking the customer's own
`location.href` and setting those two params, so the agent link needs no route of its own and
works on any page the host app already serves. A bare `role=` param is deliberately ignored —
that name belongs to host apps for their own permissions. As a side effect the whole
"CDNs serve `.html` as `text/plain`" class of bug disappears: there is no `.html` in the flow
any more, so `defaultLiveBase()` went with the page it existed for.

**The request panel becomes the session.** The four `data-mode` values now drive what the modal
*is* after submit: an async report, a chat thread, or a call. `audio` and `video` were one-way in
v1 (agent → user); both are now two-way, in the same surface.

**The channel is the developer's decision.** A draft of this session added an in-session switcher
so the customer could promote a chat to a call. That was reverted on review: the mode is
hard-coded from `data-mode` at install time, and neither the customer nor the agent may change it
mid-session. Noted in `agents.md` as a rule so it does not get re-added.

**The agent's surface is a meeting, not a dashboard.** Full-bleed customer stage plus a floating
bottom dock in the Zoom/Meet annotation idiom: **Point / Click / Draw** (+swatches, +Clear),
**Chat**, **Report**, **End**. Point is the resting state — it moves a laser and clicks nothing,
which is what makes it safe to leave armed. A coach line of shortcuts appears on connect, then
fades, and returns when the dock is hovered. Nothing else is on screen: no session list, no
metrics, no raw payload panes.

**Two layout bugs, found by looking rather than by asserting.** The connect toast and the coach
line both sat at ~92–96px from the bottom and the dock measured ~134px tall, so each was clipped
behind it. The dock now publishes its measured height as `--sl-dock-h` and both sit above
`calc(var(--sl-dock-h) + 12px)`, backed by a `ResizeObserver` because the dock wraps on narrow
stages. The suite now asserts the geometry (toast and coach line clear the dock, dock above the
stage floor, FAB inside the customer viewport) so the next CSS regression fails the build instead
of surviving as a screenshot nobody reads.

**A phantom.** A blue wash across the whole agent stage during a draw appeared in several captures
and traced to nothing: selection was empty, the ink canvas was correct, and the colour
(`rgb(50,102,208)`) exists nowhere in the source. It stopped reproducing once the preview host's
renderer was restarted — an uncomposited 1290px layer inside a 550px iframe. Recorded so nobody
chases it again.

**Tests: 87 → 119.** New coverage for role isolation (`SupportLayer.agent` undefined for
customers), "an unparameterised page is the customer role", "the host app's `role=` param is
ignored", "there is no agent page to fetch", dock/stage geometry, and the same app running in both
roles at once. Green headless **and** headed, locally and — after the Pages build — against the
live origin.

**Environment note.** Headed Chromium on this host composites poorly, which stalls Puppeteer's
`elementHandle.click()` (it waits on `requestAnimationFrame`). The suite now clicks at measured
viewport coordinates with `page.mouse`, which is both compositor-independent and closer to what a
real user does.

## 2026-09-14 — Session 3: consistency sweep, then confirm it in production

The v2 restructure was already green, but the product's *words* had not caught up with it. This
session was about making every surface tell the same story, then proving it from the deployed
origin rather than the working tree.

**The homepage was the worst offender.** Its mode table still described the v1 one-way media —
`audio` as "agent mic", `video` as "agent camera" — which is exactly backwards now that both
directions stream. Rewritten to **two-way** in both. The attribute table was also missing eight
things the code actually reads (`data-color`, `data-label`, `data-title`, `data-chat-label`,
`data-live-base`, `data-peer-cdn`, `?sl_mode=`, `?sl_color=`), so an integrator reading the docs
could not discover them.

**The rule the maintainer corrected is now enforced, not just documented.** The mode is the
developer's decision via `data-mode`; there is no user-facing channel switcher. Nothing in the
suite pinned that, so a `chat | audio | video` segment control could have been re-introduced and
passed CI. Two new groups close that:

- **`mode is dev-fixed`** — scans the customer panel and the agent dock for any `select`,
  `[data-seg]`, `[role=tablist]`, or `[role=radiogroup]` that offers two or more of
  `chat`/`audio`/`video`, and asserts the visible mode indicator is an inert `<span>`. This is the
  assertion that fails if the thing I built and you rejected ever comes back.
- **`mode matrix`** — all four modes boot through the local server, and each one must ask for the
  right thing: `none` promises a *report* and offers "Send report"; `chat` says "chat live";
  `audio` says "talk it through"; `video` says "video call". A mode that silently behaves like
  another mode now fails.

**`PRD-SupportLayer.md` needed more than its banner.** The v2 amendment at the top was correct but
easy to miss: §2.1 still listed two components, and the Phase 5 checklist still opened with
"Scaffold `agent.html`" — which an editing agent would reasonably read as outstanding work. §2.1 is
now one component with two roles, the `agent.html` bullet is struck through with a redirect, and
Phase 5 is marked delivered as one script. The banner stays; it just isn't load-bearing any more.

**Vocabulary.** "Agent console" is gone from the codebase (header comment, four section banners,
the boot log line), `test.html`, the harness's mode dropdown, and the suite's own assertion labels.
"Agent view" throughout. `test.html`'s mode options now read "two-way voice" and "two-way voice +
video" instead of the v1 one-way wording.

**Tests: 119 → 142.** Green headless (142/142) and headed (142/142). The headed run is stable now
that the suite clicks at measured viewport coordinates instead of via `elementHandle.click()`.

**Verified from the other side of the wire.** Pages built the pushed commit; `/`, `/supportlayer.js`,
`/test.html`, `/demo-app.html`, `/INTEGRATION.md`, `/favicon.svg` all 200 with correct content types
and `/agent.html` still a 404. Then the identical 142 checks ran against
`https://spuds0588.github.io/SupportLayer` — headless and headed — so the published artifact is the
artifact that was tested.

**A documented install path that 404s.** The integration guide's production advice was to "pin the
CDN URL to a tag" and named `@v1.0.0`. The repository has never had a tag, so anyone following that
line shipped a script tag that resolves to a 404 — and the same file's header says v2.0.0. The guide
now recommends an immutable **commit SHA** (always valid, no release step) or a release tag once
one exists, and states the current version explicitly. `package.json` was still on 1.0.0, so the
three version sources (file header, `SupportLayer.version`, manifest) now agree at 2.0.0.

**Session 4 — the homepage stopped teaching and started selling.** The landing page had grown into a
second, worse copy of the integration guide: an 18-row attribute table, the full webhook payload
JSON, an essay on the coordinate contract, and a headless-API listing — all of it already in
`INTEGRATION.md`, and all of it in the reader's way before they had decided to care. "Documentation"
is now **"Getting started"**: the install snippet, one paragraph on what `data-mode` buys, and one
button through to the guide. Everything configurable is documented in one place, and the homepage
says so out loud.

The feature grid went from six boxes of implementation detail to four sentences of why you'd want
it, and the demo walkthrough from six steps to four. The page now reads hero → why → demo → install
→ footer.

**The sister projects went quiet.** There was a whole "The Layer family" section — two cards with
copy buttons, live trigger buttons, and CDN status notes — sitting between the demo and the docs,
plus two more buttons in the footer. For a page whose job is to sell *this* library, that was a lot
of someone else's advertising. The section is gone and the two projects are now one dim, lowercase
line at the very bottom: named, linked, unexplained. The MailLayer and PhoneLayer scripts are still
loaded, so a `mailto:` or `tel:` link on the page is still upgraded silently, but nothing on the page
points that out.

Dead code from the deleted sections went with it: the `.sister` and `.tbl` rule sets, the
sister-status DOM updates, and the `.is-demo` box variant.

**142/142 still green** headless and headed, including the mobile layout checks (no horizontal
overflow, nav drops into the flow).

**ZipLayer joined the family list.** The repo is `Spuds0588/ZipLayer` and its site is live at
`spuds0588.github.io/ZipLayer/` — note the casing, `ZipLayer`, not `ZIPlayer`; only the canonical
spelling resolves. It is now the third quiet link in the footer, alongside MailLayer and
PhoneLayer, plus a line in the README's Sister projects list.

Two stale claims surfaced while wiring it up. `agents.md` still described SupportLayer as "the third
sibling in the Layer family (MailLayer, PhoneLayer, SupportLayer)" — true when there were three, no
longer. And its file list still promised "MailLayer + PhoneLayer live demos" on the homepage, which
the previous session deleted. Both corrected.

Checked every family link before shipping them: MailLayer 301s to its canonical
`embedded.maillayer.wiki` and resolves 200; PhoneLayer, ZipLayer and SupportLayer are all direct 200s.
