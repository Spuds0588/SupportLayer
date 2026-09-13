/**
 * SupportLayer end-to-end suite.
 *
 *   node tests/e2e.mjs            # headless (new headless Chrome)
 *   node tests/e2e.mjs --headed   # visible window, real rendering + real mouse input
 *
 * Boots serve.js on a free port, drives index.html's simulated demo (customer frame +
 * agent console frame + webhook inspector) and test.html's in-page assertions, then
 * reports every failure with the reason instead of stopping at the first one.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import puppeteer from "puppeteer-core";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const HEADED = process.argv.includes("--headed");
const ENV_PORT = Number(process.env.PORT); // some shells export PORT=0, which means "unset"
const PORT = Number.isInteger(ENV_PORT) && ENV_PORT > 0 && ENV_PORT < 65536 ? ENV_PORT : 4181 + (HEADED ? 1 : 0);
const BASE = `http://127.0.0.1:${PORT}`;
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

async function frameOf(page, name) {
  for (const f of page.frames()) {
    if (f.name() === name) return f;
  }
  return page.frames().find((f) => f.url().includes(name));
}

/** Click a real element inside the widget's shadow DOM with a trusted mouse event. */
async function trustedShadowClick(frame, innerSelector, hostSelector = "#supportlayer-root") {
  const handle = await frame.evaluateHandle(
    (host, sel) => {
      const root = document.querySelector(host);
      return root && root.shadowRoot ? root.shadowRoot.querySelector(sel) : null;
    },
    hostSelector,
    innerSelector
  );
  const element = handle.asElement();
  if (!element) {
    fail(`shadow element not found: ${innerSelector}`);
    return false;
  }
  try {
    await element.click();
    return true;
  } catch (e) {
    fail(`could not click ${innerSelector}`, e.message);
    return false;
  }
}

/* ------------------------------------------------------------------ *
 * main
 * ------------------------------------------------------------------ */
