/**
 * SupportLayer end-to-end suite.
 *
 *   node tests/e2e.mjs            # headless (new headless Chrome)
 *   node tests/e2e.mjs --headed   # visible window, real rendering + real mouse input
 *
 * Boots serve.js on a free port, drives index.html's simulated demo (customer frame +
 * the SAME page in the agent role + webhook inspector) and test.html's in-page assertions,
 * then reports every failure with the reason instead of stopping at the first one.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import puppeteer from "puppeteer-core";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const HEADED = process.argv.includes("--headed");
const ENV_PORT = Number(process.env.PORT); // some shells export PORT=0, which means "unset"
const PORT = Number.isInteger(ENV_PORT) && ENV_PORT > 0 && ENV_PORT < 65536 ? ENV_PORT : 4181 + (HEADED ? 1 : 0);
// SL_BASE (or `--base <url>`) points the whole suite at an already-running origin —
// e.g. the live GitHub Pages site — instead of booting the local dev server.
const BASE_FLAG = process.argv.indexOf("--base");
const LIVE_BASE = (process.env.SL_BASE || (BASE_FLAG !== -1 ? process.argv[BASE_FLAG + 1] : "") || "")
  .trim()
  .replace(/\/$/, "");
const BASE = LIVE_BASE || `http://127.0.0.1:${PORT}`;
const SHOT_DIR = path.join(ROOT, "screenshots");

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  ].filter(Boolean);
  return candidates.find((p) => existsSync(p));
}

/* ------------------------------------------------------------------ *
 * tiny test harness
 * ------------------------------------------------------------------ */
const results = [];
let current = "";
function group(name) {
  current = name;
  console.log(`\n\x1b[1m${name}\x1b[0m`);
}
function ok(name, detail = "") {
  results.push({ group: current, name, ok: true });
  console.log(`  \x1b[32m✓\x1b[0m ${name}${detail ? ` \x1b[90m${detail}\x1b[0m` : ""}`);
}
function fail(name, detail = "") {
  results.push({ group: current, name, ok: false, detail });
  console.log(`  \x1b[31m✗\x1b[0m ${name}\n      \x1b[31m${detail}\x1b[0m`);
}
function check(name, condition, detail = "") {
  if (condition) ok(name);
  else fail(name, detail || "assertion failed");
}
function eq(name, actual, expected) {
  if (actual === expected) ok(name);
  else fail(name, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, { timeout = 8000, interval = 100, label = "condition" } = {}) {
  const start = Date.now();
  for (;;) {
    let value;
    try {
      value = await fn();
    } catch (e) {
      value = false;
    }
    if (value) return value;
    if (Date.now() - start > timeout) return false;
    await sleep(interval);
  }
}

/* ------------------------------------------------------------------ *
 * page plumbing
 * ------------------------------------------------------------------ */
const consoleErrors = [];
const consoleWarnings = [];
const pageErrors = [];
const failedRequests = [];

function watch(page, tag) {
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push({ tag, text: msg.text(), url: page.url() });
    if (msg.type() === "warn" || msg.type() === "warning") consoleWarnings.push({ tag, text: msg.text(), url: page.url() });
  });
  page.on("pageerror", (err) => pageErrors.push({ tag, text: err.message, url: page.url() }));
  page.on("requestfailed", (req) => failedRequests.push({ tag, url: req.url(), err: req.failure()?.errorText }));
}

/**
 * Trusted clicks are dispatched through the mouse at measured coordinates rather than
 * via `elementHandle.click()`. Two reasons: the coordinates work across frames (puppeteer
 * reports iframe elements in main-frame space), and it does not depend on
 * `scrollIntoViewIfNeeded`, which stalls on displays that composite slowly (rAF barely
 * fires on this host, and the headed run would otherwise time out on the first click).
 */
async function clickBox(page, box) {
  await page.mouse.click(Math.round(box.x + box.width / 2), Math.round(box.y + box.height / 2));
}

/** Measure an element, shadow-DOM or not, inside `frame` (main-frame viewport coords). */
async function boxIn(frame, selector, { shadow = true } = {}) {
  const handle = await frame.evaluateHandle(
    (sel, useShadow) => {
      const scope = useShadow ? document.querySelector("#supportlayer-root") : document;
      const root = useShadow ? scope && scope.shadowRoot : scope;
      return root ? root.querySelector(sel) : null;
    },
    selector,
    shadow
  );
  const element = handle.asElement();
  return element ? element.boundingBox() : null;
}

/** Instant scroll (the landing page sets `scroll-behavior: smooth`, which races clicks). */
async function shownInViewport(page, selector) {
  await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const top = window.scrollY + rect.top - Math.max(0, (window.innerHeight - rect.height) / 2);
    window.scrollTo({ top: Math.max(0, top), left: 0, behavior: "instant" });
  }, selector);
  await sleep(120);
}

/** Click an element inside a frame's shadow DOM (or its document) with real mouse input. */
async function clickIn(page, frame, selector, { shadow = true, frameSelector } = {}) {
  if (frameSelector) await shownInViewport(page, frameSelector);
  const box = await boxIn(frame, selector, { shadow });
  if (!box) {
    fail(`target not found or not laid out: ${selector}`);
    return false;
  }
  await clickBox(page, box);
  return true;
}

/** Click a plain element on the page itself. */
async function clickSelector(page, selector) {
  await shownInViewport(page, selector);
  const handle = await page.$(selector);
  const box = handle ? await handle.boundingBox() : null;
  if (!box) {
    fail(`target not found or not laid out: ${selector}`);
    return false;
  }
  await clickBox(page, box);
  return true;
}

/* ------------------------------------------------------------------ *
 * main
 * ------------------------------------------------------------------ */
