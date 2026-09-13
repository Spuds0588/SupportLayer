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
