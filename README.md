# SupportLayer

**SupportLayer is a zero-backend, drop-in diagnostic and live P2P support widget for web applications.**
Add one `<script>` tag and your users get an immediate bug-report path that POSTs rich diagnostics — including a
redacted, one-frame snapshot — straight to the webhook you already have (Slack, Zendesk, Zapier, your own API).
When a report isn't enough, the agent joins the *same page* over a live peer-to-peer session and can point at
things, draw on the user's screen, and hand text over for review.

`demo.html` is the interactive development experience: it is one page with two URL-param roles. In the customer role, submit a request and the simulated webhook produces an in-page support notification with the ticket details and an **Open support portal** action. That action opens the same `demo.html` in a second tab with `?sl_role=agent&peer=...&sl-demo=1`; the agent connects over the same-origin `BroadcastChannel` transport, displays the ticket context and customer feed, and can chat, point, click, draw, or type while the customer tab updates in real time.

The legacy `room.html` fixture remains for the automated widget test harness; it is not the recommended manual demo.

## ▶ [**Open the live homepage and try the demo →**](https://spuds0588.github.io/SupportLayer/)

The homepage leads with the outcome — **one line of code and your app has support built in**, wired to the webhook
 you already run — and keeps the how-to in [`INTEGRATION.md`](INTEGRATION.md). It then plays a short **animated
 walkthrough**: a customer's checkout fails, they ask for help from the page itself, the report lands in a channel
 your team already reads, and an agent joins them on that same URL to point and draw. To try the complete interactive
 flow, open [`demo.html`](demo.html): submit a request, receive the simulated support notification, open the agent
 link in a second tab, and use the live tools against the customer page.

