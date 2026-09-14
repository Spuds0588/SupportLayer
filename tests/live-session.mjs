/**
 * A REAL support session — no `data-demo`, no loopback bus, no synthetic frames.
 *
 *   node tests/live-session.mjs            # open a session, print the agent URL, stay open
 *   node tests/live-session.mjs --check    # dial it with a second headless peer, verify, then exit
 *   node tests/live-session.mjs --headed   # visible customer window, next to your own agent window
 *
 * Why this is separate from `tests/e2e.mjs`: the suite runs the product over the loopback
 * transport, which is honest about widget logic but never touches PeerJS signalling, the
 * `getDisplayMedia` permission flow, or a real media track. This script exercises exactly those
 * three — customer in a real browser, agent wherever it gets opened — and is the only check of the
 * path a real integrator actually ships.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import puppeteer from "puppeteer-core";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const HEADED = process.argv.includes("--headed");
const CHECK = process.argv.includes("--check");
const PORT = 4231 + (HEADED ? 1 : 0);
const BASE = `http://127.0.0.1:${PORT}`;

function findChrome() {
  return [
    process.env.CHROME_PATH,
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  ].filter(Boolean).find((p) => existsSync(p));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, { timeout = 20000, interval = 250, label = "condition" } = {}) {
  const until = Date.now() + timeout;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) throw new Error(`timed out waiting for ${label}`);
    await sleep(interval);
  }
}

/* ------------------------------------------------------------------ *
 * the customer side
 * ------------------------------------------------------------------ */
async function openCustomer(browser) {
  const page = await browser.newPage();
  page.on("pageerror", (e) => console.log("  customer pageerror:", e.message));
  page.on("requestfailed", (r) => {
    if (!r.url().includes("peerjs")) console.log("  customer requestfailed:", r.url());
  });

  // `sl-demo=0` is what turns the demo fixture into a real session: real capture, real PeerJS.
  await page.goto(`${BASE}/demo-app.html?sl-demo=0`, { waitUntil: "domcontentloaded" });
  await waitFor(() => page.evaluate(() => !!window.SupportLayer), { label: "widget boot" });

  const cfg = await page.evaluate(() => ({
    mode: window.SupportLayer.config.mode,
    demo: window.SupportLayer.config.demo,
    role: window.SupportLayer.role,
  }));
  console.log("customer:", JSON.stringify(cfg));
  if (cfg.demo) throw new Error("the customer page booted in demo mode — this script exists to avoid that");

  const boxIn = async (sel) => {
    const h = await page.evaluateHandle((s) => document.querySelector("#supportlayer-root").shadowRoot.querySelector(s), sel);
    const b = await h.boundingBox();
    await h.dispose();
    return b;
  };
  const clickIn = async (sel) => {
    const b = await boxIn(sel);
    await page.mouse.click(Math.round(b.x + b.width / 2), Math.round(b.y + b.height / 2));
  };

  await clickIn(".sl-fab");
  await sleep(300);
  await page.evaluate(() => {
    const sr = document.querySelector("#supportlayer-root").shadowRoot;
    const set = (name, value) => {
      const el = sr.querySelector(`[name=${name}]`);
      if (!el) return;
      el.value = value;
      el.dispatchEvent(new Event("input", { bubbles: true }));
    };
    set("name", "Dana Reyes");
    set("issue", "Complete purchase spins forever and the total never settles.");
  });

  // A real mouse click — the widget refuses synthetic ones on purpose, and `getDisplayMedia` needs
  // the transient activation that only a trusted click provides.
  await clickIn(".sl-view[data-view=form] button[type=submit]");

  const liveUrl = await waitFor(() => page.evaluate(() => window.SupportLayer.getSession() && window.SupportLayer.getSession().liveUrl), {
    timeout: 25000,
    label: "peer registration + live_session_url",
  });
  return { page, liveUrl };
}

