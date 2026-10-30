#!/usr/bin/env node
// End-to-end smoke test for the real DevTrace desktop app (Windows / WebView2).
//
// Launches the built binary with an ISOLATED workspace directory and WebView2 profile, connects
// through the WebView2 DevTools protocol (playwright-core, no browser download), and verifies:
//   - every primary route renders; Ctrl+1..8 shortcuts navigate
//   - unavailable features are marked unavailable (no false success)
//   - light/dark theme switching changes computed colors and persists
//   - project create / duplicate validation / rename / delete through the UI
//   - session lifecycle (Milestone 2): create, steps, commands, screenshots by paste, drop and
//     file input, rendering through the `evidence` scheme, files on disk, notes autosave,
//     complete/reopen, persistence across restart, attachment removal and session deletion
//   - native capture (Milestone 3): target list, start/pause/resume/stop, Capture now, the global
//     shortcut, tray icon and window exclusion while recording, real display and window
//     screenshots decoded and checked pixel by pixel, annotations, and recovery of a capture
//     interrupted by a crash
//   - review (Milestone 4) and playbooks (Milestone 5): decisions, reorder, redaction, generation
//     from approved steps, editing, publishing a revision
//   - export (Milestone 6): Markdown with images, self-contained HTML and PDF files checked on
//     disk; the PDF is opened with the Windows PDF renderer and page 1 saved as a preview
//   - version history (Milestone 7): read and compare versions, restore a revision while keeping
//     the replaced draft, mark out of date, duplicate with its own evidence copies
//   - advanced capture and integrations (Milestone 8): automatic capture of a window that changes
//     (and nothing while paused or switched off), a terminal log written by a real PowerShell
//     transcript with secret masking, a watched configuration file, and observed and declared
//     changes reviewed and verified in Change History
//   - reliability (Milestone 9): plugin commands denied to the webview, a workspace backup saved
//     as a zip, restored after later changes (which are kept aside), and an axe-core accessibility
//     audit (WCAG 2.1 A/AA) of every screen that gets a screenshot, in both themes
//   - data and settings persist across an application restart
//   - no console errors or uncaught exceptions
// Screenshots of every screen in both themes are written to .e2e/screenshots. Window titles of
// other applications are blurred in them, and display captures (which show the real screen) are
// deleted before any screenshot is taken; the window capture uses a test window with known content.
//
// Usage:
//   npm run tauri build -- --debug --no-bundle   (once, or after changes)
//   npm run test:e2e
// Options: --binary <path>  --keep (keep the temp workspace)

