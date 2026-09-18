# SupportLayer Master Dev Document

> **AMENDMENT (v2, 2026-09-14) — read before acting on §2.1 or any `agent.html` reference below.**
> The original brief called for a standalone agent dashboard (`agent.html`). The maintainer's
> corrected vision is narrower: **the agent goes to the same domain as the user**, with URL
> parameters selecting the support experience. There is therefore **one deliverable**,
> `supportlayer.js`, and the agent role is that same script on the customer's own URL with
> `?sl_role=agent&peer=<id>`. `agent.html` has been deleted; do not rebuild it.
> The support agent sees a video-meeting-style surface — the customer's screen full-bleed plus a
> floating bottom dock of annotation tools (**Point / Click / Draw / Clear**, **Chat**, **Report**,
> **End**) — not a dashboard of panels and metrics. The request panel the user submits *becomes*
> the session: chat, or a **two-way** audio/video call, as fixed by `data-mode` at install time
> (never switchable in-session). See `agents.md` for the current architecture rules and
> `INTEGRATION.md` for the current contract. Everything else in this document still applies.
>
> **AMENDMENT (v2.1, 2026-09-14) — modes and the screen share.** Two corrections to the text below:
> 1. There are **three** modes, not four: `none`, `chat`, `video`. Voice-only `audio` is gone —
>    `video` already carries two-way audio, so a separate mode added a UI branch and no capability.
>    The old value is still accepted and maps to `video` with a console warning.
> 2. The customer's screen share is **scoped to the session and cannot be stopped from the panel**.
>    It starts with the request (one `getDisplayMedia` call serves as both the report snapshot and
>    the live share) and ends when the session ends. The contract is stated on the request form,
>    before consent. Wherever §4 or §5 says the user opts in to sharing mid-session, that is
>    superseded: a customer-held stop control destroys the product's only real advantage — the agent
>    guiding against a screen they can actually see. The browser's own capture indicator is outside
>    our reach; if the track ends, both sides are told and the customer can resume with one tap.

## Part 1: Product Requirements Document (PRD)

### 1.1 Product Overview
**SupportLayer** is a zero-backend, drop-in diagnostic and live P2P support widget for web applications. It serves as a sister project to MailLayer and PhoneLayer. By adding a single `<script>` tag to their application, developers can provide their users with an immediate bug-reporting and live-support pipeline that routes rich diagnostic data (including screen captures and live WebRTC control links) directly to their existing webhooks (Slack, Zendesk, Zapier, etc.).

### 1.2 Target Audience
*   **Developers:** Need a low-friction, high-compatibility tool to gather bug reports without setting up S3 buckets, complex WebSockets, or heavy third-party SDKs.
*   **Support Agents:** Need the ability to see exactly what the user sees to diagnose browser, extension, or rendering-specific issues, and visually guide the user.
*   **End Users:** Need a simple, non-intrusive way to report issues or get real-time help without leaving the application.