/* ------------------------------------------------------------------ *
 * the self-check: dial the session with a second peer
 * ------------------------------------------------------------------ */
async function selfCheck(browser, liveUrl) {
  const agent = await browser.newPage();
  agent.on("pageerror", (e) => console.log("  agent pageerror:", e.message));

  const failures = [];
  const check = (name, cond, detail = "") => {
    console.log(`  ${cond ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"} ${name}${detail ? ` \x1b[90m${detail}\x1b[0m` : ""}`);
    if (!cond) failures.push(name + (detail ? ` — ${detail}` : ""));
  };

  await agent.goto(liveUrl, { waitUntil: "domcontentloaded" });
  await waitFor(() => agent.evaluate(() => !!(window.SupportLayer && window.SupportLayer.agent)), { label: "agent boot" });
  check("the agent role boots from the printed URL", (await agent.evaluate(() => window.SupportLayer.role)) === "agent");
  // The link inherits `sl-demo=0` from the customer's URL, which is the point: the demo fixture has
  // to be explicitly turned off for both sides of the session.
  check("the agent side is not in demo mode", (await agent.evaluate(() => window.SupportLayer.config.demo)) === false);

  const connected = await waitFor(
    () => agent.evaluate(() => window.SupportLayer.agent.state().connected),
    { timeout: 30000, label: "peers to connect" }
  );
  check("the two peers establish a real WebRTC session", !!connected);

  // The screen share is the product: a real video track must arrive on the agent's stage. This is
  // also the only place the `hello` handshake's agent peer id gets checked against reality — over
  // the loopback bus ids are ignored, so a wrong one there costs nothing and costs everything here.
  check(
    "the agent advertises the peer id its broker actually registered",
    /^sl-[a-z0-9]+$/.test(await agent.evaluate(() => window.SupportLayer.agent.state().selfPeerId)),
    await agent.evaluate(() => window.SupportLayer.agent.state().selfPeerId)
  );
  const feed = await waitFor(
    async () =>
      agent.evaluate(() => {
        const sr = document.querySelector("#supportlayer-root").shadowRoot;
        const v = sr.querySelector(".sl-feed");
        const st = v && v.srcObject;
        if (!st || !st.getVideoTracks().length) return false;
        const t = st.getVideoTracks()[0];
        const s = (t.getSettings && t.getSettings()) || {};
        return {
          tracks: st.getVideoTracks().length,
          size: `${v.videoWidth}x${v.videoHeight}`,
          live: v.classList.contains("sl-on"),
          surface: s.displaySurface || null,
          label: t.label || "",
        };
      }),
    { timeout: 40000, label: "the customer's screen track" }
  );
  check("a real screen track reaches the agent stage", !!feed && feed.tracks > 0, JSON.stringify(feed));
  // Remote tracks do not carry `displaySurface` across the hop (the label is just "remote video"),
  // so read the customer's own capture label out of the agent's metadata — the same string the
  // agent's info card shows it. It is the only way to tell what a session is actually sharing.
  const captLabel = await agent.evaluate(() => (window.SupportLayer.agent.state().client || {}).capture_label || "");
  check("the agent is told what was captured", /^screen:/.test(captLabel), `capture_label=${captLabel}`);

  // A track that arrived is not a picture yet — decoding takes a moment, and a 0×0 video is
  // exactly the failure this check exists for (the old bug left the stage permanently blank).
  const painted = await waitFor(
    () =>
      agent.evaluate(() => {
        const v = document.querySelector("#supportlayer-root").shadowRoot.querySelector(".sl-feed");
        return v && v.videoWidth > 0 ? `${v.videoWidth}x${v.videoHeight}` : false;
      }),
    { timeout: 20000, label: "the first decoded frame" }
  );
  check("the track is actually painting", !!painted, painted);

  const badge = await agent.evaluate(() => document.querySelector("#supportlayer-root").shadowRoot.querySelector(".sl-badge").textContent.trim());
  check("the agent badge reports reality", /screen live/i.test(badge), badge);

  await agent.close();
  return failures;
}

/* ------------------------------------------------------------------ *
 * main
 * ------------------------------------------------------------------ */
const chrome = findChrome();
if (!chrome) {
  console.error("no Chrome found — set CHROME_PATH");
  process.exit(2);
}

const server = spawn(process.execPath, [path.join(ROOT, "serve.js")], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT) },
  stdio: "ignore",
});

