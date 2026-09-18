/*!
 * SupportLayer v2.1.0
 * Zero-backend, drop-in diagnostic + live P2P support widget for web applications.
 *
 * One script, two roles. The customer loads the page normally. The agent opens the
 * SAME page with `?sl_role=agent&peer=<id>` and the widget boots into a full-screen
 * agent view instead of the request button: the customer's screen, a chat
 * transcript, and a floating dock of annotation tools. There is no second app.
 *
 * Modes (`data-mode` / `?sl_mode=`), fixed by the integrator at install time:
 *   - none   — async report only, no live channel at all.
 *   - chat   — live session: the agent watches the screen and guides over text.
 *   - video  — live session plus a two-way audio + video call.
 *
 * Design rules that must not be broken (see agents.md / PRD-SupportLayer.md):
 *   - No middleware. Webhook POST + P2P WebRTC only.
 *   - YAGNI: native browser APIs, no screenshot/serializer libraries.
 *   - All coordinates on the wire are normalized 0.0-1.0, never pixels.
 *   - Widget UI lives in a Shadow DOM; privacy blur is applied to the host document.
 *   - Reports, privacy blur and screen capture only ever run in the customer role.
 *   - The live mode is the integrator's choice, never a control in the widget.
 *   - The customer's screen share is SESSION-SCOPED: it starts with the request and ends
 *     when the session ends. The panel deliberately offers no way to stop it — an agent
 *     who cannot see the screen cannot guide, which is the whole product.
 *
 * MIT License.
 */
