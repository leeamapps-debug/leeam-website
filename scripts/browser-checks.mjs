#!/usr/bin/env node
// Leeam Applications website: hands-on browser checks.
//
// Serves the site folder with python3's built-in web server, drives the Google Chrome
// already installed on the Mac through its DevTools protocol (nothing installed), and
// writes everything into the checks folder:
//   <page>-375.png and <page>-1280.png  screenshots of every page, full length
//   index-1280-zoom200.png              the home page as seen at 200 percent zoom
//   overflow.txt                        sideways-scroll check at 320, 375 and 1280 pixels
//   network.txt                         every request the browser made, to prove none leave the site
//   fonts.txt                           which font files loaded and which faces the headings and body use
//   keyboard-order-index.txt            the Tab order of the home page with the focus ring measured
//   ax-tree-<page>.txt                  the accessibility tree of every page, in reading order
//   axe-<page>.json and axe-summary.txt axe-core results, if a copy of axe.min.js is given
//   tap-sizes.txt                       the size of every link and button
//
// Usage:  node scripts/browser-checks.mjs [--axe /path/to/axe.min.js]

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CHECKS = join(ROOT, "checks");
const PORT = 8097;
const CDP_PORT = 9333;
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PAGES = ["index.html", "apps.html", "contact.html", "accessibility.html", "privacy.html", "404.html"];
const WIDTHS = [375, 1280];

const axeArg = process.argv.indexOf("--axe");
const AXE_PATH = axeArg > -1 ? process.argv[axeArg + 1] : null;

mkdirSync(CHECKS, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- local web server ----------
const server = spawn("python3", ["-m", "http.server", String(PORT), "--bind", "127.0.0.1"], {
  cwd: ROOT,
  stdio: "ignore",
});
await sleep(800);

// ---------- Chrome ----------
const profile = join(process.env.TMPDIR || "/tmp", "leeam-site-check-profile");
const chrome = spawn(
  CHROME,
  [
    "--headless=new",
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-gpu",
    "--hide-scrollbars",
    "--window-size=1280,900",
    "about:blank",
  ],
  { stdio: "ignore" }
);

async function waitForChrome() {
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
      if (r.ok) return r.json();
    } catch {}
    await sleep(200);
  }
  throw new Error("Chrome did not start");
}
await waitForChrome();
const target = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?about:blank`, { method: "PUT" })).json();

// ---------- tiny DevTools protocol client ----------
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = rej;
});
let nextId = 1;
const pending = new Map();
const listeners = [];
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { res, rej } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? rej(new Error(msg.error.message)) : res(msg.result);
  } else if (msg.method) {
    for (const l of listeners) l(msg);
  }
};
function send(method, params = {}) {
  return new Promise((res, rej) => {
    const id = nextId++;
    pending.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
function waitEvent(method) {
  return new Promise((res) => {
    const l = (msg) => {
      if (msg.method === method) {
        listeners.splice(listeners.indexOf(l), 1);
        res(msg.params);
      }
    };
    listeners.push(l);
  });
}
async function evaluate(expression) {
  const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error("page script failed: " + JSON.stringify(r.exceptionDetails).slice(0, 300));
  return r.result.value;
}

await send("Page.enable");
await send("Network.enable");
await send("Runtime.enable");
await send("DOM.enable");
await send("Accessibility.enable");
await send("Emulation.setFocusEmulationEnabled", { enabled: true });

const requests = [];
listeners.push((msg) => {
  if (msg.method === "Network.requestWillBeSent") requests.push(msg.params.request.url);
});

async function setViewport(width, scale = 1) {
  await send("Emulation.setDeviceMetricsOverride", {
    width,
    height: 900,
    deviceScaleFactor: scale,
    mobile: width < 768,
  });
}

async function open(page) {
  const loaded = waitEvent("Page.loadEventFired");
  await send("Page.navigate", { url: `http://127.0.0.1:${PORT}/${page}` });
  await loaded;
  await evaluate("document.fonts.ready.then(() => true)");
  await sleep(150);
}

async function fullPageShot(file, width, scale = 1) {
  const height = await evaluate("Math.min(document.documentElement.scrollHeight, 8000)");
  await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: scale, mobile: width < 768 });
  await sleep(100);
  const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
  writeFileSync(join(CHECKS, file), Buffer.from(shot.data, "base64"));
  await setViewport(width, scale);
  return height;
}

const overflowLines = [];
async function overflowCheck(page, width) {
  const r = await evaluate(`(() => {
    const vw = document.documentElement.clientWidth;
    const sw = document.documentElement.scrollWidth;
    const bsw = document.body.scrollWidth;
    const wide = [];
    document.querySelectorAll('body *').forEach((el) => {
      const b = el.getBoundingClientRect();
      if (b.right > vw + 0.5 || b.left < -0.5) {
        const cs = getComputedStyle(el);
        if (cs.position === 'absolute' && el.classList.contains('skip-link')) return;
        if (el.classList.contains('visually-hidden')) return;
        wide.push(el.tagName.toLowerCase() + (el.className ? '.' + String(el.className).split(' ').join('.') : '') + ' left=' + Math.round(b.left) + ' right=' + Math.round(b.right));
      }
    });
    return { vw, sw, bsw, wide: wide.slice(0, 12) };
  })()`);
  const ok = r.sw <= r.vw && r.bsw <= r.vw && r.wide.length === 0;
  overflowLines.push(
    `${ok ? "PASS" : "FAIL"}  ${page} at ${width}px: viewport ${r.vw}, document scroll width ${r.sw}, body scroll width ${r.bsw}` +
      (r.wide.length ? "\n      elements past the edge: " + r.wide.join("; ") : "")
  );
  return ok;
}