async function main() {
  if (!existsSync(SHOT_DIR)) mkdirSync(SHOT_DIR, { recursive: true });

  const server = spawn(process.execPath, ["serve.js"], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.on("data", () => {});
  server.stderr.on("data", (d) => process.stderr.write(`[serve] ${d}`));

  const up = await waitFor(async () => {
    const res = await fetch(`${BASE}/index.html`, { method: "GET" });
    return res.ok;
  }, { timeout: 8000, interval: 150 });
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

  console.log(`\x1b[1mSupportLayer e2e\x1b[0m  ${HEADED ? "HEATED" : "headless"} · ${executablePath} · ${BASE}`);

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
    /* ============================= landing page demo ============================= */
    const page = await browser.newPage();
    watch(page, "index");
    await page.goto(`${BASE}/index.html`, { waitUntil: "domcontentloaded" });

    group("landing page");
    check("page title mentions SupportLayer", (await page.title()).includes("SupportLayer"));
    const customerFrame = await page.waitForFrame((f) => f.url().includes("demo-app.html"), { timeout: 10000 });
    const agentFrame = await page.waitForFrame((f) => f.url().includes("agent.html"), { timeout: 10000 });
    check("customer demo frame loaded", !!customerFrame);
    check("agent console frame loaded", !!agentFrame);

    const widgetReady = await waitFor(() => customerFrame.evaluate(() => !!(window.SupportLayer && window.SupportLayer.config)));
    check("widget booted inside the customer frame", widgetReady);

    const cfg = await customerFrame.evaluate(() => {
      const c = window.SupportLayer.config;
      return { mode: c.mode, demo: c.demo, theme: c.theme, fields: c.fields.length, webhook: c.webhook, headless: c.headless };
    });
    eq("demo mode is active", cfg.demo, true);
    eq("mode parsed from the script tag", cfg.mode, "chat");
    eq("theme parsed from the script tag", cfg.theme, "#14b8a6");
    eq("three form fields parsed from JSON", cfg.fields, 3);
    eq("webhook URL parsed", cfg.webhook, "https://hooks.example.com/supportlayer/demo");
    eq("customer starts IDLE", await customerFrame.evaluate(() => window.SupportLayer.getState()), "IDLE");

    const agentSeam = await agentFrame.evaluate(() => {
      const s = window.__AgentConsole && window.__AgentConsole.state();
      return s ? { demo: s.demo, connected: s.connected } : null;
    });
    check("agent console exposes its test seam", !!agentSeam);
    eq("agent console is in demo mode", agentSeam?.demo, true);
    eq("agent console starts disconnected", agentSeam?.connected, false);

    /* ---------- open the widget ---------- */
    group("request flow");
    await page.click("#btn-widget");
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
    const shadowHandle = (selector) =>
      customerFrame.evaluateHandle(
        (sel) => document.querySelector("#supportlayer-root").shadowRoot.querySelector(sel),
        selector
      );
    const nameHandle = await shadowHandle("#sl-field-name");
    await nameHandle.asElement().click();
    await page.keyboard.type("Jane Doe");
    const issueHandle = await shadowHandle("#sl-field-issue");
    await issueHandle.asElement().click();
    await page.keyboard.type("The Complete purchase button spins forever.");

    const typed = await customerFrame.evaluate(() => {
      const root = document.querySelector("#supportlayer-root").shadowRoot;
      return { name: root.querySelector("#sl-field-name").value, issue: root.querySelector("#sl-field-issue").value };
    });
    eq("typed into the shadow form (real keyboard)", typed.name, "Jane Doe");
    check("textarea captured the issue", typed.issue.includes("spins forever"));

    const submitBtn = await shadowHandle("button[type=submit]");
    const submitBox = await submitBtn.asElement().boundingBox();
    check("submit button is inside the visible frame", !!submitBox && submitBox.width > 10, JSON.stringify(submitBox));
    await submitBtn.asElement().click();

    const delivered = await waitFor(async () => {
      const chip = await page.$eval("#chip-events b", (el) => Number(el.textContent));
      return chip > 0;
    }, { timeout: 10000 });
    check("webhook payload reached the inspector", delivered);

    const payload = await page.evaluate(() => {
      const text = document.querySelector("#payload").textContent.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
      const parsed = JSON.parse(text);
      return { parsed, snapshotSrc: document.querySelector("#snapshot-img").src.slice(0, 30), snapshotVisible: document.querySelector("#snapshot-img").classList.contains("show") };
    });
    eq("event_type is support_request", payload.parsed.event_type, "support_request");
    eq("status is open", payload.parsed.status, "open");
    eq("mode carried into the payload", payload.parsed.mode, "chat");
    eq("user_data carries the typed answers", payload.parsed.user_data.name, "Jane Doe");
    check("session_id looks like a uuid", /^[0-9a-f-]{20,}$/.test(payload.parsed.session_id), payload.parsed.session_id);
    check("diagnostics carry the frame viewport", /^\d+x\d+$/.test(payload.parsed.diagnostics.viewport), payload.parsed.diagnostics.viewport);
    check("diagnostics carry url + browser + timestamp", !!(payload.parsed.diagnostics.url && payload.parsed.diagnostics.browser && payload.parsed.diagnostics.timestamp));
    check("live_session_url points at agent.html with a peer id", /agent\.html\?peer=sl-/.test(payload.parsed.live_session_url || ""), payload.parsed.live_session_url);
    check("snapshot is a JPEG data URL", payload.snapshotSrc.startsWith("data:image/jpeg"), payload.snapshotSrc);
    check("snapshot preview is shown in the inspector", payload.snapshotVisible);

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
    const connected = await waitFor(async () => (await page.$eval("#chip-agent b", (el) => el.textContent)) === "connected", { timeout: 12000 });
    check("agent console joined the session", connected);
    const customerState = await customerFrame.evaluate(() => window.SupportLayer.getState());
    eq("customer state is CONNECTED", customerState, "CONNECTED");
    const agentKnowsClient = await agentFrame.evaluate(() => {
      const s = window.__AgentConsole.state();
      return { url: s.client && s.client.url, mode: s.client && s.client.mode, viewport: s.client && s.client.viewport };
    });
    check("agent received the client metadata handshake", !!agentKnowsClient.url, JSON.stringify(agentKnowsClient));
    eq("agent knows the client mode", agentKnowsClient.mode, "chat");

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
    const normalized = await agentFrame.evaluate((x, y) => {
      const rect = document.getElementById("stage").getBoundingClientRect();
      const p = window.__AgentConsole.normalize(rect.left + rect.width * x, rect.top + rect.height * y);
      return p;
    }, target.x, target.y);
    check("agent normalization round-trips within 1%", Math.abs(normalized.x - target.x) < 0.01 && Math.abs(normalized.y - target.y) < 0.01,
      `want ${target.x.toFixed(3)},${target.y.toFixed(3)} got ${normalized.x.toFixed(3)},${normalized.y.toFixed(3)}`);

    await agentFrame.evaluate((x, y) => window.__AgentConsole.send({ t: "click", x, y }), target.x, target.y);
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
      window.__AgentConsole.send({ t: "draw", start: true, color: "#14b8a6", width: 3, points: [{ x: 0.2, y: 0.2 }, { x: 0.35, y: 0.3 }, { x: 0.5, y: 0.25 }] })
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
    await agentFrame.evaluate((x, y) => window.__AgentConsole.send({ t: "type", x, y, text: "555-01-9999" }), target.x, target.y);
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
    await page.click("#btn-reload");
    await waitFor(() => customerFrame.evaluate(() => !!(window.SupportLayer && window.SupportLayer.config)), { timeout: 10000 });
    const resumeVisible = await waitFor(() =>
      customerFrame.evaluate(() => {
        const root = document.querySelector("#supportlayer-root").shadowRoot;
        const panel = root.querySelector(".sl-panel");
        return panel.classList.contains("sl-open") && !!panel.querySelector(".sl-view[data-view=resume].sl-active");
      }), { timeout: 6000 });
    check("reload offers the resume prompt instead of silently reconnecting", resumeVisible);
    eq("state is IDLE until the user resumes", await customerFrame.evaluate(() => window.SupportLayer.getState()), "IDLE");
    await trustedShadowClick(customerFrame, '.sl-view[data-view=resume] [data-act="resume"]');
    const resumed = await waitFor(() => customerFrame.evaluate(() => window.SupportLayer.getState() === "WAITING"), { timeout: 6000 });
    check("resuming moves the state to WAITING", resumed);
    const updates = await waitFor(async () => (await page.$eval("#chip-events b", (el) => Number(el.textContent))) >= 2, { timeout: 6000 });
    check("a support_update event was emitted on resume", updates);

    /* ---------- end session ---------- */
    group("session teardown");
    await trustedShadowClick(customerFrame, '.sl-view[data-view=waiting] [data-act="end"]');
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
      await page.screenshot({ path: path.join(SHOT_DIR, "landing-headed.png"), fullPage: false });
    } else {
      await page.screenshot({ path: path.join(SHOT_DIR, "landing-headless.png"), fullPage: false });
    }

    /* ============================= layout sanity ============================= */
    group("layout sanity (desktop)");
    const layout = await page.evaluate(() => {
      const box = document.querySelector(".box.is-standard");
      const frame = document.querySelector("#customer-frame").getBoundingClientRect();
      const agentFrameEl = document.querySelector("#agent-frame").getBoundingClientRect();
      return {
        overflowX: document.documentElement.scrollWidth - window.innerWidth,
        heroFont: parseFloat(getComputedStyle(document.querySelector(".hero .title")).fontSize),
        sectionPad: parseFloat(getComputedStyle(document.querySelector("#demo")).paddingTop),
        floatingIcons: document.querySelectorAll(".floating-svg").length,
        faIcons: document.querySelectorAll("svg.svg-inline--fa").length,
        boxRadius: getComputedStyle(box).borderRadius,
        customerFrame: { w: Math.round(frame.width), h: Math.round(frame.height) },
        agentFrame: { w: Math.round(agentFrameEl.width), h: Math.round(agentFrameEl.height) },
        payloadFont: getComputedStyle(document.querySelector("#payload")).fontSize,
      };
    });
    check("no horizontal overflow on desktop", layout.overflowX <= 1, `overflow=${layout.overflowX}px`);
    check("hero headline is display-sized", layout.heroFont > 40, `${layout.heroFont}px`);
    check("section rhythm is applied", layout.sectionPad > 40, `${layout.sectionPad}px`);
    check("floating background icons were generated", layout.floatingIcons > 5, `${layout.floatingIcons}`);
    check("Font Awesome rendered its icons", layout.faIcons > 5, `${layout.faIcons} svg icons`);
    check("family styling is in effect (Bulma loaded)", layout.boxRadius !== "0px", layout.boxRadius);
    check("customer frame is a usable width", layout.customerFrame.w > 900 && layout.customerFrame.h >= 600, JSON.stringify(layout.customerFrame));
    check("agent frame is a usable width", layout.agentFrame.w > 400, JSON.stringify(layout.agentFrame));

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
    await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    await page.reload({ waitUntil: "domcontentloaded" });
    await waitFor(() => page.evaluate(() => !!document.querySelector("#customer-frame")));
    await sleep(600);
    const mobile = await page.evaluate(() => ({
      overflowX: document.documentElement.scrollWidth - window.innerWidth,
      heroFont: parseFloat(getComputedStyle(document.querySelector(".hero .title")).fontSize),
      navWrap: getComputedStyle(document.querySelector(".nav-links")).position,
      frameW: Math.round(document.querySelector("#customer-frame").getBoundingClientRect().width),
    }));
    check("no horizontal overflow on mobile", mobile.overflowX <= 1, `overflow=${mobile.overflowX}px`);
    check("hero scales down on mobile", mobile.heroFont < 40 && mobile.heroFont >= 20, `${mobile.heroFont}px`);
    eq("nav links drop into the flow on mobile", mobile.navWrap, "static");
    check("customer frame fits the mobile viewport", mobile.frameW > 300 && mobile.frameW <= 390, `${mobile.frameW}px`);
    if (HEADED) await page.screenshot({ path: path.join(SHOT_DIR, "mobile-headed.png") });
    await page.setViewport({ width: 1600, height: 1000 });

    /* ============================= harness page ============================= */
    const harness = await browser.newPage();
    watch(harness, "test.html");
    await harness.goto(`${BASE}/test.html`, { waitUntil: "domcontentloaded" });
    group("test harness (test.html)");

    const badge = await waitFor(async () => {
      const t = await harness.$eval("#cfg-badge", (el) => el.textContent);
      return t.includes("mode=") ? t : false;
    });
    ok("widget booted with the harness config", badge);

    await harness.click("#btn-checks");
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
    await harness.click("#btn-load");
    const fallback = await waitFor(async () => {
      const t = await harness.$eval("#cfg-badge", (el) => el.textContent);
      return t.includes("fields=1") ? t : false;
    }, { timeout: 4000 });
    check("invalid data-fields JSON falls back to one default field", fallback, String(fallback));
    const warned = consoleWarnings.some((e) => e.text.includes("data-fields"));
    check("the fallback is announced as a console warning", warned, JSON.stringify(consoleWarnings.slice(0, 3)));

    // A non-headless widget shows the FAB; headless hides it.
    await harness.evaluate(() => { document.getElementById("f-fields").value = '[{"name":"issue","type":"textarea","label":"Issue"}]'; document.getElementById("f-headless").checked = true; });
    await harness.click("#btn-load");
    const fabHidden = await waitFor(() =>
      harness.evaluate(() => {
        const root = document.querySelector("#supportlayer-root");
        const fab = root && root.shadowRoot && root.shadowRoot.querySelector(".sl-fab");
        return !!(fab && fab.hidden);
      })
    );
    check("data-headless hides the floating button", fabHidden);

    /* ============================= agent.html standalone ============================= */
    const standalone = await browser.newPage();
    watch(standalone, "agent-standalone");
    await standalone.goto(`${BASE}/agent.html?peer=sl-does-not-exist`, { waitUntil: "domcontentloaded" });
    const agentTitle = await standalone.title();
    check("agent console renders standalone", agentTitle.includes("SupportLayer"));
    const standaloneOk = await waitFor(() => standalone.evaluate(() => !!window.__AgentConsole), { timeout: 5000 });
    check("agent console boots with a peer target", standaloneOk);
    if (HEADED) await standalone.screenshot({ path: path.join(SHOT_DIR, "agent-headed.png") });

    /* ============================= console hygiene ============================= */
    group("console hygiene");
    const origin = BASE;
    const ownErrors = consoleErrors.filter((e) => (e.url || "").startsWith(origin) || (e.text || "").includes("supportlayer") || (e.text || "").includes("agent.html"));
    // The intentional "invalid data-fields" warning is expected exactly once.
    const unexpected = ownErrors.filter((e) => !e.text.includes("data-fields"));
    check("no unexpected console errors from SupportLayer pages", unexpected.length === 0, JSON.stringify(unexpected.slice(0, 4)));
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
