# SupportLayer — Integration Guide

**Audience: whoever is putting SupportLayer into an application — a human integrator or an AI coding
agent.** This file tells you how to install, configure, and verify the library. You do not need to read
`supportlayer.js` first; everything you need is below and everything below is checked against the source.

For the architecture of *this repository* (rules for editing the widget itself), read
[`agents.md`](agents.md) instead. For the product pitch, read [`README.md`](README.md).

---

## 0. What you are integrating

A single `<script>` tag adds a support button to a page. When a user clicks it:

1. It shows a form (fields you define) and, on submit, **redacts sensitive parts of the host page**.
2. It captures **one** frame of the user's screen as a 70%-quality JPEG (the browser asks first; the
   capture stream is killed immediately afterwards).
3. It POSTs a JSON payload — diagnostics + form answers + that one frame — to **your** webhook.
4. In `chat`/`video` mode it also opens a **peer-to-peer** channel so an agent can point at
   things, draw on the user's screen, and hand over text for review.

There is no SupportLayer server. The only third-party infrastructure is the PeerJS **signalling**
broker (a public cloud service) for modes other than `none`; the screen and audio never touch it.

---

## 1. Install

### Option A — CDN (fastest)

Put this immediately before `</body>`, once per page load:

```html
<script
    src="https://cdn.jsdelivr.net/gh/Spuds0588/SupportLayer@main/supportlayer.js"
    data-webhook="https://your-app.example.com/api/support"
    data-mode="chat"
    data-theme="#14b8a6"
    data-blur-selectors=".balance, .api-key, [data-sensitive]"></script>
```

Pin an **immutable ref** rather than `@main` in production, so an upstream push cannot change your site
under you. Either a commit SHA
(`@8e18b349cb623f85f7638ae55fff709c8e63b74d` — always valid, no release step) or a release tag once you
create one (`@v2.1.0`). `@main` is fine for evaluation and for this demo site; it is not a pin.

> **There is no separate agent page to deploy — on any hosting option.** The library ships one file
> and both roles. What the agent opens is *your own page* with `?sl_role=agent&peer=<id>` appended,
> so CDN installs and self-hosted installs behave identically. Set `data-live-base` only if the agent
> should land on a different route than the page the request came from.

### Option B — self-host (recommended for production)

Copy **`supportlayer.js`** into your static assets and reference the local path:

```html
<script src="/vendor/supportlayer.js" data-webhook="/api/support" data-mode="chat"></script>
```

That is the whole install. The agent's URL is derived from the customer's own `location.href`, so it
works on every route your app already serves — nothing else to configure.

### Load it exactly once

Do not include the tag twice, and do not bundle/import the file from more than one entry point. The
widget finds its own config via `document.currentScript` with a fallback to the first
`script[src*="supportlayer"]`, so a second instance would attach a second button to the same page.
The widget is safe in `defer`, `async`, and `type="module"` scripts — the fallback covers the cases
where `document.currentScript` is `null`.

### Content Security Policy

Add, if you enforce CSP:

```
script-src  'self' https://cdn.jsdelivr.net https://unpkg.com
connect-src 'self' <your webhook origin> https://0.peerjs.com wss://0.peerjs.com
img-src     'self' data:
media-src   'self' blob:
```

`img-src data:` is required — the snapshot is a `data:` URL JPEG. If you enforce CSP and skip
`connect-src` for the PeerJS broker, live modes will fail while `mode="none"` still works.

### HTTPS

`getDisplayMedia` (the share) and `getUserMedia` (video mode) only work on `https://` or
`localhost`. On plain `http://` the widget degrades gracefully: the payload is still delivered with
`snapshot: null`.

---

## 2. Choose a mode

| `data-mode` | Snapshot + webhook | Live screen share | Extra |
| --- | --- | --- | --- |
| `none` *(default)* | ✅ | ❌ | Async ticket only. Nothing peers, nothing signals. |
| `chat` | ✅ | ✅ | Agent laser-click, draw, and directed typing, over text. |
| `video` | ✅ | ✅ | `chat`, plus a **two-way** audio + video call in both directions. |

**The mode is the developer's decision and is fixed at install time.** There is deliberately no
in-session channel switcher: the user cannot turn a chat into a call, and neither can the agent. Pick
the mode per surface (a `none` marketing page, a `video` billing flow) and let it be.