// ---------- accessibility tree ----------
async function axTree(page) {
  const { nodes } = await send("Accessibility.getFullAXTree");
  const byId = new Map(nodes.map((n) => [n.nodeId, n]));
  const lines = [];
  const val = (p) => (p && p.value !== undefined ? p.value : "");
  function walk(id, depth) {
    const n = byId.get(id);
    if (!n) return;
    const role = val(n.role);
    const name = val(n.name);
    const props = {};
    for (const p of n.properties || []) props[p.name] = val(p.value);
    if (!n.ignored && role && !["none", "generic", "InlineTextBox", "StaticText", "LineBreak"].includes(role)) {
      let extra = "";
      if (role === "heading") extra = ` level ${props.level}`;
      if (props.current && props.current !== "false") extra += ` (current ${props.current})`;
      if (role === "link" && n.properties) {
        const url = (n.properties.find((p) => p.name === "url") || {}).value;
        if (url && url.value) extra += ` -> ${url.value.replace(`http://127.0.0.1:${PORT}/`, "")}`;
      }
      lines.push(`${"  ".repeat(depth)}${role}${name ? `: "${name}"` : ""}${extra}`);
      depth += 1;
    } else if (!n.ignored && role === "StaticText" && name.trim()) {
      lines.push(`${"  ".repeat(depth)}text: "${name.trim().slice(0, 160)}${name.trim().length > 160 ? "…" : ""}"`);
    }
    for (const c of n.childIds || []) walk(c, depth);
  }
  const root = nodes.find((n) => !n.parentId) || nodes[0];
  walk(root.nodeId, 0);
  writeFileSync(join(CHECKS, `ax-tree-${page.replace(".html", "")}.txt`), lines.join("\n") + "\n");
  return lines.length;
}

// ---------- axe ----------
const axeSource = AXE_PATH && existsSync(AXE_PATH) ? readFileSync(AXE_PATH, "utf8") : null;
const axeSummary = [];
async function runAxe(page) {
  if (!axeSource) return;
  await send("Runtime.evaluate", { expression: axeSource });
  const result = await evaluate(`axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a','wcag2aa','wcag21a','wcag21aa','wcag22aa','best-practice'] } }).then(r => JSON.stringify({
    url: r.url, violations: r.violations, incomplete: r.incomplete.map(i => ({ id: i.id, impact: i.impact, description: i.description, nodes: i.nodes.length })), passes: r.passes.map(p => p.id), version: r.testEngine.version }))`);
  const r = JSON.parse(result);
  writeFileSync(join(CHECKS, `axe-${page.replace(".html", "")}.json`), JSON.stringify(r, null, 2));
  const v = r.violations.map((x) => `${x.id} (${x.impact}): ${x.help} [${x.nodes.length} element(s)]`);
  axeSummary.push(
    `${page}: axe-core ${r.version}, ${r.passes.length} rules passed, ${r.violations.length} violations, ${r.incomplete.length} needing manual review` +
      (v.length ? "\n  violations: " + v.join("\n  ") : "") +
      (r.incomplete.length ? "\n  manual review: " + r.incomplete.map((i) => `${i.id} (${i.nodes})`).join(", ") : "")
  );
}

// ---------- keyboard order ----------
async function keyboardOrder() {
  const lines = [];
  await evaluate("document.activeElement && document.activeElement.blur(); window.scrollTo(0,0); true");
  for (let i = 0; i < 40; i++) {
    await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 });
    const d = await evaluate(`(() => {
      const e = document.activeElement;
      if (!e || e === document.body) return null;
      const cs = getComputedStyle(e);
      const b = e.getBoundingClientRect();
      const label = e.getAttribute('aria-label') || (e.querySelector('img') && e.querySelector('img').alt) || e.textContent.trim().replace(/\\s+/g,' ').slice(0, 70);
      return { tag: e.tagName.toLowerCase(), label, href: e.getAttribute('href') || '', outline: cs.outlineStyle + ' ' + cs.outlineWidth + ' ' + cs.outlineColor, visible: b.width > 0 && b.height > 0 && b.bottom > 0, top: Math.round(b.top + window.scrollY) };
    })()`);
    if (!d) {
      lines.push(`${i + 1}. (focus returned to the page body: end of the tab order)`);
      break;
    }
    lines.push(`${i + 1}. ${d.tag} "${d.label}"${d.href ? ` -> ${d.href}` : ""}  focus ring: ${d.outline}${d.visible ? "" : "  (not visible on screen)"}`);
  }
  writeFileSync(join(CHECKS, "keyboard-order-index.txt"), lines.join("\n") + "\n");
  return lines;
}

