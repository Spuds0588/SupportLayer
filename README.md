# SupportLayer

**SupportLayer is a zero-backend, drop-in diagnostic and live P2P support widget for web applications.**
Add one `<script>` tag and your users get an immediate bug-report path that POSTs rich diagnostics — including a
redacted, one-frame snapshot — straight to the webhook you already have (Slack, Zendesk, Zapier, your own API).
When a report isn't enough, an agent opens a live peer-to-peer screen session and can point at things, draw on the
user's screen, and hand text over for review.

No middleware, no S3 bucket, no WebSocket relay, no SDK, no build step. Three files do the work.

- Landing page + **simulated demo**: https://spuds0588.github.io/SupportLayer/
- Integration harness: https://spuds0588.github.io/SupportLayer/test.html
- Agent console: https://spuds0588.github.io/SupportLayer/agent.html

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

Self-host it by dropping `supportlayer.js` and `agent.html` next to your app — the widget derives the agent URL from
its own script location, so nothing else needs configuring.

### Modes

| `data-mode` | What happens |
| --- | --- |
| `none` | Async bug report only. One-frame JPEG snapshot + diagnostics → webhook. No live channel. |
| `chat` | Everything above, plus a PeerJS data channel so an agent can laser-click, draw, and hand over text. |
| `audio` | Chat, plus the agent's microphone streamed back to the user. |
| `video` | Chat, plus the agent's camera. |

Screen sharing is always a separate, explicit action (`Share my screen`), so the snapshot at request time is the only
thing captured by default.

### Configuration attributes

| Attribute | Values | Purpose |
| --- | --- | --- |
| `data-webhook` | URL | Where `support_request` / `support_update` payloads are POSTed. |
| `data-mode` | `none` `chat` `audio` `video` | Async report or live P2P session. |
| `data-theme` | hex | Brand colour for every widget surface (`color-mix` derives hover/dim states). |
| `data-headless` | `true` `false` | Suppress the floating button and drive the flow yourself. |
| `data-blur-selectors` | CSS selector list | Elements blurred before capture. |
| `data-blur-regex` | pattern list | Text nodes matching any pattern are wrapped in a blurred span. |
| `data-fields` | JSON | Dynamic request form. Invalid JSON falls back to a single textarea and warns. |
| `data-demo` | `true` `false` | Simulated capture + loopback transport (used by the landing-page demo). |
| `data-live-base` | URL | Override the agent console URL. Defaults to `agent.html` next to the script. |

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
that is about to be sent — it is what powers the payload inspector in the demo).

### Webhook payload

```json
{
  "event_type": "support_request",
  "session_id": "uuid-1234-5678",
  "status": "open",
  "mode": "chat",
  "live_session_url": "https://your-site.com/agent.html?peer=sl-ab12cd34",
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
`window_geometry` lets the agent console map an *entire screen* capture back onto the page.

## Privacy model

1. Redaction is applied to the **host DOM first**, so the user physically sees blurred data in the browser's share
   prompt and in the captured frame.
2. Selector hits are blurred with an injected stylesheet; regex hits have their text nodes wrapped in a blurred span.
3. `removePrivacyBlur()` unwraps every node and deletes every injected tag — the host document returns to its exact
   original markup when a session ends.
4. The widget UI lives in a Shadow DOM, so no host stylesheet can restyle it and no page script can read it.

## Agent console

Open `agent.html?peer=<client-peer-id>` — the id comes from `live_session_url` in the payload. The customer is the
callee, so the webhook is the only thing the agent needs.

| Tool | Behaviour on the customer's page |
| --- | --- |
| **Laser click** | Visual ripple at the point, then a real `focus()` + `click()` on the element under it. |
| **Draw** | Interaction-blocking canvas strokes that clear 3 seconds after the agent stops drawing. |
| **Type** | The field is outlined, the text is handed over in a copy/paste tooltip, and (when the field is a plain input) inserted through the native value setter so React/Vue actually register it. |

Coordinates are **always normalized `0.0 – 1.0`** of the customer's viewport. The console computes the
`object-fit: contain` letterbox offset before normalizing, and offsets whole-screen captures by the customer's
reported window geometry. Pixels never cross the wire.

## Run it locally

```bash
npm start            # zero-dependency static server on http://127.0.0.1:4174
npm test             # headless Chromium end-to-end suite
npm run test:headed  # same suite with a visible window (real rendering + input)
npm run test:live    # the same 84 checks against the deployed GitHub Pages site
```

The suite boots the server itself, drives the simulated demo end to end (request → redaction → webhook payload →
agent connect → laser/draw/type → reload/resume → teardown), runs the in-page assertions in `test.html`, and fails on
any console error, uncaught exception, or broken same-origin request.

`test:live` passes `--base <url>` (equivalently `SL_BASE`) so the identical suite runs against a deployed origin —
the same 84 checks pass against `https://spuds0588.github.io/SupportLayer/`, which is how the published page is
verified rather than assumed.

## Repository layout

| File | Role |
| --- | --- |
| `supportlayer.js` | The product. Vanilla JS IIFE, one global, zero dependencies. |
| `agent.html` | The agent console. Single self-contained file. |
| `index.html` | Landing page + simulated demo (customer frame, agent frame, payload inspector). |
| `demo-app.html` | The simulated customer app used inside the demo frame. |
| `test.html` | Integration harness with in-page assertions. |
| `serve.js` | Zero-dependency static dev server. |
| `tests/e2e.mjs` | Puppeteer end-to-end suite (headless + headed). |
| `agents.md` | Architecture rules for anyone (or any model) editing this repo. |
| `todo.md`, `history.md` | Live task list and changelog. |
| `PRD-SupportLayer.md` | The master dev document this was built from. |

## Sister projects

- [MailLayer Embedded](https://spuds0588.github.io/MailLayer-Embedded/) — one line turns `mailto:` links into native webmail compose windows.
- [PhoneLayer Embedded](https://spuds0588.github.io/PhoneLayer-Embedded/) — one line routes `tel:`/`sms:` links to 49 VoIP and SMS providers.

All three follow the same philosophy: client-only, no backend, no build step, MIT.

## License

MIT © 2026 Corey Burns