`audio` was a third live mode in 2.0. `video` already carries two-way audio, so voice-only bought a UI
branch and no capability; the value is now an alias for `video` (it warns on the console and boots a
call rather than silently degrading to a report). Nothing else changes.

### The screen share is scoped to the session, not to a toggle

In a live mode the customer's screen **is** the session. There is no "Share my screen" button and no
"Stop sharing" button anywhere in the panel:

- The share starts with the request. The click that sends the form is the gesture `getDisplayMedia`
  needs, and that single capture is used for *both* the report's snapshot and the live share, so the
  customer sees one permission prompt, not two.
- It runs until the session ends. `End` (or `SupportLayer.endSession()`) stops the tracks and tears the
  session down; nothing else does.
- The contract is stated on the form, before the customer consents — "Your screen is shared with the
  agent for the whole session". Do not move that copy to after the fact.
- Browsers keep their own capture controls (Chrome's floating stop-sharing bar) and a page cannot
  remove them. If the track ends for any reason, both sides are told plainly, the session stays up,
  and the customer gets a one-tap **Share my screen again** — `getDisplayMedia` needs a fresh gesture,
  so it cannot be resumed automatically.

If you fork the panel, keep this shape. A stop control for the customer looks harmless and quietly
removes the product's whole advantage: the agent watching the screen they are guiding against.

If your app has no agent workflow yet, start with `mode="none"`. It is the whole product minus the
live channel, and it needs no broker and no CSP entry beyond your webhook.

---

## 3. Configuration reference

All attributes are read from the `<script>` tag. `data-webhook` and `data-mode` are the only ones you
must think about; the rest have working defaults.

| Attribute | Type | Default | Notes |
| --- | --- | --- | --- |
| `data-webhook` | URL | *(empty)* | POST target. **If empty, the payload is built and discarded silently.** |
| `data-mode` | `none` `chat` `video` | `none` | Anything else silently falls back to `none`. `audio` is deprecated and maps to `video`. |
| `data-theme` | hex | `#14b8a6` | Brand colour. Hover/dim states are derived with `color-mix`. |
| `data-headless` | `true` `false` | `false` | `true` hides the floating button so you can drive the flow from your own UI. |
| `data-blur-selectors` | selector list | *(empty)* | Elements matched are blurred before capture. |
| `data-blur-regex` | pattern list | *(empty)* | Text nodes matching any pattern are wrapped in a blurred span. |
| `data-fields` | JSON | one `textarea` | The request form. See §4. |
| `data-label` | text | `Get support` | Floating button label. |
| `data-title` | text | `Report an issue` | Panel heading. |
| `data-live-base` | URL | the customer's `location.href` | Base for the agent link; `sl_role=agent&peer=<id>` are appended to it. |
| `data-peer-cdn` | URL | `https://unpkg.com/peerjs@1.5.5/dist/peerjs.min.js` | Swaps the PeerJS **library** source only. |
| `data-demo` | `true` `false` | `false` | Simulated capture + loopback transport. See §10. |

`data-blur-selectors` and `data-blur-regex` split on commas **outside** `{}`, `()` and `[]`, so
quantifiers and `:is(...)` groups survive, and a JSON array is accepted too. Prefer
`data-blur-regex='"(?i)password"|"(?i)ssn"'`-style patterns over naive comma lists.

---

## 4. The request form (`data-fields`)

A JSON array of field objects. Attribute quoting matters — use single quotes outside, double inside:

```html
<script src="/vendor/supportlayer.js"
    data-webhook="/api/support"
    data-fields='[
        {"name":"email","type":"email","label":"Work email","required":true},
        {"name":"plan","type":"select","label":"Your plan","options":["Free","Pro","Team"]},
        {"name":"issue","type":"textarea","label":"What went wrong?","required":true,
         "placeholder":"Steps to reproduce help a lot"},
        {"name":"consent","type":"checkbox","label":"I agree to be contacted","required":true}
    ]'></script>
```

| Key | Type | Notes |
| --- | --- | --- |
| `name` | string | **Required.** Key used in `user_data`. Fields without it are dropped. |
| `type` | string | One of `text` `textarea` `email` `tel` `number` `select` `checkbox`. Unknown → `text`. |
| `label` | string | Falls back to `name`. |
| `placeholder` | string | Text/textarea only. |
| `required` | boolean | Blocks submit and lists the offending labels in a toast. |
| `options` | array | For `select`. |

Invalid JSON is **not fatal**: the widget logs
`[SupportLayer] data-fields is not valid JSON (...); using the default field.` and renders a single
`textarea`. So a typo costs you the form, not the widget — check the console after integrating.

Answers arrive as `user_data: { "<name>": <string|boolean> }`. `checkbox` is a real boolean;
everything else is a string.

---

## 5. The webhook contract

### Request

```
POST <data-webhook>
Content-Type: application/json
mode: cors
keepalive: true
```

Your endpoint **must answer the CORS preflight.** `Content-Type: application/json` is not a
CORS-safelisted value, so the browser sends an `OPTIONS` first. Reply to `OPTIONS` with
`Access-Control-Allow-Origin` (your site's origin, or `*`) and
`Access-Control-Allow-Headers: content-type`. A webhook that works from `curl` will still fail in the
browser without this.

Any 2xx is success; the widget does not read your response body. A network failure logs
`[SupportLayer] webhook delivery failed: ...` and the request is **not** retried — the user still sees
the sent state, so treat delivery as best-effort and consider a queue on your side (a webhook-inbox
pattern) if you need durability.

### Body

```json
{
  "event_type": "support_request",
  "session_id": "uuid-1234-5678",
  "status": "open",
  "mode": "chat",
  "live_session_url": "https://your-site.com/checkout?sl_role=agent&peer=sl-ab12cd34",
  "snapshot": "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ...",
  "user_data": { "email": "jane@acme.com", "issue": "Checkout button is frozen." },
  "diagnostics": {
    "url": "https://your-site.com/checkout",
    "browser": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ...",
    "viewport": "1440x900",
    "timestamp": "2026-09-13T13:54:00Z",
    "window_geometry": { "screen_x": 0, "outer_width": 1440, "device_pixel_ratio": 2 }
  }
}
```

| Field | Meaning |
| --- | --- |
| `event_type` | `support_request` on first submit; `support_update` on resume, cancel, or completion. |
| `session_id` | Stable across a session — use it to thread updates onto the original ticket. |
| `status` | `open` \| `cancelled` \| `completed`. |
| `live_session_url` | Send this to an agent. Opening it loads your own page in the agent role. `null` in `mode="none"`. |
| `snapshot` | One-frame 70% JPEG, max 1280px wide. **`null` if the user declined capture**, and never present on `support_update`. |
| `diagnostics.window_geometry` | Lets the agent view map an *entire-screen* capture back onto the page. |

Two HTTP calls are normal for one session (`support_request` then a `support_update` when it ends).
Deduplicate on `session_id`.

### Routing it somewhere real

- **Slack** — point `data-webhook` at an incoming-webhook URL, or a tiny proxy that reformats the
  payload into Block Kit (the `snapshot` data URL needs to be uploaded, not inlined).
- **Zendesk / Jira / Linear** — proxy and map `user_data` onto ticket fields; attach the snapshot
  after decoding the base64.
- **Your own API** — store the raw JSON as-is first, then process. Reformatting at the edge loses the
  fields you did not anticipate needing.

Keep the webhook URL out of the markup when you can: a server-rendered env var beats a hard-coded
string. The URL is visible to anyone who views source, so use a secret-bearing proxy path if the
endpoint is privileged.

---

## 6. Privacy and redaction

**Redaction runs on the host DOM before capture**, so the user physically sees blurred data in the
browser's share prompt and in the stored frame. That ordering is deliberate; do not reorder it.

```html
<script src="/vendor/supportlayer.js"
    data-webhook="/api/support"
    data-mode="chat"
    data-blur-selectors=".balance, .card-number, [data-pii], #account-panel"
    data-blur-regex='"(?i)(ssn|social security)"|"(?i)bearer [a-z0-9._-]+"'></script>
```

Guidance that matters in practice:

- Blur **containers**, not individual values, when a region is sensitive as a whole — a blurred
  number beside an unblurred account name is still a leak.
- Include error banners, console output panels, and any autofilled profile widget.
- `data-blur-selectors` matches at capture time. If your app renders sensitive data *after* a route
  change, use selectors that exist on every screen (a `data-pii` attribute) rather than positional ones.
- Round-trip is guaranteed: `removePrivacyBlur()` unwraps every injected wrap node and deletes every
  injected `<style>`, returning the host DOM to its exact original markup. If you have custom
  teardown, call it.

Widget UI lives in a **Shadow DOM**, so your stylesheets cannot restyle the panel and your page
scripts cannot read it — but equally, your CSS reset will not apply inside it. Brand it via
`data-theme` rather than by trying to target shadow nodes.

---

## 7. Framework recipes

The script must run in a browser; it touches `document` at module scope. Do not import it into a
server-rendered bundle, and do not let SSR evaluate it.

### Plain HTML
Add the tag before `</body>`. Done.

### React / Next.js (App Router)
Add the tag once in the root layout via Next's `Script` component, or as a raw `<script>` tag. Keep
it out of component bodies so a re-render cannot re-append it:

```jsx
// app/layout.tsx
import Script from "next/script";

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>
        {children}
        <Script
          src="/vendor/supportlayer.js"
          data-webhook={process.env.NEXT_PUBLIC_SUPPORT_WEBHOOK}
          data-mode="chat"
          strategy="afterInteractive"
        />
      </body>
    </html>
  );
}
```

### Vue / Nuxt
`nuxt.config.ts` → `app.head.script`: one entry with `src` and your `data-*` attributes. In a plain
Vite Vue app, put the tag in `index.html`.

### Single-page apps
The widget lives outside your router, so it survives navigation — which is what you want (it must not
remount). Two consequences:

- Redaction selectors must hold on *every* route, not just the one where the user clicked.
- To open the panel from your own UI (e.g. a "Get help" item in a nav menu), set `data-headless="true"`
  and call `window.SupportLayer.open()`.

### Self-driving the flow (headless)
With `data-headless="true"` there is no floating button; use the API:

```js
window.SupportLayer.requestHelp();  // open the panel, or the resume prompt if a session exists
window.SupportLayer.open();         // always open the panel (no resume logic)
window.SupportLayer.getState();     // "IDLE" | "SENDING" | "WAITING" | "CONNECTED"
window.SupportLayer.getSession();   // deep copy of the session, or null
window.SupportLayer.endSession();   // cancel and clean up
window.SupportLayer.reset();        // end, clear storage, back to IDLE (demos/tests)
window.SupportLayer.applyPrivacyBlur();
window.SupportLayer.removePrivacyBlur();
window.SupportLayer.version;        // "1.0.0"
window.SupportLayer.config;         // the parsed configuration
```

`requestHelp()` must ultimately be triggered by a user gesture — the snapshot needs one, and browsers
block `getDisplayMedia` otherwise.

### Events

```js
window.addEventListener("supportlayer:state", (e) => {
  console.log(e.detail.state, e.detail.session_id); // for analytics or your own spinner
});

window.addEventListener("supportlayer:webhook", (e) => {
  console.log("about to send", e.detail); // fires with the exact payload
});
```

`supportlayer:state` fires on every transition; `supportlayer:webhook` fires once per payload and is
handy for logging what left the page. Neither bubbles out of a shadow root.

### Resume behaviour
Every state change is mirrored to `localStorage['supportlayer_session']`. WebRTC cannot survive a
reload, so after a reload the widget shows a **resume prompt** instead of silently reconnecting —
automated media capture without a gesture is blocked by browsers. Do not try to skip that prompt.

---

## 8. The agent experience

Open the `live_session_url` from the webhook payload. That is the entire workflow: the payload is the
only handshake the agent needs.

The URL points at **the same page the customer is on**, with `?sl_role=agent&peer=<client-peer-id>`.
The widget sees the role param and takes over the viewport instead of rendering the request button:
the customer's live screen full-bleed, the chat transcript, and a floating tool dock. It is
intentionally close to a video meeting — there is no dashboard, no session list, no analytics panel,
and it does not need any route of its own.

- The URL carries `?peer=<client-peer-id>`. The customer is the peer that *answers*; the agent
  initiates. Never reverse this — it would require the customer to know the agent's id.
- `?sl_role=agent` is the only role switch. A bare `role=` param is ignored on purpose, because host
  apps use that name for their own permissions and the widget must not hijack it.
- Tools, all in the bottom dock: **Point** (a laser ripple follows the cursor, nothing is clicked),
  **Click** (ripple, then a real `focus()` + `click()` on the element under the point), **Draw**
  (interaction-blocking strokes in the agent's swatch colour that fade a few seconds after the
  strokes stop), **Type** (outlines the target, hands the text over in a copy/paste tooltip, and
  inserts it through the native value setter so React/Vue register the change), plus **Chat**,
  **Report** and **End**.
- The agent's stage is never blank and never lies about what it is showing. The badge reports the
  mode and the share state (`Connected · video call · screen live · 1260×820`), and if the session is
  up but no picture has arrived the stage says *"Connected — waiting for their screen…"* rather than
  rendering an empty frame. Keep that honesty if you fork it: an agent must be able to tell "they have
  not shared yet" apart from "the feed is live and nothing is happening".
- Requires `https://` for the agent's own camera/mic in `video` mode. `chat` needs no media
  permission on either side beyond the customer's screen share at request time.
- The agent first locks the visible shared surface to the customer's reported viewport aspect ratio and scales it to fit the agent window. Coordinates are **normalized `0.0`–`1.0`** within that surface; pixels never cross the wire. If you fork the agent view, preserve the customer-ratio surface and account for any remaining `object-fit: contain` letterboxing.

Typical wiring: the webhook handler posts `live_session_url` into a Slack channel or a ticket
comment, and an agent clicks it.

---

## 9. Verify your integration

Do these in order; each one catches a distinct class of mistake.

1. **Boot check** — in the console, run:
   `SupportLayer.version` → a version string, and `SupportLayer.config.webhook` → your URL.
   Empty webhook means the payload is thrown away.
2. **One real request** — click the button, capture, submit. Confirm:
   - the frame in the payload is blurred where you expected;
   - `snapshot` is a `data:image/jpeg` string (or `null` if you declined capture);
   - `user_data` keys match your `data-fields` `name` values.
3. **Preflight** — open the Network tab: the `POST` must not be preceded by a failed `OPTIONS`. If it
   is, add the CORS headers (§5).
4. **Decline path** — submit and refuse the screen-share prompt. The request must still be delivered
   with `snapshot: null`. It must not throw or hang, the session must still connect, and the panel
   must say the agent cannot see the screen and offer **Share my screen again**.
5. **Teardown** — call `SupportLayer.removePrivacyBlur()` and confirm the page's markup is unchanged
   (`document.body.innerHTML` before vs after; the widget's own tree should be the only difference).
6. **Round trip** — open the payload's `live_session_url` in a second browser. It must load *your*
   page with the agent dock over it, not a SupportLayer page. In `chat` mode, move the agent's pointer
   and confirm the laser lands on the element you hovered; then confirm **Type** hands text to the
   right field. The agent surface should match the customer's viewport ratio and scale inside the agent window; coordinate misalignment is the most common fork regression.
   - **Did the agent actually see something?** The badge must read `screen live` and the stage must
     show the customer's page, not an empty frame. If it says `no screen yet` while the customer's
     panel says the agent can see their screen, the media call never connected — check that nothing
     between you and the signalling broker (a proxy, a CSP entry) is dropping it. `npm run live:check`
     in this repo is a working reference: it opens a real session and asserts a decoded frame lands on
     the agent stage.
7. **Mode is fixed** — confirm the customer's panel offers no way to switch between chat and video.
   Changing the channel must require editing `data-mode` and reloading.
8. **The share cannot be stopped** — in a live session, confirm the only buttons in the panel are the
   call controls and `End`. There must be no "Stop sharing" and no share toggle; ending the session is
   what stops it. Then end the session and confirm the capture indicator disappears.
9. **Mobile** — repeat step 2 on a phone-sized viewport. The panel clamps itself to
   `min(384px, 100vw - 32px)` wide and `min(620px, 100vh - 120px)` tall, so it should never overflow;
   confirm the button stays reachable above your own fixed footers or cookie bars.
10. **Console hygiene** — the page must log no `console.error` after a full session. Two `warn`
   messages are legitimate: the `data-fields` warning (only if your JSON is invalid) and a webhook
   delivery failure (only if the POST actually failed).

Two live pages you can compare against: the
[two-role room](https://spuds0588.github.io/SupportLayer/room.html) (the real widget in both roles at
once, over the loopback transport — the customer frame above, the agent frame below) and the
[integration harness](https://spuds0588.github.io/SupportLayer/test.html) (in-page assertions and a
link into a real session). The
[homepage](https://spuds0588.github.io/SupportLayer/) is a pitch with a scripted animation, not a
harness.

---

## 10. Demo mode — do not ship it

`data-demo="true"`, or `?sl-demo=1` on the URL, replaces `getDisplayMedia` with a synthetic frame and
PeerJS with a `BroadcastChannel` loopback bus. It exists so a page can show the whole flow with no
backend and no permission prompt — `room.html` and the test suite use it for that.

**It must never be reachable in production.** Do not set `data-demo` in a template that a user can
influence, and if you accept a query string anywhere near the widget, be aware
`?sl-demo=1` switches it on. The two-role room deliberately drives the *real* widget — only capture
and transport are simulated, so commands issued from it are genuine and land on the page.

---

## 11. Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| No button appears | `data-headless="true"`, or the script tag is missing/blocked by CSP | Check `SupportLayer.config.headless`; check the Network tab for a blocked script. |
| Payload never arrives | Empty `data-webhook` | Silent by design — check `SupportLayer.config.webhook` in the console and set the attribute. |
| Payload arrives from `curl` but not the browser | Missing CORS preflight response | Add `Access-Control-Allow-*` headers to `OPTIONS`. |
| `snapshot` is always `null` | Declined capture, unsupported browser, or insecure context | Serve over HTTPS or `localhost`. |
| `live_session_url` points at a raw HTML page | Console hosted on a CDN | Let the default apply, or set `data-live-base` to a real HTML host. |
| Live mode never connects | CSP blocks the PeerJS broker | Add `connect-src https://0.peerjs.com wss://0.peerjs.com`. |
| Laser lands in the wrong place | Agent surface ratio differs from the customer viewport, or the fork normalizes against the stage | Lock the shared surface to the customer's viewport ratio, then normalize within that rendered surface and account for letterboxing. |
| Blur is missing on a regex | Pattern got comma-split | Use a JSON array, or avoid commas outside `{}`/`()`/`[]`. |
| Form shows one textarea | Invalid `data-fields` JSON | Look for the `data-fields` warning in the console. |
| Second click does nothing | 60-second per-session rate limit | Expected. `SupportLayer.reset()` clears it for testing. |
| Widget appears twice | The script was included more than once | Include it exactly once, in the root layout. |

---

## 12. Scope — what it deliberately does not do

Do not build these on top of the current version without agreeing to change the architecture:

- **No backend of any kind.** No relay, no storage, no screenshot service. If a design needs one, that
  design is out of scope for this library.
- **No synthetic keystroke streams.** Typing is clipboard-first by design: automated key events are
  unreliable and hostile. Directed Typing is the contract.
- **One customer, one agent.** Multi-party sessions are not supported in v1.
- **`:root`-level DOM rewriting.** Redaction wraps text nodes and adds one `<style>`; it does not
  serialize or clone the page. Do not add `html2canvas`/`rrweb`-style instrumentation.
- **No offline queue.** Webhook delivery is best-effort; durability is *your* endpoint's job.

---

## 13. Versioning

The current version is reported by `window.SupportLayer.version` and in the file header of
`supportlayer.js` (**2.1.0** — three modes, a session-scoped screen share, and the live-path fix
below; 2.0.0 was the release that collapsed the two-page design into one script with two roles).
Pin the CDN URL to a tag or commit SHA for production
(`https://cdn.jsdelivr.net/gh/Spuds0588/SupportLayer@v2.1.0/supportlayer.js` once tagged, or an
immutable SHA as shown in §5) and read the [`history.md`](history.md) entry for a version before
upgrading — it records the behaviour changes and bug fixes so you can tell whether an upgrade
affects you.

The 2.1.0 upgrade is **breaking in two ways, both deliberate**: `data-mode="audio"` now boots a
video call (same two-way audio, plus camera), and the customer can no longer stop screen sharing
mid-session. If either is a problem for your surface, use `data-mode="chat"` — text plus the agent's
view of the screen, with no call at all.

If you fork the widget, keep `agents.md` next to it; it documents the invariants that are easy to
break and expensive to debug.

---

MIT © 2026 Corey Burns
