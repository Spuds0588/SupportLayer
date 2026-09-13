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