| | |
| --- | --- |
| 🏠 **Homepage + walkthrough** | **[spuds0588.github.io/SupportLayer](https://spuds0588.github.io/SupportLayer/)** |
| 🎬 **Interactive demo** | [`demo.html`](demo.html) — submit a request, open the agent link in a second tab, and try the synced support tools |
| 🧪 **Integration harness** | [spuds0588.github.io/SupportLayer/test.html](https://spuds0588.github.io/SupportLayer/test.html) |
| 🎧 **Agent experience** | The customer's own URL + `?sl_role=agent&peer=<id>` — same page, no second app |
| 📘 **Integration guide** | [INTEGRATION.md](https://github.com/Spuds0588/SupportLayer/blob/main/INTEGRATION.md) — wiring it into your app, for humans and coding agents |

## Quick start

```html
<script
    src="https://cdn.jsdelivr.net/gh/Spuds0588/SupportLayer@main/supportlayer.js"
    data-webhook="https://api.domain.com/webhook"
    data-mode="chat"
    data-theme="#14b8a6"
    data-blur-selectors=".sensitive-data, .balance"
    data-blur-regex="(email|ssn)"
    data-fields='[
        {"name": "name",  "type": "text",     "label": "Your Name", "required": true},
        {"name": "issue", "type": "textarea", "label": "Describe the bug", "required": true}
    ]'></script>
```

Self-hosting is a single file: drop `supportlayer.js` next to your app. The agent needs no second page — the
`live_session_url` in the payload is *your own page* with `?sl_role=agent&peer=<id>` appended, so it works on any
route your app already serves. `data-live-base` overrides the base when the agent should land somewhere else.

**New to this? Read [INTEGRATION.md](https://github.com/Spuds0588/SupportLayer/blob/main/INTEGRATION.md).** It is written to be followed step by step by a human
integrator *or* an AI coding agent: delivery options, the full attribute table, framework recipes
(React/Next.js, Vue/Nuxt, plain HTML, self-driving headless mode), the exact webhook contract including the CORS
preflight your endpoint must answer, CSP and HTTPS requirements, and a post-integration verification checklist.

### Modes

The developer picks the channel once, at install time; the user never switches it mid-session. What the customer sees
inside the request panel is the same component in all three modes — it just becomes a chat thread, or a call.

| `data-mode` | What happens |
| --- | --- |
| `none` | Async bug report only. One-frame JPEG snapshot + diagnostics → webhook. No live channel. |
| `chat` | Everything above, plus a live session: the agent sees the screen and can laser-click, draw, and hand over text. |
| `video` | The same, plus a **two-way** audio + video call in both directions. |

Either live mode carries the customer's screen with it. The share starts when they send the request and runs until the
session ends — the panel offers no way to stop it in between, because an agent who cannot see the screen cannot guide.
`audio` was a third live mode in 2.0 and is now an alias for `video` (it still boots a call).

### Configuration attributes

| Attribute | Values | Purpose |
| --- | --- | --- |
| `data-webhook` | URL | Where `support_request` / `support_update` payloads are POSTed. |
| `data-mode` | `none` `chat` `video` | Async report, or a live P2P session that includes the customer's screen. |
| `data-theme` | hex | Brand colour for every widget surface (`color-mix` derives hover/dim states). |
| `data-headless` | `true` `false` | Suppress the floating button and drive the flow yourself. |
| `data-blur-selectors` | CSS selector list | Elements blurred before capture. |
| `data-blur-regex` | pattern list | Text nodes matching any pattern are wrapped in a blurred span. |
| `data-fields` | JSON | Dynamic request form. Invalid JSON falls back to a single textarea and warns. |
| `data-demo` | `true` `false` | Simulated capture + loopback transport (used by the landing-page demo). |
| `data-live-base` | URL | Override the agent link's base. Defaults to the customer's current `location.href`. |
| `data-peer-cdn` | URL | Override where the PeerJS *library* is fetched from (not the signalling server). |
| `data-label` | text | FAB button label. Default `Get support`. |
| `data-title` | text | Panel heading. Default `Report an issue`. |

`data-blur-selectors` and `data-blur-regex` split on commas **outside** `{}`, `()` and `[]`, so quantifiers like
`{2,}` and selectors like `:is(.a, .b)` survive. A JSON array is also accepted.

### Headless API

```js
window.SupportLayer.requestHelp();   // open the panel / resume prompt
window.SupportLayer.getState();      // IDLE | SENDING | WAITING | CONNECTED
window.SupportLayer.getSession();    // session object, or null
window.SupportLayer.endSession();    // cancel and clean up
window.SupportLayer.reset();         // end + clear local storage (demos, tests)
window.SupportLayer.applyPrivacyBlur();
window.SupportLayer.removePrivacyBlur();
```

Two public events fire on `window`: `supportlayer:state` and `supportlayer:webhook` (carrying the exact payload
that is about to be sent — wire it to your own UI to preview or log what your webhook will receive).

### Webhook payload

```json
{
  "event_type": "support_request",
  "session_id": "uuid-1234-5678",
  "status": "open",
  "mode": "chat",
  "live_session_url": "https://your-site.com/checkout?sl_role=agent&peer=sl-ab12cd34",
  "snapshot": "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ...",
  "user_data": { "name": "Jane Doe", "issue": "The checkout button is frozen." },
  "diagnostics": {
    "url": "https://client-site.com/checkout",
    "browser": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)...",
    "viewport": "1920x1080",
    "timestamp": "2026-09-13T13:54:00Z",
    "window_geometry": { "screen_x": 0, "outer_width": 1440, "device_pixel_ratio": 2 }
  }
}
```

`event_type` is `support_request` on the first submit and `support_update` on resume, cancellation, or completion.
`snapshot` is `null` when the user declines the capture prompt, and is never attached to `support_update`.
`window_geometry` lets the agent view map an *entire screen* capture back onto the page.

`live_session_url` is the only thing the agent needs: send it to a human (or a queue) and opening it puts that
browser on your own page in the agent role.

## Privacy model

1. Redaction is applied to the **host DOM first**, so the user physically sees blurred data in the browser's share
   prompt and in the captured frame.
2. Selector hits are blurred with an injected stylesheet; regex hits have their text nodes wrapped in a blurred span.
3. `removePrivacyBlur()` unwraps every node and deletes every injected tag — the host document returns to its exact
   original markup when a session ends.
4. The widget UI lives in a Shadow DOM, so no host stylesheet can restyle it and no page script can read it.

## The agent experience

Send the agent the `live_session_url` from the payload. Opening it loads **the same page the customer is on**,
with `?sl_role=agent&peer=<client-peer-id>` in the URL, and the widget takes over the viewport instead of showing
the request button: the customer's screen full-bleed, the chat transcript, and a floating dock of tools. It reads
like a video meeting built for support — no dashboards, no extra panels, no analytics chrome.

The dock is the whole interface, and it stays out of the way until used:

| Tool | Behaviour on the customer's page |
| --- | --- |
| **Point** | A laser ripple follows the agent's cursor. Nothing is clicked. |
| **Click** | Visual ripple at the point, then a real `focus()` + `click()` on the element under it. |
| **Draw** | Interaction-blocking canvas strokes in the agent's swatch colour that fade a few seconds after the strokes stop. |
| **Type** | The field is outlined, the text is handed over in a copy/paste tooltip, and (when the field is a plain input) inserted through the native value setter so React/Vue actually register it. |
| **Chat / Report / End** | Toggle the transcript, re-read the diagnostics the customer submitted, or close the session for them. |

A coach line listing the shortcuts appears on connect and then fades; hovering the dock brings it back.

Coordinates are **always normalized `0.0 – 1.0`** of the customer's viewport. The agent view computes the
`object-fit: contain` letterbox offset before normalizing, and offsets whole-screen captures by the customer's
reported window geometry. Pixels never cross the wire.

## Run it locally

```bash
npm start            # zero-dependency static server on http://127.0.0.1:4174
npm test             # headless Chromium end-to-end suite (188 checks)
npm run test:headed  # same suite with a visible window (real rendering + input)
npm run test:live    # the same checks against the deployed GitHub Pages site
npm run live:check   # the REAL path: real capture + real PeerJS signalling between two peers
npm run live:session # open a real session and print the agent URL for a second browser to join
```

The suite boots the server itself, plays the homepage storyboard step by step (asserting which perspective is live
at each beat), drives the two-role fixture end to end (request → redaction → webhook payload → customer and agent
frames joining the same page → chat → laser/draw/type → reload/resume → teardown), runs the in-page assertions in
`test.html`, and fails on any console error, uncaught exception, or broken same-origin request.
It also asserts layout invariants — the FAB inside the customer viewport, the agent dock above the stage floor,
toast and coach line clearing the dock — so a CSS regression fails the build instead of surviving as a bad screenshot.

`test:live` passes `--base <url>` (equivalently `SL_BASE`) so the identical suite runs against a deployed origin —
the same 188 checks pass against `https://spuds0588.github.io/SupportLayer/`, which is how the published page is
verified rather than assumed.

That suite runs everything over a same-origin `BroadcastChannel` bus with synthetic capture, which means it never
touches PeerJS signalling, the `getDisplayMedia` permission flow, or a real media track. `npm run live:check` does:
it opens a genuine customer session in a real browser, dials it from a second peer, and fails unless a real screen
track arrives *and* decodes a frame. `npm run live:session` leaves the customer window open and prints the agent URL
so a human can join the same session from another browser.

## Repository layout

| File | Role |
| --- | --- |
| `supportlayer.js` | The product — both roles. Vanilla JS IIFE, one global, zero dependencies. |
| `index.html` | Landing page: a value-first pitch, a self-playing storyboard that cuts between the two perspectives, and a waving-hands background. |
| `demo.html` | Complete interactive demo: customer request, simulated webhook notification, second-tab agent handoff, and realtime loopback controls. |
| `demo-app.html` | The simulated customer app used by the development fixture. |
| `room.html` | Legacy/dev fixture: the same customer app loaded twice for automated two-role runs. |
| `test.html` | Integration harness with in-page assertions. |
| `serve.js` | Zero-dependency static dev server. |
| `tests/e2e.mjs` | Puppeteer end-to-end suite over the loopback bus (headless + headed). |
| `tests/live-session.mjs` | The real path: real capture + real WebRTC, plus a handoff URL for a human agent. |
| `INTEGRATION.md` | Step-by-step guide for wiring the library into *your* app (humans + coding agents). |
| `agents.md` | Architecture rules for anyone (or any model) editing *this* repo. |
| `todo.md`, `history.md` | Live task list and changelog. |
| `PRD-SupportLayer.md` | The master dev document this was built from. |

## Sister projects

- [MailLayer Embedded](https://spuds0588.github.io/MailLayer-Embedded/) — one line turns `mailto:` links into native webmail compose windows.
- [PhoneLayer Embedded](https://spuds0588.github.io/PhoneLayer-Embedded/) — one line routes `tel:`/`sms:` links to 49 VoIP and SMS providers.
- [ZipLayer](https://spuds0588.github.io/ZipLayer/) — one line replaces a monolithic `.zip` download with an in-browser X-ray preview and selective extraction.

All four follow the same philosophy: client-only, no backend, no build step, MIT.

## License

MIT © 2026 Corey Burns