/*
 * `--use-fake-ui-for-media-stream` auto-accepts the capture prompt, and
 * `--auto-select-desktop-capture-source` says what it accepts. The two modes want different
 * sources: headless has no windows, so the only thing to share is its virtual display, while a
 * visible run should share **its own window** — sharing the whole screen would put the operator's
 * desktop in front of the agent, which is not what a support session is for.
 */
const VIEWPORT = HEADED ? { width: 1180, height: 760 } : { width: 1280, height: 860 };

/*
 * The capture source.
 *
 * `--use-fake-ui-for-media-stream` auto-accepts, and `--use-fake-device-for-media-stream` supplies
 * the pixels — which are Chrome's synthetic test pattern, not a page. That is a limitation worth
 * naming rather than hiding: this host has no window manager, so Chrome's capture selection only
 * ever offers the DISPLAY (`displaySurface: monitor`, confirmed against
 * `--auto-select-desktop-capture-source`, `--auto-select-tab-capture-source-by-title` and
 * `preferCurrentTab`, all of which still returned the monitor). Sharing the display would put the
 * operator's whole desktop in front of the agent, and `--use-file-for-fake-video-capture` is ignored
 * on the display path (verified: byte-identical frames with and without it).
 *
 * So this script proves the plumbing — signalling, permission, track, decode, coordinates against a
 * real DOM — while the *picture* stays synthetic. For a session where the agent can read the page,
 * open `demo-app.html?sl-demo=0` in your own browser and pick what to share there; that is also the
 * only way to exercise the real picker.
 */
const browser = await puppeteer.launch({
  executablePath: chrome,
  headless: !HEADED,
  args: [
    "--no-sandbox",
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    "--autoplay-policy=no-user-gesture-required",
  ],
  defaultViewport: VIEWPORT,
});

let exitCode = 0;
try {
  await sleep(600);
  const { page, liveUrl } = await openCustomer(browser);
  console.log("\n\x1b[1mAgent URL — open this on the same machine:\x1b[0m");
  console.log(`\x1b[36m${liveUrl}\x1b[0m\n`);

  if (CHECK) {
    console.log("\x1b[1mself-check: dialling the session\x1b[0m");
    const failures = await selfCheck(browser, liveUrl);
    if (failures.length) {
      console.error("\nreal-path failures:\n  · " + failures.join("\n  · "));
      exitCode = 1;
    } else {
      console.log("\n\x1b[32mthe real WebRTC path works end to end\x1b[0m");
    }
  } else {
    console.log("The customer window is open and sharing. Ctrl-C to end the session.");
    console.log("(Opening the URL above in a second browser starts the agent side of the same session.)");
    console.log("Heads-up: this customer is headless, so what it shares is Chrome's synthetic capture");
    console.log("pattern rather than a page. For a picture the agent can read, open");
    console.log(`${BASE}/demo-app.html?sl-demo=0 in your own browser and share from there.`);
    for (;;) {
      await sleep(5000);
      const state = await page.evaluate(() => window.SupportLayer.getState()).catch(() => "closed");
      if (state === "closed") break;
      process.stdout.write(`\r  session state: ${state}      `);
    }
  }
} catch (err) {
  console.error("\n" + (err && err.message));
  exitCode = 1;
} finally {
  if (exitCode !== 0 || CHECK) {
    await browser.close().catch(() => {});
    server.kill();
  }
}

process.exit(exitCode);