### 1.3 Core Principles & Guiding Philosophy
*   **YAGNI (You Aren't Gonna Need It):** No intermediate backends, no heavy OCR libraries, no persistent database requirements.
*   **Zero-Friction Integration:** Completely configurable via HTML `data-*` attributes on the script tag.
*   **Privacy First (Trust but Verify):** PII redaction happens at the DOM level so the user physically sees their data blurred before/during screen sharing.
*   **Security Context Boundaries:** Remote typing is handled via "Directed Typing" (prompts to copy/paste) rather than synthetic keystrokes to ensure compatibility with modern SPAs (React, Vue) and respect browser security sandboxing.

### 1.4 Core Features & Requirements
1.  **Drop-In Configuration:** Support JSON-based dynamic form fields, theming (single hex code), and modes (`none`, `chat`, `video`, with `audio` deprecated to `video`) via `<script>` tag attributes.
2.  **Privacy Redaction:** Support CSS selector and Regex-based text node blurring applied locally to the DOM prior to screen capture.
3.  **Async Bug Reporting (Mode: None):** Capture a Base64 JPEG snapshot of the viewport (via momentary `getDisplayMedia`) to send a rich webhook payload without exceeding standard size limits.
4.  **Live P2P Support (Mode: Chat+):** Establish a PeerJS WebRTC data/video channel for real-time interaction.
5.  **State Persistence:** Utilize `localStorage` to maintain session state across page reloads, allowing users to resume open support requests.
6.  **Agent Control Tools:**
    *   *Laser Pointer:* Agent clicks simulate DOM clicks on the user's screen with visual feedback.
    *   *Directed Typing:* Agent sends text, highlighting the target input and providing a copy/paste tooltip to the user.
    *   *Glass-Pane Drawing:* Agent draws on the video feed; the client renders temporary, interaction-blocking strokes on an overlay `<canvas>` that clears upon inactivity.
7.  **Spam Mitigation:** Hidden honeypot field, 60-second `sessionStorage` rate limiting, and requiring `isTrusted` click events.

---

## Part 2: Implementation Guide

### 2.1 System Architecture
The system is **one client-side component with two roles** (see the v2 amendment above):
1.  **`supportlayer.js` (The Client Injector) — customer role:** Injects a Shadow DOM interface to prevent CSS bleeding. Manages local state, DOM mutation (blurring), WebRTC pairing, and webhook execution. The request panel *becomes* the session: chat, or a two-way audio/video call, as fixed by `data-mode`.
2.  ~~**`agent.html` (The Support Dashboard):**~~ **Superseded — do not build this.** The agent role is the same `supportlayer.js` on the customer's own URL, selected by `?sl_role=agent&peer=XYZ`. The script reads the peer id, streams the customer's video full-bleed, and translates agent interactions (clicks/draws) into normalized percentages `(0.0 to 1.0)` sent over the data channel. There is no second HTML file and no separate portal to host or authenticate.

### 2.2 Script Integration API
Developers integrate the tool using the following configuration:

```html
<script 
    src="https://cdn.domain.com/supportlayer.js" 
    data-webhook="https://api.domain.com/webhook"
    data-mode="chat" 
    data-theme="#FF5733"
    data-headless="false"
    data-blur-selectors=".sensitive-data, .balance"
    data-blur-regex="(email|ssn)"
    data-fields='[
        {"name": "name", "type": "text", "label": "Your Name"},
        {"name": "issue", "type": "textarea", "label": "Describe the bug"}
    ]'
></script>
```

### 2.3 Webhook Payload Schema
The script executes a `POST` request to the provided webhook. It fires `support_request` initially, and `support_update` upon session resume, cancellation, or completion.

```json
{
  "event_type": "support_request", 
  "session_id": "uuid-1234-5678",
  "status": "open",
  "mode": "chat",
  "live_session_url": "https://dashboard.domain.com/agent?peer=peerjs-id-123",
  "snapshot": "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ...", 
  "user_data": {
    "name": "Jane Doe",
    "issue": "The checkout button is frozen."
  },
  "diagnostics": {
    "url": "https://client-site.com/checkout",
    "browser": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)...",
    "viewport": "1920x1080",
    "timestamp": "2026-09-13T13:54:00Z"
  }
}
```
*Note: `snapshot` is `null` if the user declines the screen prompt, or if it is a `support_update` event. In a live mode declining means the agent cannot see the screen at all — the session still connects and the panel offers a one-tap resume.*

### 2.4 Headless API
If `data-headless="true"`, the floating action button (FAB) is suppressed, and the developer can manually trigger the flow via standard DOM elements:
*   `window.SupportLayer.requestHelp()`
*   `window.SupportLayer.endSession()`
*   `window.SupportLayer.getState()` (Returns `IDLE`, `WAITING`, `CONNECTED`)

---

## Part 3: Developer Task List

### Phase 1: Core Initialization & UI
- [ ] Parse configuration variables from `document.currentScript.dataset`.
- [ ] Implement `try/catch` JSON parser for the `data-fields` attribute, falling back to a default `textarea` if invalid.
- [ ] Create the Shadow DOM container to encapsulate CSS styling.
- [ ] Implement CSS custom properties using the `data-theme` hex code, generating hover states via `color-mix`.
- [ ] Build the dynamic form renderer based on the parsed `fields` JSON.
- [ ] Implement state management logic (`IDLE`, `WAITING`, `CONNECTED`) syncing with `localStorage`.
- [ ] Build view-toggling logic for Initial Request, Resume Prompt, Waiting, and Connected states.

### Phase 2: Privacy & Capture Layer
- [ ] Implement `applyPrivacyBlur()`: Inject CSS for `data-blur-selectors`.
- [ ] Implement `applyPrivacyBlur()`: Create a `TreeWalker` to find and wrap matching `data-blur-regex` text nodes in blurred spans.
- [ ] Implement `removePrivacyBlur()` for cleanup.
- [ ] Write the `getScreenSnapshot()` function: trigger `getDisplayMedia`, write first frame to a hidden canvas, output to 70% quality base64 JPEG, and immediately kill media tracks.

### Phase 3: Networking & Anti-Spam
- [ ] Build webhook POST request logic.
- [ ] Implement 60-second rate limiter utilizing `sessionStorage`.
- [ ] Implement Honeypot field check on form submission.
- [ ] Ensure form submission relies on an `isTrusted` click event.
- [ ] Implement dynamic loading of the PeerJS library via script injection.
- [ ] Configure WebRTC instantiation, saving the peer ID to local state and appending it to `live_session_url` in the webhook payload.
- [ ] Implement state recovery (firing `support_update` webhook with identical `session_id` on page reload/resume).

### Phase 4: Agent Control (Client Side)
- [ ] Setup DataChannel listeners for incoming commands: `click`, `type`, `draw`.
- [ ] Implement `handleRemoteClick(x, y)`: Convert percentage coordinates to pixels, spawn visual laser pointer, and call `.click()` & `.focus()` via `document.elementFromPoint()`.
- [ ] Implement `handleRemoteType(x, y, text)`: Outline the target input, inject a floating tooltip with a "Copy" button, and handle clipboard injection.
- [ ] Implement `handleRemoteDraw(lines)`: Render coordinate arrays onto a fixed `<canvas>`, temporarily set `pointer-events: auto` to block interaction, and clear context via timeout after 3 seconds of inactivity.

### Phase 5: Agent View (Agent Side) — *implemented inside `supportlayer.js`, not a second file*
> **Delivered as one script, two roles.** The items below are the original framing of a separate
> dashboard; they all now live in `supportlayer.js` and are gated behind `AGENT_ROLE`.
- [x] Agent surface lives in `supportlayer.js` (nothing to scaffold; `agent.html` was deleted).
- [x] URL parameter parsing to extract the target `peer` ID (`?sl_role=agent&peer=…`).
- [x] PeerJS connection logic for data channels and answering media streams (both directions).
- [x] Coordinate normalization: the agent surface locks to the customer's reported viewport aspect ratio, scales to fit the agent stage, and sends relative `x`/`y` percentages `(0-1)` from that rendered surface while accounting for any `object-fit: contain` letterboxing.
- [x] Map MouseDown/MouseMove events to the selected dock tool (Point, Click, Type, Draw).
- [x] Draw coordinates batched and sent via DataChannel on mouse-move intervals.

---

## Part 4: agents.md

### System Context & Maintainer Directives

This document establishes the boundaries and rules for AI models or engineers interacting with the SupportLayer codebase.

#### 1. Architecture Paradigm
**SupportLayer is fully client-centric.** 
We do not host middleware. The client connects directly to the customer's defined Webhook, and the WebRTC connection operates strictly P2P. Do not propose adding WebSockets, Node.js relay servers, or AWS S3 buckets to the architecture.

#### 2. Strict YAGNI Execution
Do not over-engineer solutions. If a feature can be accomplished with a native Browser API, use it over a third-party library. 
*   *Do not* add heavy libraries like `rrweb` or `html2canvas`. Use native `getDisplayMedia` and standard `<canvas>` APIs.
*   *Do not* attempt to simulate `KeyboardEvent` streams to bypass SPA frameworks. Use the designed "Directed Typing" copy/paste prompt.

#### 3. State Management Rules
When modifying the widget state:
*   State must always be mirrored to `localStorage('supportlayer_session')`. 
*   Because WebRTC connections do not survive a page reload, returning to an active state (`WAITING` or `CONNECTED`) without an active Peer connection must trigger the `view-resume` UI. Do not attempt to automatically reconstruct a dropped WebRTC connection without user interaction, as browsers will block automated media requests without a trusted user gesture.

#### 4. Coordinate Math Considerations
When modifying the agent view (the `AGENT` branch of `supportlayer.js`) or the drawing logic:
*   All coordinates sent over the data channel **must** be normalized to percentages (`0.0` to `1.0`). Never send absolute pixel values. 
*   The agent view must lock the shared surface to the customer's viewport aspect ratio, scale it proportionally inside the stage, and calculate coordinates from that *rendered* surface, not the full agent DOM. Calculate any aspect ratio offset (`object-fit: contain` letterboxing) before normalizing the coordinates, or clicks/drawings will misalign on the client's screen.

#### 5. DOM Manipulation and Privacy
*   The widget UI must remain inside the Shadow DOM to prevent host site CSS interference. 
*   However, privacy blurring (CSS injection and text-node wrapping) must be applied to the **Host Document (`document.body`)**, not the Shadow DOM.
*   Ensure the `removePrivacyBlur()` function thoroughly unwraps text nodes and removes injected `<style>` tags to prevent breaking the host application state when a session ends.