// ---------- tap sizes ----------
async function tapSizes(page, width) {
  return evaluate(`(() => {
    const out = [];
    document.querySelectorAll('a, button').forEach((el) => {
      if (el.classList.contains('skip-link')) return;
      const b = el.getBoundingClientRect();
      const inline = getComputedStyle(el).display === 'inline';
      out.push({ label: (el.getAttribute('aria-label') || el.textContent.trim().replace(/\\s+/g,' ').slice(0,50)), w: Math.round(b.width), h: Math.round(b.height), inline });
    });
    return out;
  })()`);
}

// ---------- run ----------
const summary = [];
const tapLines = [];
const fontLines = [];
for (const page of PAGES) {
  for (const width of WIDTHS) {
    await setViewport(width);
    await open(page);
    const h = await fullPageShot(`${page.replace(".html", "")}-${width}.png`, width);
    summary.push(`screenshot ${page} at ${width}px: ${page.replace(".html", "")}-${width}.png (${h}px tall)`);
    await overflowCheck(page, width);
    const taps = await tapSizes(page, width);
    for (const t of taps) {
      const small = t.w < 44 || t.h < 44;
      tapLines.push(`${small ? (t.inline ? "note" : "FAIL") : "PASS"}  ${page} at ${width}px: "${t.label}" ${t.w} by ${t.h}${small && t.inline ? " (a link inside a sentence; exempt under WCAG 2.5.8)" : ""}`);
    }
    if (width === 1280) {
      await axTree(page);
      await runAxe(page);
      const f = await evaluate(`(() => {
        const faces = [...document.fonts].map(f => f.family + ' ' + f.weight + ' ' + f.style + ': ' + f.status);
        const h = document.querySelector('h1'); const p = document.querySelector('main p') || document.body;
        return { faces, h1: getComputedStyle(h).fontFamily, body: getComputedStyle(p).fontFamily,
          sgLoaded: document.fonts.check('700 20px "Space Grotesk"'), atkLoaded: document.fonts.check('400 20px "Atkinson Hyperlegible"') };
      })()`);
      fontLines.push(`${page}: h1 uses ${f.h1}; body uses ${f.body}; Space Grotesk loaded: ${f.sgLoaded}; Atkinson Hyperlegible loaded: ${f.atkLoaded}\n  faces: ${f.faces.join("; ")}`);
    }
  }
  await setViewport(320);
  await open(page);
  await overflowCheck(page, 320);
}

// home page at 200 percent zoom: a 1280 window zoomed to 200 percent lays out like a 640 pixel window drawn twice as large
await setViewport(640, 2);
await open("index.html");
const zh = await fullPageShot("index-1280-zoom200.png", 640, 2);
summary.push(`screenshot index.html at 200 percent zoom (1280 pixel window): index-1280-zoom200.png (${zh} layout px tall)`);
await overflowCheck("index.html (200 percent zoom)", 640);

// keyboard order on the home page at desktop width
await setViewport(1280);
await open("index.html");
const kb = await keyboardOrder();

// network
const external = requests.filter((u) => !u.startsWith(`http://127.0.0.1:${PORT}/`));
const uniq = [...new Set(requests)].sort();
writeFileSync(
  join(CHECKS, "network.txt"),
  `${uniq.length} distinct URLs requested while loading every page at every width.\n` +
    `${external.length === 0 ? "PASS" : "FAIL"}  requests to any other host: ${external.length}\n\n` +
    uniq.map((u) => u.replace(`http://127.0.0.1:${PORT}/`, "/")).join("\n") +
    "\n"
);

writeFileSync(join(CHECKS, "overflow.txt"), overflowLines.join("\n") + "\n");
writeFileSync(join(CHECKS, "tap-sizes.txt"), tapLines.join("\n") + "\n");
writeFileSync(join(CHECKS, "fonts.txt"), fontLines.join("\n") + "\n");
if (axeSource) writeFileSync(join(CHECKS, "axe-summary.txt"), axeSummary.join("\n") + "\n");

const failures = [
  ...overflowLines.filter((l) => l.startsWith("FAIL")),
  ...tapLines.filter((l) => l.startsWith("FAIL")),
  ...(external.length ? [`external requests: ${external.join(", ")}`] : []),
  ...axeSummary.filter((l) => !/ 0 violations/.test(l)),
];
const report =
  summary.join("\n") +
  "\n\n" +
  overflowLines.join("\n") +
  "\n\nkeyboard order (home page):\n" +
  kb.join("\n") +
  "\n\n" +
  (axeSource ? axeSummary.join("\n") : "axe-core: not run (no --axe path given)") +
  "\n\n" +
  `RESULT: ${failures.length ? "FAIL" : "PASS"} (${failures.length} failure line(s))\n`;
writeFileSync(join(CHECKS, "browser-checks-summary.txt"), report);
console.log(report);

ws.close();
chrome.kill();
server.kill();
process.exit(failures.length ? 1 : 0);