import { execFile, spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { inflateSync } from "node:zlib";
import { chromium } from "playwright-core";

const root = process.cwd();
const args = process.argv.slice(2);
const argValue = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

const binary = resolve(argValue("--binary") ?? join(root, "src-tauri", "target", "debug", "devtrace.exe"));
const keep = args.includes("--keep");
// --interactive: run on a desktop you are watching. Captures the real screen (deleted again) and
// presses the capture shortcut with injected key events.
const interactive = args.includes("--interactive");
const port = 9333;
const runDir = join(root, ".e2e", `run-${Date.now()}`);
const dataDir = join(runDir, "workspace");
const profileDir = join(runDir, "webview-profile");
const shotsDir = join(root, ".e2e", "screenshots");
// The file "Watch a file…" picks instead of showing the system dialog (test hook, see file_watch.rs).
const watchedConfig = join(runDir, "sshd_config");
// Where "Back up workspace…" saves and what "Restore from backup…" picks (test hooks, dialogs.rs).
const backupFile = join(runDir, "backups-elsewhere", "devtrace-backup.zip");

if (!existsSync(binary)) {
  console.error(`Binary not found: ${binary}\nBuild it first: npm run tauri build -- --debug --no-bundle`);
  process.exit(2);
}
mkdirSync(dataDir, { recursive: true });
mkdirSync(profileDir, { recursive: true });
mkdirSync(shotsDir, { recursive: true });

const results = [];
const consoleErrors = [];
const evidenceResponses = [];
let child = null;
let browser = null;

function check(name, condition, detail = "") {
  results.push({ name, ok: Boolean(condition), detail });
  console.log(`${condition ? "  PASS" : "  FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

/** A check that cannot run in this environment. Reported, never counted as passed. */
const skipped = [];
function skip(name, reason) {
  skipped.push({ name, reason });
  console.log(`  SKIP  ${name}  (${reason})`);
}

async function launch() {
  child = spawn(binary, [], {
    env: {
      ...process.env,
      DEVTRACE_DATA_DIR: dataDir,
      DEVTRACE_E2E_PICK_FILE: watchedConfig,
      DEVTRACE_E2E_SAVE_BACKUP: backupFile,
      DEVTRACE_E2E_PICK_BACKUP: backupFile,
      WEBVIEW2_USER_DATA_FOLDER: profileDir,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
    },
    stdio: "ignore",
  });
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) break;
    } catch {
      // not ready yet
    }
    await delay(300);
  }
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  let page = null;
  for (let attempt = 0; attempt < 50 && !page; attempt++) {
    page = browser.contexts().flatMap((context) => context.pages())[0] ?? null;
    if (!page) await delay(200);
  }
  if (!page) throw new Error("No WebView page found over CDP");
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push({ text: message.text(), url: message.location()?.url ?? "" });
  });
  page.on("pageerror", (error) => consoleErrors.push({ text: `pageerror: ${error.message}`, url: "" }));
  page.on("response", (response) => {
    if (response.url().startsWith("http://evidence.localhost/")) evidenceResponses.push(response);
  });
  await page.waitForSelector('nav[aria-label="Main"]', { timeout: 30_000 });
  return page;
}

async function shutdown() {
  try {
    await browser?.close();
  } catch {
    // ignore
  }
  browser = null;
  if (child && child.exitCode === null) {
    child.kill();
    await new Promise((resolveExit) => child.once("exit", resolveExit));
  }
  child = null;
  await delay(800);
}

const heading = (page) => page.locator("header h1").first().innerText();

async function goTo(page, label) {
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: label, exact: true }).click();
  await page.waitForTimeout(150);
}

async function setTheme(page, theme) {
  await goTo(page, "Settings");
  await page.getByRole("radio", { name: theme }).click();
  await page.waitForFunction((expected) => document.documentElement.dataset.theme === expected, theme.toLowerCase());
}

async function screenshotAll(page, theme) {
  const screens = ["Overview", "Capture", "Sessions", "Playbooks", "Change History", "Knowledge Library", "Projects", "Settings"];
  for (const screen of screens) {
    await goTo(page, screen);
    await page.waitForTimeout(250);
    if (screen === "Capture") {
      await page.getByRole("radio").first().waitFor({ timeout: 10_000 }).catch(() => undefined);
      await blurPrivateTargets(page);
    }
    const name = `${theme}-${screen.toLowerCase().replace(/\s+/g, "-")}`;
    await page.screenshot({ path: join(shotsDir, `${name}.png`) });
    await auditAccessibility(page, name);
  }
}

// Accessibility: axe-core (WCAG 2.0/2.1 A and AA rules) runs on every screen that gets a
// screenshot, in both themes. It is evaluated through the DevTools protocol, so the app's CSP
// (which forbids injected scripts) stays untouched.
const axeSource = readFileSync(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8");
const accessibility = { screens: 0, violations: [] };

async function auditAccessibility(page, name) {
  try {
    if (!(await page.evaluate(() => typeof window.axe !== "undefined"))) await page.evaluate(axeSource);
    const violations = await page.evaluate(async () => {
      const result = await window.axe.run(document, {
        runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] },
        resultTypes: ["violations"],
      });
      return result.violations.map((violation) => ({
        id: violation.id,
        impact: violation.impact,
        help: violation.help,
        targets: violation.nodes.slice(0, 10).map((node) => node.target.join(" ")),
      }));
    });
    accessibility.screens += 1;
    for (const violation of violations) accessibility.violations.push({ screen: name, ...violation });
  } catch (error) {
    accessibility.violations.push({ screen: name, id: "audit-failed", impact: "critical", help: String(error), targets: [] });
  }
}

/** Draws a plausible device settings screen in the page and returns the encoded image (base64). */
async function makeImage(page, { width, height, type = "image/png", title, rows }) {
  return page.evaluate(
    async ({ width, height, type, title, rows }) => {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, width, height);
      ctx.fillStyle = "#1f2a37";
      ctx.fillRect(0, 0, width, 48);
      ctx.fillStyle = "#ffffff";
      ctx.font = "600 18px Segoe UI, sans-serif";
      ctx.fillText(title, 20, 31);
      ctx.fillStyle = "#f1f3f5";
      ctx.fillRect(0, 48, 200, height - 48);
      ["Dashboard", "Network", "Policy & Objects", "System", "Log & Report"].forEach((label, index) => {
        if (index === 3) {
          ctx.fillStyle = "#dbe8ff";
          ctx.fillRect(0, 64 + index * 40, 200, 36);
        }
        ctx.fillStyle = "#374151";
        ctx.font = "15px Segoe UI, sans-serif";
        ctx.fillText(label, 20, 88 + index * 40);
      });
      rows.forEach(([label, value], index) => {
        const y = 110 + index * 56;
        ctx.fillStyle = "#4b5563";
        ctx.font = "15px Segoe UI, sans-serif";
        ctx.fillText(label, 240, y);
        ctx.strokeStyle = "#c5cbd3";
        ctx.strokeRect(440, y - 22, 320, 34);
        ctx.fillStyle = "#111827";
        ctx.fillText(value, 452, y);
      });
      ctx.fillStyle = "#0b65c2";
      ctx.fillRect(240, height - 80, 96, 34);
      ctx.fillStyle = "#ffffff";
      ctx.fillText("Apply", 266, height - 57);
      const blob = await new Promise((resolveBlob) => canvas.toBlob(resolveBlob, type, 0.92));
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let binary = "";
      for (let offset = 0; offset < bytes.length; offset += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
      }
      return btoa(binary);
    },
    { width, height, type, title, rows },
  );
}

/** Simulates Ctrl+V of an image (the same ClipboardEvent the browser fires for a real paste). */
async function pasteImage(page, base64, name, type) {
  await page.evaluate(
    ({ base64, name, type }) => {
      const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
      const data = new DataTransfer();
      data.items.add(new File([bytes], name, { type }));
      document.body.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
    },
    { base64, name, type },
  );
}

/** Dispatches HTML5 drag events carrying an image file onto the session's center pane. */
async function dragImage(page, base64, name, type, kinds) {
  await page.evaluate(
    ({ base64, name, type, kinds }) => {
      const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
      const data = new DataTransfer();
      data.items.add(new File([bytes], name, { type }));
      const target = document.querySelector('section[aria-label="Evidence viewer"], section[aria-label="Step content"]');
      for (const kind of kinds) target.dispatchEvent(new DragEvent(kind, { dataTransfer: data, bubbles: true, cancelable: true }));
    },
    { base64, name, type, kinds },
  );
}

const steps = (page) => page.getByRole("listbox", { name: "Session steps" });
const stepCount = (page) => page.locator('[aria-label="Session steps"] [role="option"]').count();

async function waitForSteps(page, expected) {
  await page.waitForFunction((count) => document.querySelectorAll('[aria-label="Session steps"] [role="option"]').length === count, expected, {
    timeout: 10_000,
  });
}

/** Text of the notifications currently shown, to explain a failed step. */
const notifications = (page) => page.getByRole("region", { name: "Notifications" }).innerText().catch(() => "");

/** Like waitForSteps, but returns false (and records why) instead of throwing. */
async function stepsReached(page, expected, name) {
  try {
    await waitForSteps(page, expected);
    return true;
  } catch {
    check(name, false, `steps=${await stepCount(page)}; notifications: ${(await notifications(page)).replace(/\s+/g, " ").trim() || "none"}`);
    return false;
  }
}

/** Resolves with the decoded width of the image in the evidence viewer, or 0. */
async function viewerImageWidth(page) {
  try {
    const handle = await page.waitForFunction(
      () => {
        const image = document.querySelector('section[aria-label="Evidence viewer"] img');
        return image && image.complete && image.naturalWidth > 0 ? image.naturalWidth : false;
      },
      null,
      { timeout: 10_000 },
    );
    return await handle.jsonValue();
  } catch {
    return 0;
  }
}

function filesIn(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).map((name) => ({ name, size: statSync(join(dir, name)).size }));
}

async function waitForFiles(dir, expected) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && filesIn(dir).length !== expected) await delay(100);
  return filesIn(dir);
}

/** Dismisses transient notifications so screenshots show the workspace itself. */
async function dismissToasts(page) {
  await page.evaluate(() => {
    for (const button of document.querySelectorAll('button[aria-label="Dismiss notification"]')) button.click();
  });
  await page.waitForTimeout(150);
}

/** Captures the window without toasts, after open/close animations have settled. */
async function shot(page, name) {
  await dismissToasts(page);
  await page.waitForTimeout(250);
  await page.screenshot({ path: join(shotsDir, `${name}.png`) });
  await auditAccessibility(page, name);
}

const run32 = promisify(execFile);
const win32Script = join(root, "scripts", "e2e-win32.ps1");
const POWERSHELL = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", win32Script];
let targetWindow = null;

/** Runs a Windows helper action (see scripts/e2e-win32.ps1) and returns its output lines. */
async function win32(action, processId = 0) {
  const { stdout } = await run32("powershell.exe", [...POWERSHELL, "-Action", action, "-ProcessId", String(processId)], { windowsHide: true });
  return stdout.split(/\r?\n/).filter(Boolean);
}

/** Top-level windows of the DevTrace process: { className, title, visible, affinity }. */
async function devtraceWindows() {
  return (await win32("windows", child.pid)).map((line) => {
    const [className, title, visible, affinity] = line.split("|");
    return { className, title, visible: visible === "1", affinity: Number(affinity) };
  });
}

/** Display affinity of the main window: 0 = normal, 17 = WDA_EXCLUDEFROMCAPTURE. */
async function mainWindowAffinity() {
  const main = (await devtraceWindows()).find((window) => window.visible && window.title === "DevTrace");
  return main ? main.affinity : -1;
}

const hasTrayIcon = async () => (await devtraceWindows()).some((window) => window.className === "tray_icon_app");

/** Decodes an 8-bit, non-interlaced RGB(A) PNG (the format DevTrace stores captures in). */
function decodePng(buffer) {
  if (buffer.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") throw new Error("not a PNG file");
  let offset = 8;
  let header = null;
  const data = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const body = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") header = { width: body.readUInt32BE(0), height: body.readUInt32BE(4), depth: body[8], color: body[9], interlace: body[12] };
    if (type === "IDAT") data.push(body);
    if (type === "IEND") break;
    offset += 12 + length;
  }
  if (!header || header.depth !== 8 || header.interlace !== 0 || ![2, 6].includes(header.color)) {
    throw new Error(`unsupported PNG layout ${JSON.stringify(header)}`);
  }
  const { width, height } = header;
  const channels = header.color === 6 ? 4 : 3;
  const stride = width * channels;
  const raw = inflateSync(Buffer.concat(data));
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = pixels.subarray(y * stride, (y + 1) * stride);
    const above = y > 0 ? pixels.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? out[x - channels] : 0;
      const up = above ? above[x] : 0;
      const corner = above && x >= channels ? above[x - channels] : 0;
      let predicted = 0;
      if (filter === 1) predicted = left;
      else if (filter === 2) predicted = up;
      else if (filter === 3) predicted = (left + up) >> 1;
      else if (filter === 4) {
        const estimate = left + up - corner;
        const [dl, du, dc] = [Math.abs(estimate - left), Math.abs(estimate - up), Math.abs(estimate - corner)];
        predicted = dl <= du && dl <= dc ? left : du <= dc ? up : corner;
      } else if (filter !== 0) throw new Error(`invalid PNG filter ${filter}`);
      out[x] = (line[x] + predicted) & 0xff;
    }
  }
  const pixel = (x, y) => [...pixels.subarray((y * width + x) * channels, (y * width + x) * channels + 3)];
  const sampled = new Set();
  for (let gy = 0; gy < 10; gy++) for (let gx = 0; gx < 10; gx++) sampled.add(pixel(Math.floor(((gx + 0.5) * width) / 10), Math.floor(((gy + 0.5) * height) / 10)).join(","));
  return { width, height, pixel, sampledColors: sampled.size };
}

const sizeIn = (text) => {
  const match = /(\d+)\s*\u00d7\s*(\d+)/.exec(text ?? "");
  return match ? { width: Number(match[1]), height: Number(match[2]) } : null;
};

const attachmentFolders = () => (existsSync(join(dataDir, "attachments")) ? readdirSync(join(dataDir, "attachments")) : []);

/** Blurs other applications' window titles before a screenshot of the capture setup is saved. */
async function blurPrivateTargets(page) {
  await page.evaluate(() => {
    for (const input of document.querySelectorAll('input[name="capture-target"]')) {
      const label = input.closest("label");
      const text = label?.textContent ?? "";
      if (label && !/^Display \d/.test(text) && !text.includes("E2E capture target")) label.style.filter = "blur(5px)";
    }
  });
}

async function waitForTarget(page, name) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await page.waitForTimeout(700);
    if ((await page.getByRole("radio", { name }).count()) > 0) return true;
  }
  return false;
}

async function run() {
  console.log(`DevTrace E2E smoke test\n  binary:    ${binary}\n  workspace: ${dataDir}\n`);
  let page = await launch();

  // 1. Initial state
  check("app shell renders", await page.getByRole("navigation", { name: "Main" }).isVisible());
  check("starts on Overview", (await heading(page)) === "Overview");
  check("default workspace name shown", await page.getByRole("heading", { name: "Local Workspace" }).isVisible());
  check(
    "sidebar shows honest capture status",
    await page.getByRole("link", { name: /Capture status: Not recording/ }).isVisible(),
  );

  // 2. Navigation through every route
  const routes = [
    ["Capture", "Capture"],
    ["Sessions", "Sessions"],
    ["Playbooks", "Playbooks"],
    ["Change History", "Change History"],
    ["Knowledge Library", "Knowledge Library"],
    ["Projects", "Projects"],
    ["Settings", "Settings"],
    ["Overview", "Overview"],
  ];
  for (const [link, title] of routes) {
    await goTo(page, link);
    check(`navigates to ${link}`, (await heading(page)) === title);
  }
  const activeLink = await page.locator('nav[aria-label="Main"] a[aria-current="page"]').first().innerText();
  check("active nav item marked with aria-current", activeLink.includes("Overview"), activeLink);

  // 3. Keyboard shortcuts
  await page.keyboard.press("Control+7");
  await page.waitForTimeout(150);
  check("Ctrl+7 opens Projects", (await heading(page)) === "Projects");
  await page.keyboard.press("Control+1");
  await page.waitForTimeout(150);
  check("Ctrl+1 opens Overview", (await heading(page)) === "Overview");

  // 4. Capture is available, but nothing is recorded until a capture is started
  const startCapture = page.getByRole("button", { name: "Start Capture" });
  check("Start Capture is available", (await startCapture.getAttribute("aria-disabled")) === null);
  await startCapture.click();
  await page.getByRole("heading", { name: "Start a capture" }).waitFor({ timeout: 10_000 });
  check("Start Capture opens the capture setup", (await heading(page)) === "Capture");
  await page.getByRole("radio").first().waitFor({ timeout: 10_000 });
  const primaryDisplay = page.getByRole("radio", { name: /Primary display/ });
  check("displays are listed as capture targets", (await primaryDisplay.count()) === 1);
  check("the primary display is preselected", await primaryDisplay.isChecked());
  const targetTitles = await page.evaluate(() =>
    [...document.querySelectorAll('input[name="capture-target"]')].map((input) => input.closest("label")?.querySelector('[class*="targetTitle"]')?.textContent ?? ""),
  );
  check("DevTrace's own window is not offered as a target", !targetTitles.includes("DevTrace"), `${targetTitles.length} targets`);
  check("nothing is captured before a capture starts", (await mainWindowAffinity()) === 0 && !(await hasTrayIcon()));

  // 5. Theme switching
  await setTheme(page, "Dark");
  const darkBg = await page.evaluate(() => getComputedStyle(document.querySelector("nav[aria-label='Main']")).backgroundColor);
  check("dark theme applies dark sidebar color", darkBg === "rgb(28, 28, 30)", darkBg);
  await screenshotAll(page, "dark");
  await setTheme(page, "Light");
  const lightBg = await page.evaluate(() => getComputedStyle(document.querySelector("nav[aria-label='Main']")).backgroundColor);
  check("light theme applies light sidebar color", lightBg === "rgb(245, 245, 247)", lightBg);
  await screenshotAll(page, "light");

  // 6. Project CRUD
  await goTo(page, "Projects");
  await page.getByRole("button", { name: "New Project" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Name").fill("");
  await dialog.getByRole("button", { name: "Create project" }).click();
  check("empty name shows validation error", await dialog.getByText("Project name is required.").isVisible());
  await dialog.getByLabel("Name").fill("Core Network");
  await dialog.getByLabel("Description").fill("Routing and switching changes");
  await page.screenshot({ path: join(shotsDir, "light-project-dialog.png") });
  await dialog.getByRole("button", { name: "Create project" }).click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  check("project created and shown in inspector", (await heading(page)) === "Core Network");
  check("project listed in table", await page.getByRole("table", { name: "Projects" }).getByText("Core Network").isVisible());
  await page.screenshot({ path: join(shotsDir, "light-project-inspector.png") });

  await page.getByRole("button", { name: "New Project" }).click();
  await page.getByRole("dialog").getByLabel("Name").fill("core network");
  await page.getByRole("dialog").getByRole("button", { name: "Create project" }).click();
  const duplicate = page.getByRole("dialog").getByText(/already exists/);
  await duplicate.waitFor({ timeout: 5000 });
  check("duplicate name rejected by backend with field error", await duplicate.isVisible());
  check("input preserved after failed save", (await page.getByRole("dialog").getByLabel("Name").inputValue()) === "core network");
  await page.getByRole("dialog").getByRole("button", { name: "Cancel" }).click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });

  await page.getByRole("complementary", { name: "Project details" }).getByRole("button", { name: "Edit" }).click();
  await page.getByRole("dialog").getByLabel("Name").fill("Core Network Lab");
  await page.getByRole("dialog").getByRole("button", { name: "Save changes" }).click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  check("project renamed", (await heading(page)) === "Core Network Lab");

  await goTo(page, "Overview");
  check("Overview lists the real project", await page.getByRole("link", { name: /Core Network Lab/ }).isVisible());

  // 6b. Sessions (Milestone 2): create, document, add evidence, complete
  await goTo(page, "Sessions");
  check("sessions list starts empty", await page.getByText("No sessions yet").isVisible());
  await dismissToasts(page);
  await page.getByRole("button", { name: "New Session", exact: true }).click();
  const sessionDialog = page.getByRole("dialog", { name: "New session" });
  await sessionDialog.getByRole("button", { name: "Create session" }).click();
  check("session title is required", await sessionDialog.getByText("Session title is required.").isVisible());
  await sessionDialog.getByLabel("Title").fill("Configure NTP on the branch firewall");
  await sessionDialog.getByLabel("Project").selectOption({ label: "Core Network Lab" });
  await sessionDialog.getByLabel(/Application or platform/).fill("FortiGate 7.4");
  await sessionDialog.getByLabel(/Environment/).fill("Lab");
  await sessionDialog.getByLabel(/Notes/).fill("Change CHG-1042: align NTP with the core servers.");
  await shot(page, "light-session-dialog");
  await sessionDialog.getByRole("button", { name: "Create session" }).click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  check("session created and opened", (await heading(page)) === "Configure NTP on the branch firewall");
  const sessionId = decodeURIComponent(page.url().split("#/sessions/")[1] ?? "");
  const sessionFolder = join(dataDir, "attachments", sessionId);
  check("session URL carries its id", /^[0-9a-f-]{36}$/.test(sessionId), sessionId);
  check(
    "empty session cannot be completed",
    (await page.getByRole("button", { name: "Complete", exact: true }).getAttribute("aria-disabled")) === "true",
  );
  await shot(page, "light-session-empty");

  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.getByRole("menuitem", { name: /^Step/ }).click();
  let eventDialog = page.getByRole("dialog", { name: "Add step" });
  await eventDialog.getByLabel("Title").fill("Open System > Settings");
  await eventDialog.getByLabel(/Description/).fill("Sign in to the FortiGate GUI and open System > Settings.");
  await eventDialog.getByRole("button", { name: "Add step" }).click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  await waitForSteps(page, 1);
  check("step added to the timeline", (await stepCount(page)) === 1);
  await page.keyboard.press("Control+N");
  const shortcutDialog = page.getByRole("dialog", { name: "Add step" });
  await shortcutDialog.waitFor({ timeout: 5000 }).catch(() => undefined);
  check("Ctrl+N opens Add step in a session", await shortcutDialog.isVisible());
  await page.keyboard.press("Escape");
  await page.getByRole("dialog").waitFor({ state: "hidden" });

  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.getByRole("menuitem", { name: /^Command/ }).click();
  eventDialog = page.getByRole("dialog", { name: "Add command" });
  await eventDialog.getByLabel("Title").fill("Verify NTP synchronization");
  await eventDialog.getByLabel("Command").fill("diagnose sys ntp status");
  await eventDialog.getByRole("button", { name: "Add command" }).click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  await waitForSteps(page, 2);
  check("command shown as text, never executed", await page.locator("pre code").filter({ hasText: "diagnose sys ntp status" }).isVisible());
  await shot(page, "light-session-command");

  const pastedImage = await makeImage(page, {
    width: 1280,
    height: 760,
    title: "FortiGate - System Settings",
    rows: [
      ["NTP synchronization", "Enabled"],
      ["Server", "10.0.0.10"],
      ["Sync interval", "60 minutes"],
    ],
  });
  await pasteImage(page, pastedImage, "image.png", "image/png");
  await waitForSteps(page, 3);
  const pastedWidth = await viewerImageWidth(page);
  check("pasted screenshot decoded through the evidence scheme", pastedWidth === 1280, `naturalWidth=${pastedWidth}`);
  const imageSrc = (await page.locator('section[aria-label="Evidence viewer"] img').getAttribute("src")) ?? "";
  check("image URL is an evidence id, not a file path", imageSrc.startsWith("http://evidence.localhost/") && !imageSrc.includes("attachments"), imageSrc);
  let stored = filesIn(sessionFolder);
  check("screenshot stored in the session's attachment folder", stored.length === 1 && stored[0].name.endsWith(".png"), stored.map((file) => file.name).join(", "));
  check("stored file has exactly the pasted bytes' size", stored[0]?.size === Buffer.from(pastedImage, "base64").length, `${stored[0]?.size} bytes`);
  const pastedFileName = stored[0]?.name;

  const droppedImage = await makeImage(page, {
    width: 1100,
    height: 680,
    type: "image/jpeg",
    title: "FortiGate - NTP status",
    rows: [
      ["Status", "Synchronized"],
      ["Stratum", "3"],
      ["Offset", "0.42 ms"],
    ],
  });
  await dragImage(page, droppedImage, "ntp-status.jpg", "image/jpeg", ["dragenter", "dragover"]);
  check("drop overlay explains what will happen", await page.getByText("Drop images to add screenshots").isVisible());
  await shot(page, "light-session-drop");
  await dragImage(page, droppedImage, "ntp-status.jpg", "image/jpeg", ["drop"]);
  await waitForSteps(page, 4);
  check("dropped JPEG added as a screenshot step named after the file", (await steps(page).getByText("ntp-status", { exact: true }).count()) === 1);

  const chosenImage = await makeImage(page, {
    width: 900,
    height: 560,
    title: "FortiGate - Event log",
    rows: [
      ["Event", "NTP server reachable"],
      ["Severity", "Information"],
    ],
  });
  await page
    .locator('[data-testid="image-file-input"]')
    .setInputFiles({ name: "event-log.png", mimeType: "image/png", buffer: Buffer.from(chosenImage, "base64") });
  await waitForSteps(page, 5);
  check("image chosen through the file input added", (await steps(page).getByText("event-log", { exact: true }).count()) === 1);
  stored = await waitForFiles(sessionFolder, 3);
  check("three evidence files stored, one JPEG", stored.length === 3 && stored.filter((file) => file.name.endsWith(".jpg")).length === 1);

  await page
    .locator('[data-testid="image-file-input"]')
    .setInputFiles({ name: "notes.png", mimeType: "image/png", buffer: Buffer.from("this text is not an image") });
  const rejection = page.getByText("This file is not a supported image. Use a PNG, JPEG, GIF or WebP file.");
  await rejection.waitFor({ timeout: 5000 });
  check("text disguised as PNG is rejected by content check", await rejection.isVisible());
  check("rejected file is not stored", filesIn(sessionFolder).length === 3);

  const evidenceOk = evidenceResponses.find((response) => response.status() === 200);
  if (evidenceOk) {
    const headers = await evidenceOk.allHeaders();
    check("evidence response carries the stored media type", (headers["content-type"] ?? "").startsWith("image/"), headers["content-type"]);
    check(
      "evidence response is nosniff and no-store",
      headers["x-content-type-options"] === "nosniff" && headers["cache-control"] === "no-store",
      `${headers["x-content-type-options"]} / ${headers["cache-control"]}`,
    );
  } else {
    console.log("  NOTE  evidence response headers are not observable over CDP in this WebView2 build (not counted)");
  }
  const refused = await page.evaluate(async () => {
    const attempt = (src) =>
      new Promise((resolveAttempt) => {
        const image = new Image();
        image.onload = () => resolveAttempt("loaded");
        image.onerror = () => resolveAttempt("refused");
        image.src = src;
      });
    return {
      unknown: await attempt("http://evidence.localhost/0190f5c2-7a3b-7c3d-8e4f-123456789abc"),
      traversal: await attempt("http://evidence.localhost/..%2F..%2Fdevtrace.sqlite3"),
    };
  });
  check("evidence scheme refuses unknown ids and path tricks", refused.unknown === "refused" && refused.traversal === "refused", JSON.stringify(refused));

  await steps(page).getByText("Open System > Settings", { exact: true }).dblclick();
  eventDialog = page.getByRole("dialog", { name: "Edit step" });
  await eventDialog.getByLabel("Title").fill("Open System > Settings in the FortiGate GUI");
  await eventDialog.getByRole("button", { name: "Save changes" }).click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  check("step edited from the timeline", await steps(page).getByText("Open System > Settings in the FortiGate GUI").isVisible());

  await steps(page).getByText("Pasted screenshot", { exact: true }).click();
  await viewerImageWidth(page);
  await shot(page, "light-session-workspace");

  await page.getByRole("tab", { name: "Session", exact: true }).click();
  const notes = page.getByLabel("Session notes");
  check("notes entered at creation are shown", (await notes.inputValue()) === "Change CHG-1042: align NTP with the core servers.");
  await notes.fill("Change CHG-1042: align NTP with the core servers.\nVerified synchronization after 5 minutes.");
  await page.getByText(/Saved at/).waitFor({ timeout: 5000 });
  check("session notes autosaved", await page.getByText(/Saved at/).isVisible());
  await shot(page, "light-session-notes");
  await page.getByRole("tablist", { name: "Inspector" }).getByRole("tab").first().click();

  await page.getByRole("button", { name: "Complete", exact: true }).click();
  await page.getByText(/Steps and evidence are read-only/).waitFor({ timeout: 5000 });
  check("completed session is read-only", (await page.getByRole("button", { name: "Add", exact: true }).getAttribute("aria-disabled")) === "true");
  await pasteImage(page, chosenImage, "image.png", "image/png");
  await page.getByText("Screenshot not added").waitFor({ timeout: 5000 });
  check("paste into a completed session is refused with an explanation", filesIn(sessionFolder).length === 3);
  await shot(page, "light-session-completed");
  await goTo(page, "Sessions");
  check(
    "sessions list shows the session with its step count",
    await page.getByRole("table", { name: "Capture sessions" }).getByRole("row", { name: /Configure NTP on the branch firewall.*5/ }).isVisible(),
  );
  await shot(page, "light-sessions-list");
  await page.keyboard.press("Control+N");
  const newSessionShortcut = page.getByRole("dialog", { name: "New session" });
  await newSessionShortcut.waitFor({ timeout: 5000 }).catch(() => undefined);
  check("Ctrl+N opens New session on the Sessions page", await newSessionShortcut.isVisible());
  await page.keyboard.press("Escape");
  await page.getByRole("dialog").waitFor({ state: "hidden" });

  // 6c. Capture a display (Milestone 3). A display screenshot shows the real screen, so this session
  // is deleted again before any screenshot of the app is saved. Automation sandboxes often run on a
  // desktop that is not shown, where Windows refuses to read screen pixels: there the test checks
  // that the failure is explained and nothing is stored. Keys are injected only with --interactive.
  const screenReadable = (await win32("probe")).includes("screen=ok");
  console.log(`  INFO  screen pixels readable here: ${screenReadable}; interactive: ${interactive}`);
  await goTo(page, "Capture");
  await page.getByRole("heading", { name: "Start a capture" }).waitFor({ timeout: 10_000 });
  await page.getByRole("radio").first().waitFor({ timeout: 10_000 });
  const displaySize = sizeIn(await page.getByRole("radio", { name: /Primary display/ }).evaluate((input) => input.closest("label")?.textContent));
  await page.getByRole("radio", { name: /Primary display/ }).check();
  await page.getByLabel("New session title").fill("Display capture check");
  const foldersBefore = attachmentFolders();
  await page.getByRole("button", { name: "Start capture", exact: true }).click();
  await page.getByRole("button", { name: "Capture now", exact: true }).waitFor({ timeout: 10_000 });
  check("starting a capture opens the live capture workspace", await page.getByText("Display capture check", { exact: true }).isVisible());
  check("sidebar shows Recording", await page.getByRole("link", { name: /Capture status: Recording/ }).isVisible());
  check("capture bar shows state, time and count", await page.getByRole("status", { name: /Capture status: Recording, 0 screenshots/ }).isVisible());
  check("DevTrace excludes its own window from screen capture while recording", (await mainWindowAffinity()) === 17, `affinity=${await mainWindowAffinity()}`);
  check("tray icon window created while recording", await hasTrayIcon());
  check("capture shortcut registered with Windows", (await page.getByText("Capture shortcut unavailable").count()) === 0);

  await page.getByRole("button", { name: "Capture now", exact: true }).click();
  let displayShots = 0;
  if (screenReadable) {
    if (!(await stepsReached(page, 1, "Capture now adds a screenshot step"))) throw new Error("display capture failed");
    displayShots = 1;
    const displayFolder = attachmentFolders().find((name) => !foldersBefore.includes(name));
    const displayFiles = displayFolder ? filesIn(join(dataDir, "attachments", displayFolder)) : [];
    check("Capture now stores one PNG in the session folder", displayFiles.length === 1 && displayFiles[0].name.endsWith(".png"));
    try {
      const decoded = decodePng(readFileSync(join(dataDir, "attachments", displayFolder, displayFiles[0].name)));
      check(
        "display screenshot has the display's full resolution",
        displaySize && decoded.width === displaySize.width && decoded.height === displaySize.height,
        `${decoded.width}x${decoded.height}, display ${displaySize?.width}x${displaySize?.height}`,
      );
      check("display screenshot has real content", decoded.sampledColors > 3, `${decoded.sampledColors} distinct sampled colors`);
    } catch (error) {
      check("display screenshot decodes", false, String(error));
    }
    check("screenshot rendered through the evidence scheme", (await viewerImageWidth(page)) === displaySize?.width);
    check("inspector records how and what was captured", await page.getByText("Capture now button", { exact: true }).isVisible());
    check("inspector names the captured display", await page.getByRole("complementary", { name: "Session inspector" }).getByText("Display: Display 1").isVisible());
  } else {
    const alert = page.getByRole("alert").filter({ hasText: "Last screenshot failed" });
    await alert.waitFor({ timeout: 15_000 }).catch(() => undefined);
    check("an unreadable screen is reported instead of storing an image", (await alert.count()) === 1 && (await alert.innerText()).includes("could not be captured"));
    check("a failed capture adds no step and stores no file", (await stepCount(page)) === 0 && attachmentFolders().length === foldersBefore.length);
    check("the capture keeps recording after a failed screenshot", await page.getByRole("status", { name: /Capture status: Recording, 0 screenshots/ }).isVisible());
    skip("display screenshot pixels", "this desktop is not shown, so Windows refuses screen reads; run `npm run test:e2e -- --interactive` on a desktop");
  }

  if (interactive && screenReadable) {
    await win32("hotkey");
    if (await stepsReached(page, displayShots + 1, "the global shortcut takes a screenshot")) {
      displayShots += 1;
      check("the global shortcut takes a screenshot", true);
      check("shortcut screenshots are labeled as such", await page.getByText("Capture shortcut", { exact: true }).isVisible());
    }
  } else {
    skip("pressing the global shortcut", "keys are injected only with --interactive");
  }

  await page.getByRole("button", { name: "Pause capture" }).click();
  await page.getByRole("status", { name: /Capture status: Paused/ }).waitFor({ timeout: 5000 });
  check("pausing shows Paused everywhere", await page.getByRole("link", { name: /Capture status: Paused/ }).isVisible());
  const pausedCaptureNow = page.getByRole("button", { name: "Capture now", exact: true });
  check("Capture now is unavailable while paused", (await pausedCaptureNow.getAttribute("aria-disabled")) === "true");
  check("resuming or pausing clears the last failure", (await page.getByText("Last screenshot failed").count()) === 0);
  if (interactive && screenReadable) {
    await win32("hotkey");
    await page.getByText("Last screenshot failed").waitFor({ timeout: 5000 }).catch(() => undefined);
    check("the shortcut takes nothing while paused and says why", (await stepCount(page)) === displayShots && (await page.getByRole("alert").filter({ hasText: "paused" }).count()) === 1);
  }
  await page.getByRole("button", { name: "Resume capture" }).click();
  await page.getByRole("status", { name: /Capture status: Recording/ }).waitFor({ timeout: 5000 });
  check("resuming returns to Recording", await page.getByRole("link", { name: /Capture status: Recording/ }).isVisible());

  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await page.getByRole("heading", { name: "Start a capture" }).waitFor({ timeout: 10_000 });
  check("stopping returns to the capture setup", await page.getByText("Capture stopped").isVisible());
  check("sidebar shows Not recording after stop", await page.getByRole("link", { name: /Capture status: Not recording/ }).isVisible());
  check("window exclusion and tray icon end with the capture", (await mainWindowAffinity()) === 0 && !(await hasTrayIcon()));
  await goTo(page, "Sessions");
  const displayRow = page.getByRole("table", { name: "Capture sessions" }).getByRole("row", { name: /Display capture check/ });
  check("the captured session returns to Draft after stop", (await displayRow.innerText()).includes("Draft"), (await displayRow.innerText()).replace(/\s+/g, " "));
  await displayRow.click();
  await page.getByRole("heading", { level: 1, name: "Display capture check" }).waitFor({ timeout: 10_000 });
  await dismissToasts(page);
  await page.getByRole("button", { name: "More session actions" }).click();
  await page.getByRole("menuitem", { name: /Delete session/ }).click();
  await page.getByRole("dialog", { name: /Delete .Display capture check/ }).getByRole("button", { name: "Delete session" }).click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  check("display capture session and its files deleted", attachmentFolders().length === foldersBefore.length);

  // 6d. Capture a window with known content (a test window filled with steel blue)
  targetWindow = spawn(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File", win32Script, "-Action", "target"],
    { stdio: "ignore" },
  );
  await goTo(page, "Capture");
  await page.getByRole("heading", { name: "Start a capture" }).waitFor({ timeout: 10_000 });
  const targetListed = await waitForTarget(page, /E2E capture target/);
  check("a newly opened window appears after Refresh", targetListed);
  const targetRadio = page.getByRole("radio", { name: /E2E capture target/ });
  const windowSize = sizeIn(await targetRadio.evaluate((input) => input.closest("label")?.textContent));
  await targetRadio.check();
  await blurPrivateTargets(page);
  await shot(page, "light-capture-setup");
  await page.getByLabel("New session title").fill("Window capture check");
  const foldersBeforeWindow = attachmentFolders();
  await page.getByRole("button", { name: "Start capture", exact: true }).click();
  await page.getByRole("button", { name: "Capture now", exact: true }).waitFor({ timeout: 10_000 });
  await page.getByRole("button", { name: "Capture now", exact: true }).click();
  if (!(await stepsReached(page, 1, "Capture now captures the selected window"))) throw new Error("window capture failed");
  const windowFolder = attachmentFolders().find((name) => !foldersBeforeWindow.includes(name));
  const windowFiles = windowFolder ? filesIn(join(dataDir, "attachments", windowFolder)) : [];
  try {
    const decoded = decodePng(readFileSync(join(dataDir, "attachments", windowFolder, windowFiles[0].name)));
    check(
      "window screenshot has exactly the window's visible size",
      windowSize && decoded.width === windowSize.width && decoded.height === windowSize.height,
      `${decoded.width}x${decoded.height}, window ${windowSize?.width}x${windowSize?.height}`,
    );
    const steelBlue = (rgb) => Math.abs(rgb[0] - 70) <= 6 && Math.abs(rgb[1] - 130) <= 6 && Math.abs(rgb[2] - 180) <= 6;
    const center = decoded.pixel(Math.floor(decoded.width / 2), Math.floor(decoded.height / 2));
    check("window screenshot shows the window's actual content", steelBlue(center), `center rgb(${center.join(", ")})`);
    const right = decoded.pixel(decoded.width - 4, Math.floor(decoded.height / 2));
    const bottom = decoded.pixel(Math.floor(decoded.width / 2), decoded.height - 4);
    check("window screenshot is cropped 1:1 to the frame (no dark edges)", steelBlue(right) && steelBlue(bottom), `right rgb(${right.join(", ")}), bottom rgb(${bottom.join(", ")})`);
  } catch (error) {
    check("window screenshot decodes", false, String(error));
  }
  check(
    "inspector names the captured window",
    await page.getByRole("complementary", { name: "Session inspector" }).getByText(/Window: E2E capture target/).isVisible(),
  );

  // Annotations: a highlight box with a label, saved with the screenshot
  const inspector = page.getByRole("complementary", { name: "Session inspector" });
  await inspector.getByRole("button", { name: "Add box" }).click();
  await inspector.getByText("Annotations (1)").waitFor({ timeout: 5000 });
  await inspector.getByRole("textbox", { name: "Label for annotation 1" }).fill("Settings panel");
  await inspector.getByRole("textbox", { name: "Label for annotation 1" }).press("Enter");
  await page.waitForTimeout(500);
  check("annotation shown on the screenshot", await page.getByRole("region", { name: "Evidence viewer" }).getByText("1 Settings panel").isVisible().catch(() => false));
  await shot(page, "light-capture-workspace");
  // The capture is left running: the restart below simulates a crash during a capture.

  // 7. Persistence across restart (also leave dark theme to verify settings persistence)
  await setTheme(page, "Dark");
  await shutdown();
  page = await launch();
  check("theme persisted across restart", (await page.evaluate(() => document.documentElement.dataset.theme)) === "dark");
  await goTo(page, "Projects");
  check("project persisted across restart", await page.getByRole("table", { name: "Projects" }).getByText("Core Network Lab").isVisible());

  // 7a. A capture interrupted by the restart (process killed) is recovered as a draft
  check("no capture is running after a restart", await page.getByRole("link", { name: /Capture status: Not recording/ }).isVisible());
  check("no window exclusion or tray icon after a restart", (await mainWindowAffinity()) === 0 && !(await hasTrayIcon()));
  await goTo(page, "Sessions");
  const recoveredRow = page.getByRole("table", { name: "Capture sessions" }).getByRole("row", { name: /Window capture check/ });
  check("the interrupted capture session is back to Draft", (await recoveredRow.innerText()).includes("Draft"), await recoveredRow.innerText());
  await recoveredRow.click();
  await waitForSteps(page, 1);
  check("its captured screenshot survived the crash", (await viewerImageWidth(page)) > 0);
  check("its annotation survived the crash", await page.getByRole("complementary", { name: "Session inspector" }).getByText("Annotations (1)").isVisible());
  await dismissToasts(page);
  await page.getByRole("button", { name: "More session actions" }).click();
  await page.getByRole("menuitem", { name: /Delete session/ }).click();
  await page.getByRole("dialog", { name: /Delete .Window capture check/ }).getByRole("button", { name: "Delete session" }).click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  targetWindow?.kill();
  targetWindow = null;

  // 7b. Sessions persist across restart; then reopen, remove evidence and delete safely
  await goTo(page, "Sessions");
  const sessionRow = page.getByRole("table", { name: "Capture sessions" }).getByText("Configure NTP on the branch firewall");
  check("session persisted across restart", await sessionRow.isVisible());
  await sessionRow.click();
  await waitForSteps(page, 5);
  check("steps persisted across restart", (await stepCount(page)) === 5);
  check("completed status persisted", await page.getByText(/Steps and evidence are read-only/).isVisible());
  await steps(page).getByText("Pasted screenshot", { exact: true }).click();
  const restartWidth = await viewerImageWidth(page);
  check("screenshot still renders after restart", restartWidth === 1280, `naturalWidth=${restartWidth}`);
  await shot(page, "dark-session-workspace");
  await steps(page).getByText("Verify NTP synchronization", { exact: true }).click();
  await shot(page, "dark-session-command");
  await page.getByRole("tab", { name: "Session", exact: true }).click();
  check("session notes persisted across restart", (await page.getByLabel("Session notes").inputValue()).includes("Verified synchronization after 5 minutes."));
  await page.getByRole("tablist", { name: "Inspector" }).getByRole("tab").first().click();

  await page.getByRole("button", { name: "Reopen", exact: true }).click();
  await page.waitForFunction(() => {
    const add = [...document.querySelectorAll("header button")].find((button) => button.textContent?.trim() === "Add");
    return add && !add.hasAttribute("aria-disabled");
  });
  check(
    "reopened session accepts changes again",
    (await page.getByRole("button", { name: "Add", exact: true }).getAttribute("aria-disabled")) === null,
  );

  // 7c. Review (Milestone 4): decisions with comments and keys, filter, order, redaction, audit trail
  const reviewGroup = () => page.getByRole("group", { name: "Review decision" });
  await steps(page).getByText("Open System > Settings in the FortiGate GUI", { exact: true }).click();
  await page.getByLabel(/Review comment/).fill("Matches change ticket CHG-1042");
  await reviewGroup().getByRole("button", { name: "Approve" }).click();
  await steps(page).getByText("Approved").first().waitFor({ timeout: 5000 });
  check("a step is approved with a comment", (await reviewGroup().getByRole("button", { name: "Approve" }).getAttribute("aria-pressed")) === "true");
  await steps(page).getByText("Verify NTP synchronization", { exact: true }).click();
  await page.keyboard.press("a");
  await steps(page).getByText("ntp-status", { exact: true }).click();
  await page.keyboard.press("x");
  await steps(page).getByText("event-log", { exact: true }).click();
  await page.keyboard.press("r");
  await steps(page).getByText("Rejected").waitFor({ timeout: 5000 });
  check(
    "A, X and R record decisions on the focused step",
    (await steps(page).getByText("Approved").count()) === 2 && (await steps(page).getByText("Excluded").count()) === 1,
  );
  const markReviewed = page.getByRole("button", { name: "Mark reviewed" });
  check("Mark reviewed waits until every step has a decision", (await markReviewed.getAttribute("aria-disabled")) === "true");
  await page.getByRole("combobox", { name: "Show steps" }).selectOption("excluded");
  check("the step list filters by decision", (await stepCount(page)) === 1);
  await page.getByRole("combobox", { name: "Show steps" }).selectOption("all");
  await waitForSteps(page, 5);

  await steps(page).getByText("Pasted screenshot", { exact: true }).click();
  await page.keyboard.press("Alt+ArrowUp");
  await page.waitForFunction(() => document.querySelectorAll('[aria-label="Session steps"] [role="option"]')[1]?.textContent?.includes("Pasted screenshot"), null, {
    timeout: 5000,
  }).catch(() => undefined);
  const order = await page.locator('[aria-label="Session steps"] [role="option"]').allInnerTexts();
  check("Alt+Up moves a step and the order is saved", order[1]?.includes("Pasted screenshot"), order.map((text) => text.split("\n")[0]).join(" | "));

  // Redaction: mark the NTP server field, confirm, and check the stored pixels.
  await page.getByRole("button", { name: "Redact", exact: true }).click();
  const imageBox = await page.locator('section[aria-label="Evidence viewer"] img').boundingBox();
  const toScreen = (x, y) => [imageBox.x + (x * imageBox.width) / 1280, imageBox.y + (y * imageBox.height) / 760];
  await page.mouse.move(...toScreen(440, 140));
  await page.mouse.down();
  await page.mouse.move(...toScreen(770, 184), { steps: 8 });
  await page.mouse.up();
  check("marked areas are listed before anything changes", await page.getByText("1 area", { exact: true }).isVisible());
  await page.getByRole("button", { name: "Apply redaction\u2026" }).click();
  const redactDialog = page.getByRole("dialog", { name: "Permanently redact this screenshot?" });
  check("redaction asks for explicit confirmation", await redactDialog.isVisible());
  await redactDialog.getByRole("button", { name: /Black out/ }).click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  await page.getByText("Screenshot redacted").waitFor({ timeout: 10_000 }).catch(() => undefined);
  const afterRedaction = filesIn(sessionFolder);
  const redactedFile = afterRedaction.find((file) => file.name.includes("-redacted-"));
  check(
    "redaction writes a new image and deletes the original file",
    Boolean(redactedFile) && afterRedaction.length === 3 && !afterRedaction.some((file) => file.name === pastedFileName),
    afterRedaction.map((file) => file.name).join(", "),
  );
  try {
    const redacted = decodePng(readFileSync(join(sessionFolder, redactedFile.name)));
    const inside = redacted.pixel(605, 161);
    const outside = redacted.pixel(320, 420);
    check("the marked area is black in the stored pixels", inside.every((value) => value === 0), `inside rgb(${inside.join(", ")})`);
    check("pixels outside the marked area are unchanged", outside.every((value) => value === 255), `outside rgb(${outside.join(", ")})`);
  } catch (error) {
    check("the redacted image decodes", false, String(error));
  }
  check("the viewer shows the redacted image", (await viewerImageWidth(page)) === 1280);
  check("the screenshot is marked as redacted", await page.getByRole("complementary", { name: "Session inspector" }).getByText("Redacted", { exact: true }).isVisible());

  await steps(page).getByText("Pasted screenshot", { exact: true }).click();
  await page.keyboard.press("a");
  await page.waitForFunction(() => {
    const button = [...document.querySelectorAll("header button")].find((element) => element.textContent?.trim() === "Mark reviewed");
    return button && !button.hasAttribute("aria-disabled");
  }, null, { timeout: 5000 }).catch(() => undefined);
  await markReviewed.click();
  await page.getByText("Review finished").waitFor({ timeout: 5000 }).catch(() => undefined);
  check("the session is marked reviewed once every step has a decision", await page.locator("main").getByText("Reviewed", { exact: true }).first().isVisible());
  await page.getByRole("tab", { name: "Session", exact: true }).click();
  const historyText = await page.getByRole("list", { name: "Review history" }).innerText();
  check(
    "the review history records decisions, comments, the reorder and the redaction",
    ["Marked the session reviewed", "Redacted a screenshot", "Reordered the steps", "Matches change ticket CHG-1042", "Excluded"].every((text) => historyText.includes(text)),
  );
  await shot(page, "dark-session-review-history");
  await page.getByRole("tablist", { name: "Inspector" }).getByRole("tab").first().click();
  await steps(page).getByText("Pasted screenshot", { exact: true }).click();
  await shot(page, "dark-session-review");

  // 7d. Playbook (Milestone 5): generated from the approved steps, edited, published
  await page.getByRole("button", { name: "Create playbook", exact: true }).click();
  const playbookDoc = page.getByRole("article", { name: "Playbook document" });
  await playbookDoc.waitFor({ timeout: 10_000 });
  const playbookId = decodeURIComponent(page.url().split("/playbooks/")[1] ?? "");
  const stepTitles = await playbookDoc.locator('input[aria-label$=" title"][aria-label^="Step "]').evaluateAll((inputs) => inputs.map((input) => input.value));
  check(
    "the playbook contains only the approved steps, in review order",
    stepTitles.join(" | ") === "Open System > Settings in the FortiGate GUI | Pasted screenshot | Verify NTP synchronization",
    stepTitles.join(" | "),
  );
  check("generated steps are marked as coming from the session", (await playbookDoc.getByText("From session", { exact: true }).count()) === 3);
  check("nothing is invented for verification", await playbookDoc.getByText(/No verification steps yet/).isVisible());
  const playbookFolder = join(dataDir, "playbook-assets", playbookId);
  const copied = filesIn(playbookFolder);
  const redactedSource = filesIn(sessionFolder).find((file) => file.name.includes("-redacted-"));
  check(
    "approved evidence is copied into the playbook, already redacted",
    copied.length === 1 &&
      redactedSource !== undefined &&
      readFileSync(join(playbookFolder, copied[0].name)).equals(readFileSync(join(sessionFolder, redactedSource.name))),
    copied.map((file) => file.name).join(", "),
  );
  const playbookImageWidth = await page
    .waitForFunction(
      () => {
        const image = document.querySelector('article[aria-label="Playbook document"] img');
        return image && image.complete && image.naturalWidth > 0 ? image.naturalWidth : false;
      },
      null,
      { timeout: 10_000 },
    )
    .then((handle) => handle.jsonValue())
    .catch(() => 0);
  check("the playbook image renders through the evidence scheme", playbookImageWidth === 1280, `naturalWidth=${playbookImageWidth}`);

  await playbookDoc.getByRole("textbox", { name: "Purpose", exact: true }).fill("Keep the branch firewall clock aligned with the core NTP servers.");
  await playbookDoc.getByRole("textbox", { name: "Step 3 expected result" }).fill("The status shows the server as synchronized.");
  const verificationSection = playbookDoc.getByRole("region", { name: "Verification" });
  await verificationSection.getByRole("button", { name: "Add item" }).click();
  await verificationSection.getByRole("textbox", { name: "Verification item 1" }).fill("Log timestamps match the core switches after 5 minutes.");
  await page.getByText(/Saved at/).waitFor({ timeout: 10_000 }).catch(() => undefined);
  check("edits autosave", await page.getByText(/Saved at/).isVisible());
  check("an edited generated step is marked as edited", await playbookDoc.getByText("Edited after generation").first().isVisible());
  await shot(page, "dark-playbook-editor");

  await page.getByRole("button", { name: "Publish\u2026" }).click();
  const publishDialog = page.getByRole("dialog", { name: "Publish this playbook?" });
  await publishDialog.getByLabel(/Revision note/).fill("Initial procedure from the NTP change");
  await publishDialog.getByRole("button", { name: "Publish", exact: true }).click();
  await page.getByText(/This version is published and read-only/).waitFor({ timeout: 10_000 }).catch(() => undefined);
  check("publishing records revision 1 and locks the document", (await page.getByText(/This version is published and read-only/).isVisible()) && (await page.getByText("Revision 1", { exact: true }).isVisible()));
  check("published content is read-only", (await playbookDoc.getByRole("textbox", { name: "Playbook title" }).getAttribute("readonly")) !== null);
  await shot(page, "dark-playbook-published");

  // 7e. Export (Milestone 6): revision 1 as Markdown with images, self-contained HTML and PDF
  const exportsDir = join(dataDir, "exports");
  const slug = "configure-ntp-on-the-branch-firewall";
  const exportAs = async (format, screenshotName) => {
    await page.getByRole("button", { name: "Export\u2026" }).click();
    const dialog = page.getByRole("dialog", { name: "Export playbook" });
    await dialog.getByRole("radio", { name: format, exact: true }).click();
    if (screenshotName) await shot(page, screenshotName);
    await dialog.getByRole("button", { name: "Export", exact: true }).click();
    const done = page.getByRole("dialog", { name: "Export complete" });
    const finished = await done
      .waitFor({ timeout: 90_000 })
      .then(() => true)
      .catch(() => false);
    const text = finished ? await done.innerText() : await dialog.innerText().catch(() => "");
    return { done, finished, text };
  };
  await page.getByRole("button", { name: "Export\u2026" }).click();
  const exportVersion = await page
    .getByRole("dialog", { name: "Export playbook" })
    .getByLabel("Version")
    .evaluate((select) => select.options[select.selectedIndex]?.text ?? "");
  check("the export dialog offers the published revision", /^Revision 1 \u2014 published .* \(current\)$/.test(exportVersion), exportVersion);
  await page.getByRole("dialog", { name: "Export playbook" }).getByRole("button", { name: "Cancel" }).click();

  const markdownExport = await exportAs("Markdown", "dark-export-dialog");
  check("Markdown export completes", markdownExport.finished && markdownExport.text.includes(`Exported ${slug}.md`), markdownExport.text.replace(/\s+/g, " ").slice(0, 160));
  await shot(page, "dark-export-complete");
  await markdownExport.done.getByRole("button", { name: "Done" }).click();
  const markdownFolder = readdirSync(exportsDir).find((name) => new RegExp(`^${slug}-r1-\\d{8}-\\d{6}$`).test(name));
  check("the Markdown export is a folder named after the playbook and revision", Boolean(markdownFolder), readdirSync(exportsDir).join(", "));
  if (markdownFolder) {
    const markdown = readFileSync(join(exportsDir, markdownFolder, `${slug}.md`), "utf8");
    check(
      "Markdown keeps the structure, provenance and published state",
      markdown.startsWith("# Configure NTP on the branch firewall\n") &&
        markdown.includes("Published \u2014 revision 1") &&
        markdown.includes("**Revision note:** Initial procedure from the NTP change") &&
        markdown.includes("## Purpose\n\nKeep the branch firewall clock aligned with the core NTP servers.") &&
        markdown.includes("### 1. Open System \\> Settings in the FortiGate GUI") &&
        markdown.includes("*From session \u201cConfigure NTP on the branch firewall\u201d") &&
        markdown.includes("**Expected result:** The status shows the server as synchronized.") &&
        markdown.includes("## Verification\n\n- [ ] Log timestamps match the core switches after 5 minutes."),
      markdown.slice(0, 200).replace(/\n/g, "\\n"),
    );
    check(
      "Markdown links the screenshot from its images folder and says it was redacted",
      markdown.includes("](images/step-02-1.png)") && markdown.includes("*Areas of this screenshot were permanently redacted.*"),
    );
    try {
      const exportedImage = decodePng(readFileSync(join(exportsDir, markdownFolder, "images", "step-02-1.png")));
      const redactedPixel = exportedImage.pixel(605, 161);
      check(
        "the exported screenshot is the redacted evidence",
        exportedImage.width === 1280 && redactedPixel.every((value) => value === 0),
        `${exportedImage.width}px, rgb(${redactedPixel.join(", ")})`,
      );
    } catch (error) {
      check("the exported screenshot decodes", false, String(error));
    }
  }

  const htmlExport = await exportAs("HTML");
  check("HTML export completes", htmlExport.finished && /Exported configure-ntp-on-the-branch-firewall-r1-.*\.html/.test(htmlExport.text), htmlExport.text.replace(/\s+/g, " ").slice(0, 160));
  await htmlExport.done.getByRole("button", { name: "Done" }).click();
  const htmlFile = readdirSync(exportsDir).find((name) => name.startsWith(`${slug}-r1-`) && name.endsWith(".html"));
  if (htmlFile) {
    const html = readFileSync(join(exportsDir, htmlFile), "utf8");
    check(
      "HTML is self-contained, escaped and script-free",
      html.startsWith("<!DOCTYPE html>") &&
        html.includes("default-src 'none'") &&
        html.includes('src="data:image/png;base64,') &&
        html.includes("Open System &gt; Settings in the FortiGate GUI") &&
        !/<script/i.test(html) &&
        !html.includes("http://") &&
        !html.includes("https://"),
    );
  } else {
    check("the HTML file exists", false, readdirSync(exportsDir).join(", "));
  }

  const pdfExport = await exportAs("PDF");
  check("PDF export completes", pdfExport.finished && /Exported configure-ntp-on-the-branch-firewall-r1-.*\.pdf/.test(pdfExport.text), pdfExport.text.replace(/\s+/g, " ").slice(0, 200));
  if (pdfExport.finished) await pdfExport.done.getByRole("button", { name: "Done" }).click();
  else await page.keyboard.press("Escape");
  const pdfFile = readdirSync(exportsDir).find((name) => name.startsWith(`${slug}-r1-`) && name.endsWith(".pdf"));
  if (pdfFile) {
    const pdfBytes = readFileSync(join(exportsDir, pdfFile));
    check("the PDF file is a PDF", pdfBytes.subarray(0, 5).toString("latin1") === "%PDF-" && pdfBytes.length > 20_000, `${pdfBytes.length} bytes`);
    try {
      const { stdout } = await run32(
        "powershell.exe",
        [...POWERSHELL, "-Action", "pdf", "-Path", join(exportsDir, pdfFile), "-Out", join(shotsDir, "export-pdf-page1.png")],
        { windowsHide: true },
      );
      const info = Object.fromEntries(
        stdout
          .trim()
          .split(";")
          .map((pair) => pair.split("=")),
      );
      check(
        "Windows opens the PDF: A4 or Letter pages, rendered to a preview",
        Number(info.pages) >= 1 && (["794x1123", "816x1056"].includes(`${info.width}x${info.height}`)),
        stdout.trim(),
      );
    } catch (error) {
      check("Windows opens the PDF", false, String(error).slice(0, 200));
    }
  } else {
    check("the PDF file exists", false, readdirSync(exportsDir).join(", "));
  }
  check(
    "exports leave no temporary files behind",
    readdirSync(exportsDir).every((name) => !name.startsWith(".")),
    readdirSync(exportsDir).join(", "),
  );
  check("the hidden PDF window is closed afterwards", !(await devtraceWindows()).some((window) => window.title === "DevTrace PDF export"));

  // 7f. Version history (Milestone 7): compare, restore without losing work, outdated, duplicate
  const originalPurpose = "Keep the branch firewall clock aligned with the core NTP servers.";
  const changedPurpose = "Keep the branch clock within one second of the core NTP servers.";
  await page.getByRole("button", { name: "Edit as new draft" }).click();
  await playbookDoc.getByRole("textbox", { name: "Purpose", exact: true }).waitFor({ timeout: 10_000 });
  await playbookDoc.getByRole("textbox", { name: "Purpose", exact: true }).fill(changedPurpose);
  await page.getByText(/Saved at/).waitFor({ timeout: 10_000 }).catch(() => undefined);
  await page.getByRole("button", { name: "History", exact: true }).click();
  const versionsNav = page.getByRole("navigation", { name: "Versions" });
  await versionsNav.waitFor({ timeout: 10_000 });
  const revisionView = page.getByRole("article", { name: "Revision 1" });
  await revisionView.waitFor({ timeout: 10_000 }).catch(() => undefined);
  check(
    "version history lists the draft and revision 1 and shows the published text",
    (await versionsNav.getByRole("button", { name: /Current draft/ }).isVisible()) &&
      (await versionsNav.getByRole("button", { name: /Revision 1/ }).isVisible()) &&
      (await revisionView.getByText(originalPurpose).isVisible()),
  );
  await shot(page, "dark-history-read");
  await page.getByRole("tab", { name: "Compare" }).click();
  const comparison = page.getByRole("figure", { name: "Changes to Revision 1 \u2192 Current draft" });
  await comparison.waitFor({ timeout: 10_000 }).catch(() => undefined);
  const addedRow = comparison.locator("tr", { hasText: changedPurpose });
  const removedRow = comparison.locator("tr", { hasText: originalPurpose });
  check(
    "comparing shows the changed purpose as removed and added lines",
    (await addedRow.count()) === 1 &&
      (await removedRow.count()) === 1 &&
      (await addedRow.innerText()).includes("+") &&
      (await removedRow.innerText()).includes("\u2212"),
  );
  await shot(page, "dark-history-compare");
  await page.getByRole("tab", { name: "Read" }).click();
  await page.getByRole("button", { name: "Restore as draft\u2026" }).click();
  await page.getByRole("dialog", { name: "Restore revision 1 as the draft?" }).getByRole("button", { name: "Restore as draft", exact: true }).click();
  await playbookDoc.waitFor({ timeout: 10_000 });
  await page.getByText("Restored from revision 1").waitFor({ timeout: 10_000 }).catch(() => undefined);
  check(
    "restoring revision 1 brings its content back into the draft",
    (await page.getByText("Restored from revision 1").isVisible()) &&
      (await playbookDoc.getByRole("textbox", { name: "Purpose", exact: true }).inputValue()) === originalPurpose,
  );
  await page.getByRole("button", { name: "History", exact: true }).click();
  await versionsNav.waitFor({ timeout: 10_000 });
  check("the replaced draft is kept as a saved draft", await page.getByText("Saved drafts (1)").isVisible());
  await versionsNav.getByRole("button", { name: /Saved draft/ }).click();
  const savedDraftText = await page
    .getByRole("article", { name: "Saved draft" })
    .getByText(changedPurpose)
    .waitFor({ timeout: 10_000 })
    .then(() => true)
    .catch(() => false);
  check("the saved draft still has the unpublished text", savedDraftText);
  await page.getByRole("navigation", { name: "Breadcrumb" }).getByRole("link", { name: "Configure NTP on the branch firewall" }).click();
  await playbookDoc.waitFor({ timeout: 10_000 });

  await page.getByRole("button", { name: "More playbook actions" }).click();
  await page.getByRole("menuitem", { name: /Mark as out of date/ }).click();
  const outdatedDialog = page.getByRole("dialog", { name: "Mark this procedure as out of date?" });
  await outdatedDialog.getByLabel(/What changed/).fill("FortiOS 7.6 moved the NTP settings.");
  await outdatedDialog.getByRole("button", { name: "Mark as out of date", exact: true }).click();
  await page.getByText(/Marked out of date on/).waitFor({ timeout: 10_000 }).catch(() => undefined);
  check("a published procedure can be marked out of date", await page.getByText(/Marked out of date on/).isVisible());
  await shot(page, "dark-playbook-outdated");

  await page.getByRole("button", { name: "More playbook actions" }).click();
  await page.getByRole("menuitem", { name: /Duplicate as new playbook/ }).click();
  await page
    .waitForFunction(() => document.querySelector('input[aria-label="Playbook title"]')?.value === "Copy of Configure NTP on the branch firewall", null, {
      timeout: 10_000,
    })
    .catch(() => undefined);
  const copyId = decodeURIComponent(page.url().split("/playbooks/")[1] ?? "");
  const copyFiles = filesIn(join(dataDir, "playbook-assets", copyId));
  check(
    "duplicating creates a new draft with its own copy of the screenshot",
    copyId !== playbookId &&
      (await playbookDoc.getByRole("textbox", { name: "Playbook title" }).inputValue()) === "Copy of Configure NTP on the branch firewall" &&
      copyFiles.length === 1 &&
      readFileSync(join(dataDir, "playbook-assets", copyId, copyFiles[0].name)).equals(readFileSync(join(playbookFolder, copied[0].name))),
    `${copyFiles.length} file(s)`,
  );
  check("the duplicate says where it came from", await page.getByRole("complementary", { name: "Playbook properties" }).getByText(/Duplicated from/).isVisible());
  await goTo(page, "Knowledge Library");
  const libraryTable = page.getByRole("table", { name: "Library playbooks" });
  check("the published playbook appears in the Knowledge Library", await libraryTable.getByText("Configure NTP on the branch firewall", { exact: true }).isVisible());
  check("the library marks it out of date and leaves out the unpublished copy", (await libraryTable.getByText("Out of date").isVisible()) && (await libraryTable.getByText(/^Copy of/).count()) === 0);
  await goTo(page, "Sessions");
  await page.getByRole("table", { name: "Capture sessions" }).getByText("Configure NTP on the branch firewall").click();
  await waitForSteps(page, 5);

  await steps(page).getByText("event-log", { exact: true }).click();
  await page.getByRole("list", { name: "Attached screenshots" }).getByRole("button", { name: "Remove screenshot" }).click();
  const removeDialog = page.getByRole("dialog", { name: "Remove this screenshot?" });
  await removeDialog.getByRole("button", { name: "Remove screenshot" }).click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  check("removing a screenshot deletes its file", (await waitForFiles(sessionFolder, 2)).length === 2);
  check("the step itself is kept", (await stepCount(page)) === 5);

  await dismissToasts(page);
  await page.getByRole("button", { name: "More session actions" }).click();
  await page.getByRole("menuitem", { name: /Delete session/ }).click();
  const deleteDialog = page.getByRole("dialog", { name: /Delete .Configure NTP/ });
  check(
    "session delete lists exactly what will be removed",
    (await deleteDialog.getByText("5 steps", { exact: true }).isVisible()) && (await deleteDialog.getByText(/2 screenshots/).isVisible()),
  );
  await shot(page, "dark-session-delete");
  await deleteDialog.getByRole("button", { name: "Delete session" }).click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  await page.waitForFunction(() => document.querySelector("header h1")?.textContent === "Sessions");
  check("deleting the session returns to the list", (await heading(page)) === "Sessions");
  check("session attachment folder removed from disk", !existsSync(sessionFolder));
  check("no orphaned evidence files remain", filesIn(join(dataDir, "attachments")).length === 0);
  check("deleted session no longer listed", await page.getByText("No sessions yet").isVisible());

  // 7g. Advanced capture and integrations (Milestone 8): automatic capture after screen changes
  // (opt-in; no input hooks), a terminal log written by a real PowerShell transcript, a watched
  // configuration file, and changes reviewed and verified in Change History.
  targetWindow = spawn(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File", win32Script, "-Action", "changing"],
    { stdio: "ignore" },
  );
  await goTo(page, "Capture");
  await page.getByRole("heading", { name: "Start a capture" }).waitFor({ timeout: 10_000 });
  check("a window that keeps changing is listed as a capture target", await waitForTarget(page, /E2E changing target/));
  await page.getByRole("radio", { name: /E2E changing target/ }).check();
  const autoSwitch = page.getByRole("switch", { name: "Also capture automatically when the screen changes" });
  check("automatic capture is off unless switched on", (await autoSwitch.getAttribute("aria-checked")) === "false");
  await autoSwitch.click();
  await page.getByLabel("New session title").fill("Harden SSH on the lab server");
  await page.getByRole("button", { name: "Start capture", exact: true }).click();
  await page.getByRole("button", { name: "Capture now", exact: true }).waitFor({ timeout: 10_000 });
  check("the capture status says automatic capture is on", await page.getByRole("status", { name: /automatic capture on/ }).isVisible());
  // The test window switches color every 4 seconds; each settled change is captured once.
  let autoShots = 0;
  for (const deadline = Date.now() + 25_000; Date.now() < deadline && autoShots < 2; ) {
    await page.waitForTimeout(1000);
    autoShots = await stepCount(page);
  }
  check("automatic capture takes screenshots after the window changes and settles", autoShots >= 2, `${autoShots} screenshots in 25 s`);
  if (autoShots > 0) {
    await steps(page).getByText("Screenshot of E2E changing target", { exact: true }).first().click();
    check(
      "automatic screenshots say how they were taken",
      await page.getByRole("complementary", { name: "Session inspector" }).getByText("Automatic capture", { exact: true }).isVisible(),
    );
  }
  await page.getByRole("button", { name: "Pause capture" }).click();
  await page.getByRole("status", { name: /Capture status: Paused/ }).waitFor({ timeout: 5000 });
  const pausedShots = await stepCount(page);
  await page.waitForTimeout(9000);
  check("nothing is captured automatically while paused", (await stepCount(page)) === pausedShots, `${pausedShots} before, ${await stepCount(page)} after`);
  await page.getByRole("button", { name: "Auto capture", exact: true }).click();
  await page.waitForFunction(() =>
    [...document.querySelectorAll("button[aria-pressed]")].some((button) => button.textContent?.trim() === "Auto capture" && button.getAttribute("aria-pressed") === "false"),
  );
  await page.getByRole("button", { name: "Resume capture" }).click();
  await page.getByRole("status", { name: /Capture status: Recording/ }).waitFor({ timeout: 5000 });
  await page.waitForTimeout(9000);
  check(
    "switching automatic capture off stops automatic screenshots",
    (await stepCount(page)) === pausedShots && (await page.getByRole("status", { name: /automatic capture on/ }).count()) === 0,
    `${await stepCount(page)} screenshots`,
  );
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await page.getByRole("heading", { name: "Start a capture" }).waitFor({ timeout: 10_000 });
  targetWindow?.kill();
  targetWindow = null;

  // Terminal log: DevTrace prepares a log file; the user's own PowerShell writes the transcript.
  await goTo(page, "Sessions");
  await page.getByRole("table", { name: "Capture sessions" }).getByText("Harden SSH on the lab server").click();
  await page.getByRole("heading", { level: 1, name: "Harden SSH on the lab server" }).waitFor({ timeout: 10_000 });
  const hardenId = decodeURIComponent(page.url().split("/sessions/")[1]?.split("?")[0] ?? "");
  await dismissToasts(page);
  await page.getByRole("tab", { name: "Session", exact: true }).click();
  const terminalGroup = page.getByRole("group", { name: "Terminal log" });
  await terminalGroup.getByRole("button", { name: "Start terminal log" }).click();
  const transcriptCommand = terminalGroup.getByLabel("Command to start the transcript");
  await transcriptCommand.waitFor({ timeout: 10_000 });
  const logPath = /-Path "(.+)" -Append/.exec(await transcriptCommand.innerText())?.[1] ?? "";
  check(
    "the terminal log is an empty file inside the session's workspace folder",
    logPath.toLowerCase().startsWith(join(dataDir, "terminal-logs", hardenId).toLowerCase()) && existsSync(logPath) && statSync(logPath).size === 0,
    logPath,
  );
  await run32(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", `Start-Transcript -Path '${logPath}' -Append | Out-Null; Write-Output 'sshd is running'; Stop-Transcript | Out-Null`],
    { windowsHide: true },
  );
  const transcriptStep = steps(page).getByText("Terminal output (1 line)", { exact: true });
  check(
    "output written by a real PowerShell transcript becomes a step (header and footer skipped)",
    await transcriptStep
      .waitFor({ timeout: 15_000 })
      .then(() => true)
      .catch(() => false),
  );
  appendFileSync(
    logPath,
    [
      "PS C:\\lab> Get-Service sshd",
      "",
      "Status   Name               DisplayName",
      "------   ----               -----------",
      "Running  sshd               OpenSSH SSH Server",
      "",
      "PS C:\\lab> .\\rotate-keys.ps1 -Password Hunter2x",
      "Keys rotated.",
      "PS C:\\lab> Restart-Service sshd",
      "",
    ].join("\r\n"),
  );
  const restartStep = steps(page).getByText("Restart-Service sshd", { exact: true });
  const commandsRecorded = await restartStep
    .waitFor({ timeout: 15_000 })
    .then(() => true)
    .catch(() => false);
  check("prompt lines become command steps", commandsRecorded && (await steps(page).getByText("Get-Service sshd", { exact: true }).isVisible()));
  check(
    "values that look like secrets are masked before they are stored",
    (await steps(page).getByText(".\\rotate-keys.ps1 -Password ********", { exact: true }).count()) === 1 && !(await page.content()).includes("Hunter2x"),
  );
  await steps(page).getByText("Get-Service sshd", { exact: true }).click();
  check("a command step keeps the output that followed it", await page.getByRole("complementary", { name: "Session inspector" }).getByText(/OpenSSH SSH Server/).first().isVisible());
  await page.getByRole("tab", { name: "Session", exact: true }).click();
  await terminalGroup.getByRole("button", { name: "Stop terminal log" }).click();
  await page.getByText("Terminal logging stopped").waitFor({ timeout: 10_000 }).catch(() => undefined);
  check("stopping the terminal log reports the recorded steps", await page.getByText("4 steps recorded.", { exact: true }).isVisible().catch(() => false));

  // Watched configuration file: picked in the file dialog (test hook), changes become steps.
  writeFileSync(watchedConfig, "# Lab SSH server\nPort 22\nPermitRootLogin yes\nPasswordAuthentication yes\n");
  const watchGroup = page.getByRole("group", { name: "Watched files" });
  await watchGroup.getByRole("button", { name: "Watch a file\u2026" }).click();
  await watchGroup.getByText("No changes yet").waitFor({ timeout: 10_000 }).catch(() => undefined);
  check("a watched file is listed with its name and path", (await watchGroup.getByText("sshd_config", { exact: true }).isVisible()) && (await watchGroup.getByText(watchedConfig).isVisible()));
  await page.waitForTimeout(1500);
  writeFileSync(watchedConfig, "# Lab SSH server\nPort 22\nPermitRootLogin no\nPasswordAuthentication yes\n");
  const changedStep = steps(page).getByText("Changed: sshd_config", { exact: true });
  check(
    "a change to the watched file becomes a step",
    await changedStep
      .waitFor({ timeout: 15_000 })
      .then(() => true)
      .catch(() => false),
  );
  await watchGroup.getByText(/1 change recorded/).waitFor({ timeout: 5000 }).catch(() => undefined);
  check("the watched file counts its recorded changes", await watchGroup.getByText(/1 change recorded/).isVisible());
  await shot(page, "dark-session-integrations");
  await changedStep.click();
  const stepContent = page.getByRole("region", { name: "Step content" });
  await stepContent.waitFor({ timeout: 10_000 }).catch(() => undefined);
  const stepText = await stepContent.innerText().catch(() => "");
  check(
    "the change step shows the removed and added lines",
    stepText.includes("- PermitRootLogin yes") && stepText.includes("+ PermitRootLogin no"),
    stepText.replace(/\s+/g, " ").slice(0, 160),
  );
  check(
    "the inspector names the watched file",
    await page.getByRole("complementary", { name: "Session inspector" }).locator("dd").filter({ hasText: watchedConfig }).isVisible(),
  );
  await page.getByRole("tab", { name: "Session", exact: true }).click();
  await watchGroup.getByRole("button", { name: "Stop watching sshd_config" }).click();
  await watchGroup.getByText("sshd_config", { exact: true }).waitFor({ state: "detached", timeout: 10_000 }).catch(() => undefined);
  check("watching a file stops with one click", (await watchGroup.getByText("sshd_config", { exact: true }).count()) === 0);

  // Change History: the observed file change and a declared change, reviewed and verified.
  await goTo(page, "Change History");
  const changeTable = page.getByRole("table", { name: "Change history" });
  const observedRow = changeTable.getByRole("row", { name: /sshd_config/ });
  await observedRow.waitFor({ timeout: 10_000 }).catch(() => undefined);
  const observedText = await observedRow.innerText().catch(() => "");
  check("the file change is an observed change pending review", observedText.includes("Observed") && observedText.includes("Pending"), observedText.replace(/\s+/g, " "));
  await observedRow.click();
  const changeDetails = page.getByRole("complementary", { name: "Change details" });
  await changeDetails.waitFor({ timeout: 10_000 });
  check(
    "the observed change links its source, session and step",
    (await changeDetails.getByText("Watched configuration file").isVisible()) &&
      (await changeDetails.getByRole("link", { name: "Harden SSH on the lab server" }).isVisible()) &&
      (await changeDetails.getByRole("link", { name: "Changed: sshd_config" }).isVisible()),
  );
  await changeDetails.getByLabel(/^Comment/).fill("Expected: root login disabled by the hardening guide.");
  await changeDetails.getByRole("button", { name: "Approve", exact: true }).click();
  await observedRow.getByText("Approved").waitFor({ timeout: 10_000 }).catch(() => undefined);
  const approvedText = await observedRow.innerText();
  check(
    "approving an observed change keeps its evidence level and the comment",
    approvedText.includes("Approved") &&
      approvedText.includes("Observed") &&
      (await changeDetails.locator("dd").filter({ hasText: "Expected: root login disabled by the hardening guide." }).count()) === 1,
    approvedText.replace(/\s+/g, " "),
  );

  await page.getByRole("button", { name: "Record Change", exact: true }).click();
  const recordDialog = page.getByRole("dialog", { name: "Record a change" });
  await recordDialog.getByLabel("What changed").fill("sshd: PasswordAuthentication");
  await recordDialog.getByLabel("Session (evidence)").selectOption({ label: "Harden SSH on the lab server" });
  await recordDialog.getByLabel(/^Value before/).fill("yes");
  await recordDialog.getByLabel(/^Value after/).fill("no");
  await recordDialog.getByRole("button", { name: "Record change", exact: true }).click();
  await recordDialog.waitFor({ state: "hidden", timeout: 10_000 });
  const declaredRow = changeTable.getByRole("row", { name: /sshd: PasswordAuthentication/ });
  await declaredRow.waitFor({ timeout: 10_000 }).catch(() => undefined);
  const declaredText = await declaredRow.innerText().catch(() => "");
  check("a recorded change is declared and pending", declaredText.includes("Declared") && declaredText.includes("Pending"), declaredText.replace(/\s+/g, " "));
  await changeDetails.getByRole("button", { name: "Approve", exact: true }).click();
  await declaredRow.getByText("Approved").waitFor({ timeout: 10_000 }).catch(() => undefined);
  await changeDetails.getByRole("button", { name: "Mark verified\u2026" }).click();
  const verifyDialog = page.getByRole("dialog", { name: "Mark this change as verified?" });
  await verifyDialog.getByRole("button", { name: "Mark verified", exact: true }).click();
  check(
    "verifying without saying how is refused",
    await verifyDialog
      .getByText("How the outcome was verified is required.")
      .waitFor({ timeout: 5000 })
      .then(() => true)
      .catch(() => false),
  );
  await verifyDialog.getByLabel("How the outcome was verified").fill('sshd -T | findstr passwordauthentication returned "passwordauthentication no".');
  await verifyDialog.getByRole("button", { name: "Mark verified", exact: true }).click();
  await verifyDialog.waitFor({ state: "hidden", timeout: 10_000 });
  await declaredRow.getByText("Verified").waitFor({ timeout: 10_000 }).catch(() => undefined);
  check(
    "a change is verified only with a note on how it was checked",
    (await declaredRow.innerText()).includes("Verified") && (await changeDetails.getByText(/findstr passwordauthentication/).isVisible()),
  );
  await shot(page, "dark-change-history-review");

  // Deleting the session removes its screenshots and terminal logs; change records remain.
  await goTo(page, "Sessions");
  await page.getByRole("table", { name: "Capture sessions" }).getByText("Harden SSH on the lab server").click();
  await page.getByRole("heading", { level: 1, name: "Harden SSH on the lab server" }).waitFor({ timeout: 10_000 });
  await dismissToasts(page);
  await page.getByRole("button", { name: "More session actions" }).click();
  await page.getByRole("menuitem", { name: /Delete session/ }).click();
  await page.getByRole("dialog", { name: /Delete .Harden SSH/ }).getByRole("button", { name: "Delete session" }).click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  check(
    "deleting the session removes its screenshots and terminal logs",
    !existsSync(join(dataDir, "terminal-logs", hardenId)) && filesIn(join(dataDir, "attachments")).length === 0,
  );
  await goTo(page, "Change History");
  await changeTable.getByText("sshd: PasswordAuthentication").waitFor({ timeout: 10_000 }).catch(() => undefined);
  check(
    "change records outlive the deleted session",
    (await changeTable.getByText("sshd: PasswordAuthentication").isVisible()) && (await changeTable.getByRole("row", { name: /sshd_config/ }).isVisible()),
  );
  await goTo(page, "Settings");
  check(
    "Settings lists the integrations and where to find them",
    (await page.getByText("PowerShell transcript", { exact: true }).isVisible()) && (await page.getByText("Configuration file watch", { exact: true }).isVisible()),
  );

  // 7h. Reliability (Milestone 9): per-command permissions, workspace backup and restore.
  const deniedDialog = await page.evaluate(async () => {
    try {
      await window.__TAURI_INTERNALS__.invoke("plugin:dialog|open", { options: {} });
      return "allowed";
    } catch (error) {
      return String(error);
    }
  });
  const deniedOpener = await page.evaluate(async () => {
    try {
      await window.__TAURI_INTERNALS__.invoke("plugin:opener|open_path", { path: "C:\\Windows\\notepad.exe" });
      return "allowed";
    } catch (error) {
      return String(error);
    }
  });
  check(
    "the webview cannot call plugin commands no capability grants (file dialog, opener)",
    deniedDialog !== "allowed" && deniedOpener !== "allowed" && /not allowed|denied|permission/i.test(`${deniedDialog} ${deniedOpener}`),
    `${deniedDialog.slice(0, 80)} | ${deniedOpener.slice(0, 80)}`,
  );

  mkdirSync(join(runDir, "backups-elsewhere"), { recursive: true });
  const backupGroup = page.getByRole("region", { name: "Backup and restore" });
  await backupGroup.getByRole("button", { name: "Back up workspace\u2026" }).click();
  await backupGroup.getByText("Backup saved", { exact: true }).waitFor({ timeout: 30_000 }).catch(() => undefined);
  const backupBytes = existsSync(backupFile) ? readFileSync(backupFile) : Buffer.alloc(0);
  check(
    "a backup is saved as one zip file where the user chose",
    backupBytes.length > 1000 && backupBytes.subarray(0, 4).toString("hex") === "504b0304" && (await backupGroup.getByText(backupFile).isVisible()),
    `${backupBytes.length} bytes`,
  );
  check("the backup leaves no temporary files behind", !existsSync(`${backupFile}.partial`) && !readdirSync(join(dataDir, "backups")).some((name) => name.startsWith(".backup-")));
  await shot(page, "dark-settings-backup");

  // Work done after the backup is replaced by the restore (and kept aside).
  await goTo(page, "Projects");
  await page.getByRole("button", { name: "New Project" }).click();
  await page.getByRole("dialog").getByLabel("Name").fill("Created after the backup");
  await page.getByRole("dialog").getByRole("button", { name: "Create project" }).click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  await goTo(page, "Settings");
  await backupGroup.getByRole("button", { name: "Restore from backup\u2026" }).click();
  const restoreDialog = page.getByRole("dialog", { name: "Restore this backup?" });
  await restoreDialog.waitFor({ timeout: 15_000 }).catch(() => undefined);
  check(
    "restoring first shows what the backup contains",
    (await restoreDialog.getByText("devtrace-backup.zip", { exact: true }).isVisible().catch(() => false)) &&
      (await restoreDialog.getByText(/1 project, 0 sessions, 2 playbooks, 2 changes/).isVisible().catch(() => false)),
  );
  await shot(page, "dark-restore-confirm");
  await restoreDialog.getByRole("button", { name: "Restore backup", exact: true }).click();
  await page.getByText("Backup restored", { exact: true }).waitFor({ timeout: 30_000 }).catch(() => undefined);
  await page.waitForSelector('nav[aria-label="Main"]', { timeout: 30_000 });
  const previousFolders = readdirSync(join(dataDir, "backups")).filter((name) => name.startsWith("before-restore-"));
  check(
    "after the restore, the app reloads and says where the replaced data is kept",
    (await page.getByText("Backup restored", { exact: true }).isVisible().catch(() => false)) &&
      previousFolders.length === 1 &&
      existsSync(join(dataDir, "backups", previousFolders[0] ?? "-", "devtrace.sqlite3")),
    previousFolders.join(", "),
  );
  check("the restore leaves no staging folder behind", !readdirSync(join(dataDir, "backups")).some((name) => name.startsWith("restore-staging-")));
  await goTo(page, "Projects");
  const projectsTable = page.getByRole("table", { name: "Projects" });
  await projectsTable.getByText("Core Network Lab").waitFor({ timeout: 10_000 }).catch(() => undefined);
  check(
    "the restored workspace has the backed-up data and not the later changes",
    (await projectsTable.getByText("Core Network Lab").isVisible()) && (await projectsTable.getByText("Created after the backup").count()) === 0,
  );
  await goTo(page, "Knowledge Library");
  await page.getByRole("table", { name: "Library playbooks" }).getByText("Configure NTP on the branch firewall", { exact: true }).click();
  await page.getByRole("button", { name: "History", exact: true }).waitFor({ timeout: 10_000 }).catch(() => undefined);
  const restoredImage = await page
    .waitForFunction(
      () => {
        const images = [...document.querySelectorAll("main img")];
        return images.length > 0 && images.every((image) => image.complete && image.naturalWidth > 0);
      },
      null,
      { timeout: 10_000 },
    )
    .then(() => true)
    .catch(() => false);
  check("restored playbooks still show their screenshots", restoredImage);

  // 8. Delete
  await goTo(page, "Projects");
  await page.getByRole("table", { name: "Projects" }).getByText("Core Network Lab").click();
  await page.getByRole("complementary", { name: "Project details" }).getByRole("button", { name: "Delete" }).click();
  const confirm = page.getByRole("dialog");
  check("delete asks for confirmation", await confirm.getByText(/permanently removed/).isVisible());
  await page.screenshot({ path: join(shotsDir, "dark-delete-confirm.png") });
  await confirm.getByRole("button", { name: "Delete project" }).click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  check("project deleted", await page.getByText("No projects yet").isVisible());

  // 9. Responsive: narrow windows force the compact sidebar
  await page.setViewportSize({ width: 980, height: 680 });
  await page.waitForTimeout(300);
  const narrowWidth = await page.evaluate(() => document.querySelector("nav[aria-label='Main']").getBoundingClientRect().width);
  check("narrow window uses compact sidebar", narrowWidth <= 60, `${Math.round(narrowWidth)}px`);
  check(
    "sidebar toggle explains why it is unavailable when narrow",
    (await page.getByRole("button", { name: "Show sidebar" }).getAttribute("aria-disabled")) === "true",
  );
  await page.screenshot({ path: join(shotsDir, "dark-narrow-projects.png") });

  // 10. Dev-only component gallery is excluded from this build
  await page.evaluate(() => {
    window.location.hash = "#/dev/components";
  });
  await page.waitForTimeout(200);
  check("dev component gallery not routable in built app", (await heading(page)) === "Not found");

  // The two evidence requests refused on purpose above log "failed to load resource"; nothing else may.
  for (const violation of accessibility.violations) {
    console.log(`  A11Y  [${violation.impact}] ${violation.screen}: ${violation.id} - ${violation.help} (${violation.targets.join(", ")})`);
  }
  const seriousViolations = accessibility.violations.filter((violation) => violation.impact === "serious" || violation.impact === "critical");
  check(
    `no serious or critical accessibility violations on ${accessibility.screens} audited screens (axe-core, WCAG 2.1 A/AA)`,
    seriousViolations.length === 0 && accessibility.screens >= 20,
    seriousViolations
      .slice(0, 3)
      .map((violation) => `${violation.screen}: ${violation.id}`)
      .join(" | "),
  );
  const unexpected = consoleErrors.filter(
    (entry) => !(entry.url.includes("evidence.localhost/0190f5c2-7a3b-7c3d-8e4f-123456789abc") || entry.url.includes("devtrace.sqlite3")),
  );
  check(
    "no console errors or uncaught exceptions",
    unexpected.length === 0,
    unexpected
      .slice(0, 3)
      .map((entry) => `${entry.text} ${entry.url}`)
      .join(" | "),
  );
}

try {
  await run();
} catch (error) {
  check("test run completed without exceptions", false, error instanceof Error ? error.message : String(error));
} finally {
  await shutdown();
  targetWindow?.kill();
  if (!keep) rmSync(runDir, { recursive: true, force: true });
}

const failed = results.filter((result) => !result.ok);
const skippedNote = skipped.length > 0 ? ` ${skipped.length} skipped (see SKIP lines).` : "";
console.log(`\n${results.length - failed.length}/${results.length} checks passed.${skippedNote} Screenshots: ${shotsDir}`);
process.exit(failed.length === 0 ? 0 : 1);