async function main() {
  if (!existsSync(SHOT_DIR)) mkdirSync(SHOT_DIR, { recursive: true });

  const server = LIVE_BASE
    ? { kill() {}, stdout: { on() {} }, stderr: { on() {} } }
    : spawn(process.execPath, ["serve.js"], {
        cwd: ROOT,
        env: { ...process.env, PORT: String(PORT) },
        stdio: ["ignore", "pipe", "pipe"],
      });
  server.stdout.on("data", () => {});
  server.stderr.on("data", (d) => process.stderr.write(`[serve] ${d}`));

  const up = await waitFor(async () => {
    try {
      const res = await fetch(`${BASE}/index.html`, { method: "GET" });
      return res.ok;
    } catch (e) {
      return false;
    }
  }, { timeout: LIVE_BASE ? 20000 : 8000, interval: 150 });
  if (!up) {
    console.error("dev server never came up");
    server.kill();
    process.exit(1);
  }

  const executablePath = findChrome();
  if (!executablePath) {
    console.error("No Chrome/Chromium found. Set CHROME_PATH.");
    server.kill();
    process.exit(1);
  }

  console.log(
    `\x1b[1mSupportLayer e2e\x1b[0m  ${HEADED ? "HEATED" : "headless"} · ${executablePath} · ${BASE}${LIVE_BASE ? " (live)" : ""}`
  );

  const browser = await puppeteer.launch({
    executablePath,
    headless: !HEADED,
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-background-timer-throttling",
      "--window-size=1600,1000",
      ...(HEADED ? ["--window-position=0,0"] : []),
    ],
    defaultViewport: { width: 1600, height: 1000 },
  });

  try {
    /* ============================= homepage =============================
     * The landing page is a pitch plus a scripted animation; it no longer embeds the widget,
     * so it gets its own page and its own group. */
    const home = await browser.newPage();
    watch(home, "index");
    await home.goto(`${BASE}/index.html`, { waitUntil: "domcontentloaded" });

    group("homepage");
    check("page title mentions SupportLayer", (await home.title()).includes("SupportLayer"));
    eq("the homepage no longer embeds the widget in frames", (await home.$$("iframe")).length, 0);

    const storyShell = await home.evaluate(() => {
      const s = document.getElementById("story");
      const items = Array.from(s.querySelectorAll(".story-captions li"));
      return s
        ? {
            captions: items.length,
            blankCaptions: items.filter((li) => !li.textContent.trim()).length,
            steps: window.__story ? window.__story.last + 1 : null,
            replay: !!s.querySelector("#story-replay"),
            step: Number(s.getAttribute("data-step")),
          }
        : null;
    });
    check("the storyboard is on the page", !!storyShell, JSON.stringify(storyShell));
    eq("the storyboard can reach every step", storyShell?.steps, 8);
    /* Asserted against the story's own step count, not a literal: the shipped storyboard had
       seven steps and six captions, so its payoff frame cleared the caption line and sat there
       blank — and a hardcoded 6 was holding that in place. */
    eq("the storyboard ships one caption per step", storyShell?.captions, storyShell?.steps);
    eq("no step is left without a caption", storyShell?.blankCaptions, 0);
    check("the storyboard offers a replay", storyShell?.replay);

    /* The story is one window that cuts between perspectives. Read the whole state of a step,
       so each assertion is about what that side is actually being shown. */
    const storyState = () =>
      home.evaluate(() => {
        /* checkVisibility with opacityProperty is the honest oracle: a child can set
           `visibility: visible` inside a hidden parent, and the cross-faded view keeps its
           subtree at opacity 0. Reading only computed `visibility` reports the agent's
           session as visible on the customer's side, which is not what a person sees. */
        const vis = (sel) => {
          const e = document.querySelector(sel);
          if (!e) return false;
          return e.checkVisibility({ opacityProperty: true, visibilityProperty: true });
        };
        const story = document.getElementById("story");
        return {
          step: Number(story.getAttribute("data-step")),
          side: story.getAttribute("data-side"),
          error: vis(".js-error"),
          panel: vis(".js-panel"),
          redact: vis(".js-redact"),
          chat: vis(".js-chat"),
          reply: vis(".js-reply-2"),
          ring: vis(".js-ring"),
          incoming: vis(".js-incoming"),
          fab: vis(".js-fab"),
          session: vis(".js-session"),
          sessionSpot: vis(".js-session-spot"),
          share: vis(".js-share"),
          notice: vis(".js-notice"),
          url: document.getElementById("story-url").textContent,
          tag: document.getElementById("story-tag").textContent,
          feature: document.querySelector(".js-feature").textContent,
          activeCaptions: document.querySelectorAll(".story-captions li.on").length,
          activeDots: document.querySelectorAll("#story-progress li.on").length,
          dots: document.querySelectorAll("#story-progress li").length,
        };
      });

    /* Let each beat come to rest before reading it. Sampling mid-transition reads a blend of
       both perspectives — the two views cross-fade over 450ms and the redaction reveal lands
       at 400ms — so a short wait would assert against an in-between frame. */
    const SETTLE = 700;

    // Every step the story can reach, so the perspective claim is checked, not assumed.
    const sides = [];
    for (let n = 0; n <= 7; n++) {
      await home.evaluate((i) => window.__story.goto(i), n);
      await sleep(SETTLE);
      const s = await storyState();
      sides.push(s.side);
      if (n === 0) {
        check("step 0 is a plainly normal checkout", s.side === "customer" && !s.fab && !s.error && !s.panel && !s.incoming, JSON.stringify(s));
      }
      if (n === 1) {
        check("step 1 introduces the widget with the failure it exists for", s.side === "customer" && s.fab && s.error && !s.panel, JSON.stringify(s));
      }
      if (n === 2) {
        check("step 2 shows the redaction, on the customer's side", s.side === "customer" && s.redact && s.panel, JSON.stringify(s));
        check("the widget replaces the button rather than stacking on it", !s.fab, JSON.stringify(s));
        check("the screen is not shared yet at the redaction beat", !s.share, JSON.stringify(s));
      }
      if (n === 3) {
        check(
          "step 3 shows the screen going with the request",
          s.side === "customer" && s.share && s.panel && !s.session && !s.notice,
          JSON.stringify(s)
        );
      }
      if (n === 4) {
        check("step 4 cuts to the agent to show the report arriving", s.side === "agent" && s.notice && !s.session, JSON.stringify(s));
        check("the agent's beat never shows the customer's request panel", !s.panel && !s.error, JSON.stringify(s));
      }
      if (n === 5) {
        check("step 5 keeps the agent's view and opens the session", s.side === "agent" && s.session && s.sessionSpot && !s.notice, JSON.stringify(s));
        check("the agent's window is the customer's own URL in the agent role", /sl_role=agent/.test(s.url) && /agent role/.test(s.tag), `${s.url} / ${s.tag}`);
        const capture = await home.evaluate(() => {
          const customer = document.querySelector(".view-customer .mock-app");
          const agent = document.querySelector(".session-screen .mock-app");
          const values = (root) => Array.from(root.querySelectorAll(".mock-line, .mock-sensitive"), (node) => node.textContent.replace(/\\s+/g, " ").trim());
          return {
            customerValues: values(customer),
            agentValues: values(agent),
            agentHasReplacementSkeleton: !!document.querySelector(".session-screen .skel"),
            customerWidth: Math.round(customer.getBoundingClientRect().width),
            agentWidth: Math.round(agent.getBoundingClientRect().width),
            agentSensitiveFilters: Array.from(agent.querySelectorAll(".js-sensitive"), (node) => getComputedStyle(node).filter),
          };
        });
        check("the agent feed uses the same checkout data as the customer", JSON.stringify(capture.customerValues) === JSON.stringify(capture.agentValues), JSON.stringify(capture));
        check("the agent feed has no replacement skeleton content", !capture.agentHasReplacementSkeleton, JSON.stringify(capture));
        check("the agent feed keeps the customer's page scale", capture.agentWidth === capture.customerWidth, JSON.stringify(capture));
        check("sensitive values are blurred in the agent feed", capture.agentSensitiveFilters.every((filter) => filter !== "none"), JSON.stringify(capture));
      }
      if (n === 6) {
        check("step 6 cuts back to the customer to show the help landing", s.side === "customer" && s.ring && s.incoming && s.chat, JSON.stringify(s));
        check("the agent's own chrome is not visible once the customer's side has settled", !s.session && !s.sessionSpot && !s.notice, JSON.stringify(s));
        // The share outlives the beat that introduced it — that is the whole point of it.
        check("the share chip is still on screen after the perspective cuts back", s.share, JSON.stringify(s));
      }
    }
    check("the story uses both perspectives", sides.includes("customer") && sides.includes("agent"), sides.join(","));
    check(
      "it cuts back and forth rather than sitting on one side",
      sides.join(",") === "customer,customer,customer,customer,agent,agent,customer,customer",
      sides.join(",")
    );

    // Play it the way a visitor does: scroll to it and let the observer start it.
    await shownInViewport(home, "#story");
    const reachedEnd = await waitFor(
      () => home.evaluate(() => Number(document.getElementById("story").getAttribute("data-step")) === 7),
      { timeout: 25000 }
    );
    check(
      "the story plays itself to the end with no input",
      reachedEnd,
      `stopped at step ${await home.evaluate(() => document.getElementById("story").getAttribute("data-step"))}`
    );

    const finalFrame = await storyState();
    check("the story ends on the customer's side", finalFrame.side === "customer", JSON.stringify(finalFrame));
    check("it ends with the error highlighted on the customer's screen", finalFrame.ring && finalFrame.error, JSON.stringify(finalFrame));
    check("it ends with the chat resolved", finalFrame.chat && finalFrame.reply, JSON.stringify(finalFrame));
    check("the customer's chrome is back to their own URL", finalFrame.url === "shop.sunnybakery.example/checkout", finalFrame.url);
    check("the feature line points at a real property", finalFrame.feature.length > 3, finalFrame.feature);
    eq("exactly one caption is highlighted", finalFrame.activeCaptions, 1);
    eq("exactly one progress dot is active", finalFrame.activeDots, 1);
    eq("there is a progress dot per step", finalFrame.dots, 8);

    await clickSelector(home, "#story-replay");
    const rewound = await waitFor(
      () => home.evaluate(() => Number(document.getElementById("story").getAttribute("data-step")) <= 1),
      { timeout: 5000 }
    );
    check("replay rewinds the story", rewound, `step ${await home.evaluate(() => document.getElementById("story").getAttribute("data-step"))}`);
    const endedAgain = await waitFor(
      () => home.evaluate(() => Number(document.getElementById("story").getAttribute("data-step")) === 7),
      { timeout: 25000 }
    );
    check("the replayed story reaches the same end", endedAgain);

    await home.screenshot({ path: path.join(SHOT_DIR, `landing-${HEADED ? "headed" : "headless"}.png`), fullPage: false });

    /* ============================= two roles, one document =============================
     * The interaction tests bring their own room — the same page loaded twice, customer and
     * agent — so they exercise the widget rather than the marketing page's markup. */
    const page = await browser.newPage();
    watch(page, "room");
    // A real page on the real origin, not `setContent`: an `about:blank` top frame gives the
    // frames an opaque storage context, and the widget cannot read its own session there.
    await page.goto(`${BASE}/room.html`, { waitUntil: "domcontentloaded" });
    const customerFrame = await page.waitForFrame((f) => f.url().includes("demo-app.html") && !f.url().includes("sl_role"), { timeout: 10000 });
    const agentFrame = await page.waitForFrame((f) => f.url().includes("sl_role=agent"), { timeout: 10000 });

    group("two roles, one document");
    check("the customer frame loaded", !!customerFrame);
    check("the agent frame is the same document with a role param", !!agentFrame);
    eq("and it is literally the same file", agentFrame.url().split("?")[0], customerFrame.url().split("?")[0]);

    const widgetReady = await waitFor(() => customerFrame.evaluate(() => !!(window.SupportLayer && window.SupportLayer.config)));
    check("widget booted inside the customer frame", widgetReady);

    const cfg = await customerFrame.evaluate(() => {
      const c = window.SupportLayer.config;
      return { mode: c.mode, demo: c.demo, theme: c.theme, fields: c.fields.length, webhook: c.webhook, headless: c.headless };
    });
    eq("demo mode is active", cfg.demo, true);
    eq("mode parsed from the script tag", cfg.mode, "video");
    eq("customer pane reports the user role", await customerFrame.evaluate(() => window.SupportLayer.role), "user");
    eq("theme parsed from the script tag", cfg.theme, "#14b8a6");
    eq("three form fields parsed from JSON", cfg.fields, 3);
    eq("webhook URL parsed", cfg.webhook, "https://hooks.example.com/supportlayer/demo");
    eq("customer starts IDLE", await customerFrame.evaluate(() => window.SupportLayer.getState()), "IDLE");

    const agentSeam = await agentFrame.evaluate(() => {
      const a = window.SupportLayer && window.SupportLayer.agent;
      const s = a && a.state();
      return s ? { demo: s.demo, connected: s.connected, tool: s.tool, role: window.SupportLayer.role } : null;
    });
    check("agent role exposes its test seam", !!agentSeam);
    eq("the agent frame runs the widget in the agent role", agentSeam?.role, "agent");
    eq("agent view is in demo mode", agentSeam?.demo, true);
    eq("agent view starts disconnected", agentSeam?.connected, false);
    eq("the default tool is point, not a destructive click", agentSeam?.tool, "point");

    const agentShell = await agentFrame.evaluate(() => {
      const root = document.querySelector("#supportlayer-root").shadowRoot;
      const stage = root.querySelector(".sl-stage");
      const dock = root.querySelector(".sl-dock");
      const tools = Array.prototype.map.call(root.querySelectorAll(".sl-tool[data-tool]"), (b) => b.getAttribute("data-tool"));
      const rect = dock ? dock.getBoundingClientRect() : null;
      return {
        hasStage: !!stage,
        tools,
        hasChat: !!root.querySelector(".sl-card"),
        chatOpen: !!root.querySelector(".sl-card:not(.sl-info-card)") && !root.querySelector(".sl-card:not(.sl-info-card)").hidden,
        fabHidden: !root.querySelector(".sl-fab"),
        emptyShown: !root.querySelector(".sl-stage-empty").hidden,
        dockBottom: rect ? Math.round(window.innerHeight - rect.bottom) : null,
        dockFloats: rect ? getComputedStyle(dock).position : null,
      };
    });
    check("the agent gets a full-screen stage", agentShell.hasStage);
    eq("the tool dock offers point · click · draw · type", agentShell.tools.join(","), "point,click,draw,type");
    check("the dock is a floating bar pinned to the bottom", agentShell.dockFloats === "absolute" && agentShell.dockBottom < 40, JSON.stringify(agentShell));
    check("the agent never sees the customer request button", agentShell.fabHidden);
    check("the agent waits with an explicit empty state", agentShell.emptyShown);
    check("communication is open by default", agentShell.chatOpen);

    /* ---------- open the widget ---------- */
    group("request flow");
    await clickIn(page, customerFrame, ".sl-fab", { frameSelector: "#customer-frame" });
    const panelOpen = await waitFor(() =>
      customerFrame.evaluate(() => {
        const root = document.querySelector("#supportlayer-root");
        const panel = root && root.shadowRoot && root.shadowRoot.querySelector(".sl-panel");
        return !!(panel && panel.classList.contains("sl-open") && panel.querySelector(".sl-view[data-view=form].sl-active"));
      })
    );
    check("requestHelp() opens the request form", panelOpen);
    check("widget UI lives in a shadow root", await customerFrame.evaluate(() => !!document.querySelector("#supportlayer-root").shadowRoot));

    /* ---------- fill and submit with trusted input ---------- */
    await shownInViewport(page, "#customer-frame");
    await clickIn(page, customerFrame, "#sl-field-name");
    await page.keyboard.type("Jane Doe");
    await clickIn(page, customerFrame, "#sl-field-issue");
    await page.keyboard.type("The Complete purchase button spins forever.");

    const typed = await customerFrame.evaluate(() => {
      const root = document.querySelector("#supportlayer-root").shadowRoot;
      return { name: root.querySelector("#sl-field-name").value, issue: root.querySelector("#sl-field-issue").value };
    });
    eq("typed into the shadow form (real keyboard)", typed.name, "Jane Doe");
    check("textarea captured the issue", typed.issue.includes("spins forever"));

    const submitBox = await boxIn(customerFrame, "button[type=submit]");
    check("submit button is inside the visible frame", !!submitBox && submitBox.width > 10, JSON.stringify(submitBox));
    // Capture the payload from the widget's own public event rather than a page-level inspector.
    await customerFrame.evaluate(() => {
      window.__payloads = [];
      window.addEventListener("supportlayer:webhook", (e) => window.__payloads.push(e.detail));
    });
    await clickIn(page, customerFrame, "button[type=submit]");

    const delivered = await waitFor(
      () => customerFrame.evaluate(() => (window.__payloads || []).length > 0),
      { timeout: 10000 }
    );
    check("the widget emitted its webhook payload", delivered);

    const payload = await customerFrame.evaluate(() => {
      const p = (window.__payloads || [])[0] || null;
      const snap = String((p && p.snapshot) || "");
      return { parsed: p, snapshotSrc: snap.slice(0, 30), snapshotIsJpeg: snap.indexOf("data:image/jpeg") === 0, snapshotLen: snap.length };
    });
    eq("event_type is support_request", payload.parsed.event_type, "support_request");
    eq("status is open", payload.parsed.status, "open");
    eq("mode carried into the payload", payload.parsed.mode, "video");
    eq("user_data carries the typed answers", payload.parsed.user_data.name, "Jane Doe");
    check("session_id looks like a uuid", /^[0-9a-f-]{20,}$/.test(payload.parsed.session_id), payload.parsed.session_id);
    check("diagnostics carry the frame viewport", /^\d+x\d+$/.test(payload.parsed.diagnostics.viewport), payload.parsed.diagnostics.viewport);
    check("diagnostics carry url + browser + timestamp", !!(payload.parsed.diagnostics.url && payload.parsed.diagnostics.browser && payload.parsed.diagnostics.timestamp));
    check(
      "live_session_url is the customer's own page with the agent role",
      /demo-app\.html\?sl_role=agent&peer=sl-/.test(payload.parsed.live_session_url || ""),
      payload.parsed.live_session_url
    );
    check("snapshot is a JPEG data URL", payload.snapshotSrc.startsWith("data:image/jpeg"), payload.snapshotSrc);
    check("snapshot carries real pixels, not an empty frame", payload.snapshotLen > 500, `${payload.snapshotLen} chars`);

    /* ---------- privacy ---------- */
    group("privacy redaction");
    const privacy = await customerFrame.evaluate(() => ({
      style: !!document.getElementById("supportlayer-privacy-css"),
      wrapped: document.querySelectorAll(".sl-blurred").length,
      emailStillThere: document.body.textContent.includes("jane.doe@example.com"),
      blurRule: (document.getElementById("supportlayer-privacy-css") || {}).textContent || "",
      configured: window.SupportLayer.config.blurSelectors,
      regexes: window.SupportLayer.config.blurRegex,
    }));
    check("privacy stylesheet injected into the host document", privacy.style);
    check("regex-matched text nodes were wrapped", privacy.wrapped > 0, `wrapped=${privacy.wrapped}`);
    check(
      "selector rules include every configured selector",
      privacy.configured.every((sel) => privacy.blurRule.includes(sel)),
      `rules=${JSON.stringify(privacy.blurRule.slice(0, 80))}`
    );
    eq("blur patterns are split without breaking quantifiers", privacy.regexes.length, 1);
    eq(
      "the pattern keeps its `{2,}` quantifier intact",
      privacy.regexes[0],
      "\\d{3}-\\d{2}-\\d{4}|[\\w.+-]+@[\\w-]+\\.[a-z]{2,}"
    );
    check("blur is applied to the host DOM, not the widget (text still present)", privacy.emailStillThere);

    /* ---------- agent connects over the loopback bus ---------- */
    group("live session");
    const connected = await waitFor(
      () => agentFrame.evaluate(() => !!(window.SupportLayer && window.SupportLayer.agent && window.SupportLayer.agent.state().connected)),
      { timeout: 12000 }
    );
    check("the agent joined the session on its own", connected);
    const customerConnected = await waitFor(() => customerFrame.evaluate(() => window.SupportLayer.getState() === "CONNECTED"), { timeout: 8000 });
    check("customer state is CONNECTED", customerConnected, await customerFrame.evaluate(() => window.SupportLayer.getState()));
    const agentKnowsClient = await waitFor(
      () =>
        agentFrame.evaluate(() => {
          const s = window.SupportLayer.agent.state();
          return s.client && s.client.url ? { url: s.client.url, mode: s.client.mode, viewport: s.client.viewport } : false;
        }),
      { timeout: 8000 }
    );
    check("agent received the client metadata handshake", !!agentKnowsClient && !!agentKnowsClient.url, JSON.stringify(agentKnowsClient));
    eq("agent knows the client mode", agentKnowsClient && agentKnowsClient.mode, "video");

    const stageLive = await waitFor(
      () => agentFrame.evaluate(() => window.SupportLayer.agent.state().feed)
    );
    check("the customer's screen feed reached the agent stage", stageLive);

    const customerPanel = await customerFrame.evaluate(() => {
      const root = document.querySelector("#supportlayer-root").shadowRoot;
      const live = root.querySelector('.sl-view[data-view=live]');
      return {
        active: live.classList.contains("sl-active"),
        formGone: !live.parentElement.querySelector('.sl-view[data-view=form].sl-active'),
        hasComposer: !!live.querySelector(".sl-composer input"),
        hasTranscript: !!live.querySelector(".sl-transcript"),
        actions: Array.prototype.map.call(live.querySelectorAll(".sl-call-bar button"), (b) => b.textContent.trim()),
        shareState: (() => {
          const el = live.querySelector(".sl-share-state");
          return el ? { state: el.getAttribute("data-state"), text: el.textContent.trim() } : null;
        })(),
      };
    });
    check("the request panel became the live session panel", customerPanel.active && customerPanel.formGone, JSON.stringify(customerPanel));
    check("the live panel is a chat (transcript + composer)", customerPanel.hasComposer && customerPanel.hasTranscript);
    check("video sessions expose call controls", customerPanel.actions.join("|").includes("Mute"), customerPanel.actions.join("|"));
    check(
      "the demo simulates the screen share so the agent has a feed",
      customerPanel.shareState && customerPanel.shareState.state === "on",
      JSON.stringify(customerPanel.shareState)
    );

    /* ---------- the screen share belongs to the session, not to a toggle ----------
     * An agent who cannot see the screen cannot guide, which is the whole product. So the live
     * panel deliberately has no way to stop sharing: the customer consents once, when they send
     * the request, and ending the session is the only thing that stops it. If this fails, someone
     * has handed the customer a control that blinds the agent mid-session. */
    group("screen share is session-scoped");
    const shareFacts = await customerFrame.evaluate(() => {
      const root = document.querySelector("#supportlayer-root").shadowRoot;
      const labels = Array.prototype.map.call(root.querySelectorAll("button"), (b) => b.textContent.trim());
      const state = root.querySelector(".sl-share-state");
      return {
        sessionShared: !!((window.SupportLayer.getSession() || {}).screenShared),
        state: state ? state.getAttribute("data-state") : null,
        stateText: state ? state.textContent.trim() : "",
        stopControls: labels.filter((t) => /stop sharing|stop screen|end sharing/i.test(t)),
        labels,
      };
    });
    check("the session reports a live share", shareFacts.sessionShared, JSON.stringify(shareFacts));
    check("the panel tells the customer the agent can see this screen", /can see this screen/i.test(shareFacts.stateText), shareFacts.stateText);
    check(
      "no stop-sharing control exists anywhere in the panel",
      shareFacts.stopControls.length === 0,
      shareFacts.stopControls.join(" | ") || shareFacts.labels.join(" | ")
    );
    const widgetCode = readFileSync(path.join(ROOT, "supportlayer.js"), "utf8");
    check("the widget source has no 'Stop sharing' label", !/["']Stop sharing["']/.test(widgetCode));
    check("the widget offers no screen-share toggle to begin with", !/shareScreen\s*\(/.test(widgetCode), "shareScreen() came back");
    check(
      "the share is announced to the agent and started by the session, not by a control",
      /screen-share-began/.test(widgetCode) && /beginScreenShare/.test(widgetCode)
    );
    /* The `hello` handshake tells the customer which peer id to dial with its screen. Over the
       loopback bus ids are ignored, so advertising a locally invented one costs nothing here and
       costs the whole session over real signalling — the customer calls a peer that does not exist
       and the agent's stage stays empty forever. tests/live-session.mjs exercises the real path;
       this pins the rule where it is cheap to check. */
    check(
      "the hello handshake advertises the broker's peer id, not a local guess",
      /agentPeerId: selfPeerId\(\)/.test(widgetCode) && !/agentPeerId: AGENT_ID/.test(widgetCode)
    );

    /* ---------- the channel is the developer's decision, not a user control ----------
     * `data-mode` picks the channel at install time and the panel simply BECOMES that channel.
     * A chat/audio/video switcher in the UI would be a regression: if this fails, someone has
     * re-introduced a user-facing preference. Change the channel by editing `data-mode`. */
    group("mode is dev-fixed");
    const switcherScan = async (frame, label) =>
      frame.evaluate(() => {
        const root = document.querySelector("#supportlayer-root").shadowRoot;
        const names = ["chat", "video"];
        const suspects = [];
        root.querySelectorAll("select, [data-mode], [data-channel], [data-seg], .sl-seg, [role=tablist], [role=radiogroup], [role=tab]").forEach((el) => {
          if (el.tagName === "SELECT") {
            const vals = Array.prototype.map.call(el.options, (o) => String(o.value || "").toLowerCase());
            if (names.filter((n) => vals.includes(n)).length >= 2) suspects.push("select:" + vals.join(","));
          } else {
            suspects.push(el.tagName.toLowerCase() + "." + String(el.className || ""));
          }
        });
        // The mode indicator may exist, but it must be inert text, never a control.
        const chip = root.querySelector(".sl-live-mode");
        return {
          suspects,
          chipTag: chip ? chip.tagName.toLowerCase() : null,
          chipText: chip ? chip.textContent.trim() : null,
        };
      });
    const customerSwitcher = await switcherScan(customerFrame);
    check(
      "the customer panel offers no channel switcher",
      customerSwitcher.suspects.length === 0,
      customerSwitcher.suspects.join(" | ") || "clean"
    );
    check(
      "the mode is shown as inert text, not a control",
      customerSwitcher.chipTag === "span" && /video call/i.test(customerSwitcher.chipText || ""),
      JSON.stringify(customerSwitcher)
    );
    const agentSwitcher = await switcherScan(agentFrame);
    check(
      "the agent dock offers no channel switcher",
      agentSwitcher.suspects.length === 0,
      agentSwitcher.suspects.join(" | ") || "clean"
    );


    /* ---------- the dock must not eat its own overlays ---------- */
    group("agent dock clearance");
    await agentFrame.evaluate(() => {
      const sr = document.querySelector("#supportlayer-root").shadowRoot;
      sr.querySelector(".sl-agent-toast").className = "sl-agent-toast sl-show";
    });
    await sleep(300);
    const dockGeom = await agentFrame.evaluate(() => {
      const sr = document.querySelector("#supportlayer-root").shadowRoot;
      const stage = sr.querySelector(".sl-stage");
      const rect = (el) => {
        const b = el.getBoundingClientRect();
        return { top: Math.round(b.top), bottom: Math.round(b.bottom), left: Math.round(b.left), right: Math.round(b.right), h: Math.round(b.height) };
      };
      return {
        dock: rect(sr.querySelector(".sl-dock")),
        hint: rect(sr.querySelector(".sl-agent-hint")),
        toast: rect(sr.querySelector(".sl-agent-toast")),
        declared: stage.style.getPropertyValue("--sl-dock-h"),
        viewportH: window.innerHeight,
      };
    });
    check("the dock publishes its measured height", !!dockGeom.declared, dockGeom.declared || "(unset)");
    check(
      "the coach line clears the dock",
      dockGeom.hint.bottom <= dockGeom.dock.top,
      `hint.bottom=${dockGeom.hint.bottom} dock.top=${dockGeom.dock.top}`
    );
    check(
      "toasts clear the dock",
      dockGeom.toast.bottom <= dockGeom.dock.top,
      `toast.bottom=${dockGeom.toast.bottom} dock.top=${dockGeom.dock.top}`
    );
    check("the dock stays inside the agent stage", dockGeom.dock.bottom <= dockGeom.viewportH, JSON.stringify(dockGeom.dock));

    /* ---------- two-way chat ---------- */
    group("two-way chat");
    await agentFrame.evaluate(() => window.SupportLayer.agent.chat("I can see your checkout — try the pay button again."));
    const customerGotChat = await waitFor(() =>
      customerFrame.evaluate(() => {
        const root = document.querySelector("#supportlayer-root").shadowRoot;
        const box = root.querySelector(".sl-transcript");
        return box.textContent.includes("try the pay button again");
      })
    );
    check("the customer receives agent messages in the panel", customerGotChat);
    eq(
      "the agent transcript keeps its own side of the conversation",
      await agentFrame.evaluate(() => window.SupportLayer.getChat().some((m) => m.from === "me" && m.text.includes("pay button"))),
      true
    );
    await customerFrame.evaluate(() => window.SupportLayer.chat("Still spinning, and the total says $52.06."));
    const agentGotChat = await waitFor(() =>
      agentFrame.evaluate(() => {
        const root = document.querySelector("#supportlayer-root").shadowRoot;
        return root.querySelector(".sl-transcript").textContent.includes("Still spinning");
      })
    );
    check("the agent receives customer messages", agentGotChat);
    const unreadBadge = await agentFrame.evaluate(() => {
      const root = document.querySelector("#supportlayer-root").shadowRoot;
      const badge = root.querySelector(".sl-unread");
      return { hidden: badge.hidden, text: badge.textContent };
    });
    check("an open chat window stays available for incoming messages", unreadBadge.hidden && agentFrame.url().includes("sl_role=agent"), JSON.stringify(unreadBadge));
    const chatOpened = await agentFrame.evaluate(() => {
      const root = document.querySelector("#supportlayer-root").shadowRoot;
      const card = root.querySelector(".sl-card:not(.sl-info-card)");
      return !!card && !card.hidden;
    });
    check("communication remains open after messages arrive", chatOpened);

    /* ---------- coordinate round trip ---------- */
    group("agent control · coordinates");
    const target = await customerFrame.evaluate(async () => {
      const el = document.querySelector("#ssn");
      el.scrollIntoView({ block: "center" });
      await new Promise((r) => setTimeout(r, 250)); // let the scroll settle before measuring
      el.addEventListener("click", () => { window.__ssnClicked = (window.__ssnClicked || 0) + 1; });
      const r = el.getBoundingClientRect();
      return { x: (r.left + r.width / 2) / window.innerWidth, y: (r.top + r.height / 2) / window.innerHeight };
    });
    check("target coordinate is inside the viewport", target.x > 0 && target.x < 1 && target.y > 0 && target.y < 1, JSON.stringify(target));

    // Normalization math must reproduce the coordinates the customer just reported.
    const viewportGeometry = await agentFrame.evaluate(() => {
      const root = document.querySelector("#supportlayer-root").shadowRoot;
      const stage = root.querySelector(".sl-stage").getBoundingClientRect();
      const surface = root.querySelector(".sl-sim.sl-on, .sl-feed.sl-on, .sl-ink").getBoundingClientRect();
      const client = window.SupportLayer.agent.state().client;
      return {
        clientViewport: client && client.viewport,
        stage: { width: stage.width, height: stage.height },
        surface: { width: surface.width, height: surface.height },
      };
    });
    const expectedAspect = viewportGeometry.clientViewport.w / viewportGeometry.clientViewport.h;
    const actualAspect = viewportGeometry.surface.width / viewportGeometry.surface.height;
    check("agent surface uses the customer's viewport ratio", Math.abs(actualAspect - expectedAspect) < 0.01, JSON.stringify(viewportGeometry));
    check("agent surface is scaled inside the available stage", viewportGeometry.surface.width <= viewportGeometry.stage.width + 1 && viewportGeometry.surface.height <= viewportGeometry.stage.height + 1, JSON.stringify(viewportGeometry));

    const normalized = await agentFrame.evaluate((x, y) => {
      const root = document.querySelector("#supportlayer-root").shadowRoot;
      const surface = root.querySelector(".sl-sim.sl-on, .sl-feed.sl-on, .sl-ink");
      const rect = surface.getBoundingClientRect();
      return window.SupportLayer.agent.normalize(rect.left + rect.width * x, rect.top + rect.height * y);
    }, target.x, target.y);
    check("agent normalization round-trips within 1%", Math.abs(normalized.x - target.x) < 0.01 && Math.abs(normalized.y - target.y) < 0.01,
      `want ${target.x.toFixed(3)},${target.y.toFixed(3)} got ${normalized.x.toFixed(3)},${normalized.y.toFixed(3)}`);

    // Point is deliberately non-destructive: spotlight only, no DOM click.
    await agentFrame.evaluate((x, y) => window.SupportLayer.agent.send({ t: "point", x, y, color: "#f59e0b" }), target.x, target.y);
    const pointed = await waitFor(() =>
      customerFrame.evaluate(() => {
        const laser = document.querySelector("#supportlayer-root").shadowRoot.querySelector(".sl-laser");
        return !laser.hidden;
      })
    );
    check("the point tool spotlights without firing a click", pointed && (await customerFrame.evaluate(() => window.__ssnClicked || 0)) === 0);

    await agentFrame.evaluate((x, y) => window.SupportLayer.agent.send({ t: "click", x, y }), target.x, target.y);
    const clicked = await waitFor(() => customerFrame.evaluate(() => window.__ssnClicked > 0), { timeout: 4000 });
    check("remote click fired on the real element", clicked);
    const laser = await customerFrame.evaluate(() => {
      const laser = document.querySelector("#supportlayer-root").shadowRoot.querySelector(".sl-laser");
      return { hidden: laser.hidden, left: parseFloat(laser.style.left), top: parseFloat(laser.style.top), w: window.innerWidth, h: window.innerHeight };
    });
    check("laser pointer is visible at the click point", laser.hidden === false, JSON.stringify(laser));
    check(
      "laser lands within 12px of the requested point",
      Math.abs(laser.left - target.x * laser.w) < 12 && Math.abs(laser.top - target.y * laser.h) < 12,
      `laser ${laser.left},${laser.top} vs target ${(target.x * laser.w).toFixed(0)},${(target.y * laser.h).toFixed(0)}`
    );

    /* ---------- glass-pane drawing ---------- */
    group("agent control · drawing");
    await agentFrame.evaluate(() =>
      window.SupportLayer.agent.send({ t: "draw", start: true, color: "#14b8a6", width: 3, points: [{ x: 0.2, y: 0.2 }, { x: 0.35, y: 0.3 }, { x: 0.5, y: 0.25 }] })
    );
    const drawing = await waitFor(() =>
      customerFrame.evaluate(() => {
        const root = document.querySelector("#supportlayer-root").shadowRoot;
        const canvas = root.querySelector("canvas.sl-draw");
        return canvas.classList.contains("sl-blocking") && !root.querySelector(".sl-draw-hint").hidden;
      })
    );
    check("overlay canvas blocks interaction and shows the hint", drawing);
    const clearedAfterIdle = await waitFor(
      () =>
        customerFrame.evaluate(() => {
          const root = document.querySelector("#supportlayer-root").shadowRoot;
          return !root.querySelector("canvas.sl-draw").classList.contains("sl-blocking");
        }),
      { timeout: 6000 }
    );
    check("strokes clear themselves after 3s of inactivity", clearedAfterIdle);

    /* ---------- directed typing ---------- */
    group("agent control · directed typing");
    await agentFrame.evaluate((x, y) => window.SupportLayer.agent.send({ t: "type", x, y, text: "555-01-9999" }), target.x, target.y);
    const typing = await waitFor(() =>
      customerFrame.evaluate(() => {
        const root = document.querySelector("#supportlayer-root").shadowRoot;
        const tip = root.querySelector(".sl-typing");
        return {
          tipVisible: !tip.hidden,
          tipText: tip.querySelector("textarea") ? tip.querySelector("textarea").value : "",
          value: document.querySelector("#ssn").value,
          highlighted: document.querySelectorAll(".sl-type-target").length,
        };
      })
    );
    check("typing tooltip appeared for the customer", typing && typing.tipVisible);
    eq("tooltip carries the agent's text", typing?.tipText, "555-01-9999");
    eq("value inserted through the native setter", typing?.value, "555-01-9999");
    check("target field is outlined", (typing?.highlighted || 0) > 0);

    /* ---------- state persistence ---------- */
    group("state persistence");
    await customerFrame.evaluate(() => location.reload()).catch(() => {});
    await waitFor(() => customerFrame.evaluate(() => !!(window.SupportLayer && window.SupportLayer.config)), { timeout: 10000 });
    const resumeVisible = await waitFor(() =>
      customerFrame.evaluate(() => {
        const root = document.querySelector("#supportlayer-root").shadowRoot;
        const panel = root.querySelector(".sl-panel");
        return panel.classList.contains("sl-open") && !!panel.querySelector(".sl-view[data-view=resume].sl-active");
      }), { timeout: 6000 });
    check("reload offers the resume prompt instead of silently reconnecting", resumeVisible);
    eq("state is IDLE until the user resumes", await customerFrame.evaluate(() => window.SupportLayer.getState()), "IDLE");
    // Count the widget's own webhook events from inside the frame; the homepage inspector is gone.
    await customerFrame.evaluate(() => {
      window.__events = [];
      window.addEventListener("supportlayer:webhook", (e) => window.__events.push(e.detail && e.detail.event_type));
    });
    await clickIn(page, customerFrame, '.sl-view[data-view=resume] [data-act="resume"]', { frameSelector: "#customer-frame" });
    const resumed = await waitFor(() => customerFrame.evaluate(() => ["WAITING", "CONNECTED"].includes(window.SupportLayer.getState())), { timeout: 6000 });
    check("resuming reopens the session", resumed);
    const updates = await waitFor(
      () => customerFrame.evaluate(() => (window.__events || []).includes("support_update")),
      { timeout: 6000 }
    );
    check("a support_update event was emitted on resume", updates, JSON.stringify(await customerFrame.evaluate(() => window.__events)));
    const rejoined = await waitFor(() => customerFrame.evaluate(() => window.SupportLayer.getState() === "CONNECTED"), { timeout: 8000 });
    check("the agent pane finds the resumed session again", rejoined);

    /* ---------- end session ---------- */
    group("session teardown");
    const endSel = await customerFrame.evaluate(() =>
      window.SupportLayer.getState() === "CONNECTED" ? '.sl-view[data-view=live] [data-act="end"]' : '.sl-view[data-view=waiting] [data-act="end"]'
    );
    await clickIn(page, customerFrame, endSel, { frameSelector: "#customer-frame" });
    const ended = await waitFor(() => customerFrame.evaluate(() => window.SupportLayer.getState() === "IDLE"), { timeout: 6000 });
    check("endSession drops back to IDLE", ended);
    const cleaned = await customerFrame.evaluate(() => ({
      style: !!document.getElementById("supportlayer-privacy-css"),
      wrapped: document.querySelectorAll(".sl-blurred").length,
      stored: localStorage.getItem("supportlayer_session"),
    }));
    check("privacy blur fully removed on teardown", !cleaned.style && cleaned.wrapped === 0);
    check("session storage cleared", !cleaned.stored);

    if (HEADED) {
      await page.screenshot({ path: path.join(SHOT_DIR, "room-headed.png"), fullPage: false });
    } else {
      await page.screenshot({ path: path.join(SHOT_DIR, "room-headless.png"), fullPage: false });
    }

    /* ============================= layout sanity ============================= */
    group("layout sanity (desktop)");
    const layout = await home.evaluate(() => {
      const box = document.querySelector(".box.is-standard");
      const stage = document.querySelector(".stage .frame").getBoundingClientRect();
      const viewport = document.querySelector(".viewport").getBoundingClientRect();
      return {
        overflowX: document.documentElement.scrollWidth - window.innerWidth,
        heroFont: parseFloat(getComputedStyle(document.querySelector(".hero .title")).fontSize),
        sectionPad: parseFloat(getComputedStyle(document.querySelector("#demo")).paddingTop),
        bgPointerEvents: getComputedStyle(document.getElementById("bg-canvas")).pointerEvents,
        faIcons: document.querySelectorAll("svg.svg-inline--fa").length,
        boxRadius: getComputedStyle(box).borderRadius,
        stageW: Math.round(stage.width),
        viewportH: Math.round(viewport.height),
      };
    });
    check("no horizontal overflow on desktop", layout.overflowX <= 1, `overflow=${layout.overflowX}px`);
    check("hero headline is display-sized", layout.heroFont > 40, `${layout.heroFont}px`);
    check("section rhythm is applied", layout.sectionPad > 40, `${layout.sectionPad}px`);
    check("the background layer ignores pointer events", layout.bgPointerEvents === "none", layout.bgPointerEvents);
    check("Font Awesome rendered its icons", layout.faIcons > 5, `${layout.faIcons} svg icons`);
    check("family styling is in effect (Bulma loaded)", layout.boxRadius !== "0px", layout.boxRadius);
    check("the story is a single, centred window", layout.stageW > 600 && layout.stageW <= 800, `${layout.stageW}px`);
    check("the story viewport has real height", layout.viewportH > 300, `${layout.viewportH}px`);

    group("waving-hands background");
    /* Deterministic on any host. Some desktops (including this environment) report
       prefers-reduced-motion, which silences the spawner *by design* — so the motion-allowed
       branch has to be forced, and the page reloaded for the JS guard to re-read the query.
       The reduced branch is asserted separately in its own group. */
    await home.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "no-preference" }]);
    await home.reload({ waitUntil: "domcontentloaded" });
    await waitFor(() => home.evaluate(() => !!document.getElementById("floating-container")));
    /* The spawner also stops in a hidden tab and other pages exist by now, so `home` must be
       frontmost or this samples a deliberately paused animation. */
    await home.bringToFront();
    /* The background is a spawner, not a fixed set of elements: sample it over a few
       seconds so an instant when no hand happens to be up can't read as "broken". */
    const hands = await home.evaluate(async () => {
      const seen = { spawned: 0, peak: 0, sawHand: false, drawn: false, pointerEvents: "" };
      for (let i = 0; i < 34; i++) {
        const slots = document.querySelectorAll(".hand-slot");
        seen.spawned = window.__handsSpawned || 0;
        if (slots.length > seen.peak) seen.peak = slots.length;
        if (slots.length) {
          seen.sawHand = true;
          if (slots[0].querySelector("svg rect")) seen.drawn = true;
          seen.pointerEvents = getComputedStyle(slots[0]).pointerEvents;
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      return seen;
    });
    check("hands pop up in the background over time", hands.spawned >= 2, JSON.stringify(hands));
    check("a spawned hand is actually drawn", hands.drawn, JSON.stringify(hands));
    check("hands fade back out instead of piling up", hands.peak >= 1 && hands.peak <= 8, `peak ${hands.peak} at once`);
    check("background hands never intercept clicks", hands.pointerEvents === "none", hands.pointerEvents);

    group("customer app layout");

    const customerLayout = await customerFrame.evaluate(() => {
      const cols = getComputedStyle(document.querySelector("main")).gridTemplateColumns;
      const pay = document.querySelector("#pay").getBoundingClientRect();
      const fab = document.querySelector("#supportlayer-root").shadowRoot.querySelector(".sl-fab").getBoundingClientRect();
      return {
        columns: cols,
        payVisible: pay.top > 0 && pay.bottom < window.innerHeight,
        fab: { x: Math.round(fab.right), y: Math.round(fab.bottom), w: Math.round(fab.width) },
        inner: { w: window.innerWidth, h: window.innerHeight },
      };
    });
    check("customer app keeps its two-column checkout layout", customerLayout.columns.split(" ").length >= 2, customerLayout.columns);
    check("the failing pay button is above the fold", customerLayout.payVisible);
    check("the widget FAB sits inside the customer viewport", customerLayout.fab.x <= customerLayout.inner.w && customerLayout.fab.y <= customerLayout.inner.h, JSON.stringify(customerLayout.fab));

    const idleOverlays = await customerFrame.evaluate(() => {
      const root = document.querySelector("#supportlayer-root").shadowRoot;
      const visible = [];
      [".sl-draw-hint", ".sl-typing", ".sl-laser", "canvas.sl-draw"].forEach((sel) => {
        const el = root.querySelector(sel);
        if (!el) return;
        const cs = getComputedStyle(el);
        const box = el.getBoundingClientRect();
        if (cs.display !== "none" && cs.visibility !== "hidden" && box.width > 0 && box.height > 0) visible.push(sel + "(" + Math.round(box.width) + "x" + Math.round(box.height) + ")");
      });
      return visible;
    });
    eq("no agent overlay is visible on an idle page", idleOverlays.join(","), "");

    group("layout sanity (mobile)");
    await home.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    await home.reload({ waitUntil: "domcontentloaded" });
    await waitFor(() => home.evaluate(() => !!document.querySelector("#story")));
    await sleep(600);
    const mobile = await home.evaluate(() => ({
      overflowX: document.documentElement.scrollWidth - window.innerWidth,
      heroFont: parseFloat(getComputedStyle(document.querySelector(".hero .title")).fontSize),
      navWrap: getComputedStyle(document.querySelector(".nav-links")).position,
      stageW: Math.round(document.querySelector(".stage .frame").getBoundingClientRect().width),
    }));
    check("no horizontal overflow on mobile", mobile.overflowX <= 1, `overflow=${mobile.overflowX}px`);
    check("hero scales down on mobile", mobile.heroFont < 40 && mobile.heroFont >= 20, `${mobile.heroFont}px`);
    eq("nav links drop into the flow on mobile", mobile.navWrap, "static");
    check("the story window fits the mobile viewport", mobile.stageW > 280 && mobile.stageW <= 390, `${mobile.stageW}px`);
    if (HEADED) await home.screenshot({ path: path.join(SHOT_DIR, "mobile-headed.png") });

    group("background respects reduced motion");
    await home.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
    await home.reload({ waitUntil: "domcontentloaded" });
    await sleep(1800);
    const reduced = await home.evaluate(() => ({
      spawned: window.__handsSpawned || 0,
      slots: document.querySelectorAll(".hand-slot").length,
    }));
    eq("no hands are spawned when motion is reduced", `${reduced.spawned}/${reduced.slots}`, "0/0");
    await home.emulateMediaFeatures([]);

    await home.setViewport({ width: 1600, height: 1000 });

    /* ============================= harness page ============================= */
    const harness = await browser.newPage();
    watch(harness, "test.html");
    await harness.goto(`${BASE}/test.html`, { waitUntil: "domcontentloaded" });
    group("role parameter handling");
    const roleProbe = await browser.newPage();
    watch(roleProbe, "test.html?sl_role=agent");
    await roleProbe.goto(`${BASE}/test.html?sl_role=agent&peer=sl-probe`, { waitUntil: "domcontentloaded" });
    // NB: only `sl_role` is authoritative — a host app's own `role=` is left alone.
    const probed = await waitFor(() => roleProbe.evaluate(() => !!(window.SupportLayer && window.SupportLayer.agent)));
    check("sl_role=agent switches the very same page into the agent view", probed);
    eq("the agent knows which peer it was pointed at", await roleProbe.evaluate(() => window.SupportLayer.agent.state().peer), "sl-probe");
    check(
      "the agent role leaves the host page's privacy alone",
      await roleProbe.evaluate(() => !document.getElementById("supportlayer-privacy-css")),
      "an agent must never redact the page it is looking at"
    );
    await roleProbe.close();

    group("test harness (test.html)");
    const badge = await waitFor(async () => {
      const t = await harness.$eval("#cfg-badge", (el) => el.textContent);
      return t.includes("mode=") ? t : false;
    });
    ok("widget booted with the harness config", badge);
    eq("an unparameterised page is the customer role", await harness.evaluate(() => window.SupportLayer.role), "user");
    eq(
      "there is no agent page to fetch — the link is built from location.href",
      await harness.evaluate(() => window.SupportLayer.config.liveBase),
      null
    );
    check(
      "the host app's own role= param is ignored",
      await harness.evaluate(() => window.SupportLayer.role === "user"),
      "role=agent in the URL would be the host app's, not ours"
    );

    await clickSelector(harness, "#btn-checks");
    await waitFor(async () => (await harness.$$eval(".checks li", (els) => els.length)) > 3);
    const checkRows = await harness.$$eval(".checks li", (els) =>
      els.map((el) => ({ pass: el.classList.contains("pass"), text: el.textContent.trim() }))
    );
    const failed = checkRows.filter((r) => !r.pass);
    check(`${checkRows.length} in-page assertions pass`, failed.length === 0, failed.map((f) => f.text).join(" | "));
    check("privacy round-trip assertion is covered", checkRows.some((r) => r.text.includes("round-trips") && r.pass));

    // Broken data-fields JSON must fall back to the default field.
    await harness.evaluate(() => {
      document.getElementById("f-fields").value = "{ not: valid json ";
    });
    await clickSelector(harness, "#btn-load");
    const fallback = await waitFor(async () => {
      const t = await harness.$eval("#cfg-badge", (el) => el.textContent);
      return t.includes("fields=1") ? t : false;
    }, { timeout: 4000 });
    check("invalid data-fields JSON falls back to one default field", fallback, String(fallback));
    const warned = consoleWarnings.some((e) => e.text.includes("data-fields"));
    check("the fallback is announced as a console warning", warned, JSON.stringify(consoleWarnings.slice(0, 3)));

    // A non-headless widget shows the FAB; headless hides it.
    await harness.evaluate(() => { document.getElementById("f-fields").value = '[{"name":"issue","type":"textarea","label":"Issue"}]'; document.getElementById("f-headless").checked = true; });
    await clickSelector(harness, "#btn-load");
    const fabHidden = await waitFor(() =>
      harness.evaluate(() => {
        const root = document.querySelector("#supportlayer-root");
        const fab = root && root.shadowRoot && root.shadowRoot.querySelector(".sl-fab");
        return !!(fab && fab.hidden);
      })
    );
    check("data-headless hides the floating button", fabHidden);

    /* ============================= agent role discovered by the bus ============================= */
    group("agent role (standalone)");
    const standalone = await browser.newPage();
    watch(standalone, "agent-role");
    await standalone.goto(`${BASE}/demo-app.html?sl_role=agent&sl-demo=1`, { waitUntil: "domcontentloaded" });
    const standaloneOk = await waitFor(() => standalone.evaluate(() => !!(window.SupportLayer && window.SupportLayer.agent)), { timeout: 5000 });
    check("a page with ?sl_role=agent boots the agent view", standaloneOk);
    const standaloneShell = await standalone.evaluate(() => {
      const root = document.querySelector("#supportlayer-root").shadowRoot;
      const agentEl = root.querySelector(".sl-agent").getBoundingClientRect();
      const pageHeading = document.querySelector("h1").getBoundingClientRect();
      return {
        coversViewport: Math.round(agentEl.width) >= window.innerWidth && Math.round(agentEl.height) >= window.innerHeight,
        coversTheApp: agentEl.top <= pageHeading.top,
        waiting: /Waiting/.test(root.querySelector(".sl-badge").textContent),
        noFab: !root.querySelector(".sl-fab"),
      };
    });
    check("the agent view covers the host app instead of sitting on it", standaloneShell.coversViewport && standaloneShell.coversTheApp, JSON.stringify(standaloneShell));
    check("with no customer it waits, and never shows the request button", standaloneShell.waiting && standaloneShell.noFab, JSON.stringify(standaloneShell));
    if (HEADED) await standalone.screenshot({ path: path.join(SHOT_DIR, "agent-headed.png") });
    await standalone.close();

    /* ============================= interactive single-file demo =============================
     * `demo.html` is the handoff experience a developer can open directly: the customer submits
     * a real widget request, the simulated webhook becomes a support notification, and opening its
     * link loads the same document in the agent role in a second tab. */
    group("interactive demo handoff");
    const demoCustomer = await browser.newPage();
    const demoAgent = await browser.newPage();
    watch(demoCustomer, "demo-customer");
    watch(demoAgent, "demo-agent");
    await demoCustomer.goto(`${BASE}/demo.html`, { waitUntil: "domcontentloaded" });
    const demoBooted = await waitFor(() => demoCustomer.evaluate(() => !!window.SupportLayer && window.SupportLayer.role === "user"));
    check("demo.html boots as the customer experience", demoBooted);
    check("demo page has one customer document and no embedded room", await demoCustomer.evaluate(() => document.querySelectorAll("iframe").length === 0));
    await demoCustomer.evaluate(() => window.SupportLayer.reset());
    await clickSelector(demoCustomer, "#help");
    await waitFor(() => demoCustomer.evaluate(() => document.querySelector("#supportlayer-root").shadowRoot.querySelector(".sl-panel.sl-open")));
    const demoForm = await demoCustomer.evaluate(() => {
      const root = document.querySelector("#supportlayer-root").shadowRoot;
      return { name: !!root.querySelector("#sl-field-name"), issue: !!root.querySelector("#sl-field-issue"), severity: !!root.querySelector("#sl-field-severity") };
    });
    check("demo request form exposes ticket fields", demoForm.name && demoForm.issue && demoForm.severity, JSON.stringify(demoForm));
    await clickIn(demoCustomer, demoCustomer, "#sl-field-name");
    await demoCustomer.keyboard.type("Demo Developer");
    await clickIn(demoCustomer, demoCustomer, "#sl-field-issue");
    await demoCustomer.keyboard.type("The checkout button keeps timing out.");
    await clickIn(demoCustomer, demoCustomer, "#sl-field-severity");
    await demoCustomer.keyboard.type("Blocking my checkout");
    await clickIn(demoCustomer, demoCustomer, "button[type=submit]");
    const notification = await waitFor(() => demoCustomer.evaluate(() => {
      const toast = document.querySelector("#ticket-toast");
      return toast && toast.classList.contains("show") && !!document.querySelector("#open-agent");
    }), { timeout: 10000 });
    check("the simulated webhook becomes a support notification", notification);
    const ticket = await demoCustomer.evaluate(() => JSON.parse(localStorage.getItem("supportlayer_demo_ticket") || "null"));
    check("notification stores a customer ticket and agent URL", !!ticket && ticket.name === "Demo Developer" && /demo\.html\?/.test(ticket.url || ""), JSON.stringify(ticket));
    check("agent URL uses the same demo document and agent role", /sl_role=agent/.test(ticket?.url || "") && /sl-demo=1/.test(ticket?.url || ""), ticket?.url || "");
    await demoAgent.goto(ticket.url, { waitUntil: "domcontentloaded" });
    const agentBooted = await waitFor(() => demoAgent.evaluate(() => !!window.SupportLayer && window.SupportLayer.role === "agent"));
    check("opening the handoff URL boots the agent role", agentBooted);
    const agentSurface = await demoAgent.evaluate(() => {
      const root = document.querySelector("#supportlayer-root").shadowRoot;
      const chat = root.querySelector(".sl-card:not(.sl-info-card)");
      return { hiddenCustomerShell: document.getElementById("customer-shell").hidden, chatOpen: !!chat && !chat.hidden, hasContextCard: !!document.querySelector(".agent-ticket") };
    });
    check("agent tab shows only communication and tools", agentSurface.hiddenCustomerShell && agentSurface.chatOpen && !agentSurface.hasContextCard, JSON.stringify(agentSurface));
    const demoConnected = await waitFor(() => demoAgent.evaluate(() => window.SupportLayer.agent && window.SupportLayer.agent.state().connected), { timeout: 12000 });
    check("agent tab connects to the customer over the demo transport", demoConnected);
    const demoCustomerConnected = await waitFor(() => demoCustomer.evaluate(() => window.SupportLayer.getState() === "CONNECTED"), { timeout: 8000 });
    check("customer status stays synchronized with the agent connection", demoCustomerConnected);
    const agentFeed = await demoAgent.evaluate(() => window.SupportLayer.agent.state().feed);
    check("agent tab displays the simulated customer screen", agentFeed);
    await demoAgent.evaluate(() => window.SupportLayer.agent.chat("I can see the checkout timeout. I’m pointing at the payment area now."));
    const customerChat = await waitFor(() => demoCustomer.evaluate(() => window.SupportLayer.getChat().some((message) => message.text.includes("payment area"))));
    check("agent chat arrives in the customer tab in realtime", customerChat);
    await demoCustomer.close();
    await demoAgent.close();

    /* ============================= CDN delivery =============================
     * The quick-start snippet loads the widget from jsDelivr, which serves `.html` as
     * text/plain — the old architecture pointed at a broken agent URL because of it.
     * There is no second file to fetch any more, which this asserts. */
    group("CDN delivery");
    const cdnPage = await browser.newPage();
    watch(cdnPage, "cdn");
    const widgetSource = readFileSync(path.join(ROOT, "supportlayer.js"), "utf8");
    await cdnPage.setRequestInterception(true);
    cdnPage.on("request", (req) => {
      if (req.url().includes("jsdelivr.net") && req.url().endsWith("supportlayer.js")) {
        req.respond({ status: 200, contentType: "application/javascript", body: widgetSource });
      } else {
        req.continue();
      }
    });
    await cdnPage.setContent(
      `<!doctype html><html><body><script src="https://cdn.jsdelivr.net/gh/Spuds0588/SupportLayer@main/supportlayer.js" data-webhook="https://hooks.example.com/x" data-mode="none"></script></body></html>`,
      { waitUntil: "domcontentloaded" }
    );
    const cdnReady = await waitFor(() => cdnPage.evaluate(() => !!(window.SupportLayer && window.SupportLayer.config)), { timeout: 6000 });
    check("widget boots when loaded from a static-file CDN", cdnReady);
    eq("a CDN copy is still the customer role", cdnReady ? await cdnPage.evaluate(() => window.SupportLayer.role) : null, "user");
    check(
      "there is no second document to serve — the widget never links to one",
      !/agent\.html/.test(widgetSource),
      "an agent.html reference crept back into the widget"
    );
    await cdnPage.close();

    /* ============================= mode matrix =============================
     * `data-mode` is the developer's single switch, fixed at install time. Each mode must
     * shape the request panel itself — copy and controls — with no user-facing switcher. */
    group("mode matrix");
    const MODE_SPEC = {
      none: { head: "Send a report", button: "Send report", blurb: /snapshot/i, shareNote: false },
      chat: { head: "Start a live session", button: "Start session", blurb: /chat live/i, shareNote: true },
      video: { head: "Start a live session", button: "Start session", blurb: /two-way video call/i, shareNote: true },
    };
    for (const mode of Object.keys(MODE_SPEC)) {
      const spec = MODE_SPEC[mode];
      const modePage = await browser.newPage();
      watch(modePage, `mode=${mode}`);
      await modePage.setContent(
        `<!doctype html><html><body><script src="${BASE}/supportlayer.js" data-webhook="" data-mode="${mode}" data-demo="true"></script></body></html>`,
        { waitUntil: "domcontentloaded" }
      );
      const modeBooted = await waitFor(() => modePage.evaluate(() => !!(window.SupportLayer && window.SupportLayer.config)), { timeout: 6000 });
      eq(`data-mode="${mode}" is honoured`, modeBooted ? await modePage.evaluate(() => window.SupportLayer.config.mode) : null, mode);
      const form = await modePage.evaluate(() => {
        const root = document.querySelector("#supportlayer-root").shadowRoot;
        const v = root.querySelector(".sl-view[data-view=form]");
        const names = ["chat", "video"];
        const switchers = [];
        root.querySelectorAll("select, [data-seg], [role=tablist], [role=radiogroup]").forEach((el) => {
          if (el.tagName === "SELECT") {
            const vals = Array.prototype.map.call(el.options, (o) => String(o.value || "").toLowerCase());
            if (names.filter((n) => vals.includes(n)).length >= 2) switchers.push("select");
          } else switchers.push(el.tagName.toLowerCase());
        });
        return {
          head: v.querySelector("h3").textContent.trim(),
          button: v.querySelector("button[type=submit]").textContent.trim(),
          blurb: v.querySelector("p").textContent.trim(),
          shareNote: (v.querySelector(".sl-note") || {}).textContent || "",
          switchers,
        };
      });
      eq(`mode=${mode}: request panel heading`, form.head, spec.head);
      eq(`mode=${mode}: submit button label`, form.button, spec.button);
      check(`mode=${mode}: the panel describes that channel`, spec.blurb.test(form.blurb), form.blurb);
      check(`mode=${mode}: no channel switcher in the panel`, form.switchers.length === 0, form.switchers.join(",") || "clean");
      // The share contract has to be stated before the customer consents, not after.
      check(
        `mode=${mode}: the screen-share contract is ${spec.shareNote ? "stated up front" : "absent"}`,
        spec.shareNote === /shared with the agent for the whole session/i.test(form.shareNote),
        form.shareNote.slice(0, 120)
      );
      await modePage.close();
    }

    /* ------------------------ retired: the voice-only mode ------------------------
     * `audio` was a third live mode. `video` already carries two-way audio, so the third mode
     * bought a UI branch and no capability. An existing tag must keep working — its author
     * asked for a call, and they still get one — but `audio` is not a mode any more. */
    group("audio mode is retired");
    const legacyPage = await browser.newPage();
    watch(legacyPage, "mode=audio");
    await legacyPage.setContent(
      `<!doctype html><html><body><script src="${BASE}/supportlayer.js" data-webhook="" data-mode="audio" data-demo="true"></script></body></html>`,
      { waitUntil: "domcontentloaded" }
    );
    const legacyBooted = await waitFor(() => legacyPage.evaluate(() => !!(window.SupportLayer && window.SupportLayer.config)), { timeout: 6000 });
    eq(
      'data-mode="audio" still buys a live call',
      legacyBooted ? await legacyPage.evaluate(() => window.SupportLayer.config.mode) : null,
      "video"
    );
    check(
      "the alias is announced rather than applied silently",
      consoleWarnings.some((e) => /no longer a mode/.test(e.text)),
      JSON.stringify(consoleWarnings.slice(0, 3))
    );
    eq(
      "MODES no longer lists audio",
      await legacyPage.evaluate(() => window.SupportLayer.config.mode === "audio"),
      false
    );
    await legacyPage.close();

    /* ============================= console hygiene ============================= */
    group("console hygiene");
    const origin = BASE;
    const ownErrors = consoleErrors.filter((e) => (e.url || "").startsWith(origin) || (e.text || "").includes("supportlayer") || (e.text || "").includes("agent.html"));
    // The intentional "invalid data-fields" warning is expected exactly once.
    const unexpected = ownErrors.filter((e) => !e.text.includes("data-fields"));
    check("no unexpected console errors from SupportLayer pages", unexpected.length === 0, JSON.stringify(unexpected.slice(0, 4)));
    // Browser noise (parser-blocking document.write, autoplay policy) is not ours to police;
    // what matters is that the widget only warns about the things it documents.
    const ownWarnings = consoleWarnings.filter((e) => e.text.includes("[SupportLayer]"));
    const unexpectedWarnings = ownWarnings.filter((e) => !e.text.includes("data-fields") && !/no longer a mode/.test(e.text));
    check(
      "the only SupportLayer-authored warnings are the documented ones",
      unexpectedWarnings.length === 0,
      JSON.stringify(unexpectedWarnings.slice(0, 4))
    );
    check("no uncaught page errors", pageErrors.length === 0, JSON.stringify(pageErrors.slice(0, 4)));

    const ownFailedRequests = failedRequests.filter((r) => r.url.startsWith(origin));
    check("no failed requests for our own assets", ownFailedRequests.length === 0, JSON.stringify(ownFailedRequests.slice(0, 4)));

    const offsiteFailures = failedRequests.filter((r) => !r.url.startsWith(origin));
    if (offsiteFailures.length) {
      console.log(`  \x1b[90m· ${offsiteFailures.length} off-site request(s) failed (CDN/offline) — not counted\x1b[0m`);
    }
  } finally {
    await browser.close().catch(() => {});
    server.kill();
  }

  const failures = results.filter((r) => !r.ok);
  console.log(`\n\x1b[1m${results.length - failures.length}/${results.length} checks passed\x1b[0m`);
  if (failures.length) {
    console.log("\x1b[31mFailed:\x1b[0m");
    for (const f of failures) console.log(`  · [${f.group}] ${f.name} — ${f.detail}`);
    process.exitCode = 1;
  }
  if (!HEADED) console.log(`\x1b[90mscreenshots: screenshots/landing-headless.png\x1b[0m`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
