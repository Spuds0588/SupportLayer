/*!
 * SupportLayer v1.0.0
 * Zero-backend, drop-in diagnostic + live P2P support widget for web applications.
 *
 * Design rules that must not be broken (see agents.md / PRD-SupportLayer.md):
 *   - No middleware. Webhook POST + P2P WebRTC only.
 *   - YAGNI: native browser APIs, no screenshot/serializer libraries.
 *   - All coordinates on the wire are normalized 0.0-1.0, never pixels.
 *   - Widget UI lives in a Shadow DOM; privacy blur is applied to the host document.
 *
 * MIT License.
 */
(function () {
  "use strict";

  /* ====================================================================== *
   * 0. Tiny helpers
   * ====================================================================== */

  var VERSION = "1.0.0";
  var STORAGE_KEY = "supportlayer_session";
  var RATE_KEY = "supportlayer_rate";
  var RATE_WINDOW_MS = 60 * 1000;
  var PRIVACY_STYLE_ID = "supportlayer-privacy-css";
  var TARGET_STYLE_ID = "supportlayer-target-css";
  var DEFAULT_THEME = "#14b8a6";
  var DEFAULT_PEER_CDN = "https://unpkg.com/peerjs@1.5.5/dist/peerjs.min.js";
  var MODES = ["none", "chat", "audio", "video"];

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

  function splitAttr(v) {
    return String(v || "")
      .split(",")
      .map(function (s) {
        return s.trim();
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
   * 1. Configuration (script-tag attributes)
   * ====================================================================== */

  var script = document.currentScript || document.querySelector('script[src*="supportlayer"]');

  function dataAttr(name) {
    return script ? script.getAttribute("data-" + name) : null;
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

  var CFG = {
    webhook: dataAttr("webhook") || "",
    mode: (function () {
      var m = String(dataAttr("mode") || "none").toLowerCase();
      return MODES.indexOf(m) >= 0 ? m : "none";
    })(),
    theme: normalizeHex(dataAttr("theme") || DEFAULT_THEME),
    headless: String(dataAttr("headless") || "false") === "true",
    blurSelectors: splitAttr(dataAttr("blur-selectors")),
    blurRegex: splitAttr(dataAttr("blur-regex")),
    fields: parseFields(dataAttr("fields")),
    demo: String(dataAttr("demo") || "false") === "true" || /[?&]sl-demo=1/.test(location.search),
    peerCdn: dataAttr("peer-cdn") || DEFAULT_PEER_CDN,
    liveBase: dataAttr("live-base") || (function () {
      // Default live-session dashboard URL: agent.html next to this script.
      try {
        var src = script && script.src ? script.src : location.href;
        return new URL("agent.html", src).href;
      } catch (e) {
        return "agent.html";
      }
    })(),
    labels: {
      fab: dataAttr("label") || "Get support",
      title: dataAttr("title") || "Report an issue"
    }
  };

  var LIVE_MODES = CFG.mode !== "none";
  var LOG_PREFIX = "[SupportLayer]";

  function log() {
    if (CFG.demo) console.debug.apply(console, [LOG_PREFIX].concat([].slice.call(arguments)));
  }

  /* ====================================================================== *
   * 2. State machine + persistence
   * ====================================================================== */

  var STATES = { IDLE: "IDLE", SENDING: "SENDING", WAITING: "WAITING", CONNECTED: "CONNECTED" };
  var state = STATES.IDLE;

  var session = null; // { id, state, status, mode, peerId, createdAt, updatedAt, liveUrl, userData, snapshotAt }
  var liveStream = null; // active screen-share MediaStream (live modes, user opted in)
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
    if (!session) return;
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
      window.dispatchEvent(new CustomEvent("supportlayer:state", { detail: { state: state, session_id: session && session.id } }));
    } catch (e) {
      /* ignore */
    }
    if (ui.ready) {
      renderPanel();
      if (ui.resumeHint) ui.resumeHint.hidden = state !== STATES.IDLE || !loadStoredSession();
    }
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
      // Used by the agent dashboard to map "entire screen" captures back onto the page.
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

  function stopStream(stream) {
    if (!stream) return;
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

  /**
   * Real capture: momentary getDisplayMedia → first useful frame → 70% JPEG → tracks killed.
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

    return navigator.mediaDevices
      .getDisplayMedia({ video: { frameRate: 5, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false })
      .then(function (stream) {
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
            stopStream(stream);
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
   * 7. Webhook
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
   * 8. UI — Shadow DOM
   * ====================================================================== */

  var ui = { ready: false };

  var CSS = [
    "* { box-sizing: border-box; }",
    ":host, .sl-root { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Inter, Roboto, sans-serif; }",
    "button { font: inherit; cursor: pointer; }",
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
    "  width: min(384px, calc(100vw - 32px)); max-height: min(620px, calc(100vh - 120px));",
    "  display: none; flex-direction: column; overflow: hidden;",
    "  background: #10131a; color: #eef1f6; border: 1px solid rgba(255,255,255,.1); border-radius: 18px;",
    "  box-shadow: 0 30px 70px rgba(0,0,0,.55);",
    "  animation: sl-in .22s ease-out;",
    "}",
    "@keyframes sl-in { from { opacity: 0; transform: translateY(12px) scale(.98); } to { opacity: 1; transform: none; } }",
    ".sl-panel.sl-open { display: flex; }",
    ".sl-head { display: flex; align-items: center; gap: 10px; padding: 14px 16px; border-bottom: 1px solid rgba(255,255,255,.08); background: rgba(255,255,255,.02); }",
    ".sl-dot { width: 9px; height: 9px; border-radius: 50%; background: var(--sl-theme); box-shadow: 0 0 0 4px var(--sl-theme-dim); flex: none; }",
    ".sl-head h2 { margin: 0; font-size: 14px; font-weight: 700; letter-spacing: .01em; flex: 1; }",
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
    ".sl-row { display: flex; gap: 8px; margin-top: 10px; }",
    ".sl-note { font-size: 11px; color: #8c96a8; margin-top: 10px; line-height: 1.5; }",
    ".sl-toast { display: none; margin-bottom: 12px; padding: 9px 11px; border-radius: 10px; font-size: 12px; line-height: 1.45; }",
    ".sl-toast.sl-show { display: block; }",
    ".sl-toast.sl-warn { background: rgba(254,188,46,.12); color: #ffd377; border: 1px solid rgba(254,188,46,.3); }",
    ".sl-toast.sl-bad { background: rgba(255,95,87,.12); color: #ffa7a1; border: 1px solid rgba(255,95,87,.3); }",
    ".sl-toast.sl-good { background: rgba(40,200,64,.12); color: #8ef0a4; border: 1px solid rgba(40,200,64,.3); }",
    ".sl-spin { width: 30px; height: 30px; margin: 6px auto 14px; border-radius: 50%; border: 3px solid rgba(255,255,255,.14); border-top-color: var(--sl-theme); animation: sl-spin 1s linear infinite; }",
    "@keyframes sl-spin { to { transform: rotate(360deg); } }",
    ".sl-center { text-align: center; }",
    ".sl-mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; color: #93a0b5; word-break: break-all; }",
    ".sl-link { display: block; padding: 9px 11px; border-radius: 10px; background: rgba(255,255,255,.05); border: 1px dashed rgba(255,255,255,.16); margin: 10px 0; }",
    ".sl-status { display: flex; align-items: center; gap: 8px; font-size: 13px; font-weight: 600; margin-bottom: 10px; }",
    ".sl-pulse { width: 10px; height: 10px; border-radius: 50%; background: #28c840; animation: sl-pulse 1.6s ease-out infinite; }",
    "@keyframes sl-pulse { 0% { box-shadow: 0 0 0 0 rgba(40,200,64,.5); } 100% { box-shadow: 0 0 0 12px rgba(40,200,64,0); } }",
    ".sl-check { width: 40px; height: 40px; border-radius: 50%; background: rgba(40,200,64,.14); color: #6ee787; display: flex; align-items: center; justify-content: center; font-size: 20px; margin: 0 auto 12px; }",
    "video.sl-agent-video { width: 100%; border-radius: 12px; background: #05070b; margin-bottom: 10px; }",
    ".sl-pill { display: inline-block; padding: 3px 8px; border-radius: 999px; font-size: 10px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; background: var(--sl-theme-dim); color: var(--sl-theme-fg); border: 1px solid var(--sl-theme-border); }",
    /* overlay layers (laser + drawing) */
    ".sl-overlay { position: fixed; inset: 0; pointer-events: none; z-index: 1; }",
    "canvas.sl-draw { position: fixed; inset: 0; width: 100%; height: 100%; pointer-events: none; z-index: 4; }",
    "canvas.sl-draw.sl-blocking { pointer-events: auto; cursor: default; }",
    ".sl-laser { position: fixed; width: 26px; height: 26px; margin: -13px 0 0 -13px; pointer-events: none; z-index: 6; }",
    ".sl-laser i { position: absolute; inset: 0; border-radius: 50%; background: radial-gradient(circle at 50% 50%, #fff 0 14%, var(--sl-theme) 16% 40%, rgba(20,184,166,0) 62%); animation: sl-laser 1.1s ease-out forwards; }",
    ".sl-laser b { position: absolute; inset: -6px; border-radius: 50%; border: 2px solid var(--sl-theme); animation: sl-ring 1.1s ease-out forwards; }",
    "@keyframes sl-laser { 0% { transform: scale(.4); opacity: 1; } 70% { transform: scale(1); opacity: 1; } 100% { transform: scale(1.25); opacity: 0; } }",
    "@keyframes sl-ring { 0% { transform: scale(.5); opacity: .9; } 100% { transform: scale(2.1); opacity: 0; } }",
    ".sl-draw-hint { position: fixed; left: 50%; bottom: 26px; transform: translateX(-50%); z-index: 7; pointer-events: auto; display: inline-flex; align-items: center; gap: 10px; padding: 8px 10px 8px 14px; border-radius: 999px; background: rgba(16,19,26,.94); border: 1px solid rgba(255,255,255,.14); color: #eef1f6; font-size: 12px; box-shadow: 0 10px 30px rgba(0,0,0,.5); }",
    ".sl-draw-hint button { background: rgba(255,255,255,.1); border: 0; color: #fff; border-radius: 999px; padding: 4px 10px; font-size: 11px; font-weight: 600; }",
    ".sl-typing { position: fixed; z-index: 8; pointer-events: auto; width: min(320px, calc(100vw - 24px)); padding: 12px; border-radius: 14px; background: #10131a; border: 1px solid var(--sl-theme-border); color: #eef1f6; box-shadow: 0 19px 44px rgba(0,0,0,.55); }",
    ".sl-typing .sl-typing-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 8px; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .05em; color: var(--sl-theme-fg); }",
    ".sl-typing textarea { width: 100%; min-height: 56px; resize: vertical; background: #171b24; color: #fff; border: 1px solid rgba(255,255,255,.14); border-radius: 10px; padding: 8px 10px; font: inherit; font-size: 13px; }",
    ".sl-typing .sl-typing-actions { display: flex; gap: 8px; margin-top: 8px; }",
    ".sl-typing .sl-typing-actions button { flex: 1; padding: 8px 10px; border-radius: 9px; border: 0; font-size: 12px; font-weight: 700; background: var(--sl-theme); color: var(--sl-on-theme); }",
    ".sl-typing .sl-typing-actions button.sl-alt { background: rgba(255,255,255,.08); color: #dfe4ee; }"
  ].join("\n");

  function buildStyle() {
    var style = document.createElement("style");
    var fallbacks =
      "@supports not (color: color-mix(in srgb, red, blue)) {" +
      "  .sl-fab:hover, .sl-btn:hover { filter: brightness(1.12); }" +
      "}";
    style.textContent =
      ":host {\n" +
      "  --sl-theme: " + CFG.theme + ";\n" +
      "  --sl-theme-hover: color-mix(in srgb, " + CFG.theme + " 86%, #ffffff);\n" +
      "  --sl-theme-dim: color-mix(in srgb, " + CFG.theme + " 16%, transparent);\n" +
      "  --sl-theme-border: color-mix(in srgb, " + CFG.theme + " 45%, transparent);\n" +
      "  --sl-theme-fg: color-mix(in srgb, " + CFG.theme + " 60%, #ffffff);\n" +
      "  --sl-theme-glow: color-mix(in srgb, " + CFG.theme + " 35%, transparent);\n" +
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

    // FAB
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

    // Panel
    ui.panel = h("section", { class: "sl-panel", role: "dialog", "aria-label": "SupportLayer" });
    ui.panel.innerHTML =
      '<div class="sl-head"><span class="sl-dot"></span><h2></h2><button class="sl-x" type="button" aria-label="Close">✕</button></div>' +
      '<div class="sl-body"><div class="sl-toast"></div>' +
      '<div class="sl-view" data-view="form"></div>' +
      '<div class="sl-view" data-view="resume"></div>' +
      '<div class="sl-view" data-view="waiting"></div>' +
      '<div class="sl-view" data-view="connected"></div>' +
      '<div class="sl-view" data-view="sent"></div>' +
      "</div>";
    ui.panel.querySelector("h2").textContent = CFG.labels.title;
    ui.panel.querySelector(".sl-x").addEventListener("click", function () {
      closePanel();
    });
    root.appendChild(ui.panel);
    ui.toast = ui.panel.querySelector(".sl-toast");
    ui.views = {};
    Array.prototype.forEach.call(ui.panel.querySelectorAll("[data-view]"), function (v) {
      ui.views[v.getAttribute("data-view")] = v;
    });

    document.documentElement.appendChild(host);
    ui.host = host;
    ui.root = root;
    ui.ready = true;

    buildForm();
    buildResume();
    buildWaiting();
    buildConnected();
    buildSent();
    resizeCanvas();
    if (CFG.headless) ui.panel.style.bottom = "20px";
    renderPanel();
    window.addEventListener("resize", resizeCanvas);
  }

  /* ---------------------------- form view ---------------------------- */

  function fieldId(name) {
    return "sl-field-" + name.replace(/[^a-zA-Z0-9_-]/g, "");
  }

  function buildForm() {
    var view = ui.views.form;
    var head = CFG.mode === "none" ? "Send a report" : "Start a live session";
    var html = "<h3>" + esc(head) + "</h3><p>" + esc(
      CFG.mode === "none"
        ? "Tell us what happened and we'll attach a snapshot plus diagnostics."
        : "Tell us what happened — an agent can then watch, point, and guide you live."
    ) + "</p><form novalidate>";

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
      "A one-frame snapshot is attached to your report. You can decline the screen prompt and still send it." +
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

  /* ---------------------------- other views ---------------------------- */

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

  function buildWaiting() {
    ui.views.waiting.innerHTML =
      '<div class="sl-center"><div class="sl-spin"></div><h3>Waiting for an agent</h3>' +
      '<p class="sl-wait-meta">Your report was delivered. Keep this page open — an agent can join in a moment.</p></div>' +
      '<div class="sl-link"><div class="sl-mono sl-live-url"></div></div>' +
      '<button class="sl-btn sl-btn-ghost" type="button" data-act="copy">Copy agent link</button>' +
      '<div class="sl-row"><button class="sl-btn sl-btn-ghost" type="button" data-act="share">Share my screen</button>' +
      '<button class="sl-btn sl-btn-ghost" type="button" data-act="end">Cancel</button></div>' +
      '<p class="sl-note sl-wait-note"></p>';
    ui.views.waiting.querySelector('[data-act="copy"]').addEventListener("click", function () {
      copyText(session && session.liveUrl ? session.liveUrl : "", "Agent link copied");
    });
    ui.views.waiting.querySelector('[data-act="share"]').addEventListener("click", function () {
      shareScreen();
    });
    ui.views.waiting.querySelector('[data-act="end"]').addEventListener("click", function () {
      endSession("cancelled");
    });
  }

  function buildConnected() {
    ui.views.connected.innerHTML =
      '<div class="sl-status"><span class="sl-pulse"></span><span>Agent connected</span></div>' +
      '<p class="sl-conn-meta"></p>' +
      '<video class="sl-agent-video" playsinline autoplay hidden></video>' +
      '<button class="sl-btn sl-btn-ghost" type="button" data-act="share">Share my screen</button>' +
      '<div class="sl-row"><button class="sl-btn sl-btn-ghost" type="button" data-act="end">End session</button></div>' +
      '<p class="sl-note">The agent can point at things and highlight fields. Nothing is ever typed into your page without you seeing it first.</p>';
    ui.views.connected.querySelector('[data-act="share"]').addEventListener("click", function () {
      shareScreen();
    });
    ui.views.connected.querySelector('[data-act="end"]').addEventListener("click", function () {
      endSession("completed");
    });
    ui.agentVideo = ui.views.connected.querySelector("video");
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
      renderPanel();
    });
  }

  /* ---------------------------- rendering ---------------------------- */

  function currentView() {
    if (state === STATES.CONNECTED) return "connected";
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

  function renderPanel() {
    if (!ui.ready) return;
    var view = currentView();
    if (view) showView(view);
    if (view === "waiting") {
      var waitMeta = ui.views.waiting.querySelector(".sl-wait-meta");
      var liveUrl = session && session.liveUrl;
      ui.views.waiting.querySelector(".sl-live-url").textContent = liveUrl || "generating agent link…";
      ui.views.waiting.querySelector('[data-act="copy"]').hidden = !liveUrl;
      ui.views.waiting.querySelector('[data-act="share"]').hidden = !LIVE_MODES || !!liveStream;
      var note = ui.views.waiting.querySelector(".sl-wait-note");
      if (!LIVE_MODES) {
        note.textContent = "This deployment is report-only (mode=none) — no live channel was opened.";
      } else if (transportFailed) {
        note.textContent = "Live channel unavailable (" + transportFailed + ") — your report still reached the team.";
      } else if (liveStream) {
        note.textContent = "You are sharing your screen with the support team.";
      } else {
        note.textContent = "";
      }
      if (state === STATES.SENDING) waitMeta.textContent = "Uploading your report and snapshot…";
    }
    if (view === "connected") {
      var meta = ui.views.connected.querySelector(".sl-conn-meta");
      meta.innerHTML =
        "Session <span class='sl-mono'>" + esc(shortId(session && session.id)) + "</span> · mode <strong>" + esc(CFG.mode) + "</strong>" +
        (liveStream ? " · <span class='sl-pill'>screen shared</span>" : " · screen not shared");
      ui.views.connected.querySelector('[data-act="share"]').hidden = !!liveStream || !supportsCapture();
    }
    if (view === "sent") {
      var size = session && session.snapshotSize ? " · snapshot " + humanBytes(session.snapshotSize) : "";
      ui.views.sent.querySelector(".sl-sent-meta").textContent =
        (session && session.delivered === false
          ? "The webhook could not be reached — the payload was logged locally instead."
          : "Posted to the support webhook with diagnostics and a one-frame snapshot.") +
        size +
        (session ? " · session " + shortId(session.id) : "");
    }
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
    if (!ui.ready) return;
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
    renderPanel();
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
   * 9. Transport layer — real PeerJS, or an in-page loopback bus for demos
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

  function liveSessionUrl(peerId) {
    if (!peerId) return null;
    var sep = CFG.liveBase.indexOf("?") >= 0 ? "&" : "?";
    return CFG.liveBase + sep + "peer=" + encodeURIComponent(peerId) + (CFG.demo ? "&demo=1" : "");
  }

  /** Loopback bus: same wire protocol as PeerJS, no network. Demo/testing only. */
  function LoopbackTransport() {
    var ch;
    try {
      ch = new BroadcastChannel("supportlayer-bus");
    } catch (e) {
      ch = null;
    }
    var self = {
      name: "loopback",
      peerId: session.peerId,
      send: function (obj) {
        if (!ch) return;
        ch.postMessage({ dir: "client→agent", to: session.peerId, data: obj });
      },
      announce: function () {},
      close: function () {
        try {
          if (ch) ch.postMessage({ dir: "client→agent", to: session.peerId, data: { t: "bye" } });
          if (ch) ch.close();
        } catch (e) {
          /* ignore */
        }
      }
    };
    if (!ch) {
      transportFailed = "BroadcastChannel unavailable";
      return self;
    }
    ch.onmessage = function (ev) {
      var msg = ev.data || {};
      if (msg.dir !== "agent→client") return;
      if (msg.to && msg.to !== session.peerId) return;
      var data = msg.data || {};
      if (data.t === "hello") {
        if (data.agentPeerId) session.agentPeerId = data.agentPeerId;
        if (state !== STATES.CONNECTED) onTransportConnected("loopback");
      }
      handleWire(data);
    };
    // Periodic announce so an agent pane that loads later still finds us.
    var tries = 0;
    self.announce = function () {
      if (tries++ > 200 || state === STATES.CONNECTED) return;
      if (ch) ch.postMessage({ dir: "client→agent", to: session.peerId, data: { t: "announce", mode: CFG.mode } });
      if (state !== STATES.CONNECTED) setTimeout(self.announce, 1200);
    };
    self.announce();
    return self;
  }

  /** Real P2P transport. The client is the callee; the agent dials in. */
  function PeerTransport() {
    var peer = null;
    var conn = null;
    var mediaCall = null;
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
      callAgent: function (agentPeerId, stream) {
        if (!peer || !agentPeerId) return;
        try {
          var call = peer.call(agentPeerId, stream || new MediaStream());
          if (!call) return;
          mediaCall = mediaCall || call;
          call.on("stream", function (remote) {
            attachRemoteStream(remote);
          });
          call.on("error", function (err) {
            log("media call error", err && err.message);
          });
        } catch (e) {
          log("media call failed", e && e.message);
        }
      },
      close: function () {
        try {
          if (mediaCall && mediaCall.close) mediaCall.close();
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

    loadPeerJS()
      .then(function (Peer) {
        if (!peer) {
          peer = new Peer(makePeerId(), { debug: 0 });
        }
        peer.on("open", function (id) {
          self.peerId = id;
          onPeerReady(id);
        });
        peer.on("connection", function (c) {
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
        });
        peer.on("error", function (err) {
          var type = (err && err.type) || "peer-error";
          if (type === "peer-unavailable") return; // agent not up yet; harmless
          transportFailed = type;
          log("peer error", type);
          renderPanel();
        });
      })
      .catch(function (err) {
        transportFailed = err && err.message ? err.message : "peerjs-unavailable";
        log("transport unavailable:", transportFailed);
        setState(STATES.WAITING); // report already delivered; live channel degraded
      });

    return self;
  }

  function metaForAgent() {
    var tr = liveStream ? liveStream.getVideoTracks()[0] : null;
    return {
      ua: navigator.userAgent,
      mode: CFG.mode,
      url: location.href,
      title: document.title,
      viewport: { w: window.innerWidth, h: window.innerHeight },
      screen_shared: !!liveStream,
      capture_label: tr ? tr.label : null,
      geometry: diagnostics().window_geometry,
      theme: CFG.theme,
      demo: CFG.demo
    };
  }

  function createTransport() {
    transportFailed = null;
    if (CFG.demo) {
      // Loopback needs its peer id up front; there is no PeerJS 'open' handshake.
      session.peerId = session.peerId || makePeerId();
      session.liveUrl = liveSessionUrl(session.peerId);
      saveSession();
      transport = LoopbackTransport();
    } else {
      transport = PeerTransport();
    }
    return transport;
  }

  function attachRemoteStream(remote) {
    if (!remote || !ui.agentVideo) return;
    var hasVideo = remote.getVideoTracks().length > 0;
    if (!hasVideo && remote.getAudioTracks().length === 0) return;
    ui.agentVideo.hidden = false;
    ui.agentVideo.srcObject = remote;
    ui.agentVideo.play().catch(function () {
      toast("Agent audio/video is ready — click the video to play it.", "warn");
      ui.agentVideo.addEventListener("click", function () {
        ui.agentVideo.play().catch(function () {});
      });
    });
  }

  function onPeerReady(peerId) {
    session.peerId = peerId;
    session.liveUrl = liveSessionUrl(peerId);
    saveSession();
    renderPanel();
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
    if (transport) {
      transport.send(Object.assign({ t: "meta", ua: navigator.userAgent }, metaForAgent()));
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
    renderPanel();
  }

  function onTransportClosed(reason) {
    if (state !== STATES.CONNECTED) return;
    log("agent disconnected:", reason);
    detachRemoteStream();
    setState(STATES.WAITING);
    toast("The agent disconnected. Waiting for someone to rejoin…", "warn");
  }

  function detachRemoteStream() {
    if (ui.agentVideo) {
      ui.agentVideo.hidden = true;
      try {
        ui.agentVideo.srcObject = null;
      } catch (e) {
        /* ignore */
      }
    }
  }

  /* ====================================================================== *
   * 10. Wire protocol (agent → client commands)
   * ====================================================================== */

  function handleWire(msg) {
    switch (msg.t) {
      case "hello":
        if (msg.agentPeerId) {
          session.agentPeerId = msg.agentPeerId;
          saveSession();
          if (transport && transport.callAgent) {
            transport.callAgent(msg.agentPeerId, liveStream || new MediaStream());
          }
        }
        break;
      case "click":
        handleRemoteClick(msg.x, msg.y);
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
      case "ping":
        if (transport) transport.send({ t: "pong", at: Date.now() });
        break;
      case "who-is-there":
        // Agent console polling the loopback bus — (re-)announce ourselves.
        if (transport && transport.send) transport.send({ t: "announce", mode: CFG.mode });
        break;
      case "end":
        endSession("completed");
        break;
      default:
        log("unknown command", msg.t);
    }
  }

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

  function showLaser(x, y) {
    if (!ui.laser) return;
    ui.laser.hidden = false;
    ui.laser.style.left = x + "px";
    ui.laser.style.top = y + "px";
    // restart the animation
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

  function handleRemoteClick(x, y) {
    var hit = elementAtNormalized(x, y);
    showLaser(hit.x, hit.y);
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
      ".sl-type-target { outline: 3px solid " + CFG.theme + " !important; outline-offset: 2px !important; box-shadow: 0 0 0 6px " +
      CFG.theme + "22 !important; transition: outline-color .2s ease; }"
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

  /* ---------------------------- drawing ---------------------------- */

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
      ui.ctx.strokeStyle = s.color || CFG.theme;
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
      strokes.push({ points: [], color: msg.color || CFG.theme, width: msg.width || 4 });
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
    if (ui.canvas) ui.canvas.classList.remove("sl-blocking");
    if (ui.drawHint) ui.drawHint.hidden = true;
  }

  /* ====================================================================== *
   * 11. Session lifecycle
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
      renderPanel();
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
    renderPanel();

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
          renderPanel();
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
        renderPanel();
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
    renderPanel();
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
        transport.close();
      } catch (e) {
        /* ignore */
      }
    }
    transport = null;
    transportFailed = null;
    lastSnapshot = null;
    stopStream(liveStream);
    liveStream = null;
    detachRemoteStream();
    clearDrawing();
    removePrivacyBlur();
    var target = document.getElementById(TARGET_STYLE_ID);
    if (target && target.parentNode) target.parentNode.removeChild(target);
    if (ui.typing) ui.typing.hidden = true;
    ui.forceSent = false;
    clearSession();
    setState(STATES.IDLE);
    closePanel();
    renderPanel();
  }

  function shareScreen() {
    if (!supportsCapture()) {
      toast("This browser cannot share a screen.", "warn");
      return;
    }
    if (CFG.demo) {
      liveStream = null;
      transport && transport.send({ t: "simulated-screen", on: true });
      toast("Simulated screen share is on (demo mode — nothing is really captured).", "good");
      renderPanel();
      return;
    }
    navigator.mediaDevices
      .getDisplayMedia({ video: { frameRate: 12 }, audio: false })
      .then(function (stream) {
        liveStream = stream;
        var track = stream.getVideoTracks()[0];
        if (track) {
          track.addEventListener("ended", function () {
            stopStream(liveStream);
            liveStream = null;
            if (transport) transport.send({ t: "screen-share-ended" });
            renderPanel();
          });
        }
        if (transport) {
          if (transport.callAgent && session.agentPeerId) {
            // Re-call with the real screen stream — the agent renders the newest stream.
            transport.callAgent(session.agentPeerId, stream);
          }
          transport.send({ t: "screen-share-began", viewport: { w: window.innerWidth, h: window.innerHeight } });
        }
        if (session) session.screenSharedAt = nowIso();
        toast("You are sharing your screen with the agent.", "good");
        renderPanel();
      })
      .catch(function (err) {
        log("share declined:", err && err.name);
        toast("Screen share was cancelled.", "warn");
      });
  }

  /* ====================================================================== *
   * 12. Public API
   * ====================================================================== */

  window.SupportLayer = {
    version: VERSION,
    config: CFG,
    requestHelp: function () {
      var stored = loadStoredSession();
      if (stored && stored.id && stored.status !== "cancelled" && stored.status !== "completed") {
        session = stored;
        openPanel("resume");
      } else {
        openPanel("auto");
      }
    },
    endSession: function () {
      endSession("cancelled");
    },
    getState: function () {
      return state;
    },
    getSession: function () {
      return session ? JSON.parse(JSON.stringify(session)) : null;
    },
    reset: function () {
      endSession("cancelled");
      try {
        window.sessionStorage.removeItem(RATE_KEY);
      } catch (e) {
        /* ignore */
      }
      ui.forceSent = false;
      clearSession();
      setState(STATES.IDLE);
      renderPanel();
    },
    applyPrivacyBlur: applyPrivacyBlur,
    removePrivacyBlur: removePrivacyBlur,
    /** Exposed so integrators can drive the flow from their own UI. */
    open: function () {
      openPanel("auto");
    }
  };

  /* ====================================================================== *
   * 13. Boot
   * ====================================================================== */

  function boot() {
    buildUI();
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