(function () {
  "use strict";

  /* ====================================================================== *
   * 0. Small helpers
   * ====================================================================== */

  var VERSION = "2.1.0";
  var STORAGE_KEY = "supportlayer_session";
  var RATE_KEY = "supportlayer_rate";
  var RATE_WINDOW_MS = 60 * 1000;
  var PRIVACY_STYLE_ID = "supportlayer-privacy-css";
  var TARGET_STYLE_ID = "supportlayer-target-css";
  var DEFAULT_THEME = "#14b8a6";
  var DEFAULT_PEER_CDN = "https://unpkg.com/peerjs@1.5.5/dist/peerjs.min.js";
  var MODES = ["none", "chat", "video"];
  /**
   * `audio` was a third live mode in 2.0. `video` already carries two-way audio, so voice-only
   * added a UI branch without adding a capability. Anyone still passing it wants a call, so it
   * maps to `video` rather than silently degrading to a report-only widget.
   */
  var LEGACY_MODES = { audio: "video" };
  var SWATCHES = ["#14b8a6", "#f59e0b", "#f43f5e", "#38bdf8"];

  function uuid() {
    try {
      if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    } catch (e) {
      /* fall through */
    }
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
      var r = (Math.random() * 16) | 0;
      return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
    });
  }

  function shortId(id) {
    return String(id || "").slice(0, 8);
  }

  function esc(str) {
    return String(str == null ? "" : str).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function clamp(n, min, max) {
    n = Number(n);
    if (!isFinite(n)) return min;
    return Math.min(max, Math.max(min, n));
  }

  function round3(n) {
    return Math.round(Number(n) * 1000) / 1000;
  }

  function isHex(v) {
    return /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.test(String(v || "").trim());
  }

  function normalizeHex(v) {
    var s = String(v || "").trim();
    if (!isHex(s)) return DEFAULT_THEME;
    if (s.charAt(0) !== "#") s = "#" + s;
    if (s.length === 4) s = "#" + s[1] + s[1] + s[2] + s[2] + s[3] + s[3];
    return s.toLowerCase();
  }

  function nowIso() {
    return new Date().toISOString();
  }

  /**
   * Split a comma-separated attribute into entries without tearing apart the entries
   * themselves: quantifiers (`{2,}`), selector functions (`:is(a, b)`) and attribute
   * selectors (`[data-x]`) all legally contain commas. A JSON array is accepted too.
   */
  function splitPatterns(raw) {
    var s = String(raw == null ? "" : raw).trim();
    if (!s) return [];
    if (s.charAt(0) === "[") {
      try {
        var parsed = JSON.parse(s);
        if (Array.isArray(parsed)) return parsed.map(String).filter(function (x) { return x.trim(); });
      } catch (e) {
        /* not JSON — fall through to the brace-aware splitter */
      }
    }
    var out = [];
    var current = "";
    var depth = 0;
    for (var i = 0; i < s.length; i++) {
      var ch = s.charAt(i);
      if (ch === "{" || ch === "(" || ch === "[") depth++;
      else if (ch === "}" || ch === ")" || ch === "]") depth = Math.max(0, depth - 1);
      if (ch === "," && depth === 0) {
        out.push(current);
        current = "";
      } else {
        current += ch;
      }
    }
    out.push(current);
    return out
      .map(function (t) {
        return t.trim();
      })
      .filter(Boolean);
  }

  function bytesOf(str) {
    try {
      return new Blob([str]).size;
    } catch (e) {
      return str ? str.length : 0;
    }
  }

  function humanBytes(n) {
    if (n < 1024) return n + " B";
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
    return (n / 1024 / 1024).toFixed(2) + " MB";
  }

  /* ====================================================================== *
   * 1. Configuration (script-tag attributes + role params)
   * ====================================================================== */

  var script = document.currentScript || document.querySelector('script[src*="supportlayer"]');

  function dataAttr(name) {
    return script ? script.getAttribute("data-" + name) : null;
  }

  var QUERY = (function () {
    try {
      return new URLSearchParams(location.search);
    } catch (e) {
      return { get: function () { return null; } };
    }
  })();

  function param() {
    for (var i = 0; i < arguments.length; i++) {
      var v = QUERY.get(arguments[i]);
      if (v) return v;
    }
    return null;
  }

  /**
   * Same lookup, but a flag that was explicitly turned OFF must read as off. `param()` skips any
   * empty value, so `?sl-demo=0` and `?sl-demo=false` can only be distinguished if we read the raw
   * string: a value that is present but falsey is a deliberate "no", not an absent parameter.
   */
  function flagParam(names) {
    for (var i = 0; i < names.length; i++) {
      var raw = QUERY.get(names[i]);
      if (raw === null) continue;
      return !/^(0|false|no|off)$/i.test(String(raw).trim());
    }
    return null; // not mentioned at all
  }

  var DEFAULT_FIELDS = [
    { name: "issue", type: "textarea", label: "What went wrong?", required: true, placeholder: "Describe the problem you ran into…" }
  ];

  var FIELD_TYPES = ["text", "textarea", "email", "tel", "number", "select", "checkbox"];

  function parseFields(raw) {
    if (!raw) return DEFAULT_FIELDS.slice();
    try {
      var parsed = JSON.parse(raw);
      if (!Array.isArray(parsed) || !parsed.length) throw new Error("expected a non-empty array");
      var fields = parsed
        .filter(function (f) {
          return f && typeof f === "object" && f.name;
        })
        .map(function (f) {
          var type = String(f.type || "text").toLowerCase();
          return {
            name: String(f.name),
            type: FIELD_TYPES.indexOf(type) >= 0 ? type : "text",
            label: f.label ? String(f.label) : String(f.name),
            placeholder: f.placeholder ? String(f.placeholder) : "",
            required: !!f.required,
            options: Array.isArray(f.options) ? f.options : []
          };
        });
      if (!fields.length) throw new Error("no usable fields");
      return fields;
    } catch (e) {
      console.warn("[SupportLayer] data-fields is not valid JSON (" + e.message + "); using the default field.");
      return DEFAULT_FIELDS.slice();
    }
  }

  /**
   * The agent joins the customer's own page — there is no second app to host. `?sl_role=agent`
   * is the only way to switch role (a bare `role=` param belongs to the host app, not to us).
   */
  var AGENT_ROLE = /^agent$/i.test(String(param("sl_role") || dataAttr("role") || ""));

  var CFG = {
    role: AGENT_ROLE ? "agent" : "user",
    peer: param("peer", "peerId", "sl_peer") || dataAttr("peer") || null,
    webhook: dataAttr("webhook") || "",
    mode: (function () {
      var m = String(param("sl_mode") || dataAttr("mode") || "none").toLowerCase();
      if (LEGACY_MODES[m]) {
        console.warn(
          '[SupportLayer] data-mode="' +
            m +
            '" is no longer a mode — use "video" for a two-way audio + video call. Using "' +
            LEGACY_MODES[m] +
            '".'
        );
        m = LEGACY_MODES[m];
      }
      return MODES.indexOf(m) >= 0 ? m : "none";
    })(),
    theme: normalizeHex(dataAttr("theme") || DEFAULT_THEME),
    headless: String(dataAttr("headless") || "false") === "true",
    blurSelectors: splitPatterns(dataAttr("blur-selectors")),
    blurRegex: splitPatterns(dataAttr("blur-regex")),
    fields: parseFields(dataAttr("fields")),
    demo: demoEnabled(),
    peerCdn: dataAttr("peer-cdn") || DEFAULT_PEER_CDN,
    liveBase: dataAttr("live-base") || null,
    color: normalizeHex(param("sl_color") || dataAttr("color") || SWATCHES[0]),
    labels: {
      fab: dataAttr("label") || "Get support",
      title: dataAttr("title") || "Report an issue",
      chat: dataAttr("chat-label") || "Support chat"
    }
  };

  /**
   * Demo mode is a development fixture, so it may be turned on by an attribute or a param — and
   * turned back OFF by a param, which is how a real-mode session points at a page that ships with
   * `data-demo="true"` (see tests/live-session.mjs).
   */
  function demoEnabled() {
    var flag = flagParam(["sl-demo", "demo"]);
    if (flag !== null) return flag;
    return String(dataAttr("demo") || "false") === "true";
  }

  var AGENT = CFG.role === "agent";
  var LIVE_MODES = CFG.mode !== "none";
  var LOG_PREFIX = "[SupportLayer]";

  function log() {
    if (!CFG.demo && !AGENT) return;
    console.debug.apply(console, [LOG_PREFIX].concat([].slice.call(arguments)));
  }

  /* ====================================================================== *
   * 2. State machine + persistence
   * ====================================================================== */

  var STATES = { IDLE: "IDLE", SENDING: "SENDING", WAITING: "WAITING", CONNECTED: "CONNECTED" };
  var state = STATES.IDLE;

  var session = null; // customer only: { id, state, status, mode, peerId, createdAt, updatedAt, liveUrl, userData, snapshotAt }
  var sharePromise = null; // in-flight getDisplayMedia request, so one request means one prompt
  var lastSnapshot = null; // data URL kept in memory only — never persisted

  function storageGet(key) {
    try {
      return window.localStorage.getItem(key);
    } catch (e) {
      return null;
    }
  }

  function storageSet(key, value) {
    try {
      window.localStorage.setItem(key, value);
    } catch (e) {
      /* private mode / quota — the widget still works for this page view */
    }
  }

  function storageRemove(key) {
    try {
      window.localStorage.removeItem(key);
    } catch (e) {
      /* ignore */
    }
  }

  function saveSession() {
    if (AGENT || !session) return;
    session.state = state;
    session.updatedAt = nowIso();
    try {
      session.userData = currentUserData();
    } catch (e) {
      /* ignore */
    }
    storageSet(STORAGE_KEY, JSON.stringify(session));
  }

  function loadStoredSession() {
    var raw = storageGet(STORAGE_KEY);
    if (!raw) return null;
    try {
      var parsed = JSON.parse(raw);
      if (!parsed || !parsed.id) return null;
      return parsed;
    } catch (e) {
      storageRemove(STORAGE_KEY);
      return null;
    }
  }

  function clearSession() {
    try {
      session = null;
    } finally {
      storageRemove(STORAGE_KEY);
    }
  }

  function setState(next) {
    if (state === next) return;
    state = next;
    log("state →", next);
    saveSession();
    try {
      window.dispatchEvent(new CustomEvent("supportlayer:state", { detail: { state: state, session_id: session && session.id, role: CFG.role } }));
    } catch (e) {
      /* ignore */
    }
    if (ui.ready) renderChrome();
  }

  /* ====================================================================== *
   * 3. Diagnostics
   * ====================================================================== */

  function diagnostics() {
    var nav = navigator;
    var geom = {
      screen_x: window.screenX,
      screen_y: window.screenY,
      outer_width: window.outerWidth,
      outer_height: window.outerHeight,
      inner_width: window.innerWidth,
      inner_height: window.innerHeight,
      screen_width: screen.width,
      screen_height: screen.height,
      device_pixel_ratio: window.devicePixelRatio || 1
    };
    var conn = nav.connection || nav.mozConnection || nav.webkitConnection;
    return {
      url: location.href,
      title: document.title,
      browser: nav.userAgent,
      viewport: window.innerWidth + "x" + window.innerHeight,
      timestamp: nowIso(),
      language: nav.language || null,
      referrer: document.referrer || null,
      platform: nav.platform || null,
      connection: conn && conn.effectiveType ? conn.effectiveType : null,
      // Used by the agent view to map "entire screen" captures back onto the page.
      window_geometry: geom
    };
  }

  /* ====================================================================== *
   * 4. Privacy redaction (HOST document — never the shadow root)
   * ====================================================================== */

  var privacyApplied = false;
  var wrappedNodes = [];

  function privacyStyleText() {
    var parts = [];
    if (CFG.blurSelectors.length) {
      parts.push(
        CFG.blurSelectors.join(",\n") +
          "\n{ filter: blur(7px) !important; transition: filter .2s ease; }"
      );
    }
    parts.push(".sl-blurred { filter: blur(6px) !important; }");
    parts.push("mark.sl-blurred { background: transparent !important; color: inherit !important; }");
    return parts.join("\n");
  }

  function textWalkerFilter(node) {
    if (!node || !node.parentNode) return NodeFilter.FILTER_REJECT;
    var parent = node.parentNode;
    var tag = parent.nodeName ? parent.nodeName.toLowerCase() : "";
    if (["script", "style", "noscript", "textarea", "title", "select"].indexOf(tag) >= 0) return NodeFilter.FILTER_REJECT;
    if (parent.closest && parent.closest("#supportlayer-root")) return NodeFilter.FILTER_REJECT;
    if (parent.classList && parent.classList.contains("sl-blurred")) return NodeFilter.FILTER_REJECT;
    if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
    return NodeFilter.FILTER_ACCEPT;
  }

  function compileRegexes() {
    var out = [];
    CFG.blurRegex.forEach(function (pattern) {
      try {
        out.push(new RegExp("(" + pattern + ")", "gi"));
      } catch (e) {
        try {
          out.push(new RegExp("(" + pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + ")", "gi"));
        } catch (e2) {
          console.warn(LOG_PREFIX, "ignoring invalid data-blur-regex entry:", pattern);
        }
      }
    });
    return out;
  }

  function applyPrivacyBlur() {
    if (AGENT) return { selectors: 0, texts: 0, agent: true };
    if (privacyApplied) return { selectors: CFG.blurSelectors.length, texts: 0 };
    if (!CFG.blurSelectors.length && !CFG.blurRegex.length) {
      privacyApplied = true;
      return { selectors: 0, texts: 0 };
    }

    if (CFG.blurSelectors.length) {
      var style = document.createElement("style");
      style.id = PRIVACY_STYLE_ID;
      style.setAttribute("data-supportlayer", "privacy");
      style.textContent = privacyStyleText();
      document.head.appendChild(style);
    }

    var regexes = compileRegexes();
    var count = 0;
    if (regexes.length && document.body) {
      var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, { acceptNode: textWalkerFilter });
      var nodes = [];
      while (walker.nextNode()) nodes.push(walker.currentNode);
      nodes.forEach(function (node) {
        var matches = regexes.some(function (re) {
          re.lastIndex = 0;
          return re.test(node.nodeValue);
        });
        if (!matches) return;
        var mark = document.createElement("span");
        mark.className = "sl-blurred";
        mark.setAttribute("data-supportlayer", "blur");
        node.parentNode.insertBefore(mark, node);
        mark.appendChild(node);
        wrappedNodes.push(mark);
        count++;
      });
    }

    privacyApplied = true;
    log("privacy blur applied:", CFG.blurSelectors.length, "selector(s),", count, "text node(s)");
    return { selectors: CFG.blurSelectors.length, texts: count };
  }

  function removePrivacyBlur() {
    var style = document.getElementById(PRIVACY_STYLE_ID);
    if (style && style.parentNode) style.parentNode.removeChild(style);
    var target = document.getElementById(TARGET_STYLE_ID);
    if (target && target.parentNode) target.parentNode.removeChild(target);
    wrappedNodes.forEach(function (mark) {
      if (!mark.parentNode) return;
      var parent = mark.parentNode;
      while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
      parent.removeChild(mark);
      if (parent.normalize) parent.normalize();
    });
    wrappedNodes = [];
    privacyApplied = false;
    log("privacy blur removed");
  }

  /* ====================================================================== *
   * 5. Screen capture
   * ====================================================================== */

  function supportsCapture() {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia);
  }

  function supportsUserMedia() {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  }

  function stopStream(stream) {
    if (!stream || typeof stream === "string") return;
    try {
      stream.getTracks().forEach(function (t) {
        t.stop();
      });
    } catch (e) {
      /* ignore */
    }
  }

  /**
   * Demo/simulated capture: renders a mock viewport to a canvas so the whole flow can be
   * shown without a permission prompt. Never used unless data-demo="true".
   */
  function syntheticSnapshot() {
    var maxW = 1280;
    var vw = Math.max(320, window.innerWidth);
    var vh = Math.max(240, window.innerHeight);
    var scale = Math.min(1, maxW / vw);
    var w = Math.round(vw * scale);
    var h = Math.round(vh * scale);
    var canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    var ctx = canvas.getContext("2d");

    ctx.fillStyle = "#0f1115";
    ctx.fillRect(0, 0, w, h);

    // Browser chrome
    ctx.fillStyle = "#171a21";
    ctx.fillRect(0, 0, w, 30 * scale);
    ["#ff5f57", "#febc2e", "#28c840"].forEach(function (c, i) {
      ctx.fillStyle = c;
      ctx.beginPath();
      ctx.arc((14 + i * 16) * scale, 15 * scale, 5 * scale, 0, Math.PI * 2);
      ctx.fill();
    });
    ctx.fillStyle = "#2a2f3a";
    ctx.fillRect(70 * scale, 8 * scale, w - 100 * scale, 15 * scale);
    ctx.fillStyle = "#8b93a7";
    ctx.font = Math.round(10 * scale) + "px sans-serif";
    ctx.fillText(String(location.host || "localhost"), 78 * scale, 19 * scale);

    // Simulated page content
    ctx.fillStyle = "#131722";
    ctx.fillRect(20 * scale, 50 * scale, w - 40 * scale, h - 90 * scale);
    ctx.fillStyle = "#1d2430";
    for (var i = 0; i < 5; i++) ctx.fillRect((30 + i * 40) * scale, 40 * scale, 30 * scale, 6 * scale);
    ctx.fillStyle = CFG.theme;
    ctx.fillRect(30 * scale, 70 * scale, 150 * scale, 10 * scale);
    ctx.fillStyle = "#39414f";
    for (var r = 0; r < 6; r++) ctx.fillRect(30 * scale, (100 + r * 22) * scale, (w - 120) * scale, 8 * scale);
    // Blurred-sensitive blocks
    ctx.fillStyle = "#4c5566";
    ctx.font = "bold " + Math.round(11 * scale) + "px sans-serif";
    ctx.fillText("████████  (redacted before capture)", 30 * scale, (250 * scale));

    ctx.fillStyle = "rgba(20,184,166,.14)";
    ctx.fillRect(30 * scale, (h - 120) * scale, 250 * scale, 40 * scale);
    ctx.fillStyle = "#8be9d6";
    ctx.font = "bold " + Math.round(11 * scale) + "px sans-serif";
    ctx.fillText("SIMULATED CAPTURE — demo mode", 40 * scale, (h - 95) * scale);

    ctx.fillStyle = "#7b8494";
    ctx.font = Math.round(10 * scale) + "px sans-serif";
    ctx.fillText("No screen was shared. Real mode uses getDisplayMedia().", 40 * scale, (h - 78) * scale);

    return { dataUrl: canvas.toDataURL("image/jpeg", 0.7), width: w, height: h, label: "simulated" };
  }

  /** One 70% JPEG frame off a display stream. Never stops the stream — a live session keeps it. */
  function frameFromStream(stream) {
    return new Promise(function (resolve) {
      var video = document.createElement("video");
      video.muted = true;
      video.playsInline = true;
      video.setAttribute("aria-hidden", "true");
      video.style.cssText = "position:fixed;left:-10000px;top:0;width:1px;height:1px;opacity:0;";
      document.body.appendChild(video);
      video.srcObject = stream;

      var label = "";
      try {
        label = stream.getVideoTracks()[0].label || "";
      } catch (e) {
        /* ignore */
      }

      var settled = false;
      function finish() {
        if (settled) return;
        settled = true;
        var out = null;
        try {
          var maxW = 1280;
          var scale = Math.min(1, maxW / video.videoWidth);
          var canvas = document.createElement("canvas");
          canvas.width = Math.round(video.videoWidth * scale);
          canvas.height = Math.round(video.videoHeight * scale);
          canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
          out = {
            dataUrl: canvas.toDataURL("image/jpeg", 0.7),
            width: canvas.width,
            height: canvas.height,
            label: label
          };
        } catch (e) {
          console.warn(LOG_PREFIX, "snapshot render failed:", e && e.message);
        }
        try {
          video.srcObject = null;
          video.remove();
        } catch (e) {
          /* ignore */
        }
        resolve(out);
      }

      function ready() {
        // Wait one more frame so the compositor has a real frame, not a black one.
        requestAnimationFrame(function () {
          requestAnimationFrame(finish);
        });
      }

      video.onloadedmetadata = function () {
        video.play().then(ready, ready);
      };
      video.onerror = finish;
      setTimeout(finish, 4000); // hard safety net
    });
  }

  /**
   * The report's one-frame snapshot.
   *
   * In a live mode this is deliberately the *same* capture the agent will watch: the customer is
   * asked for their screen once, when they send the request, and that stream is kept for the
   * session (see beginScreenShare). Two separate getDisplayMedia calls would mean two permission
   * prompts for one request.
   *
   * MUST be invoked from a trusted user gesture. Resolves to null when the user declines.
   */
  function getScreenSnapshot() {
    if (CFG.demo) {
      try {
        return Promise.resolve(syntheticSnapshot());
      } catch (e) {
        return Promise.resolve(null);
      }
    }
    if (!supportsCapture()) return Promise.resolve(null);

    if (LIVE_MODES) {
      return beginScreenShare().then(function (stream) {
        return stream ? frameFromStream(stream) : null;
      });
    }

    // Report-only: capture the snapshot, then hand the screen straight back.
    return navigator.mediaDevices
      .getDisplayMedia({ video: { frameRate: 5, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false })
      .then(function (stream) {
        return frameFromStream(stream).then(function (snap) {
          stopStream(stream);
          return snap;
        });
      })
      .catch(function (err) {
        log("screen capture declined or unavailable:", err && err.name);
        return null;
      });
  }

  /* ====================================================================== *
   * 6. Anti-spam
   * ====================================================================== */

  function rateLimitRemaining() {
    var last = 0;
    try {
      last = Number(window.sessionStorage.getItem(RATE_KEY) || 0);
    } catch (e) {
      last = 0;
    }
    var remaining = RATE_WINDOW_MS - (Date.now() - last);
    return remaining > 0 ? remaining : 0;
  }

  function markRateLimit() {
    try {
      window.sessionStorage.setItem(RATE_KEY, String(Date.now()));
    } catch (e) {
      /* ignore */
    }
  }

  /* ====================================================================== *
   * 7. Webhook (customer role only)
   * ====================================================================== */

  function postWebhook(payload) {
    try {
      window.dispatchEvent(new CustomEvent("supportlayer:webhook", { detail: payload }));
    } catch (e) {
      /* ignore */
    }

    if (CFG.demo) {
      log("webhook (simulated):", payload.event_type, payload.session_id);
      return Promise.resolve({ ok: true, simulated: true, size: bytesOf(JSON.stringify(payload)) });
    }
    if (!CFG.webhook) {
      log("no data-webhook configured; payload not delivered");
      return Promise.resolve({ ok: false, reason: "no-webhook", size: bytesOf(JSON.stringify(payload)) });
    }

    var body = JSON.stringify(payload);
    return fetch(CFG.webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body,
      keepalive: true,
      mode: "cors"
    })
      .then(function (res) {
        return { ok: res.ok, status: res.status, size: body.length };
      })
      .catch(function (err) {
        console.warn(LOG_PREFIX, "webhook delivery failed:", err && err.message);
        return { ok: false, reason: "network", size: body.length };
      });
  }

  function buildPayload(eventType, extra) {
    var payload = {
      event_type: eventType,
      session_id: session.id,
      status: session.status || "open",
      mode: CFG.mode,
      live_session_url: session.liveUrl || null,
      snapshot: null,
      user_data: session.userData || {},
      diagnostics: diagnostics()
    };
    return Object.assign(payload, extra || {});
  }

  /* ====================================================================== *
   * 8. Chat transcript (both roles)
   * ====================================================================== */

  var chatLog = []; // { from: "me"|"them"|"sys", text, at }
  var unread = 0;

  function pushChat(from, text, at, opts) {
    text = String(text == null ? "" : text);
    if (!text) return;
    chatLog.push({ from: from, text: text, at: at || nowIso(), atMs: Date.now() });
    if (chatLog.length > 300) chatLog.shift();
    renderChat();
    if (from === "them" && !chatOpen()) bumpUnread(1);
    if (opts && opts.notify) toast(text.slice(0, 90), "good");
  }

  function sysChat(text) {
    pushChat("sys", text, nowIso());
  }

  function bumpUnread(n) {
    unread += n;
    renderUnread();
  }

  function renderUnread() {
    var badges = [ui.chatBadge, ui.panelChatBadge];
    badges.forEach(function (b) {
      if (!b) return;
      b.textContent = unread > 99 ? "99+" : String(unread);
      b.hidden = unread === 0;
    });
  }

  function chatOpen() {
    if (AGENT) return !!(ui.chatCard && !ui.chatCard.hidden);
    return !!(ui.panel && ui.panel.classList.contains("sl-open") && state === STATES.CONNECTED);
  }

  function renderChat() {
    [ui.transcript, ui.agentTranscript].forEach(function (box) {
      if (!box) return;
      box.innerHTML = "";
      chatLog.forEach(function (m) {
        var div = document.createElement("div");
        if (m.from === "sys") {
          div.className = "sl-msg sl-sys";
          div.textContent = m.text;
        } else {
          div.className = "sl-msg " + (m.from === "me" ? "sl-me" : "sl-them");
          var b = document.createElement("b");
          b.textContent = m.from === "me" ? (AGENT ? "You" : "You") : (AGENT ? "Customer" : "Agent");
          var p = document.createElement("span");
          p.textContent = m.text;
          div.appendChild(b);
          div.appendChild(p);
        }
        box.appendChild(div);
      });
      box.scrollTop = box.scrollHeight;
    });
  }

  /** Customer → agent or agent → customer, whichever direction this role owns. */
  function sendChat(text) {
    text = String(text || "").trim();
    if (!text) return false;
    if (!transport) {
      if (!AGENT) toast("Still connecting — your message was not sent.", "warn");
      return false;
    }
    var msg = { t: "chat", text: text, at: nowIso() };
    if (AGENT) sendToClient(msg);
    else sendToAgent(msg);
    pushChat("me", text, msg.at);
    return true;
  }

  /* ====================================================================== *
   * 9. Media state (both roles)
   * ====================================================================== */

  var media = {
    screen: null, // customer: local display stream for the whole session (or "simulated")
    av: null, // customer: local mic + camera stream (or "simulated")
    remote: null, // agent: customer camera+mic / customer: agent camera+mic
    calls: [] // active PeerJS calls so teardown can close them
  };

  function trackState(stream) {
    if (!stream || typeof stream === "string") return { present: true, simulated: true, video: false, audio: false };
    var v = [],
      a = [];
    try {
      v = stream.getVideoTracks();
      a = stream.getAudioTracks();
    } catch (e) {
      /* ignore */
    }
    return { present: true, simulated: false, video: v.length > 0, audio: a.length > 0, label: v[0] ? v[0].label : "" };
  }

  /* ====================================================================== *
   * 10. UI — Shadow DOM
   * ====================================================================== */

  var ui = { ready: false };

  var CSS = [
    "* { box-sizing: border-box; }",
    // The `hidden` attribute must win over any display we set ourselves.
    "[hidden] { display: none !important; }",
    ":host, .sl-root { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Inter, Roboto, sans-serif; }",
    "button { font: inherit; cursor: pointer; }",

    /* ---------- shared ---------- */
    ".sl-mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; color: #93a0b5; word-break: break-all; }",
    ".sl-note { font-size: 11px; color: #8c96a8; margin-top: 10px; line-height: 1.5; }",
    ".sl-pill { display: inline-block; padding: 3px 8px; border-radius: 999px; font-size: 10px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; background: var(--sl-theme-dim); color: var(--sl-theme-fg); border: 1px solid var(--sl-theme-border); }",
    ".sl-toast { display: none; margin-bottom: 12px; padding: 9px 11px; border-radius: 10px; font-size: 12px; line-height: 1.45; }",
    ".sl-toast.sl-show { display: block; }",
    ".sl-toast.sl-warn { background: rgba(254,188,46,.12); color: #ffd377; border: 1px solid rgba(254,188,46,.3); }",
    ".sl-toast.sl-bad { background: rgba(255,95,87,.12); color: #ffa7a1; border: 1px solid rgba(255,95,87,.3); }",
    ".sl-toast.sl-good { background: rgba(40,200,64,.12); color: #8ef0a4; border: 1px solid rgba(40,200,64,.3); }",
    ".sl-dot { width: 9px; height: 9px; border-radius: 50%; background: var(--sl-theme); box-shadow: 0 0 0 4px var(--sl-theme-dim); flex: none; }",

    /* ---------- customer: fab + panel ---------- */
    ".sl-fab {",
    "  position: fixed; right: 20px; bottom: 20px; z-index: 2; pointer-events: auto;",
    "  display: inline-flex; align-items: center; gap: 8px;",
    "  padding: 12px 18px; border: 0; border-radius: 999px;",
    "  background: var(--sl-theme); color: var(--sl-on-theme); font-weight: 700; font-size: 14px;",
    "  box-shadow: 0 12px 28px rgba(0,0,0,.4), 0 0 0 0 var(--sl-theme-glow);",
    "  transition: transform .18s ease, background .18s ease;",
    "}",
    ".sl-fab:hover { background: var(--sl-theme-hover); transform: translateY(-2px); }",
    ".sl-fab svg { width: 16px; height: 16px; fill: currentColor; }",
    ".sl-panel {",
    "  position: fixed; right: 20px; bottom: 82px; z-index: 3; pointer-events: auto;",
    "  width: min(400px, calc(100vw - 32px)); max-height: min(660px, calc(100vh - 120px));",
    "  display: none; flex-direction: column; overflow: hidden;",
    "  background: #10131a; color: #eef1f6; border: 1px solid rgba(255,255,255,.1); border-radius: 18px;",
    "  box-shadow: 0 30px 70px rgba(0,0,0,.55);",
    "  animation: sl-in .22s ease-out;",
    "}",
    "@keyframes sl-in { from { opacity: 0; transform: translateY(12px) scale(.98); } to { opacity: 1; transform: none; } }",
    ".sl-panel.sl-open { display: flex; }",
    ".sl-head { display: flex; align-items: center; gap: 10px; padding: 14px 16px; border-bottom: 1px solid rgba(255,255,255,.08); background: rgba(255,255,255,.02); }",
    ".sl-head h2 { margin: 0; font-size: 14px; font-weight: 700; letter-spacing: .01em; flex: 1; }",
    ".sl-head .sl-badge-count { position: static; }",
    ".sl-x { background: transparent; border: 0; color: #98a1b3; font-size: 18px; line-height: 1; padding: 4px 6px; border-radius: 8px; }",
    ".sl-x:hover { color: #fff; background: rgba(255,255,255,.08); }",
    ".sl-body { padding: 16px; overflow: auto; }",
    ".sl-body p { margin: 0 0 12px; font-size: 13px; line-height: 1.5; color: #b7bfcd; }",
    ".sl-body h3 { margin: 0 0 6px; font-size: 15px; color: #fff; }",
    ".sl-view { display: none; }",
    ".sl-view.sl-active { display: block; }",
    ".sl-field { margin-bottom: 12px; }",
    ".sl-field label { display: block; font-size: 12px; font-weight: 600; color: #cfd6e2; margin-bottom: 5px; }",
    ".sl-field input[type=text], .sl-field input[type=email], .sl-field input[type=tel], .sl-field input[type=number], .sl-field textarea, .sl-field select {",
    "  width: 100%; padding: 9px 11px; border-radius: 10px; font-size: 13px;",
    "  background: #171b24; color: #fff; border: 1px solid rgba(255,255,255,.12); outline: none;",
    "}",
    ".sl-field input:focus, .sl-field textarea:focus, .sl-field select:focus { border-color: var(--sl-theme); box-shadow: 0 0 0 3px var(--sl-theme-dim); }",
    ".sl-field textarea { min-height: 84px; resize: vertical; }",
    ".sl-hp { position: absolute !important; left: -9999px !important; width: 1px; height: 1px; opacity: 0; }",
    ".sl-btn {",
    "  display: block; width: 100%; padding: 11px 14px; border-radius: 11px; border: 0;",
    "  background: var(--sl-theme); color: var(--sl-on-theme); font-weight: 700; font-size: 13px;",
    "}",
    ".sl-btn:hover { background: var(--sl-theme-hover); }",
    ".sl-btn[disabled] { opacity: .55; cursor: default; }",
    ".sl-btn-ghost { background: rgba(255,255,255,.06); color: #dfe4ee; border: 1px solid rgba(255,255,255,.12); }",
    ".sl-btn-ghost:hover { background: rgba(255,255,255,.12); }",
    ".sl-btn-ghost.sl-on { background: var(--sl-theme-dim); border-color: var(--sl-theme-border); color: var(--sl-theme-fg); }",
    ".sl-btn-ghost.sl-danger:hover { background: rgba(255,95,87,.16); border-color: rgba(255,95,87,.45); color: #ffb4b0; }",
    ".sl-row { display: flex; gap: 8px; margin-top: 10px; }",
    ".sl-row > button { flex: 1; }",
    ".sl-center { text-align: center; }",
    ".sl-spin { width: 30px; height: 30px; margin: 6px auto 14px; border-radius: 50%; border: 3px solid rgba(255,255,255,.14); border-top-color: var(--sl-theme); animation: sl-spin 1s linear infinite; }",
    "@keyframes sl-spin { to { transform: rotate(360deg); } }",
    ".sl-link { display: block; padding: 9px 11px; border-radius: 10px; background: rgba(255,255,255,.05); border: 1px dashed rgba(255,255,255,.16); margin: 10px 0; }",
    ".sl-status { display: flex; align-items: center; gap: 8px; font-size: 13px; font-weight: 600; }",
    ".sl-pulse { width: 10px; height: 10px; border-radius: 50%; background: #28c840; animation: sl-pulse 1.6s ease-out infinite; flex: none; }",
    "@keyframes sl-pulse { 0% { box-shadow: 0 0 0 0 rgba(40,200,64,.5); } 100% { box-shadow: 0 0 0 12px rgba(40,200,64,0); } }",
    ".sl-check { width: 40px; height: 40px; border-radius: 50%; background: rgba(40,200,64,.14); color: #6ee787; display: flex; align-items: center; justify-content: center; font-size: 20px; margin: 0 auto 12px; }",

    /* ---------- customer: live session (chat + call) ---------- */
    ".sl-live-head { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; flex-wrap: wrap; }",
    ".sl-live-head .sl-mono { flex: 1; text-align: right; }",
    ".sl-media { display: grid; gap: 8px; margin-bottom: 10px; }",
    ".sl-media.sl-two { grid-template-columns: 1fr 1fr; }",
    "video.sl-remote, video.sl-self { width: 100%; border-radius: 12px; background: #05070b; border: 1px solid rgba(255,255,255,.1); aspect-ratio: 4 / 3; object-fit: cover; }",
    // Remote audio rides its own element (never display:none, or the sound can die).
    "audio.sl-remote-audio { width: 1px; height: 1px; opacity: 0; pointer-events: none; }",
    ".sl-audio-bar { display: flex; align-items: center; gap: 10px; padding: 9px 12px; border-radius: 12px; background: rgba(255,255,255,.05); border: 1px solid rgba(255,255,255,.1); font-size: 12px; color: #cfd6e2; }",
    ".sl-audio-bar .sl-wave { display: inline-flex; gap: 3px; align-items: flex-end; height: 14px; }",
    ".sl-audio-bar .sl-wave i { width: 3px; background: var(--sl-theme); border-radius: 2px; animation: sl-wave 1.1s ease-in-out infinite; }",
    ".sl-audio-bar .sl-wave i:nth-child(2) { animation-delay: .15s; }",
    ".sl-audio-bar .sl-wave i:nth-child(3) { animation-delay: .3s; }",
    ".sl-audio-bar .sl-wave i:nth-child(4) { animation-delay: .45s; }",
    "@keyframes sl-wave { 0%, 100% { height: 4px; } 50% { height: 14px; } }",
    ".sl-audio-bar.sl-muted .sl-wave i { animation: none; height: 4px; background: #6b7385; }",
    ".sl-transcript { max-height: 208px; min-height: 96px; overflow: auto; display: flex; flex-direction: column; gap: 7px; padding: 10px; border-radius: 12px; background: rgba(255,255,255,.03); border: 1px solid rgba(255,255,255,.08); margin-bottom: 10px; }",
    ".sl-transcript:empty::after { content: 'No messages yet — say hello.'; color: #6f788a; font-size: 12px; }",
    ".sl-msg { max-width: 86%; font-size: 12.5px; line-height: 1.45; padding: 7px 10px; border-radius: 12px; word-break: break-word; }",
    ".sl-msg b { display: block; font-size: 10px; text-transform: uppercase; letter-spacing: .05em; opacity: .62; font-weight: 700; margin-bottom: 2px; }",
    ".sl-msg span { white-space: pre-wrap; }",
    ".sl-msg.sl-them { align-self: flex-start; background: rgba(255,255,255,.07); color: #eef1f6; border-bottom-left-radius: 4px; }",
    ".sl-msg.sl-me { align-self: flex-end; background: var(--sl-theme-dim); border: 1px solid var(--sl-theme-border); color: #eef1f6; border-bottom-right-radius: 4px; }",
    ".sl-msg.sl-sys { align-self: center; background: transparent; color: #7e8798; font-size: 11px; text-align: center; padding: 2px 0; }",
    ".sl-composer { display: flex; gap: 8px; }",
    ".sl-composer input { flex: 1; padding: 10px 12px; border-radius: 11px; font-size: 13px; background: #171b24; color: #fff; border: 1px solid rgba(255,255,255,.12); outline: none; min-width: 0; }",
    ".sl-composer input:focus { border-color: var(--sl-theme); box-shadow: 0 0 0 3px var(--sl-theme-dim); }",
    ".sl-composer button { flex: none; padding: 10px 15px; border-radius: 11px; border: 0; background: var(--sl-theme); color: var(--sl-on-theme); font-weight: 700; font-size: 13px; }",
    ".sl-call-bar { display: flex; gap: 8px; margin-top: 10px; flex-wrap: wrap; }",
    ".sl-call-bar button { flex: 1 1 auto; padding: 9px 11px; border-radius: 10px; font-size: 12px; font-weight: 600; border: 1px solid rgba(255,255,255,.12); background: rgba(255,255,255,.06); color: #dfe4ee; }",
    ".sl-share-state { display: flex; align-items: center; gap: 8px; padding: 9px 12px; border-radius: 11px; font-size: 12px; font-weight: 600; border: 1px solid rgba(255,255,255,.1); background: rgba(255,255,255,.05); color: #cfd6e2; }",
    ".sl-share-state .sl-share-dot { width: 8px; height: 8px; border-radius: 50%; background: #6b7385; flex: none; }",
    ".sl-share-state[data-state=on] { border-color: rgba(20,184,166,.45); background: rgba(20,184,166,.12); color: #9fe9dc; }",
    ".sl-share-state[data-state=on] .sl-share-dot { background: #14b8a6; box-shadow: 0 0 0 4px rgba(20,184,166,.18); animation: sl-pulse-teal 1.8s ease-out infinite; }",
    "@keyframes sl-pulse-teal { 0% { box-shadow: 0 0 0 0 rgba(20,184,166,.45); } 100% { box-shadow: 0 0 0 9px rgba(20,184,166,0); } }",
    ".sl-share-state[data-state=off] { border-color: rgba(245,158,11,.4); background: rgba(245,158,11,.1); color: #f7d08a; }",
    ".sl-share-state[data-state=off] .sl-share-dot { background: #f59e0b; }",
    ".sl-share-state.sl-share-inline { flex: 1 1 100%; order: -1; }",
    ".sl-share-state[hidden] { display: none; }",

    /* ---------- overlay layers (laser + drawing + typing) ---------- */
    ".sl-overlay { position: fixed; inset: 0; pointer-events: none; z-index: 1; }",
    /* The overlay canvas stays out of the layout (and out of a11y trees) until an
       agent actually draws, so an idle page shows no agent chrome at all. */
    "canvas.sl-draw { display: none; position: fixed; inset: 0; width: 100%; height: 100%; pointer-events: none; z-index: 4; }",
    "canvas.sl-draw.sl-blocking { display: block; pointer-events: auto; cursor: default; }",
    ".sl-laser { position: fixed; width: 26px; height: 26px; margin: -13px 0 0 -13px; pointer-events: none; z-index: 6; }",
    ".sl-laser i { position: absolute; inset: 0; border-radius: 50%; background: radial-gradient(circle at 50% 50%, #fff 0 14%, var(--sl-laser, #14b8a6) 16% 40%, rgba(20,184,166,0) 62%); animation: sl-laser 1.1s ease-out forwards; }",
    ".sl-laser b { position: absolute; inset: -6px; border-radius: 50%; border: 2px solid var(--sl-laser, #14b8a6); animation: sl-ring 1.1s ease-out forwards; }",
    "@keyframes sl-laser { 0% { transform: scale(.4); opacity: 1; } 70% { transform: scale(1); opacity: 1; } 100% { transform: scale(1.25); opacity: 0; } }",
    "@keyframes sl-ring { 0% { transform: scale(.5); opacity: .9; } 100% { transform: scale(2.1); opacity: 0; } }",
    ".sl-draw-hint { position: fixed; left: 50%; bottom: 26px; transform: translateX(-50%); z-index: 7; pointer-events: auto; display: inline-flex; align-items: center; gap: 10px; padding: 8px 10px 8px 14px; border-radius: 999px; background: rgba(16,19,26,.94); border: 1px solid rgba(255,255,255,.14); color: #eef1f6; font-size: 12px; box-shadow: 0 10px 30px rgba(0,0,0,.5); }",
    ".sl-draw-hint button { background: rgba(255,255,255,.1); border: 0; color: #fff; border-radius: 999px; padding: 4px 10px; font-size: 11px; font-weight: 600; }",
    ".sl-typing { position: fixed; z-index: 8; pointer-events: auto; width: min(320px, calc(100vw - 24px)); padding: 12px; border-radius: 14px; background: #10131a; border: 1px solid var(--sl-theme-border); color: #eef1f6; box-shadow: 0 19px 44px rgba(0,0,0,.55); }",
    ".sl-typing .sl-typing-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 8px; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .05em; color: var(--sl-theme-fg); }",
    ".sl-typing textarea { width: 100%; min-height: 56px; resize: vertical; background: #171b24; color: #fff; border: 1px solid rgba(255,255,255,.14); border-radius: 10px; padding: 8px 10px; font: inherit; font-size: 13px; }",
    ".sl-typing .sl-typing-actions { display: flex; gap: 8px; margin-top: 8px; }",
    ".sl-typing .sl-typing-actions button { flex: 1; padding: 8px 10px; border-radius: 9px; border: 0; font-size: 12px; font-weight: 700; background: var(--sl-theme); color: var(--sl-on-theme); }",
    ".sl-typing .sl-typing-actions button.sl-alt { background: rgba(255,255,255,.08); color: #dfe4ee; }",

    /* ---------- agent view: stage ---------- */
    ".sl-agent { position: fixed; inset: 0; z-index: 2147483000; pointer-events: auto; display: flex; flex-direction: column; background: #05070b; color: #eef1f6; }",
    ".sl-stage { position: relative; flex: 1; min-height: 0; overflow: hidden; background: #05070b; }",
    ".sl-stage[data-tool='point'] { cursor: cell; }",
    ".sl-stage[data-tool='click'] { cursor: pointer; }",
    ".sl-stage[data-tool='draw'] { cursor: crosshair; }",
    ".sl-stage[data-tool='type'] { cursor: text; }",
    ".sl-feed { position: absolute; left: 50%; top: 50%; width: 0; height: 0; transform: translate(-50%, -50%); object-fit: contain; background: #000; display: none; }",
    ".sl-feed.sl-on { display: block; }",
    "canvas.sl-sim { position: absolute; left: 50%; top: 50%; width: 0; height: 0; transform: translate(-50%, -50%); display: none; }",
    "canvas.sl-sim.sl-on { display: block; }",
    "canvas.sl-ink { position: absolute; left: 50%; top: 50%; width: 0; height: 0; transform: translate(-50%, -50%); z-index: 3; touch-action: none; }",
    "video.sl-pip, video.sl-selfcam { position: absolute; right: 16px; width: 22%; max-width: 260px; aspect-ratio: 4 / 3; object-fit: cover; border-radius: 12px; border: 1px solid rgba(255,255,255,.16); background: #05070b; box-shadow: 0 14px 34px rgba(0,0,0,.5); display: none; z-index: 4; }",
    "video.sl-pip.sl-on, video.sl-selfcam.sl-on { display: block; }",
    "video.sl-pip { top: 16px; }",
    "video.sl-selfcam { bottom: 108px; width: 16%; }",
    ".sl-cam-ph { position: absolute; right: 16px; top: 16px; width: 22%; max-width: 260px; aspect-ratio: 4 / 3; border-radius: 12px; z-index: 4; display: none; align-items: center; justify-content: center; text-align: center; padding: 8px; font-size: 11px; color: #8d97a9; background: linear-gradient(135deg, #161b24, #0d1116); border: 1px solid rgba(255,255,255,.14); }",
    ".sl-cam-ph.sl-on { display: flex; }",
    ".sl-badge { position: absolute; left: 16px; top: 16px; z-index: 5; display: inline-flex; align-items: center; gap: 8px; padding: 6px 12px; border-radius: 999px; background: rgba(10,12,16,.82); border: 1px solid rgba(255,255,255,.12); font-size: 11px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; color: #98a1b3; }",
    ".sl-badge b { width: 7px; height: 7px; border-radius: 50%; background: #febc2e; flex: none; }",
    ".sl-badge.sl-live b { background: #28c840; animation: sl-blink 1.4s ease-in-out infinite; }",
    ".sl-badge em { font-style: normal; color: #6f788a; font-weight: 600; letter-spacing: 0; text-transform: none; }",
    "@keyframes sl-blink { 50% { opacity: .35; } }",
    ".sl-stage-empty { position: absolute; inset: 0; z-index: 2; display: flex; flex-direction: column; gap: 10px; align-items: center; justify-content: center; text-align: center; padding: 26px; color: #98a1b3; background: rgba(5,7,11,.9); }",
    ".sl-stage-empty strong { color: #eef1f6; font-size: 16px; }",
    ".sl-stage-empty code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; color: #9fe9dc; }",
    ".sl-stage-empty .sl-spin { margin: 0; }",

    /* ---------- agent view: floating dock ---------- */
    ".sl-dock { position: absolute; left: 50%; bottom: 16px; transform: translateX(-50%); z-index: 9; display: flex; align-items: center; gap: 8px; padding: 8px; border-radius: 16px; background: rgba(13,16,22,.92); border: 1px solid rgba(255,255,255,.13); box-shadow: 0 22px 48px rgba(0,0,0,.6); max-width: calc(100% - 24px); flex-wrap: wrap; justify-content: center; }",
    ".sl-dock-group { display: flex; align-items: center; gap: 6px; }",
    ".sl-dock-sep { width: 1px; align-self: stretch; background: rgba(255,255,255,.12); margin: 2px 2px; }",
    ".sl-tool, .sl-dock-btn { display: inline-flex; align-items: center; gap: 7px; padding: 8px 12px; border-radius: 10px; border: 1px solid transparent; background: rgba(255,255,255,.05); color: #98a1b3; font-size: 12.5px; font-weight: 600; white-space: nowrap; }",
    ".sl-tool:hover, .sl-dock-btn:hover { color: #fff; background: rgba(255,255,255,.1); }",
    ".sl-tool[aria-pressed='true'] { background: var(--sl-theme-dim); border-color: var(--sl-theme-border); color: var(--sl-theme-fg); }",
    ".sl-tool svg, .sl-dock-btn svg { width: 14px; height: 14px; fill: currentColor; flex: none; }",
    ".sl-tool kbd { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 10px; opacity: .65; }",
    ".sl-dock-btn.sl-danger { color: #ffa7a1; }",
    ".sl-dock-btn.sl-danger:hover { background: rgba(255,95,87,.16); color: #ffb4b0; }",
    ".sl-dock-btn.sl-armed { background: var(--sl-theme-dim); color: var(--sl-theme-fg); }",
    ".sl-type-input { flex: 1 1 220px; min-width: 150px; max-width: 340px; padding: 9px 11px; border-radius: 10px; border: 1px solid rgba(255,255,255,.12); background: #171b24; color: #fff; font: inherit; font-size: 12.5px; outline: none; }",
    ".sl-type-input:focus { border-color: var(--sl-theme); box-shadow: 0 0 0 3px var(--sl-theme-dim); }",
    ".sl-swatches { display: flex; gap: 5px; }",
    ".sl-swatch { width: 22px; height: 22px; border-radius: 50%; border: 2px solid rgba(255,255,255,.2); padding: 0; }",
    ".sl-swatch[aria-pressed='true'] { border-color: #fff; box-shadow: 0 0 0 2px rgba(255,255,255,.22); }",
    ".sl-unread { display: inline-flex; align-items: center; justify-content: center; min-width: 17px; height: 17px; padding: 0 5px; border-radius: 999px; background: #ff5f57; color: #fff; font-size: 10px; font-weight: 800; }",

    /* ---------- agent view: chat + what-is-happening card ---------- */
    ".sl-card { position: absolute; right: 16px; bottom: calc(var(--sl-dock-h, 104px) + 12px); z-index: 8; width: min(340px, calc(100% - 32px)); max-height: min(390px, 48vh); display: flex; flex-direction: column; border-radius: 14px; background: rgba(13,16,22,.98); border: 1px solid rgba(255,255,255,.13); box-shadow: 0 18px 42px rgba(0,0,0,.5); overflow: hidden; }",
    ".sl-card[hidden] { display: none !important; }",
    ".sl-info-card { left: 16px; right: auto; bottom: calc(var(--sl-dock-h, 104px) + 12px); }",
    ".sl-card-head { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-bottom: 1px solid rgba(255,255,255,.08); font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; color: #98a1b3; }",
    ".sl-card-head span { flex: 1; }",
    ".sl-card-body { padding: 11px 13px; overflow: auto; }",
    ".sl-card-body .sl-transcript { margin-bottom: 0; max-height: 220px; }",
    ".sl-agent-composer { display: flex; gap: 7px; padding: 10px 11px; border-top: 1px solid rgba(255,255,255,.08); }",
    ".sl-agent-composer input { flex: 1; padding: 9px 11px; border-radius: 10px; border: 1px solid rgba(255,255,255,.12); background: #171b24; color: #fff; font: inherit; font-size: 12.5px; outline: none; min-width: 0; }",
    ".sl-agent-composer button { padding: 9px 13px; border-radius: 10px; border: 0; background: var(--sl-theme); color: var(--sl-on-theme); font-weight: 700; font-size: 12.5px; }",
    ".sl-info-rows { display: grid; gap: 7px; font-size: 12.5px; }",
    ".sl-info-rows .sl-kv { display: flex; gap: 10px; }",
    ".sl-info-rows .sl-kv span:first-child { color: #8c96a8; flex: none; min-width: 78px; }",
    ".sl-info-rows .sl-kv span:last-child { word-break: break-word; }",
    ".sl-answers { margin: 0; padding: 0; list-style: none; }",
    ".sl-answers li { padding: 7px 10px; border-radius: 9px; background: rgba(255,255,255,.05); margin-bottom: 7px; font-size: 12.5px; }",
    ".sl-answers b { display: block; color: #8c96a8; font-size: 10px; text-transform: uppercase; letter-spacing: .05em; font-weight: 700; }",
    ".sl-snap { width: 100%; border-radius: 10px; border: 1px solid rgba(255,255,255,.12); display: block; margin-top: 8px; }",
    /* Both float above the dock, whose measured height lands in --sl-dock-h — the dock wraps
       to three rows on narrow panes, so a fixed offset would sit inside it. */
    ".sl-agent-toast { position: absolute; left: 50%; bottom: calc(var(--sl-dock-h, 104px) + 12px); transform: translateX(-50%) translateY(12px); z-index: 10; padding: 9px 15px; border-radius: 999px; background: rgba(13,16,22,.96); border: 1px solid var(--sl-theme-border); color: #eef1f6; font-size: 12.5px; opacity: 0; pointer-events: none; transition: opacity .2s ease, transform .2s ease; }",
    ".sl-agent-toast.sl-show { opacity: 1; transform: translateX(-50%) translateY(0); }",
    ".sl-agent-hint { position: absolute; left: 16px; bottom: calc(var(--sl-dock-h, 104px) + 12px); z-index: 6; max-width: 250px; font-size: 11px; line-height: 1.45; color: #7e8798; text-shadow: 0 1px 2px rgba(0,0,0,.6); transition: opacity .45s ease; }",
    ".sl-agent-hint b { color: #cfd6e2; }",
    ".sl-agent-hint.sl-fade { opacity: 0; }",
  ].join("\n");

  function buildStyle() {
    var style = document.createElement("style");
    var fallbacks =
      "@supports not (color: color-mix(in srgb, red, blue)) {" +
      "  .sl-fab:hover, .sl-btn:hover { filter: brightness(1.12); }" +
      "}";
    style.textContent =
      ":host {\n" +
      "  --sl-theme: " + CFG.color + ";\n" +
      "  --sl-theme-hover: color-mix(in srgb, " + CFG.color + " 86%, #ffffff);\n" +
      "  --sl-theme-dim: color-mix(in srgb, " + CFG.color + " 16%, transparent);\n" +
      "  --sl-theme-border: color-mix(in srgb, " + CFG.color + " 45%, transparent);\n" +
      "  --sl-theme-fg: color-mix(in srgb, " + CFG.color + " 60%, #ffffff);\n" +
      "  --sl-theme-glow: color-mix(in srgb, " + CFG.color + " 35%, transparent);\n" +
      "  --sl-on-theme: #05100e;\n" +
      "  color-scheme: dark;\n" +
      "}\n" +
      fallbacks +
      "\n" +
      CSS;
    return style;
  }

  function h(tag, attrs, html) {
    var el = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === "class") el.className = attrs[k];
        else if (k === "text") el.textContent = attrs[k];
        else el.setAttribute(k, attrs[k]);
      });
    }
    if (html != null) el.innerHTML = html;
    return el;
  }

  var ICONS = {
    point: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 3l6.5 16 2.2-6.3L19 10.5 4 3z"/></svg>',
    click: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 2l10.3 10.3-4.6.6 2.9 5.6-2.3 1.2-2.9-5.6-3.2 3.3L9 2z"/></svg>',
    draw: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 17.2V21h3.8L18 9.8 14.2 6 3 17.2zM20.7 7.1a1 1 0 0 0 0-1.4l-2.4-2.4a1 1 0 0 0-1.4 0l-1.8 1.8 3.8 3.8 1.8-1.8z"/></svg>',
    type: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4h16v3h-6.5v13h-3V7H4V4z"/></svg>',
    chat: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 3h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H9l-5 4V4a1 1 0 0 1 1-1z"/></svg>',
    info: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z"/></svg>',
    clear: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 5h14v3H6V5zm-2 6h18v3H4v-3zm4 6h10v3H8v-3z"/></svg>',
    end: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 9c-2.6 0-5 .5-7 1.6V14l3-1v-2.2c1.3-.5 2.6-.8 4-.8s2.7.3 4 .8V13l3 1v-3.4C17 9.5 14.6 9 12 9z"/></svg>',
    screen: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 4h18a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1h-7v2h3v2H7v-2h3v-2H3a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zm1 2v9h16V6H4z"/></svg>'
  };

  function buildUI() {
    var host = h("div", { id: "supportlayer-root" });
    host.style.cssText =
      "position:fixed;inset:0;pointer-events:none;z-index:2147483000;contain:layout style;";
    var root = host.attachShadow({ mode: "open" });
    root.appendChild(buildStyle());

    var overlay = h("div", { class: "sl-overlay" });

    // Laser pointer
    ui.laser = h("div", { class: "sl-laser", hidden: "true" }, "<i></i><b></b>");
    overlay.appendChild(ui.laser);

    // Drawing canvas
    ui.canvas = h("canvas", { class: "sl-draw" });
    ui.canvas.setAttribute("aria-hidden", "true");
    overlay.appendChild(ui.canvas);
    ui.ctx = ui.canvas.getContext("2d");

    ui.drawHint = h(
      "div",
      { class: "sl-draw-hint", hidden: "true" },
      '<span>✏️ The agent is drawing on your screen</span><button type="button">Dismiss</button>'
    );
    ui.drawHint.querySelector("button").addEventListener("click", function () {
      clearDrawing();
    });
    overlay.appendChild(ui.drawHint);

    // Directed-typing tooltip
    ui.typing = h("div", { class: "sl-typing", hidden: "true" });
    overlay.appendChild(ui.typing);

    root.appendChild(overlay);

    if (AGENT) buildAgentUI(root);
    else buildCustomerUI(root);

    document.documentElement.appendChild(host);
    ui.host = host;
    ui.root = root;
    ui.ready = true;

    if (!AGENT) {
      buildForm();
      buildResume();
      buildWaiting();
      buildLive();
      buildSent();
      resizeCanvas();
      if (CFG.headless) ui.panel.style.bottom = "20px";
      renderChrome();
    }
    window.addEventListener("resize", onResize);
  }

  function onResize() {
    if (AGENT) {
      sizeAgentStage();
      redrawAgentInk();
    } else {
      resizeCanvas();
    }
  }

  /** The demo has no real capture, so the agent stage renders a labelled mock feed. */
  function renderSimulatedFeedIfNeeded() {
    if (!AGENT || !ui.sim) return;
    var show = CFG.demo && !!ag.remoteScreen && !ag.hasRealFeed;
    // (hasRealFeed is set once a genuine WebRTC screen stream arrives.)
    ui.sim.classList.toggle("sl-on", show);
    if (show) {
      if (ui.stageEmpty) ui.stageEmpty.hidden = true;
      sizeAgentStage();
    }
  }

  /* ---------------------------- customer shell ---------------------------- */

  function buildCustomerUI(root) {
    ui.fab = h(
      "button",
      { class: "sl-fab", type: "button", "aria-label": CFG.labels.fab },
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2a7 7 0 0 0-7 7v4.6L3.3 17a1 1 0 0 0 .9 1.5h15.6a1 1 0 0 0 .9-1.5L19 13.6V9a7 7 0 0 0-7-7Zm0 20a3.5 3.5 0 0 0 3.4-2.6H8.6A3.5 3.5 0 0 0 12 22Z"/></svg><span></span>'
    );
    ui.fab.querySelector("span").textContent = CFG.labels.fab;
    ui.fab.hidden = CFG.headless;
    ui.fab.addEventListener("click", function () {
      openPanel(state === STATES.IDLE && loadStoredSession() ? "resume" : "auto");
    });
    root.appendChild(ui.fab);

    ui.panel = h("section", { class: "sl-panel", role: "dialog", "aria-label": "SupportLayer" });
    ui.panel.innerHTML =
      '<div class="sl-head"><span class="sl-dot"></span><h2></h2><span class="sl-unread" hidden></span><button class="sl-x" type="button" aria-label="Close">✕</button></div>' +
      '<div class="sl-body"><div class="sl-toast"></div>' +
      '<div class="sl-view" data-view="form"></div>' +
      '<div class="sl-view" data-view="resume"></div>' +
      '<div class="sl-view" data-view="waiting"></div>' +
      '<div class="sl-view" data-view="live"></div>' +
      '<div class="sl-view" data-view="sent"></div>' +
      "</div>";
    ui.panel.querySelector("h2").textContent = CFG.labels.title;
    ui.panel.querySelector(".sl-x").addEventListener("click", function () {
      closePanel();
    });
    root.appendChild(ui.panel);

    ui.toast = ui.panel.querySelector(".sl-toast");
    ui.panelChatBadge = ui.panel.querySelector(".sl-unread");
    ui.views = {};
    Array.prototype.forEach.call(ui.panel.querySelectorAll("[data-view]"), function (v) {
      ui.views[v.getAttribute("data-view")] = v;
    });
  }

  /* ---------------------------- agent shell ---------------------------- */

  function buildAgentUI(root) {
    ui.agent = h("div", { class: "sl-agent" });

    var stage = h("div", { class: "sl-stage", "data-tool": "point" });
    ui.stage = stage;

    ui.feed = h("video", { class: "sl-feed", playsinline: "", autoplay: "", muted: "" });
    stage.appendChild(ui.feed);

    ui.sim = h("canvas", { class: "sl-sim" });
    ui.sim.setAttribute("aria-hidden", "true");
    stage.appendChild(ui.sim);

    ui.ink = h("canvas", { class: "sl-ink" });
    ui.ink.setAttribute("aria-hidden", "true");
    stage.appendChild(ui.ink);
    ui.inkCtx = ui.ink.getContext("2d");

    ui.pip = h("video", { class: "sl-pip", playsinline: "", autoplay: "" });
    ui.pip.setAttribute("aria-label", "Customer camera");
    stage.appendChild(ui.pip);

    ui.camPh = h("div", { class: "sl-cam-ph" }, "Customer camera<br><em>simulated</em>");
    stage.appendChild(ui.camPh);

    ui.selfcam = h("video", { class: "sl-selfcam", playsinline: "", autoplay: "", muted: "" });
    ui.selfcam.setAttribute("aria-label", "Your camera");
    stage.appendChild(ui.selfcam);

    ui.badge = h("span", { class: "sl-badge" }, '<b></b><span class="sl-badge-text">Connecting…</span>');
    stage.appendChild(ui.badge);

    ui.stageEmpty = h("div", { class: "sl-stage-empty" });
    stage.appendChild(ui.stageEmpty);

    ui.agentHint = h(
      "p",
      { class: "sl-agent-hint" },
      "<b>Point</b> to spotlight, <b>Click</b> to act, <b>Draw</b> to sketch, <b>Type</b> to hand over text."
    );
    stage.appendChild(ui.agentHint);

    ui.agentToast = h("div", { class: "sl-agent-toast" });
    stage.appendChild(ui.agentToast);

    // ---- floating dock
    var dock = h("div", { class: "sl-dock", role: "toolbar", "aria-label": "Support tools" });

    var tools = h("div", { class: "sl-dock-group" });
    [
      ["point", "Point", "1"],
      ["click", "Click", "2"],
      ["draw", "Draw", "3"],
      ["type", "Type", "4"]
    ].forEach(function (t) {
      var b = h(
        "button",
        { class: "sl-tool", type: "button", "data-tool": t[0], "aria-pressed": String(t[0] === "point"), title: t[1] + " (" + t[2] + ")" },
        ICONS[t[0]] + "<span>" + t[1] + "</span><kbd>" + t[2] + "</kbd>"
      );
      b.addEventListener("click", function () {
        setTool(t[0]);
      });
      tools.appendChild(b);
    });
    dock.appendChild(tools);

    ui.typeInput = h("input", { class: "sl-type-input", type: "text", placeholder: "Text to place in their field…" });
    ui.typeInput.addEventListener("focus", function () {
      setTool("type");
    });
    ui.typeInput.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && this.value.trim()) {
        setTool("type");
        agentToast("Now click the field on their screen.");
      }
    });
    dock.appendChild(ui.typeInput);

    var swatches = h("div", { class: "sl-dock-group sl-swatches" });
    SWATCHES.forEach(function (c) {
      var s = h("button", { class: "sl-swatch", type: "button", "data-color": c, "aria-pressed": String(c === CFG.color), title: "Annotation colour" });
      s.style.background = c;
      s.addEventListener("click", function () {
        setColor(c);
      });
      swatches.appendChild(s);
    });
    dock.appendChild(swatches);

    dock.appendChild(h("div", { class: "sl-dock-sep" }));

    var actions = h("div", { class: "sl-dock-group" });
    ui.clearBtn = h("button", { class: "sl-dock-btn", type: "button", "data-act": "clear", title: "Clear the overlay (Esc)" }, ICONS.clear + "<span>Clear</span>");
    ui.clearBtn.addEventListener("click", function () {
      clearAgentInk();
      sendToClient({ t: "clear" });
      agentToast("Overlay cleared for you and the customer.");
    });
    actions.appendChild(ui.clearBtn);

    ui.chatBtn = h("button", { class: "sl-dock-btn sl-armed", type: "button", "data-act": "chat", "aria-expanded": "true", title: "Communication is always open" }, ICONS.chat + "<span>Chat</span>");
    ui.chatBadge = h("b", { class: "sl-unread", hidden: "true" }, "0");
    ui.chatBtn.appendChild(ui.chatBadge);
    ui.chatBtn.addEventListener("click", function () {
      toggleAgentCard("chat", true);
    });
    actions.appendChild(ui.chatBtn);

    ui.endBtn = h("button", { class: "sl-dock-btn sl-danger", type: "button", "data-act": "end", title: "End the session for the customer" }, ICONS.end + "<span>End</span>");
    ui.endBtn.addEventListener("click", function () {
      agentToast("Session ended.");
      endAgentSession();
    });
    actions.appendChild(ui.endBtn);

    dock.appendChild(actions);
    stage.appendChild(dock);
    ui.dock = dock;
    measureDock();
    if (window.ResizeObserver) new ResizeObserver(measureDock).observe(dock);
    dock.addEventListener("mouseenter", function () {
      showAgentHint(4000);
    });

    // ---- chat card
    ui.chatCard = h("div", { class: "sl-card", role: "log", "aria-label": "Support chat" });
    ui.chatCard.innerHTML =
      '<div class="sl-card-head"><span>Communication · live</span></div>' +
      '<div class="sl-card-body"><div class="sl-transcript"></div></div>';
    ui.agentTranscript = ui.chatCard.querySelector(".sl-transcript");
    var form = h("form", { class: "sl-agent-composer" });
    form.innerHTML = '<input type="text" placeholder="Message the customer…" aria-label="Message the customer"><button type="submit">Send</button>';
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var input = form.querySelector("input");
      if (sendChat(input.value)) input.value = "";
    });
    ui.chatCard.appendChild(form);
    stage.appendChild(ui.chatCard);

    // Request details arrive in the original support payload and handoff URL.
    // Keep the agent surface focused on communication and the live tools.
    ui.infoCard = null;

    ui.agent.appendChild(stage);
    root.appendChild(ui.agent);

    document.addEventListener("keydown", onAgentKeydown);
    ui.ink.addEventListener("pointerdown", onAgentPointerDown);
    ui.ink.addEventListener("pointermove", onAgentPointerMove);
    ui.ink.addEventListener("pointerup", onAgentPointerUp);
    ui.ink.addEventListener("pointercancel", onAgentPointerUp);
    ui.ink.addEventListener("pointerleave", onAgentPointerUp);

    renderStageEmpty();
    renderAgentBadge();
    sizeAgentStage();
  }

  function renderStageEmpty() {
    if (!ui.stageEmpty) return;
    ui.stageEmpty.hidden = feedLive();
    if (ui.stageEmpty.hidden) return;
    if (state === STATES.CONNECTED) {
      // Connected but no picture: say what is actually happening rather than showing a blank stage.
      ui.stageEmpty.innerHTML =
        "<strong>Connected — waiting for their screen…</strong>" +
        "<span>The customer's share starts with their request and runs until the session ends, so this should only be a moment.</span>";
      return;
    }
    ui.stageEmpty.innerHTML =
      '<div class="sl-spin"></div><strong>Waiting for a customer to connect…</strong>' +
      "<span>Open the link from the support webhook — it points at the customer's own page you are already on.</span>" +
      "<code>?sl_role=agent&amp;peer=&lt;customer-peer-id&gt;</code>" +
      '<span style="font-size:11.5px">' +
      (CFG.demo ? "Demo mode: discovery happens over the same-origin loopback bus." : "Real mode: this page dials the customer's peer id over WebRTC.") +
      "</span>";
  }

  function feedLive() {
    return !!(ui.feed && ui.feed.classList.contains("sl-on")) || !!(ui.sim && ui.sim.classList.contains("sl-on"));
  }

  /* ====================================================================== *
   * 11. Customer panel — views
   * ====================================================================== */

  function fieldId(name) {
    return "sl-field-" + name.replace(/[^a-zA-Z0-9_-]/g, "");
  }

  function buildForm() {
    var view = ui.views.form;
    var head = CFG.mode === "none" ? "Send a report" : "Start a live session";
    var blurb =
      CFG.mode === "none"
        ? "Tell us what happened and we'll attach a snapshot plus diagnostics."
        : CFG.mode === "video"
        ? "Tell us what happened, then start a two-way video call — they see your screen and your camera, so they can point, draw and talk it through with you."
        : "Tell us what happened, then chat live — they see your screen, so they can point at the right thing and hand you the exact text to type.";
    // Consent for the screen share has to be read before it is given, so the contract is stated
    // here — on the form — rather than only once the session is already live.
    var html =
      "<h3>" +
      esc(head) +
      "</h3><p>" +
      esc(blurb) +
      "</p>" +
      (LIVE_MODES
        ? '<p class="sl-note">Your screen is shared with the agent for the whole session — that is how they can see what you see. Ending the session is what stops it.</p>'
        : "") +
      "<form novalidate>";

    CFG.fields.forEach(function (f) {
      var id = fieldId(f.name);
      var label = esc(f.label) + (f.required ? ' <span aria-hidden="true">*</span>' : "");
      html += '<div class="sl-field">';
      if (f.type === "checkbox") {
        html += '<label for="' + id + '" style="display:flex;gap:8px;align-items:flex-start"><input type="checkbox" id="' + id + '" name="' + esc(f.name) + '" style="margin-top:2px"> <span>' + label + "</span></label>";
      } else {
        html += '<label for="' + id + '">' + label + "</label>";
        if (f.type === "textarea") {
          html += '<textarea id="' + id + '" name="' + esc(f.name) + '" placeholder="' + esc(f.placeholder) + '"></textarea>';
        } else if (f.type === "select") {
          html += '<select id="' + id + '" name="' + esc(f.name) + '">';
          html += '<option value="">Choose…</option>';
          f.options.forEach(function (o) {
            var val = typeof o === "object" ? o.value : o;
            var text = typeof o === "object" ? o.label || o.value : o;
            html += '<option value="' + esc(val) + '">' + esc(text) + "</option>";
          });
          html += "</select>";
        } else {
          html += '<input type="' + f.type + '" id="' + id + '" name="' + esc(f.name) + '" placeholder="' + esc(f.placeholder) + '">';
        }
      }
      html += "</div>";
    });

    // Honeypot — hidden from humans, irresistible to bots.
    html +=
      '<div class="sl-field sl-hp" aria-hidden="true"><label for="sl-hp-input">Company website</label>' +
      '<input type="text" id="sl-hp-input" name="company_website" tabindex="-1" autocomplete="off"></div>';
    html += '<button class="sl-btn" type="submit">' + (CFG.mode === "none" ? "Send report" : "Start session") + "</button>";
    html += "</form>";
    html +=
      '<p class="sl-note">' +
      (CFG.blurSelectors.length || CFG.blurRegex.length
        ? "Sensitive fields on this page are blurred <strong>before</strong> anything is captured. "
        : "") +
      (LIVE_MODES
        ? "Everything on this page is captured once, when you send this — the agent watches from there, and declining the screen prompt leaves you with chat only."
        : "A one-frame snapshot is attached to your report. You can decline the screen prompt and still send it.") +
      "</p>";

    view.innerHTML = html;
    ui.form = view.querySelector("form");

    ui.form.addEventListener("submit", function (e) {
      e.preventDefault();
      handleSubmit();
    });
    // Trusted-gesture bookkeeping for the isTrusted gate.
    view.addEventListener(
      "click",
      function (e) {
        if (e.isTrusted) lastTrustedAt = Date.now();
      },
      true
    );
    view.addEventListener(
      "keydown",
      function (e) {
        if (e.isTrusted) lastTrustedAt = Date.now();
      },
      true
    );
  }

  var lastTrustedAt = 0;

  function currentUserData() {
    var out = {};
    CFG.fields.forEach(function (f) {
      var el = ui.form && ui.form.querySelector('[name="' + f.name.replace(/"/g, '\\"') + '"]');
      if (!el) return;
      out[f.name] = f.type === "checkbox" ? !!el.checked : el.value;
    });
    return out;
  }

  function honeypotTripped() {
    var el = ui.form && ui.form.querySelector('[name="company_website"]');
    return !!(el && el.value);
  }

  function fillForm(values) {
    if (!values || !ui.form) return;
    Object.keys(values).forEach(function (k) {
      var el = ui.form.querySelector('[name="' + k.replace(/"/g, '\\"') + '"]');
      if (!el) return;
      if (el.type === "checkbox") el.checked = !!values[k];
      else el.value = values[k] == null ? "" : values[k];
    });
  }

  function buildResume() {
    ui.views.resume.innerHTML =
      "<h3>You have an open request</h3>" +
      '<p class="sl-resume-meta"></p>' +
      '<button class="sl-btn" type="button" data-act="resume">Resume session</button>' +
      '<div class="sl-row"><button class="sl-btn sl-btn-ghost" type="button" data-act="end">End it</button></div>' +
      '<p class="sl-note">Live connections do not survive a page reload — resuming reconnects you to the support queue with the same session ID.</p>';
    ui.views.resume.querySelector('[data-act="resume"]').addEventListener("click", function () {
      resumeSession();
    });
    ui.views.resume.querySelector('[data-act="end"]').addEventListener("click", function () {
      endSession("cancelled");
    });
  }

  /* One source of truth for "can the agent see this screen right now", shared by both customer
     views. Note what is absent: any control that stops the share. Ending the session is the
     only thing that does, and the copy says so before the customer ever sends the request. */
  var SHARE_STATE_HTML =
    '<div class="sl-share-state" data-state="starting"><span class="sl-share-dot"></span>' +
    '<span class="sl-share-text">Starting your screen share…</span></div>';
  var SHARE_STATE_INLINE_HTML =
    '<div class="sl-share-state sl-share-inline" data-state="starting"><span class="sl-share-dot"></span>' +
    '<span class="sl-share-text">Starting your screen share…</span></div>';

  function paintShareState(scope) {
    if (!scope || !scope.querySelector) return;
    var el = scope.querySelector(".sl-share-state");
    if (!el) return;
    var state = screenShared() ? "on" : session && session.shareAttempted ? "off" : "starting";
    el.setAttribute("data-state", state);
    var text = el.querySelector(".sl-share-text");
    if (text) {
      text.textContent =
        state === "on"
          ? "Your agent can see this screen"
          : state === "off"
          ? "Not shared — the agent can't see your screen"
          : "Starting your screen share…";
    }
    var btn = scope.querySelector('[data-act="resume-share"]');
    if (btn) btn.hidden = state !== "off" || !LIVE_MODES;
  }

  function buildWaiting() {
    ui.views.waiting.innerHTML =
      '<div class="sl-center"><div class="sl-spin"></div><h3>Waiting for an agent</h3>' +
      '<p class="sl-wait-meta">Your report was delivered. Keep this page open — an agent can join in a moment.</p></div>' +
      SHARE_STATE_HTML +
      '<div class="sl-link"><div class="sl-mono sl-live-url"></div></div>' +
      '<button class="sl-btn sl-btn-ghost" type="button" data-act="copy">Copy agent link</button>' +
      '<div class="sl-row"><button class="sl-btn sl-btn-ghost" type="button" data-act="resume-share" hidden>Share my screen again</button>' +
      '<button class="sl-btn sl-btn-ghost" type="button" data-act="end">Cancel</button></div>' +
      '<p class="sl-note sl-wait-note"></p>';
    ui.views.waiting.querySelector('[data-act="copy"]').addEventListener("click", function () {
      copyText(session && session.liveUrl ? session.liveUrl : "", "Agent link copied");
    });
    ui.views.waiting.querySelector('[data-act="resume-share"]').addEventListener("click", function () {
      beginScreenShare().then(renderChrome);
    });
    ui.views.waiting.querySelector('[data-act="end"]').addEventListener("click", function () {
      endSession("cancelled");
    });
  }

  function buildLive() {
    var mode = CFG.mode;
    var html =
      '<div class="sl-live-head"><span class="sl-status"><span class="sl-pulse"></span><span class="sl-live-status">Agent connected</span></span>' +
      '<span class="sl-pill sl-live-mode"></span>' +
      '<span class="sl-mono sl-live-id"></span></div>' +
      '<div class="sl-media" hidden></div>' +
      '<div class="sl-transcript" role="log" aria-live="polite"></div>' +
      '<form class="sl-composer" novalidate><input type="text" placeholder="Message the agent…" aria-label="Message the agent"><button type="submit">Send</button></form>' +
      '<div class="sl-call-bar">' +
      SHARE_STATE_INLINE_HTML +
      '<button class="sl-btn-ghost" type="button" data-act="resume-share" hidden>Share my screen again</button>' +
      '<button class="sl-btn-ghost" type="button" data-act="mic" hidden>Mute</button>' +
      '<button class="sl-btn-ghost" type="button" data-act="cam" hidden>Turn off camera</button>' +
      '<button class="sl-btn-ghost sl-danger" type="button" data-act="end">End</button>' +
      "</div>" +
      '<p class="sl-note">' +
      (mode === "none"
        ? ""
        : "Your screen stays shared for this session — that is how the agent can point at the right thing. " +
          "Ending the session is what stops it. Nothing is ever typed into your page without you seeing it first.") +
      "</p>";
    ui.views.live.innerHTML = html;

    ui.transcript = ui.views.live.querySelector(".sl-transcript");
    ui.liveMedia = ui.views.live.querySelector(".sl-media");
    ui.liveStatus = ui.views.live.querySelector(".sl-live-status");
    ui.liveModeChip = ui.views.live.querySelector(".sl-live-mode");

    ui.views.live.querySelector(".sl-composer").addEventListener("submit", function (e) {
      e.preventDefault();
      var input = this.querySelector("input");
      if (sendChat(input.value)) input.value = "";
    });
    ui.views.live.querySelector('[data-act="resume-share"]').addEventListener("click", function () {
      beginScreenShare().then(renderChrome);
    });
    ui.views.live.querySelector('[data-act="mic"]').addEventListener("click", function () {
      toggleMic();
    });
    ui.views.live.querySelector('[data-act="cam"]').addEventListener("click", function () {
      toggleCam();
    });
    ui.views.live.querySelector('[data-act="end"]').addEventListener("click", function () {
      endSession("completed");
    });
  }

  function buildSent() {
    ui.views.sent.innerHTML =
      '<div class="sl-center"><div class="sl-check">✓</div><h3>Report delivered</h3>' +
      '<p class="sl-sent-meta"></p></div>' +
      '<button class="sl-btn" type="button" data-act="close">Done</button>';
    ui.views.sent.querySelector('[data-act="close"]').addEventListener("click", function () {
      clearSession();
      setState(STATES.IDLE);
      closePanel();
      renderChrome();
    });
  }

  /* ---------------------------- customer rendering ---------------------------- */

  function currentView() {
    if (state === STATES.CONNECTED) return "live";
    if (state === STATES.WAITING) return "waiting";
    if (state === STATES.SENDING) return "waiting";
    if (ui.forceSent) return "sent";
    return null;
  }

  function showView(name) {
    Object.keys(ui.views).forEach(function (k) {
      ui.views[k].classList.toggle("sl-active", k === name);
    });
  }

  function renderLive() {
    if (!ui.liveMedia) return;
    var mode = CFG.mode;
    // The chip is inert text that names the channel the integrator chose — never a control.
    ui.liveModeChip.textContent = mode === "video" ? "Live video call" : "Live chat";
    ui.liveStatus.textContent = transportFailed ? "Agent connected (degraded)" : "Agent connected";

    var avOn = mode === "video";
    var tiles = [];
    var remote = media.remote && typeof media.remote !== "string" ? media.remote : null;
    var remoteVideo = remote && remote.getVideoTracks().length ? new MediaStream(remote.getVideoTracks()) : null;
    var remoteAudio = remote && remote.getAudioTracks().length ? new MediaStream(remote.getAudioTracks()) : null;
    var selfVideo = media.av && typeof media.av !== "string" && media.av.getVideoTracks().length ? media.av : null;

    if (avOn) {
      if (remoteVideo) tiles.push('<video class="sl-remote" playsinline autoplay></video>');
      if (selfVideo) tiles.push('<video class="sl-self" playsinline autoplay muted></video>');
      // Audio goes on its own element so a video tile never doubles the sound.
      if (remoteAudio) tiles.push('<audio class="sl-remote-audio" autoplay></audio>');
      if (!tiles.length) {
        tiles.push(
          '<div class="sl-audio-bar' + (micOn() ? "" : " sl-muted") + '"><span class="sl-wave"><i></i><i></i><i></i><i></i></span>' +
            "<span>" +
            (CFG.demo
              ? "Simulated video call · mic " + (micOn() ? "live" : "muted")
              : micOn()
              ? "Call connected · waiting for their mic…"
              : "You are muted") +
            "</span></div>"
        );
      }
    }

    ui.liveMedia.innerHTML = tiles.join("");
    ui.liveMedia.hidden = tiles.length === 0;
    ui.liveMedia.classList.toggle("sl-two", !!(remoteVideo && selfVideo));

    var remoteEl = ui.liveMedia.querySelector("video.sl-remote");
    if (remoteEl && remoteVideo) plug(remoteEl, remoteVideo);
    var selfEl = ui.liveMedia.querySelector("video.sl-self");
    if (selfEl && selfVideo) plug(selfEl, selfVideo);
    var audioEl = ui.liveMedia.querySelector("audio.sl-remote-audio");
    if (audioEl && remoteAudio) plug(audioEl, remoteAudio);

    paintShareState(ui.views.live);

    var micBtn = ui.views.live.querySelector('[data-act="mic"]');
    micBtn.hidden = !avOn;
    micBtn.textContent = micOn() ? "Mute" : "Unmute";
    micBtn.classList.toggle("sl-on", !micOn());

    var camBtn = ui.views.live.querySelector('[data-act="cam"]');
    camBtn.hidden = mode !== "video";
    camBtn.textContent = camOn() ? "Turn off camera" : "Turn on camera";
    camBtn.classList.toggle("sl-on", !camOn());

    ui.views.live.querySelector(".sl-live-id").textContent = session ? shortId(session.id) : "";
  }

  function plug(el, stream) {
    if (el.srcObject !== stream) el.srcObject = stream;
    var p = el.play();
    if (p && p.catch) p.catch(function () {});
  }

  function renderWaiting() {
    var waitMeta = ui.views.waiting.querySelector(".sl-wait-meta");
    var liveUrl = session && session.liveUrl;
    ui.views.waiting.querySelector(".sl-live-url").textContent = liveUrl || "generating agent link…";
    ui.views.waiting.querySelector('[data-act="copy"]').hidden = !liveUrl;
    paintShareState(ui.views.waiting);
    var note = ui.views.waiting.querySelector(".sl-wait-note");
    if (!LIVE_MODES) {
      note.textContent = "This deployment is report-only (mode=none) — no live channel was opened.";
    } else if (transportFailed) {
      note.textContent = "Live channel unavailable (" + transportFailed + ") — your report still reached the team.";
    } else {
      note.textContent = "";
    }
    if (state === STATES.SENDING) waitMeta.textContent = "Uploading your report and snapshot…";
  }

  /** Single entry point for all chrome updates, both roles. */
  function renderChrome() {
    if (!ui.ready) return;
    if (AGENT) {
      renderAgentBadge();
      renderStageEmpty();
      renderUnread();
      return;
    }
    var view = currentView();
    if (view) showView(view);
    if (view === "waiting") renderWaiting();
    if (view === "live") renderLive();
    if (view === "sent") {
      var size = session && session.snapshotSize ? " · snapshot " + humanBytes(session.snapshotSize) : "";
      ui.views.sent.querySelector(".sl-sent-meta").textContent =
        (session && session.delivered === false
          ? "The webhook could not be reached — the payload was logged locally instead."
          : "Posted to the support webhook with diagnostics and a one-frame snapshot.") +
        size +
        (session ? " · session " + shortId(session.id) : "");
    }    renderUnread();
  }

  function toast(message, kind) {
    if (!ui.toast) return;
    ui.toast.className = "sl-toast sl-show" + (kind ? " sl-" + kind : "");
    ui.toast.textContent = message;
    clearTimeout(ui._toastTimer);
    ui._toastTimer = setTimeout(function () {
      ui.toast.className = "sl-toast";
    }, 6000);
  }

  function openPanel(mode) {
    if (!ui.ready || AGENT) return;
    ui.panel.classList.add("sl-open");
    if (mode === "resume") {
      var stored = loadStoredSession();
      ui.views.resume.querySelector(".sl-resume-meta").textContent = stored
        ? "Started " + new Date(stored.createdAt).toLocaleString() + " · session " + shortId(stored.id) + " · mode " + stored.mode + "."
        : "";
      showView("resume");
    } else if (state === STATES.IDLE && !currentView()) {
      showView("form");
    }
    unread = 0;
    renderChrome();
  }

  function closePanel() {
    if (ui.panel) ui.panel.classList.remove("sl-open");
  }

  function copyText(text, okMessage) {
    function fallback() {
      try {
        var ta = document.createElement("textarea");
        ta.value = text;
        ta.style.cssText = "position:fixed;left:-9999px;top:0;";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        ta.remove();
        return true;
      } catch (e) {
        return false;
      }
    }
    var done = function (ok) {
      toast(ok ? okMessage || "Copied to clipboard" : "Copy failed — select the text manually", ok ? "good" : "warn");
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () {
        done(true);
      }, function () {
        done(fallback());
      });
    } else {
      done(fallback());
    }
  }

  /* ====================================================================== *
   * 12. Agent view
   * ====================================================================== */

  var ag = {
    client: null, // { url, title, viewport, mode, ua, geometry, capture_label, ... }
    targetPeer: CFG.peer || null,
    tool: "point",
    color: CFG.color,
    strokes: [],
    current: null,
    pending: [],
    pendingStart: false,
    flushQueued: false,
    clearTimer: null,
    drawing: false,
    hasFeed: false,
    remoteScreen: false,
    demoScreen: null
  };

  function clientMode() {
    return (ag.client && ag.client.mode) || "chat";
  }

  function micOn() {
    if (CFG.demo) return true;
    if (!media.av || typeof media.av === "string") return true;
    var t = media.av.getAudioTracks()[0];
    return t ? t.enabled !== false : true;
  }

  function camOn() {
    if (CFG.demo) return true;
    if (!media.av || typeof media.av === "string") return true;
    var t = media.av.getVideoTracks()[0];
    return t ? t.enabled !== false : true;
  }

  function agentToast(message, kind) {
    if (!ui.agentToast) return;
    ui.agentToast.textContent = message;
    ui.agentToast.className = "sl-agent-toast sl-show" + (kind ? " sl-" + kind : "");
    clearTimeout(ui._agentToastTimer);
    ui._agentToastTimer = setTimeout(function () {
      ui.agentToast.className = "sl-agent-toast";
    }, 2600);
  }

  function setTool(next) {
    if (!ui.stage) return;
    ag.tool = next;
    ui.stage.dataset.tool = next;
    Array.prototype.forEach.call(ui.dock.querySelectorAll(".sl-tool[data-tool]"), function (b) {
      b.setAttribute("aria-pressed", String(b.getAttribute("data-tool") === next));
    });
    if (next !== "draw" && ag.drawing) endStroke();
  }

  function setColor(color) {
    ag.color = normalizeHex(color);
    Array.prototype.forEach.call(ui.dock.querySelectorAll(".sl-swatch"), function (b) {
      b.setAttribute("aria-pressed", String(b.getAttribute("data-color") === ag.color));
    });
  }

  function onAgentKeydown(e) {
    if (e.target && (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA")) return;
    if (e.key === "1") setTool("point");
    else if (e.key === "2") setTool("click");
    else if (e.key === "3") setTool("draw");
    else if (e.key === "4") setTool("type");
    else if (e.key === "Escape") {
      clearAgentInk();
      sendToClient({ t: "clear" });
    }
  }

  function toggleAgentCard(which, force) {
    var card = which === "chat" ? ui.chatCard : ui.infoCard;
    var btn = which === "chat" ? ui.chatBtn : ui.infoBtn;
    var open = force == null ? card.hidden : force;
    card.hidden = !open;
    btn.classList.toggle("sl-armed", open);
    btn.setAttribute("aria-expanded", String(open));
    if (which === "chat") {
      if (open) {
        unread = 0;
        renderUnread();
      }
    } else if (open) {
      renderAgentInfo();
    }
  }

  function renderAgentBadge() {
    if (!ui.badge) return;
    var live = state === STATES.CONNECTED;
    ui.badge.classList.toggle("sl-live", live);
    var bits = [live ? "Connected" : transportFailed ? "Offline" : "Waiting"];
    if (live) {
      bits.push(clientMode() === "video" ? "video call" : "chat");
      bits.push(feedLive() ? "screen live" : "no screen yet");
    }
    if (ag.client && ag.client.viewport) bits.push(ag.client.viewport.w + "×" + ag.client.viewport.h);
    if (CFG.demo) bits.push("simulated feed");
    ui.badge.innerHTML = '<b></b><span class="sl-badge-text">' + esc(bits.join(" · ")) + "</span>";
  }

  function renderAgentInfo() {
    if (!ui.infoCard || !AGENT) return;
    var c = ag.client || {};
    var rows = [
      ["Session", ag.targetPeer ? shortId(ag.targetPeer) : "–"],
      ["Page", c.url || "–"],
      ["Viewport", c.viewport ? c.viewport.w + " × " + c.viewport.h : "–"],
      ["Mode", clientMode()],
      ["Privacy", c.privacy_summary || "applied before capture"]
    ];
    ui.infoCard.querySelector(".sl-info-rows").innerHTML = rows
      .map(function (r) {
        return '<div class="sl-kv"><span>' + esc(r[0]) + "</span><span>" + esc(r[1]) + "</span></div>";
      })
      .join("");
    var values = (ag.session && ag.session.values) || {};
    var keys = Object.keys(values);
    ui.infoCard.querySelector(".sl-answers").innerHTML = keys.length
      ? keys
          .map(function (k) {
            return "<li><b>" + esc(k) + "</b>" + esc(values[k]) + "</li>";
          })
          .join("")
      : "";
    var img = ui.infoCard.querySelector(".sl-snap");
    if (ag.snapshot) {
      img.src = ag.snapshot;
      img.hidden = false;
    } else {
      img.hidden = true;
    }
  }

  /* ---------------------------- stage geometry ---------------------------- */

  function clientAspect() {
    if (ag.client && ag.client.viewport && ag.client.viewport.w && ag.client.viewport.h) {
      return ag.client.viewport.w / ag.client.viewport.h;
    }
    return 16 / 10;
  }

  /** Publish the dock's real height so the toast and coach line clear it. */
  function measureDock() {
    if (!ui.dock || !ui.stage) return;
    ui.stage.style.setProperty("--sl-dock-h", Math.round(ui.dock.getBoundingClientRect().height) + 16 + "px");
  }

  /**
   * The tool cheat-sheet is a coach line, not furniture: it lingers after connect, then gets
   * out of the way. Hovering the dock brings it back.
   */
  function showAgentHint(lingerMs) {
    if (!ui.agentHint) return;
    ui.agentHint.classList.remove("sl-fade");
    clearTimeout(hintTimer);
    hintTimer = setTimeout(function () {
      ui.agentHint.classList.add("sl-fade");
    }, lingerMs == null ? 9000 : lingerMs);
  }

  var hintTimer = null;

  function sizeAgentStage() {
    if (!ui.ink || !ui.stage) return;
    var stage = ui.stage.getBoundingClientRect();
    var aspect = clientAspect();
    var width = Math.min(stage.width, stage.height * aspect);
    var height = width / aspect;
    [ui.feed, ui.sim, ui.ink].forEach(function (surface) {
      if (!surface) return;
      surface.style.width = Math.max(1, Math.round(width)) + "px";
      surface.style.height = Math.max(1, Math.round(height)) + "px";
    });
    var rect = { width: width, height: height };
    measureDock();
    var dpr = Math.min(2, window.devicePixelRatio || 1);
    [ui.ink, ui.sim].forEach(function (c) {
      c.width = Math.max(1, Math.round(rect.width * dpr));
      c.height = Math.max(1, Math.round(rect.height * dpr));
    });
    drawSimulatedFeed();
  }

  function stageRect() {
    var surface = ui.feed && ui.feed.classList.contains("sl-on") ? ui.feed : ui.sim && ui.sim.classList.contains("sl-on") ? ui.sim : ui.ink;
    return (surface || ui.stage).getBoundingClientRect();
  }

  /**
   * Raw page point (px) → normalized 0..1 of the CUSTOMER viewport, correcting for
   * letterboxing and for whole-screen captures. Mirrors the customer's own mapping.
   */
  function agentNormalize(cx, cy) {
    var box = stageRect();
    var x = (cx - box.left) / box.width;
    var y = (cy - box.top) / box.height;

    if (ui.feed && ui.feed.videoWidth && ui.feed.videoHeight) {
      var boxAspect = box.width / box.height;
      var vidAspect = ui.feed.videoWidth / ui.feed.videoHeight;
      if (Math.abs(boxAspect - vidAspect) > 0.01) {
        var scale = vidAspect > boxAspect ? box.width / ui.feed.videoWidth : box.height / ui.feed.videoHeight;
        var dw = ui.feed.videoWidth * scale;
        var dh = ui.feed.videoHeight * scale;
        var offX = (box.width - dw) / 2;
        var offY = (box.height - dh) / 2;
        x = (cx - box.left - offX) / dw;
        y = (cy - box.top - offY) / dh;
      }
    }

    if (usesScreenMapping() && ag.client && ag.client.geometry) {
      var g = ag.client.geometry;
      var frameW = (ui.feed && ui.feed.videoWidth) || 1920;
      var frameH = (ui.feed && ui.feed.videoHeight) || 1080;
      var sxs = frameW / ((g.screen_width * g.device_pixel_ratio) || frameW);
      var sys = frameH / ((g.screen_height * g.device_pixel_ratio) || frameH);
      x = (x * frameW - g.screen_x * sxs) / Math.max(1, g.outer_width * sxs);
      y = (y * frameH - g.screen_y * sys) / Math.max(1, g.outer_height * sys);
    }

    return {
      x: clamp(round3(x), 0, 1),
      y: clamp(round3(y), 0, 1),
      px: clamp(cx - box.left, 0, box.width),
      py: clamp(cy - box.top, 0, box.height)
    };
  }

  function usesScreenMapping() {
    if (!ag.client) return false;
    var label = ag.client.capture_label || "";
    return /screen|display|monitor|entire/i.test(label);
  }

  /* ---------------------------- agent tools ---------------------------- */

  function localLaser(px, py) {
    if (!ui.stage) return;
    var el = document.createElement("span");
    el.style.cssText =
      "position:absolute;left:" + px + "px;top:" + py + "px;width:22px;height:22px;margin:-11px 0 0 -11px;border-radius:50%;" +
      "background:radial-gradient(circle,#fff 0 18%," + ag.color + " 20% 46%,transparent 62%);z-index:5;pointer-events:none;transition:opacity .5s ease;opacity:1";
    ui.stage.appendChild(el);
    setTimeout(function () {
      el.style.opacity = "0";
    }, 700);
    setTimeout(function () {
      el.remove();
    }, 1300);
  }

  function onAgentPointerDown(e) {
    if (!ui.ink) return;
    if (state !== STATES.CONNECTED) {
      agentToast("No customer connected yet.");
      return;
    }
    var p = agentNormalize(e.clientX, e.clientY);

    if (ag.tool === "point" || ag.tool === "click") {
      localLaser(p.px, p.py);
      sendToClient({ t: ag.tool === "click" ? "click" : "point", x: p.x, y: p.y, color: ag.color });
      return;
    }

    if (ag.tool === "type") {
      var text = ui.typeInput.value;
      if (!text.trim()) {
        agentToast("Type the text to hand over first, then click the field.");
        ui.typeInput.focus();
        return;
      }
      localLaser(p.px, p.py);
      sendToClient({ t: "type", x: p.x, y: p.y, text: text });
      agentToast("Sent — they will see it in a highlighted field.");
      return;
    }

    ag.drawing = true;
    ag.current = [];
    ag.strokes.push(ag.current);
    if (ag.strokes.length > 40) ag.strokes.shift();
    if (ui.ink.setPointerCapture) {
      try {
        ui.ink.setPointerCapture(e.pointerId);
      } catch (err) {
        /* ignore */
      }
    }
    addAgentPoint(p.px, p.py, p.x, p.y, true);
  }

  function onAgentPointerMove(e) {
    if (!ag.drawing || ag.tool !== "draw") return;
    var p = agentNormalize(e.clientX, e.clientY);
    addAgentPoint(p.px, p.py, p.x, p.y, false);
  }

  function onAgentPointerUp() {
    endStroke();
  }

  function endStroke() {
    if (!ag.drawing) return;
    ag.drawing = false;
    flushStroke();
    armAgentClear();
  }

  function addAgentPoint(px, py, x, y, start) {
    ag.current.push({ x: px, y: py });
    ag.pending.push({ x: x, y: y });
    if (start) ag.pendingStart = true;
    redrawAgentInk();
    if (start || !ag.flushQueued) {
      ag.flushQueued = true;
      requestAnimationFrame(flushStroke);
    }
    armAgentClear();
  }

  /** Batched at ~60fps: only new points cross the wire. */
  function flushStroke() {
    ag.flushQueued = false;
    if (!ag.pending.length) return;
    var batch = ag.pending;
    ag.pending = [];
    sendToClient({ t: "draw", points: batch, start: ag.pendingStart, color: ag.color, width: 3 });
    ag.pendingStart = false;
  }

  function redrawAgentInk() {
    if (!ui.inkCtx) return;
    var dpr = Number(ui.ink.dataset.dpr || 0) || Math.min(2, window.devicePixelRatio || 1);
    ui.ink.dataset.dpr = String(dpr);
    var w = ui.ink.width / dpr;
    var h = ui.ink.height / dpr;
    ui.inkCtx.setTransform(1, 0, 0, 1, 0, 0);
    ui.inkCtx.clearRect(0, 0, ui.ink.width, ui.ink.height);
    ui.inkCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ui.inkCtx.lineCap = "round";
    ui.inkCtx.lineJoin = "round";
    var box = stageRect();
    var fx = w / Math.max(1, box.width);
    var fy = h / Math.max(1, box.height);
    ag.strokes.forEach(function (s) {
      if (!s.length) return;
      ui.inkCtx.beginPath();
      s.forEach(function (p, i) {
        if (i === 0) ui.inkCtx.moveTo(p.x * fx, p.y * fy);
        else ui.inkCtx.lineTo(p.x * fx, p.y * fy);
      });
      if (s.length === 1) ui.inkCtx.lineTo(s[0].x * fx + 0.1, s[0].y * fy);
      ui.inkCtx.strokeStyle = s.color || ag.color;
      ui.inkCtx.lineWidth = 3;
      ui.inkCtx.stroke();
    });
  }

  function armAgentClear() {
    clearTimeout(ag.clearTimer);
    ag.clearTimer = setTimeout(function () {
      clearAgentInk();
      sendToClient({ t: "clear" });
    }, 3000);
  }

  function clearAgentInk() {
    clearTimeout(ag.clearTimer);
    ag.strokes = [];
    ag.current = null;
    ag.pending = [];
    ag.pendingStart = false;
    redrawAgentInk();
  }

  /* ---------------------------- simulated feed ---------------------------- */

  function drawSunnyBakeryDemoScreen(ctx, W, H, S, font, screen) {
    var ink = "#12151c";
    var muted = "#6b7385";
    var line = "#e6e8ee";
    var page = "#f7f8fb";
    var card = "#ffffff";
    var left = Math.max(18, (W - 1060 * S) / 2);
    var contentW = W - left * 2;
    var asideW = 290 * S;
    var gap = 22 * S;
    var mainW = Math.max(220 * S, contentW - asideW - gap);
    var pad = 16 * S;
    var text = function (value, x, y, size, color, weight) {
      ctx.fillStyle = color || ink;
      ctx.font = (weight || "400") + " " + Math.max(8, Math.round(size * S)) + "px " + font;
      ctx.fillText(String(value), x, y);
    };
    var box = function (x, y, w, h, fill, stroke, radius) {
      ctx.fillStyle = fill;
      ctx.beginPath();
      ctx.roundRect(x, y, w, h, radius || 8 * S);
      ctx.fill();
      if (stroke) { ctx.strokeStyle = stroke; ctx.stroke(); }
    };
    var blur = function (value, x, y, w) {
      ctx.save();
      ctx.filter = "blur(" + Math.max(2, 5 * S) + "px)";
      text(value, x, y, 11, ink, "600");
      ctx.restore();
      ctx.strokeStyle = "rgba(107,115,133,.35)";
      ctx.strokeRect(x - 2 * S, y - 13 * S, w, 17 * S);
    };

    ctx.fillStyle = page;
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = card;
    ctx.fillRect(0, 0, W, 54 * S);
    ctx.strokeStyle = line;
    ctx.beginPath(); ctx.moveTo(0, 54 * S); ctx.lineTo(W, 54 * S); ctx.stroke();
    box(22 * S, 17 * S, 21 * S, 21 * S, "#f4a52a", null, 6 * S);
    text("Sunny Bakery", 52 * S, 32 * S, 14, ink, "700");
    text("Shop", W - 230 * S, 31 * S, 10, muted, "600");
    text("Subscriptions", W - 174 * S, 31 * S, 10, muted, "600");
    box(W - 86 * S, 14 * S, 64 * S, 26 * S, ink, null, 13 * S);
    text("Cart · 3", W - 75 * S, 31 * S, 9, "#fff", "700");

    var top = 78 * S;
    text("Checkout", left, top, 19, ink, "800");
    text("This is the customer’s real page.", left, top + 22 * S, 10, muted, "400");
    var cardY = top + 38 * S;
    var cardH = 218 * S;
    box(left, cardY, mainW, cardH, card, line, 12 * S);
    var products = [["Sourdough starter kit", "$32.00"], ["Rye flour, stone ground", "$9.60"], ["Bench scraper", "$6.60"]];
    products.forEach(function (item, i) {
      var y = cardY + (18 + i * 57) * S;
      box(left + pad, y, 42 * S, 42 * S, "#ffe1a8", null, 8 * S);
      text(item[0], left + 56 * S, y + 17 * S, 10.5, ink, "700");
      text(i === 0 ? "Ships Tuesday · qty 1" : i === 1 ? "2 kg · qty 2" : "Stainless · qty 1", left + 56 * S, y + 33 * S, 9, muted, "400");
      text(item[1], left + mainW - 62 * S, y + 23 * S, 10.5, ink, "700");
      if (i < products.length - 1) { ctx.strokeStyle = line; ctx.setLineDash([2 * S, 3 * S]); ctx.beginPath(); ctx.moveTo(left + pad, y + 51 * S); ctx.lineTo(left + mainW - pad, y + 51 * S); ctx.stroke(); ctx.setLineDash([]); }
    });

    var payY = cardY + cardH + 14 * S;
    var payH = 238 * S;
    box(left, payY, mainW, payH, card, line, 12 * S);
    text("Payment", left + pad, payY + 23 * S, 12, ink, "800");
    text("Card on file", left + pad, payY + 49 * S, 9, muted, "700");
    blur("4242 4242 4242 4242", left + 106 * S, payY + 49 * S, 128 * S);
    text("Receipt email", left + pad, payY + 76 * S, 9, muted, "700");
    blur("jane.doe@example.com", left + 106 * S, payY + 76 * S, 128 * S);
    text("Tax ID on file", left + pad, payY + 103 * S, 9, muted, "700");
    blur("123-45-6789", left + 106 * S, payY + 103 * S, 128 * S);
    box(left + pad, payY + 122 * S, mainW - pad * 2, 30 * S, "#14b8a6", null, 7 * S);
    text("Complete purchase", left + mainW / 2 - 45 * S, payY + 142 * S, 10, "#05100e", "800");
    box(left + pad, payY + 161 * S, mainW - pad * 2, 51 * S, "#fef2f2", "#fecaca", 8 * S);
    text("Payment gateway timeout (504).", left + pad + 8 * S, payY + 181 * S, 9.5, "#b91c1c", "700");
    text("Your card was not charged.", left + pad + 8 * S, payY + 197 * S, 9, "#b91c1c", "400");

    var asideX = left + mainW + gap;
    box(asideX, cardY, asideW, 184 * S, card, line, 12 * S);
    text("Order summary", asideX + pad, cardY + 23 * S, 12, ink, "800");
    [["Subtotal", "$48.20"], ["Shipping", "Free"], ["Tax", "$3.86"]].forEach(function (item, i) {
      text(item[0], asideX + pad, cardY + (53 + i * 25) * S, 10, muted, "400");
      text(item[1], asideX + asideW - 58 * S, cardY + (53 + i * 25) * S, 10, ink, "600");
    });
    ctx.strokeStyle = line; ctx.beginPath(); ctx.moveTo(asideX + pad, cardY + 127 * S); ctx.lineTo(asideX + asideW - pad, cardY + 127 * S); ctx.stroke();
    text("Total due", asideX + pad, cardY + 151 * S, 11, ink, "800");
    blur("$52.06", asideX + asideW - 60 * S, cardY + 151 * S, 48 * S);
    box(asideX, cardY + 198 * S, asideW, 118 * S, card, line, 12 * S);
    text("Account", asideX + pad, cardY + 221 * S, 12, ink, "800");
    text("Signed in as", asideX + pad, cardY + 246 * S, 9, muted, "400");
    blur("jane.doe@example.com", asideX + pad, cardY + 264 * S, 140 * S);
    text("Weekly subscription", asideX + pad, cardY + 294 * S, 9, muted, "400");
    text("SIMULATED CUSTOMER SCREEN · sensitive data blurred", left, H - 14 * S, 9, "#0f766e", "800");
  }

  function drawSimulatedFeed() {
    if (!ui.sim || !ui.sim.classList.contains("sl-on")) return;
    var ctx = ui.sim.getContext("2d");
    var dpr = Math.min(2, window.devicePixelRatio || 1);
    var w = ui.sim.width;
    var h = ui.sim.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    var W = w / dpr;
    var H = h / dpr;
    var S = W / 1280;
    var font = getComputedStyle(document.body).fontFamily || "sans-serif";

    if (ag.demoScreen && ag.demoScreen.type === "sunny-bakery-checkout") {
      drawSunnyBakeryDemoScreen(ctx, W, H, S, font, ag.demoScreen);
      return;
    }

    ctx.fillStyle = "#f7f8fb";
    ctx.fillRect(0, 0, W, H);
    // Browser chrome
    ctx.fillStyle = "#e6e8ee";
    ctx.fillRect(0, 0, W, 34 * S);
    ["#ff5f57", "#febc2e", "#28c840"].forEach(function (c, i) {
      ctx.fillStyle = c;
      ctx.beginPath();
      ctx.arc((16 + i * 17) * S, 17 * S, 5 * S, 0, Math.PI * 2);
      ctx.fill();
    });
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(80 * S, 9 * S, W - 110 * S, 16 * S);
    ctx.fillStyle = "#6b7385";
    ctx.font = Math.round(10 * S) + "px " + font;
    ctx.fillText((ag.client && ag.client.url) || "https://shop.sunnybakery.example/checkout", 88 * S, 21 * S);

    // App header
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 34 * S, W, 46 * S);
    ctx.fillStyle = "#f4a52a";
    ctx.fillRect(28 * S, 48 * S, 18 * S, 18 * S);
    ctx.fillStyle = "#12151c";
    ctx.font = "bold " + Math.round(15 * S) + "px " + font;
    ctx.fillText("Sunny Bakery", 54 * S, 62 * S);
    for (var n = 0; n < 3; n++) {
      ctx.fillStyle = "#c9ced9";
      ctx.fillRect((W - 320 + n * 96) * S, 54 * S, 66 * S, 8 * S);
    }

    var pad = 28 * S;
    var leftW = W - 350 * S - pad * 2;
    ctx.fillStyle = "#12151c";
    ctx.font = "bold " + Math.round(17 * S) + "px " + font;
    ctx.fillText("Checkout", pad, 108 * S);

    for (var r = 0; r < 4; r++) {
      var y = 126 * S + r * 74 * S;
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(pad, y, leftW, 60 * S);
      ctx.strokeStyle = "#e6e8ee";
      ctx.strokeRect(pad + 0.5, y + 0.5, leftW - 1, 60 * S - 1);
      ctx.fillStyle = "rgba(244,165,42,.35)";
      ctx.fillRect(pad + 12 * S, y + 10 * S, 40 * S, 40 * S);
      ctx.fillStyle = "#d5dae4";
      ctx.fillRect(pad + 64 * S, y + 16 * S, 180 * S, 9 * S);
      ctx.fillRect(pad + 64 * S, y + 33 * S, 110 * S, 7 * S);
      ctx.fillStyle = "#12151c";
      ctx.font = Math.round(11 * S) + "px " + font;
      ctx.fillText("$" + (8 + r * 3) + ".20", pad + leftW - 52 * S, y + 34 * S);
    }

    // Checkout column
    var colX = W - 322 * S;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(colX, 126 * S, 294 * S, H - 168 * S);
    ctx.strokeStyle = "#e6e8ee";
    ctx.strokeRect(colX + 0.5, 126.5 * S, 293 * S, H - 169 * S);
    ctx.fillStyle = "#6b7385";
    ctx.font = "bold " + Math.round(12 * S) + "px " + font;
    ctx.fillText("ORDER SUMMARY", colX + 18 * S, 152 * S);
    ["Subtotal  $48.20", "Shipping  Free", "Tax  $3.86"].forEach(function (label, i) {
      ctx.fillStyle = "#4a5162";
      ctx.font = Math.round(11.5 * S) + "px " + font;
      ctx.fillText(label, colX + 18 * S, (178 + i * 24) * S);
    });

    var barY = 262 * S;
    ctx.fillStyle = "#12151c";
    ctx.font = "bold " + Math.round(13 * S) + "px " + font;
    ctx.fillText("Total due", colX + 18 * S, barY + 4 * S);
    ctx.fillText("$52.06", colX + 210 * S, barY + 4 * S);
    ctx.fillStyle = "#e6e8ee";
    ctx.fillRect(colX + 18 * S, barY + 14 * S, 258 * S, 1 * S);

    ["Card  ████████", "jane.doe@example.com", "SSN  ████████"].forEach(function (label, i) {
      ctx.fillStyle = "#f1f3f7";
      ctx.fillRect(colX + 18 * S, (302 + i * 36) * S, 258 * S, 28 * S);
      ctx.fillStyle = "#6b7385";
      ctx.font = Math.round(11 * S) + "px " + font;
      ctx.fillText(label + "  (redacted)", colX + 28 * S, (320 + i * 36) * S);
    });

    ctx.fillStyle = "#14b8a6";
    ctx.fillRect(colX + 18 * S, (H - 86) * S, 258 * S, 40 * S);
    ctx.fillStyle = "#05100e";
    ctx.font = "bold " + Math.round(13 * S) + "px " + font;
    ctx.fillText("Complete purchase", colX + 76 * S, (H - 61) * S);

    // Watermark
    ctx.fillStyle = "rgba(180,83,9,.9)";
    ctx.font = "bold " + Math.round(10.5 * S) + "px " + font;
    ctx.fillText("SIMULATED SCREEN FEED — point, draw and type land on the real customer page.", 28 * S, (H - 20) * S);
  }

  /* ====================================================================== *
   * 13. Transport — real PeerJS, or a same-origin loopback bus for demos
   * ====================================================================== */

  var transport = null;
  var transportFailed = null;

  function makePeerId() {
    return "sl-" + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
  }

  function loadPeerJS() {
    if (window.Peer) return Promise.resolve(window.Peer);
    return new Promise(function (resolve, reject) {
      var existing = document.querySelector('script[data-supportlayer="peerjs"]');
      if (existing) {
        existing.addEventListener("load", function () {
          resolve(window.Peer);
        });
        existing.addEventListener("error", function () {
          reject(new Error("peerjs-load-failed"));
        });
        return;
      }
      var s = document.createElement("script");
      s.src = CFG.peerCdn;
      s.async = true;
      s.setAttribute("data-supportlayer", "peerjs");
      s.onload = function () {
        window.Peer ? resolve(window.Peer) : reject(new Error("peerjs-missing-global"));
      };
      s.onerror = function () {
        reject(new Error("peerjs-load-failed"));
      };
      document.head.appendChild(s);
    });
  }

  /**
   * The agent link is the customer's own page with role params — no second app to host,
   * so `location.href` is already the right base unless the integrator overrides it.
   */
  function liveSessionUrl(peerId) {
    if (!peerId) return null;
    var base = CFG.liveBase || location.href;
    var u;
    try {
      u = new URL(base, location.href);
    } catch (e) {
      return base + (base.indexOf("?") >= 0 ? "&" : "?") + "sl_role=agent&peer=" + encodeURIComponent(peerId);
    }
    u.searchParams.set("sl_role", "agent");
    u.searchParams.set("peer", peerId);
    if (CFG.demo) u.searchParams.set("sl-demo", "1");
    return u.toString();
  }

  /** Same wire protocol as PeerJS, no network — same-origin BroadcastChannel. Demo/testing only. */
  function LoopbackTransport() {
    var ch;
    var closed = false;
    var self = { name: "loopback", peerId: null, send: function () {}, announce: function () {}, close: function () {} };

    try {
      ch = new BroadcastChannel("supportlayer-bus");
    } catch (e) {
      ch = null;
    }
    if (!ch) {
      transportFailed = "BroadcastChannel unavailable";
      return self;
    }

    function post(to, obj) {
      if (closed) return;
      ch.postMessage({ dir: AGENT ? "agent→client" : "client→agent", to: to, data: obj });
    }

    ch.onmessage = function (ev) {
      var msg = ev.data || {};
      if (closed) return;
      if (AGENT) {
        if (msg.dir !== "client→agent") return;
        if (ag.targetPeer && msg.to && msg.to !== ag.targetPeer) return;
        onAgentBusMessage(msg.to, msg.data || {});
        return;
      }
      if (msg.dir !== "agent→client") return;
      var peerId = session ? session.peerId : null;
      if (msg.to && msg.to !== peerId) return;
      var data = msg.data || {};
      if (data.t === "hello") {
        if (data.agentPeerId && session) session.agentPeerId = data.agentPeerId;
        if (state !== STATES.CONNECTED) onTransportConnected("loopback");
      }
      onClientMessage(data);
    };

    if (AGENT) {
      self.send = function (obj) {
        post(ag.targetPeer || CFG.peer || "", obj);
      };
      // Periodic "is anyone there?" until a customer answers.
      var tries = 0;
      self.announce = function () {
        if (closed || state === STATES.CONNECTED || tries++ > 200) return;
        post("", { t: "who-is-there" });
        if (!closed && state !== STATES.CONNECTED) setTimeout(self.announce, 1200);
      };
      self.announce();
    } else {
      self.peerId = session ? session.peerId : null;
      self.send = function (obj) {
        post(self.peerId, obj);
      };
      // Periodic announce so an agent pane that loads later still finds us.
      var n = 0;
      self.announce = function () {
        if (closed || state === STATES.CONNECTED || n++ > 200) return;
        post(self.peerId, { t: "announce", mode: CFG.mode });
        if (!closed && state !== STATES.CONNECTED) setTimeout(self.announce, 1200);
      };
      self.announce();
    }

    self.close = function () {
      if (closed) return;
      closed = true;
      try {
        self.send({ t: "bye" });
      } catch (e) {
        /* ignore */
      }
      try {
        ch.close();
      } catch (e) {
        /* ignore */
      }
    };
    return self;
  }

  /** Real P2P transport. The customer is the callee and dials media; the agent dials the data channel. */
  function PeerTransport() {
    var peer = null;
    var conn = null;
    var self = {
      name: "peerjs",
      peerId: null,
      send: function (obj) {
        if (conn && conn.open) {
          try {
            conn.send(obj);
          } catch (e) {
            log("send failed", e && e.message);
          }
        }
      },
      announce: function () {},
      callAgent: function (agentPeerId, stream, kind) {
        if (!peer || !agentPeerId) return null;
        try {
          var call = peer.call(agentPeerId, stream || new MediaStream(), { metadata: { kind: kind || "screen" } });
          if (!call) return null;
          media.calls.push(call);
          call.on("stream", function (remote) {
            onRemoteStream(kind || "screen", remote);
          });
          call.on("error", function (err) {
            log("media call error", err && err.message);
          });
          return call;
        } catch (e) {
          log("media call failed", e && e.message);
          return null;
        }
      },
      close: function () {
        try {
          media.calls.forEach(function (c) {
            if (c && c.close) c.close();
          });
          media.calls = [];
          if (conn && conn.close) conn.close();
          if (peer && peer.destroy) peer.destroy();
        } catch (e) {
          /* ignore */
        }
      }
    };

    if (window.__SL_PEER_FACTORY__) {
      peer = window.__SL_PEER_FACTORY__(makePeerId());
    }

    function wireConn(c) {
      conn = c;
      c.on("open", function () {
        onTransportConnected("peerjs");
      });
      c.on("data", function (d) {
        handleWire(d || {});
      });
      c.on("close", function () {
        onTransportClosed("conn-close");
      });
      c.on("error", function (err) {
        log("data connection error", err && err.message);
      });
    }

    /** Agent side: dial the customer's peer id from the support link. */
    function dial(peerId) {
      if (!peer || !peerId) return;
      log("dialing", peerId);
      wireConn(peer.connect(peerId, { reliable: true, metadata: { role: "agent" } }));
    }

    loadPeerJS()
      .then(function (Peer) {
        if (!peer) {
          peer = new Peer(makePeerId(), { debug: 0 });
        }
        peer.on("open", function (id) {
          self.peerId = id;
          onPeerReady(id);
          if (AGENT && CFG.peer) dial(CFG.peer);
        });
        peer.on("connection", function (c) {
          wireConn(c);
        });
        if (AGENT) peer.on("call", onIncomingCall);
        peer.on("error", function (err) {
          var type = (err && err.type) || "peer-error";
          if (type === "peer-unavailable") return; // customer not up yet; harmless
          transportFailed = type;
          log("peer error", type);
          renderChrome();
        });
      })
      .catch(function (err) {
        transportFailed = err && err.message ? err.message : "peerjs-unavailable";
        log("transport unavailable:", transportFailed);
        if (!AGENT) setState(STATES.WAITING); // report already delivered; live channel degraded
        renderChrome();
      });

    return self;
  }

  function onIncomingCall(call) {
    var kind = (call.metadata && call.metadata.kind) || "screen";
    var answer = function (stream) {
      try {
        call.answer(stream || new MediaStream());
      } catch (e) {
        log("answer failed", e && e.message);
      }
    };
    log("incoming", kind, "call from the customer");
    if (kind === "av" && clientMode() === "video") {
      ensureLocalAV()
        .then(function (stream) {
          if (stream) log("sharing my camera + mic");
          answer(stream);
        })
        .catch(function () {
          log("mic/camera permission denied — answering without local media");
          answer(null);
        });
    } else {
      answer(null);
    }
    call.on("stream", function (remote) {
      onRemoteStream(kind, remote);
    });
  }

  /** The agent's own mic + camera — only a video session needs them. */
  function ensureLocalAV() {
    if (CFG.demo) return Promise.resolve(null);
    if (media.av) return Promise.resolve(media.av);
    if (clientMode() !== "video") return Promise.resolve(null);
    if (!supportsUserMedia()) return Promise.resolve(null);
    return navigator.mediaDevices
      .getUserMedia({ audio: true, video: true })
      .then(function (stream) {
        media.av = stream;
        if (ui.selfcam) {
          ui.selfcam.srcObject = stream;
          ui.selfcam.classList.add("sl-on");
          var p = ui.selfcam.play();
          if (p && p.catch) p.catch(function () {});
        }
        return stream;
      });
  }

  /** Media arriving from the other side. */
  function onRemoteStream(kind, remote) {
    if (!remote) return;
    if (AGENT) {
      if (kind === "screen") {
        attachRemoteScreen(remote);
      } else {
        media.remote = remote;
        var hasVideo = trackState(remote).video;
        if (hasVideo && ui.pip) {
          ui.pip.srcObject = remote;
          ui.pip.classList.add("sl-on");
          var p2 = ui.pip.play();
          if (p2 && p2.catch) p2.catch(function () {});
        }
        if (!hasVideo && ui.camPh) ui.camPh.classList.remove("sl-on");
        agentToast("Call connected.");
      }
      return;
    }
    media.remote = remote;
    renderLive();
  }

  function attachRemoteScreen(remote) {
    ag.remoteScreen = true;
    ag.hasRealFeed = true;
    ag.hasFeed = true;
    if (ui.sim) ui.sim.classList.remove("sl-on");
    if (ui.feed) {
      ui.feed.srcObject = remote;
      ui.feed.classList.add("sl-on");
      var p = ui.feed.play();
      if (p && p.catch) p.catch(function () {});
    }
    if (ui.stageEmpty) ui.stageEmpty.hidden = true;
    if (ui.camPh) ui.camPh.classList.remove("sl-on");
    renderAgentBadge();
    agentToast("Customer screen is live.");
  }

  function detachRemoteStreams() {
    if (ui.feed) {
      ui.feed.classList.remove("sl-on");
      try {
        ui.feed.srcObject = null;
      } catch (e) {
        /* ignore */
      }
    }
    if (ui.pip) {
      ui.pip.classList.remove("sl-on");
      try {
        ui.pip.srcObject = null;
      } catch (e) {
        /* ignore */
      }
    }
    if (ui.selfcam) {
      ui.selfcam.classList.remove("sl-on");
      try {
        ui.selfcam.srcObject = null;
      } catch (e) {
        /* ignore */
      }
    }
    if (AGENT) {
      ag.remoteScreen = false;
      ag.hasFeed = false;
      ag.hasRealFeed = false;
    }
  }

  function createTransport() {
    transportFailed = null;
    if (CFG.demo) {
      if (!AGENT) {
        session.peerId = session.peerId || makePeerId();
        session.liveUrl = liveSessionUrl(session.peerId);
        saveSession();
      }
      transport = LoopbackTransport();
    } else {
      transport = PeerTransport();
    }
    return transport;
  }

  function onPeerReady(peerId) {
    if (AGENT) {
      if (!ag.targetPeer && CFG.peer) ag.targetPeer = CFG.peer;
      return null;
    }
    session.peerId = peerId;
    session.liveUrl = liveSessionUrl(peerId);
    saveSession();
    renderChrome();
    if (state === STATES.WAITING || state === STATES.SENDING) {
      var eventType = session.resumed ? "support_update" : "support_request";
      session.resumed = false;
      postWebhook(buildPayload(eventType, { status: "open", snapshot: pendingSnapshot })).then(function (res) {
        onReportDelivered(res);
      });
    }
  }

  function onTransportConnected(kind) {
    log("agent connected via", kind);
    setState(STATES.CONNECTED);
    if (AGENT) {
      if (ui.stageEmpty) ui.stageEmpty.hidden = true;
      renderAgentBadge();
      showAgentHint();
      // The hello carries the agent's peer id so the customer knows where to dial its
      // screen and camera streams back to. Without it the media never starts.
      sendToClient({ t: "hello", agentPeerId: selfPeerId() });
      sysChat("Connected to the customer.");
      sendChat("Hi! I'm looking at your screen now — tell me what you see.");
      renderAgentInfo();
      return;
    }
    sysChat("An agent joined the session.");

    if (transport) {
      transport.send(Object.assign({ t: "meta", ua: navigator.userAgent }, metaForAgent()));
      var demoScreen = demoScreenForAgent();
      if (demoScreen) transport.send({ t: "demo-screen", screen: demoScreen });
      transport.send({
        t: "session",
        sessionId: session.id,
        mode: CFG.mode,
        values: session.userData || {},
        privacy: session.privacy || {}
      });
      if (lastSnapshot) {
        transport.send({ t: "snapshot", data: lastSnapshot, captured: session.snapshotAt });
      }
    }
    toast("An agent joined your session.", "good");
    startCallMedia();
    // The share belongs to the session, so a session that has to start one starts it here too:
    // an agent should never join to a blank stage. A decline is never retried silently.
    if (LIVE_MODES && !media.screen && !(session && session.shareAttempted)) beginScreenShare();
    if (LIVE_MODES) announceShareState();
    renderChrome();
  }

  function onTransportClosed(reason) {
    if (state !== STATES.CONNECTED) return;
    log("other side disconnected:", reason);
    setState(STATES.WAITING);
    if (AGENT) {
      detachRemoteStreams();
      if (ui.sim) ui.sim.classList.remove("sl-on");
      ag.client = null;
      ag.remoteScreen = false;
      renderAgentBadge();
      renderStageEmpty();
      renderChat();
      agentToast("The customer left the session.", "warn");
      // Go back to listening: they may reload the page and rejoin.
      keepListening();
      return;
    }
    detachRemoteStreams();
    media.remote = null;
    sysChat("The agent disconnected.");
    toast("The agent disconnected. Waiting for someone to rejoin…", "warn");
    renderChrome();
  }

  function metaForAgent() {
    var tr = media.screen && typeof media.screen !== "string" ? media.screen.getVideoTracks()[0] : null;
    return {
      ua: navigator.userAgent,
      mode: CFG.mode,
      url: location.href,
      title: document.title,
      peerId: session ? session.peerId : null,
      viewport: { w: window.innerWidth, h: window.innerHeight },
      screen_shared: !!media.screen,
      capture_label: tr ? tr.label : null,
      geometry: diagnostics().window_geometry,
      theme: CFG.color,
      demo: CFG.demo
    };
  }

  function demoScreenForAgent() {
    if (!CFG.demo || typeof window.__supportLayerDemoScreen !== "function") return null;
    try {
      return window.__supportLayerDemoScreen();
    } catch (e) {
      log("demo screen model failed:", e && e.message);
      return null;
    }
  }

  function sendToAgent(obj) {
    if (transport) transport.send(obj);
  }

  function sendToClient(obj) {
    if (!transport) return false;
    if (AGENT) transport.send(Object.assign({ from: "agent" }, obj));
    else transport.send(obj);
    return true;
  }

  /* ====================================================================== *
   * 14. Wire protocol
   * ====================================================================== */

  function handleWire(msg) {
    if (AGENT) onAgentMessage(msg);
    else onClientMessage(msg);
  }

  /** Customer receiving agent commands. */
  function onClientMessage(msg) {
    switch (msg.t) {
      case "hello":
        if (msg.agentPeerId) {
          session.agentPeerId = msg.agentPeerId;
          saveSession();
          if (transport && transport.callAgent) {
            if (media.screen) transport.callAgent(msg.agentPeerId, media.screen, "screen");
            if (media.av) transport.callAgent(msg.agentPeerId, media.av, "av");
          }
        }
        break;
      case "point":
        showLaser(clamp(msg.x, 0, 1) * window.innerWidth, clamp(msg.y, 0, 1) * window.innerHeight, msg.color);
        break;
      case "click":
        handleRemoteClick(msg.x, msg.y, msg.color);
        break;
      case "type":
        handleRemoteType(msg.x, msg.y, msg.text);
        break;
      case "draw":
        handleRemoteDraw(msg);
        break;
      case "clear":
        clearDrawing();
        break;
      case "chat":
        pushChat("them", msg.text, msg.at, { notify: !chatOpen() });
        break;
      case "mic":
        sysChat(msg.from === "agent" ? "The agent muted their microphone." : "The agent unmuted their microphone.");
        break;
      case "ping":
        if (transport && transport.send) transport.send({ t: "pong", at: Date.now() });
        break;
      case "bye":
        onTransportClosed("customer-left");
        break;
      case "who-is-there":
        // Agent polling the loopback bus — (re-)announce ourselves.
        if (transport && transport.send) transport.send({ t: "announce", mode: CFG.mode });
        break;
      case "end":
        endSession("completed");
        break;
      default:
        log("unknown command", msg.t);
    }
  }

  /** Agent receiving customer events. */
  function onAgentMessage(msg) {
    switch (msg.t) {
      case "announce":
        greetCustomer();
        break;
      case "meta":
        ag.client = msg;
        if (ui.stage && msg.viewport && msg.viewport.w && msg.viewport.h) {
          ui.stage.style.setProperty("--sl-client-aspect", String(msg.viewport.w / msg.viewport.h));
          sizeAgentStage();
        }
        // The customer also reports its own peer id, which is useful when a support
        // agent reloads and has to dial back into the same session.
        if (msg.peerId && !ag.targetPeer) ag.targetPeer = msg.peerId;
        if (ui.stageEmpty) ui.stageEmpty.hidden = state === STATES.CONNECTED;
        renderAgentBadge();
        renderAgentInfo();
        renderSimulatedFeedIfNeeded();
        break;
      case "session":
        ag.session = msg;
        renderAgentInfo();
        break;
      case "snapshot":
        if (msg.data) {
          ag.snapshot = msg.data;
          renderAgentInfo();
        }
        break;
      case "demo-screen":
        if (msg.screen) {
          ag.demoScreen = msg.screen;
          renderSimulatedFeedIfNeeded();
        }
        break;
      case "chat":
        pushChat("them", msg.text, msg.at, { notify: !chatOpen() });
        if (!chatOpen()) agentToast("New message from the customer.");
        break;
      case "screen-share-began":
      case "simulated-screen":
        ag.remoteScreen = true;
        renderSimulatedFeedIfNeeded();
        renderAgentBadge();
        agentToast("Screen feed is live.");
        break;
      case "screen-share-ended":
        ag.remoteScreen = false;
        if (ui.feed) ui.feed.classList.remove("sl-on");
        if (ui.sim) ui.sim.classList.remove("sl-on");
        renderAgentBadge();
        renderStageEmpty();
        agentToast(msg.lost ? "The customer's screen is no longer shared." : "The customer stopped sharing.", "warn");
        break;
      case "simulated-media":
        if (ui.camPh) {
          ui.camPh.innerHTML = "Customer camera<br><em>simulated</em>";
          ui.camPh.classList.add("sl-on");
        }
        agentToast("Simulated video call started.");
        break;
      case "pong":
        agentToast("Pong — round trip " + Math.max(0, Date.now() - (msg.at || Date.now())) + "ms");
        break;
      case "end":
        agentToast("The customer ended the session.", "warn");
        endAgentSession();
        break;
      case "bye":
        agentToast("The customer left the session.", "warn");
        onTransportClosed("bye");
        break;
      default:
        log("unknown customer message", msg.t);
    }
  }

  /** Loopback agent: learn who is on the other end, then greet. */
  function onAgentBusMessage(to, data) {
    if (!ag.targetPeer && to) ag.targetPeer = to;
    onAgentMessage(data);
  }

  function greetCustomer() {
    if (!transport) return;
    if (state !== STATES.CONNECTED) onTransportConnected(transport.name);
    else sendToClient({ t: "hello", agentPeerId: selfPeerId() });
  }

  /** Re-announce so a customer who reloaded the page gets picked back up. */
  function keepListening() {
    if (transport && transport.announce) transport.announce();
  }

  var AGENT_ID = "agent-" + Math.random().toString(36).slice(2, 9);

  /**
   * The id the customer must dial to send its screen back.
   *
   * This has to be the id the signalling broker actually registered for us. The customer's media
   * call is a fresh PeerJS call to this string, so a locally invented one resolves to nothing: the
   * broker answers `peer-unavailable` and the agent sits on a stage that never fills. It is assumed
   * different from `AGENT_ID` (a per-page random) only over the loopback bus, which ignores ids.
   */
  function selfPeerId() {
    return (transport && transport.peerId) || AGENT_ID;
  }

  /* ====================================================================== *
   * 15. Customer-side host page controls (agent → this page)
   * ====================================================================== */

  function isOurNode(el) {
    if (!el || !el.closest) return false;
    return !!el.closest("#supportlayer-root");
  }

  function elementAtNormalized(x, y) {
    var px = clamp(x, 0, 1) * window.innerWidth;
    var py = clamp(y, 0, 1) * window.innerHeight;
    var stack = document.elementsFromPoint(px, py) || [];
    for (var i = 0; i < stack.length; i++) {
      if (!isOurNode(stack[i])) return { el: stack[i], x: px, y: py };
    }
    return { el: document.elementFromPoint(px, py), x: px, y: py };
  }

  function showLaser(x, y, color) {
    if (!ui.laser) return;
    ui.laser.style.setProperty("--sl-laser", normalizeHex(color || CFG.color));
    ui.laser.hidden = false;
    ui.laser.style.left = x + "px";
    ui.laser.style.top = y + "px";
    var i = ui.laser.querySelector("i");
    var b = ui.laser.querySelector("b");
    [i, b].forEach(function (n) {
      n.style.animation = "none";
      void n.offsetWidth;
      n.style.animation = "";
    });
    clearTimeout(ui._laserTimer);
    ui._laserTimer = setTimeout(function () {
      ui.laser.hidden = true;
    }, 1300);
  }

  function handleRemoteClick(x, y, color) {
    var hit = elementAtNormalized(x, y);
    showLaser(hit.x, hit.y, color);
    var el = hit.el;
    if (!el || isOurNode(el)) return;
    try {
      if (el.focus) el.focus({ preventScroll: false });
      if (typeof el.click === "function") el.click();
      log("remote click on", el.tagName, el.className || "");
    } catch (e) {
      log("remote click failed", e && e.message);
    }
  }

  function targetStyleText() {
    return (
      ".sl-type-target { outline: 3px solid " + CFG.color + " !important; outline-offset: 2px !important; box-shadow: 0 0 0 6px " +
      CFG.color + "22 !important; transition: outline-color .2s ease; }"
    );
  }

  function markTarget(el) {
    if (!el) return;
    var style = document.getElementById(TARGET_STYLE_ID);
    if (!style) {
      style = document.createElement("style");
      style.id = TARGET_STYLE_ID;
      style.setAttribute("data-supportlayer", "target");
      style.textContent = targetStyleText();
      document.head.appendChild(style);
    }
    Array.prototype.forEach.call(document.querySelectorAll(".sl-type-target"), function (n) {
      n.classList.remove("sl-type-target");
    });
    el.classList.add("sl-type-target");
    clearTimeout(ui._targetTimer);
    ui._targetTimer = setTimeout(function () {
      el.classList.remove("sl-type-target");
    }, 15000);
  }

  function insertTextInto(el, text) {
    if (!el) return false;
    try {
      var tag = el.tagName ? el.tagName.toLowerCase() : "";
      if (tag === "input" || tag === "textarea") {
        var proto = tag === "textarea" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
        var desc = Object.getOwnPropertyDescriptor(proto, "value");
        if (desc && desc.set) desc.set.call(el, text);
        else el.value = text;
      } else if (el.isContentEditable) {
        el.textContent = text;
      } else {
        return false;
      }
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    } catch (e) {
      log("direct insert failed", e && e.message);
      return false;
    }
  }

  function handleRemoteType(x, y, text) {
    var payload = String(text == null ? "" : text);
    var hit = elementAtNormalized(x, y);
    showLaser(hit.x, hit.y);
    var el = hit.el;
    if (el && !isOurNode(el)) {
      var editable = el.closest && el.closest("input, textarea, [contenteditable=''], [contenteditable='true']");
      el = editable || el;
    } else {
      el = null;
    }
    if (el && el.focus) {
      try {
        el.focus();
      } catch (e) {
        /* ignore */
      }
    }
    markTarget(el);
    var inserted = insertTextInto(el, payload);
    // Clipboard is the guaranteed path — the user always gets a copy button.
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(payload).catch(function () {});
    } catch (e) {
      /* ignore */
    }
    showTypingTooltip(el, payload, inserted, { px: hit.x, py: hit.y });
    pushChat("them", payload, nowIso());
    sysChat("The agent handed over text for you to review.");
  }

  function showTypingTooltip(el, text, inserted, point) {
    if (!ui.typing) return;
    var rect = el && el.getBoundingClientRect ? el.getBoundingClientRect() : null;
    ui.typing.hidden = false;
    ui.typing.innerHTML =
      '<div class="sl-typing-head"><span>Agent typed for you</span><button class="sl-x" type="button" aria-label="Close">✕</button></div>' +
      '<textarea readonly rows="3"></textarea>' +
      '<div class="sl-typing-actions"><button type="button" data-act="copy">Copy text</button><button type="button" class="sl-alt" data-act="close">Dismiss</button></div>' +
      '<p class="sl-note" style="margin:8px 0 0">' +
      (inserted
        ? "Inserted into the highlighted field — check it looks right. If your app ignored it, use Copy."
        : "Paste this into the highlighted field.") +
      "</p>";
    ui.typing.querySelector("textarea").value = text;
    var place = function () {
      var w = ui.typing.offsetWidth;
      var hgt = ui.typing.offsetHeight;
      var left, top;
      if (rect && rect.width) {
        left = rect.left + rect.width / 2 - w / 2;
        top = rect.bottom + 10;
        if (top + hgt > window.innerHeight - 8) top = Math.max(8, rect.top - hgt - 10);
      } else {
        left = point.px - w / 2;
        top = point.py + 18;
      }
      ui.typing.style.left = clamp(left, 8, Math.max(8, window.innerWidth - w - 8)) + "px";
      ui.typing.style.top = clamp(top, 8, Math.max(8, window.innerHeight - hgt - 8)) + "px";
    };
    place();
    ui.typing.querySelector('[data-act="copy"]').addEventListener("click", function () {
      copyText(text, "Text copied — paste it into the field");
    });
    ui.typing.querySelector('[data-act="close"]').addEventListener("click", function () {
      ui.typing.hidden = true;
    });
    ui.typing.querySelector(".sl-x").addEventListener("click", function () {
      ui.typing.hidden = true;
    });
    clearTimeout(ui._typingTimer);
    ui._typingTimer = setTimeout(function () {
      ui.typing.hidden = true;
    }, 30000);
  }

  /* ---------------------------- drawing on the customer page ---------------------------- */

  var strokes = [];
  var drawIdleTimer = null;

  function resizeCanvas() {
    if (!ui.canvas) return;
    var dpr = Math.min(2, window.devicePixelRatio || 1);
    ui.canvas.width = Math.round(window.innerWidth * dpr);
    ui.canvas.height = Math.round(window.innerHeight * dpr);
    ui.canvas.dataset.dpr = String(dpr);
    redrawStrokes();
  }

  function redrawStrokes() {
    if (!ui.ctx) return;
    var dpr = Number(ui.canvas.dataset.dpr || 1);
    ui.ctx.setTransform(1, 0, 0, 1, 0, 0);
    ui.ctx.clearRect(0, 0, ui.canvas.width, ui.canvas.height);
    ui.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ui.ctx.lineCap = "round";
    ui.ctx.lineJoin = "round";
    strokes.forEach(function (s) {
      if (!s.points || s.points.length < 1) return;
      ui.ctx.strokeStyle = s.color || CFG.color;
      ui.ctx.lineWidth = s.width || 4;
      ui.ctx.beginPath();
      var w = window.innerWidth;
      var hgt = window.innerHeight;
      s.points.forEach(function (p, i) {
        var px = clamp(p.x, 0, 1) * w;
        var py = clamp(p.y, 0, 1) * hgt;
        if (i === 0) ui.ctx.moveTo(px, py);
        else ui.ctx.lineTo(px, py);
      });
      if (s.points.length === 1) {
        var p0 = s.points[0];
        ui.ctx.lineTo(clamp(p0.x, 0, 1) * window.innerWidth + 0.1, clamp(p0.y, 0, 1) * window.innerHeight);
      }
      ui.ctx.stroke();
    });
  }

  function handleRemoteDraw(msg) {
    if (!ui.canvas.width) resizeCanvas();
    var pts = Array.isArray(msg.points) ? msg.points : [];
    if (msg.start || !strokes.length) {
      strokes.push({ points: [], color: msg.color || CFG.color, width: msg.width || 4 });
      if (strokes.length > 40) strokes.shift();
    }
    var target = strokes[strokes.length - 1];
    pts.forEach(function (p) {
      if (p && typeof p.x === "number" && typeof p.y === "number") target.points.push(p);
    });
    redrawStrokes();
    ui.canvas.classList.add("sl-blocking");
    ui.drawHint.hidden = false;
    armDrawIdle();
  }

  function armDrawIdle() {
    clearTimeout(drawIdleTimer);
    drawIdleTimer = setTimeout(clearDrawing, 3000);
  }

  function clearDrawing() {
    clearTimeout(drawIdleTimer);
    strokes = [];
    if (ui.ctx) redrawStrokes();
    if (ui.canvas) {
      ui.canvas.classList.remove("sl-blocking");
      ui.canvas.width = 0;
      ui.canvas.height = 0;
    }
    if (ui.drawHint) ui.drawHint.hidden = true;
  }

  /* ====================================================================== *
   * 16. Session lifecycle (customer role)
   * ====================================================================== */

  function handleSubmit() {
    // isTrusted gate (anti-spam): blur-triggered submissions are ignored.
    if (Date.now() - lastTrustedAt > 4000) {
      toast("This request needs a direct click on the button.", "warn");
      return;
    }
    if (honeypotTripped()) {
      // Silently pretend it worked; never open a channel for a bot.
      log("honeypot tripped — dropping request");
      session = {
        id: uuid(),
        status: "open",
        mode: CFG.mode,
        createdAt: nowIso(),
        updatedAt: nowIso(),
        userData: {},
        peerId: null,
        liveUrl: null,
        shadowed: true
      };
      ui.forceSent = true;
      setState(STATES.IDLE);
      openPanel("auto");
      renderChrome();
      return;
    }
    var remaining = rateLimitRemaining();
    if (remaining > 0) {
      toast("Please wait " + Math.ceil(remaining / 1000) + "s before sending another request.", "warn");
      return;
    }

    var userData = currentUserData();
    var missing = CFG.fields.filter(function (f) {
      return f.required && (f.type === "checkbox" ? !userData[f.name] : !String(userData[f.name] || "").trim());
    });
    if (missing.length) {
      toast("Please fill in: " + missing.map(function (f) {
        return f.label;
      }).join(", "), "bad");
      return;
    }

    markRateLimit();
    ui.forceSent = false;
    session = {
      id: uuid(),
      status: "open",
      mode: CFG.mode,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      userData: userData,
      peerId: null,
      liveUrl: null
    };
    setState(STATES.SENDING);
    openPanel();
    renderChrome();

    // The click's user gesture dies at the first await, and getDisplayMedia needs one — so the
    // screen is asked for here. In a live mode this single capture is both the report's snapshot
    // and the session's share; a report-only install asks later, only for the snapshot.
    if (LIVE_MODES) beginScreenShare();

    // Privacy first, then capture — the user physically sees blurred data in the prompt/frame.
    var privacy = applyPrivacyBlur();
    session.privacy = privacy;
    session.privacy.demo = CFG.demo;

    getScreenSnapshot().then(function (snap) {
      session.snapshotAt = snap ? nowIso() : null;
      if (snap) session.snapshotSize = bytesOf(snap.dataUrl);
      lastSnapshot = snap ? snap.dataUrl : null;

      if (!LIVE_MODES) {
        session.status = "open";
        return postWebhook(
          buildPayload("support_request", { snapshot: snap ? snap.dataUrl : null, capture: snap ? { width: snap.width, height: snap.height, label: snap.label } : null })
        ).then(function (res) {
          ui.forceSent = true;
          session.status = "open";
          session.delivered = !!(res && res.ok);
          saveSession();
          setState(STATES.IDLE);
          openPanel("auto");
          renderChrome();
        });
      }

      // Live modes: open the channel, then report with the agent URL attached.
      session.liveUrl = null;
      createTransport();
      pendingSnapshot = snap ? snap.dataUrl : null;
      if (transport && transport.name === "loopback") {
        // No peer-id handshake in loopback mode; the URL already exists.
        postWebhook(buildPayload("support_request", { status: "open", snapshot: pendingSnapshot })).then(onReportDelivered);
      } else {
        // PeerTransport posts from onPeerReady once the id exists (or fails over).
        setState(STATES.WAITING);
        renderChrome();
        setTimeout(function () {
          if (state === STATES.WAITING && !session.liveUrl) {
            postWebhook(buildPayload("support_request", { snapshot: pendingSnapshot })).then(onReportDelivered);
          }
        }, 9000);
      }
    });
  }

  var pendingSnapshot = null;

  function onReportDelivered(res) {
    log("report delivered:", res && (res.ok ? "ok" : res.reason || res.status));
    if (state === STATES.SENDING) setState(STATES.WAITING);
    renderChrome();
  }

  function resumeSession() {
    var stored = loadStoredSession();
    if (!stored) return openPanel("auto");
    session = stored;
    session.resumed = true;
    fillForm(stored.userData);
    setState(STATES.WAITING);
    openPanel();
    applyPrivacyBlur();
    createTransport();
    postWebhook(buildPayload("support_update", { status: "open", resumed: true, live_session_url: null })).then(onReportDelivered);
    if (transport && transport.announce) transport.announce();
  }

  function endSession(reason) {
    var finalStatus = reason === "completed" ? "completed" : "cancelled";
    if (session) {
      session.status = finalStatus;
      postWebhook(buildPayload("support_update", { status: finalStatus }));
    }
    if (transport) {
      try {
        transport.send({ t: "end" });
        transport.close();
      } catch (e) {
        /* ignore */
      }
    }
    transport = null;
    transportFailed = null;
    lastSnapshot = null;
    stopSharing();
    stopStream(media.av);
    media.av = null;
    media.remote = null;
    detachRemoteStreams();
    clearDrawing();
    removePrivacyBlur();
    var target = document.getElementById(TARGET_STYLE_ID);
    if (target && target.parentNode) target.parentNode.removeChild(target);
    if (ui.typing) ui.typing.hidden = true;
    ui.forceSent = false;
    clearSession();
    setState(STATES.IDLE);
    closePanel();
    renderChrome();
  }

  /** Agent side teardown: tell the customer, then drop everything. */
  function endAgentSession() {
    try {
      if (transport) {
        transport.send({ t: "end" });
        transport.close();
      }
    } catch (e) {
      /* ignore */
    }
    transport = null;
    transportFailed = null;
    media.calls = [];
    stopStream(media.av);
    media.av = null;
    media.remote = null;
    detachRemoteStreams();
    clearAgentInk();
    ag.client = null;
    ag.snapshot = null;
    ag.session = null;
    ag.remoteScreen = false;
    ag.hasRealFeed = false;
    setState(STATES.IDLE);
    renderAgentBadge();
    renderStageEmpty();
    renderUnread();
    if (ui.chatCard) {
      ui.chatCard.hidden = false;
      ui.chatBtn.classList.add("sl-armed");
      ui.chatBtn.setAttribute("aria-expanded", "true");
    }
    if (ui.infoCard) ui.infoCard.hidden = true;
    // Keep listening so the customer can rejoin after a reload.
    if (CFG.demo) transport = LoopbackTransport();
    else createTransport();
  }

  /* ---------------------------- screen + call media ---------------------------- */

  /**
   * The customer's screen is the point of a live session: the agent guides against it, so the
   * share is scoped to the session rather than to a toggle. It starts with the request and ends
   * when the session ends, and no control in the panel can stop it in between.
   *
   * Browsers keep their own capture controls (Chrome's floating stop-sharing bar) and nothing on
   * a page can remove those, so when the track ends for any reason we say so plainly on both sides
   * and offer a one-tap resume. A resume needs a fresh gesture, which is why the first call has to
   * come from one.
   */
  function screenShared() {
    return !!media.screen;
  }

  /** Starts (or re-starts) the session's screen share. Resolves to the stream, or null. */
  function beginScreenShare() {
    if (media.screen) return Promise.resolve(media.screen);
    if (!LIVE_MODES) return Promise.resolve(null);
    if (CFG.demo) {
      media.screen = "simulated";
      onShareStarted(media.screen);
      return Promise.resolve(media.screen);
    }
    if (sharePromise) return sharePromise;
    if (!supportsCapture()) {
      if (session) session.shareAttempted = true;
      toast("This browser cannot share a screen — you can still chat with the agent.", "warn");
      return Promise.resolve(null);
    }
    sharePromise = navigator.mediaDevices
      .getDisplayMedia({ video: { frameRate: 12 }, audio: false })
      .then(function (stream) {
        media.screen = stream;
        onShareStarted(stream);
        return stream;
      })
      .catch(function (err) {
        log("share declined or unavailable:", err && err.name);
        if (session) session.shareAttempted = true;
        renderChrome();
        return null;
      })
      .then(function (stream) {
        sharePromise = null;
        return stream;
      });
    return sharePromise;
  }

  /** A capture stream is live: tell the agent, and wire it to the peer if there is one. */
  function onShareStarted(stream) {
    if (session) {
      session.screenShared = true;
      session.screenSharedAt = nowIso();
      session.shareAttempted = true;
      saveSession();
    }
    var track = stream && typeof stream !== "string" ? stream.getVideoTracks()[0] : null;
    if (track) track.addEventListener("ended", onShareLost);
    if (session && session.agentPeerId && transport && transport.callAgent) {
      transport.callAgent(session.agentPeerId, stream, "screen");
    }
    announceShareState();
    sysChat("Screen sharing is on — the agent can see this tab for as long as the session lasts.");
    renderChrome();
  }

  /** Keep the agent's stage honest about what it is looking at (or not looking at). */
  function announceShareState() {
    if (media.screen === "simulated") {
      sendToAgent({ t: "simulated-screen", on: true, viewport: { w: window.innerWidth, h: window.innerHeight } });
      return;
    }
    if (media.screen) {
      sendToAgent({ t: "screen-share-began", viewport: { w: window.innerWidth, h: window.innerHeight } });
    } else {
      sendToAgent({ t: "screen-share-ended", lost: true });
    }
  }

  /** The capture ended underneath us — the customer's browser control, or the tab shutting it down. */
  function onShareLost() {
    if (!media.screen) return;
    stopStream(media.screen);
    media.screen = null;
    if (session) {
      session.screenShared = false;
      session.shareAttempted = true;
      saveSession();
    }
    sendToAgent({ t: "screen-share-ended", lost: true });
    sysChat("Screen sharing stopped — the agent can no longer see your screen.");
    toast("Your screen is no longer being shared. Use “Share my screen again” to continue.", "warn");
    renderChrome();
  }

  /** Teardown only: the session is over, so the share goes with it. */
  function stopSharing() {
    if (media.screen) stopStream(media.screen);
    media.screen = null;
    if (session) {
      session.screenShared = false;
      session.shareAttempted = true;
    }
  }

  /** The customer's own mic + camera — video mode only. `chat` is screen + text by design. */
  function startCallMedia() {
    if (!LIVE_MODES || CFG.mode !== "video") return;
    if (media.av) return;
    if (CFG.demo) {
      media.av = "simulated";
      sendToAgent({ t: "simulated-media", kind: "video", on: true });
      sysChat("Simulated video call started.");
      renderChrome();
      return;
    }
    if (!supportsUserMedia()) return;
    navigator.mediaDevices
      .getUserMedia({ audio: true, video: true })
      .then(function (stream) {
        media.av = stream;
        if (session && session.agentPeerId && transport && transport.callAgent) {
          transport.callAgent(session.agentPeerId, stream, "av");
        }
        sysChat("Video call started — your mic and camera are live.");
        renderChrome();
      })
      .catch(function (err) {
        log("mic/camera declined:", err && err.name);
        toast("Microphone/camera permission was declined — you can still chat and share your screen.", "warn");
        renderChrome();
      });
  }

  function toggleMic() {
    if (CFG.demo || !media.av || typeof media.av === "string") return;
    var track = media.av.getAudioTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    sendToAgent({ t: "mic", on: track.enabled });
    renderChrome();
  }

  function toggleCam() {
    if (CFG.demo || !media.av || typeof media.av === "string") return;
    var track = media.av.getVideoTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    sendToAgent({ t: "cam", on: track.enabled });
    renderChrome();
  }

  /* ====================================================================== *
   * 17. Public API
   * ====================================================================== */

  window.SupportLayer = {
    version: VERSION,
    role: CFG.role,
    config: CFG,
    requestHelp: function () {
      if (AGENT) return;
      var stored = loadStoredSession();
      if (stored && stored.id && stored.status !== "cancelled" && stored.status !== "completed") {
        session = stored;
        openPanel("resume");
      } else {
        openPanel("auto");
      }
    },
    endSession: function () {
      if (AGENT) endAgentSession();
      else endSession("cancelled");
    },
    getState: function () {
      return state;
    },
    getSession: function () {
      return session ? JSON.parse(JSON.stringify(session)) : null;
    },
    getChat: function () {
      return chatLog.map(function (m) {
        return { from: m.from, text: m.text, at: m.at };
      });
    },
    chat: function (text) {
      return sendChat(text);
    },
    reset: function () {
      if (AGENT) return endAgentSession();
      endSession("cancelled");
      try {
        window.sessionStorage.removeItem(RATE_KEY);
      } catch (e) {
        /* ignore */
      }
      ui.forceSent = false;
      clearSession();
      setState(STATES.IDLE);
      renderChrome();
    },
    applyPrivacyBlur: applyPrivacyBlur,
    removePrivacyBlur: removePrivacyBlur,
    /** Exposed so integrators can drive the flow from their own UI. */
    open: function () {
      openPanel("auto");
    },
    /**
     * Agent-role seam: drive the tools from your own chrome, or from a test.
     * Undefined in the customer role.
     */
    agent: AGENT
      ? {
          send: sendToClient,
          chat: sendChat,
          setTool: setTool,
          setColor: setColor,
          normalize: agentNormalize,
          liveSessionUrl: function () {
            return CFG.peer ? liveSessionUrl(CFG.peer) : null;
          },
          state: function () {
            return {
              connected: state === STATES.CONNECTED,
              demo: CFG.demo,
              peer: ag.targetPeer,
              // The id the customer dials to send its screen back — the broker's, not a guess.
              selfPeerId: selfPeerId(),
              mode: clientMode(),
              tool: ag.tool,
              color: ag.color,
              client: ag.client ? JSON.parse(JSON.stringify(ag.client)) : null,
              feed: feedLive(),
              chat: chatLog.length,
              transport: transport ? transport.name : null
            };
          }
        }
      : undefined
  };

  /* ====================================================================== *
   * 18. Boot
   * ====================================================================== */

  function boot() {
    buildUI();
    if (AGENT) {
      // One discovery round trip, then wait. Never a report, never a FAB.
      createTransport();
      log("agent view ready — mode:", CFG.mode, "| demo:", CFG.demo, "| peer:", CFG.peer || "(discover)");
      renderAgentBadge();
      renderStageEmpty();
      return;
    }
    var stored = loadStoredSession();
    if (stored && (stored.state === "WAITING" || stored.state === "CONNECTED") && stored.status === "open") {
      // WebRTC cannot survive a reload: never auto-reconnect, always ask first.
      session = stored;
      state = STATES.IDLE;
      setState(STATES.IDLE);
      openPanel("resume");
    }
    log("ready — mode:", CFG.mode, "| headless:", CFG.headless, "| demo:", CFG.demo);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
