import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const root = process.cwd();
const require = createRequire(join(root, "package.json"));
const { chromium } = require("playwright-core");

const binary = resolve(join(root, "src-tauri", "target", "debug", "devtrace.exe"));
const port = 9375;
const testDir = join(root, ".e2e", `shots-autocapture-${Date.now()}`);
const dataDir = join(testDir, "workspace");
const profileDir = join(testDir, "webview-profile");
const outDir = join(root, "docs", "linkedin-screenshots");
const artifactDir = "C:/Users/verga/.gemini/antigravity/brain/374475d9-ca05-4fc1-934d-e08e6507a003";

mkdirSync(dataDir, { recursive: true });
mkdirSync(profileDir, { recursive: true });
mkdirSync(outDir, { recursive: true });

let slideshowChild = null;
let child = null;
let viteChild = null;
let browser = null;

async function run() {
  try {
    console.log("1. Starting slideshow window in PowerShell...");
    const slideshowScript = join(root, "scripts", "slideshow.ps1");
    slideshowChild = spawn(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", slideshowScript, "-IntervalMs", "4000"],
      { cwd: root, stdio: "ignore" }
    );
    await delay(2000);

    console.log("2. Checking Vite dev server...");
    let viteReady = false;
    try {
      const res = await fetch("http://localhost:1420");
      if (res.ok) viteReady = true;
    } catch {}

    if (!viteReady) {
      console.log("Spawning Vite dev server...");
      const npxCmd = process.platform === "win32" ? "npx.cmd" : "npx";
      viteChild = spawn(npxCmd, ["vite", "--port", "1420", "--strictPort"], {
        cwd: root,
        stdio: "ignore",
        shell: true,
      });
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        try {
          const res = await fetch("http://localhost:1420");
          if (res.ok) {
            viteReady = true;
            break;
          }
        } catch {}
        await delay(200);
      }
      console.log("Vite ready.");
    }

    console.log("3. Launching DevTrace desktop app...");
    child = spawn(binary, [], {
      env: {
        ...process.env,
        DEVTRACE_DATA_DIR: dataDir,
        WEBVIEW2_USER_DATA_FOLDER: profileDir,
        WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
      },
      stdio: "ignore",
    });

    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/json/version`);
        if (response.ok) break;
      } catch {}
      await delay(300);
    }

    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    let page = null;
    for (let i = 0; i < 30 && !page; i++) {
      page = browser.contexts().flatMap((c) => c.pages())[0] ?? null;
      if (!page) await delay(200);
    }
    if (!page) throw new Error("No page found");

    await page.waitForSelector('nav[aria-label="Main"]', { timeout: 20_000 });
    await page.setViewportSize({ width: 1440, height: 900 });

    // Enable dark theme
    await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Settings", exact: true }).click();
    await page.getByRole("radio", { name: "Dark" }).click();
    await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
    await delay(300);

    // 4. Navigate to Capture and find the slideshow target
    console.log("4. Navigating to Capture screen and finding target...");
    await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Capture", exact: true }).click();
    await page.getByRole("heading", { name: "Start a capture" }).waitFor({ timeout: 10_000 });

    let targetFound = false;
    for (let attempt = 0; attempt < 20; attempt++) {
      await page.getByRole("button", { name: "Refresh", exact: true }).click();
      await delay(600);
      const count = await page.getByRole("radio", { name: /DevTrace Slideshow Display/ }).count();
      if (count > 0) {
        targetFound = true;
        break;
      }
    }

    if (!targetFound) {
      console.log("Target not found by title, selecting first available window/display target...");
      await page.getByRole("radio").first().check();
    } else {
      console.log("Target 'DevTrace Slideshow Display' found! Selecting it...");
      await page.getByRole("radio", { name: /DevTrace Slideshow Display/ }).check();
    }

    // Toggle on automatic capture
    const autoSwitch = page.getByRole("switch", { name: "Also capture automatically when the screen changes" });
    if ((await autoSwitch.getAttribute("aria-checked")) !== "true") {
      await autoSwitch.click();
    }

    await page.getByLabel("New session title").fill("Visual Feature Guide");
    console.log("5. Starting auto-capture...");
    await page.getByRole("button", { name: "Start capture", exact: true }).click();
    await page.getByRole("button", { name: "Capture now", exact: true }).waitFor({ timeout: 10_000 });

    // Let the slideshow run and let DevTrace's auto-capture observe visual changes
    console.log("Auto-capture is now actively watching the changing slides in memory...");
    const stepCountLocator = () => page.locator('[aria-label="Session steps"] [role="option"]').count();

    const captureDeadline = Date.now() + 25_000;
    let count = 0;
    while (Date.now() < captureDeadline) {
      await delay(2000);
      count = await stepCountLocator();
      console.log(`Auto-captured steps so far: ${count}`);
      if (count >= 4) break;
    }

    // Stop capture
    console.log("Stopping capture...");
    await page.getByRole("button", { name: "Stop", exact: true }).click();
    await delay(1000);

    // 6. Review and approve the steps
    console.log("6. Reviewing and approving steps in the session...");
    await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Sessions", exact: true }).click();
    await delay(500);
    await page.getByRole("table", { name: "Capture sessions" }).getByText("Visual Feature Guide").first().click();
    await page.getByRole("heading", { level: 1, name: "Visual Feature Guide" }).waitFor({ timeout: 10_000 });

    const stepOptions = await page.locator('[aria-label="Session steps"] [role="option"]').all();
    console.log(`Found ${stepOptions.length} captured steps to approve...`);
    for (let i = 0; i < stepOptions.length; i++) {
      await stepOptions[i].click();
      await delay(200);
      const approveBtn = page.getByRole("button", { name: "Approve", exact: true });
      if (await approveBtn.isVisible()) {
        await approveBtn.click();
        await delay(200);
      }
    }

    await page.getByRole("button", { name: "Mark reviewed" }).click();
    await delay(500);

    // 7. Create Playbook
    console.log("7. Creating Playbook from approved steps...");
    await page.getByRole("button", { name: "Create playbook" }).click();
    const playbookDoc = page.locator('article[aria-label="Playbook document"]');
    await playbookDoc.waitFor({ timeout: 10_000 });

    await playbookDoc
      .getByRole("textbox", { name: "Purpose", exact: true })
      .fill("Complete engineering reference showcasing DevTrace's automatic screen-change capture, terminal transcript logging, and versioned multi-format export capabilities.");
    await delay(1000);

    // Publish the playbook
    console.log("Publishing Playbook revision 1...");
    await page.getByRole("button", { name: "Publish…", exact: true }).click();
    const publishDialog = page.getByRole("dialog", { name: "Publish this playbook?" });
    await publishDialog.getByLabel(/Revision note/).fill("Initial published visual guide with auto-captured evidence");
    await publishDialog.getByRole("button", { name: "Publish", exact: true }).click();
    await page.getByText(/This version is published and read-only/).waitFor({ timeout: 10_000 });

    // 8. Export as PDF
    console.log("8. Exporting playbook to PDF (Windows)...");
    await page.getByRole("button", { name: "Export…", exact: true }).click();
    const exportDialog = page.getByRole("dialog", { name: "Export playbook" });
    await delay(300);
    await exportDialog.getByRole("button", { name: "Export", exact: true }).click();

    const doneDialog = page.getByRole("dialog", { name: "Export complete" });
    await doneDialog.waitFor({ timeout: 60_000 });
    console.log("PDF Export complete!");
    await doneDialog.getByRole("button", { name: "Done" }).click();

    // 9. Locate the generated PDF
    const exportsDir = join(dataDir, "exports");
    const exportedFiles = existsSync(exportsDir) ? readdirSync(exportsDir) : [];
    const pdfFileName = exportedFiles.find((f) => f.endsWith(".pdf"));
    if (!pdfFileName) throw new Error("Exported PDF file not found in " + exportsDir);

    const pdfSrcPath = join(exportsDir, pdfFileName);
    const pdfDestPath = join(outDir, "DevTrace-Feature-Playbook.pdf");
    const pdfArtifactPath = join(artifactDir, "DevTrace-Feature-Playbook.pdf");

    copyFileSync(pdfSrcPath, pdfDestPath);
    copyFileSync(pdfSrcPath, pdfArtifactPath);
    console.log(`Exported PDF copied to:\n  ${pdfDestPath}\n  ${pdfArtifactPath}`);

    // 10. Render the PDF page using PowerShell e2e-win32.ps1 -Action pdf
    console.log("10. Rendering PDF pages to PNG preview...");
    const win32Script = join(root, "scripts", "e2e-win32.ps1");
    const page1Out = join(outDir, "DevTrace-Playbook-PDF-page1.png");
    const page1Artifact = join(artifactDir, "DevTrace-Playbook-PDF-page1.png");

    const renderProc = spawn(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", win32Script, "-Action", "pdf", "-Path", pdfDestPath, "-Out", page1Out],
      { cwd: root }
    );

    await new Promise((resolveRender) => renderProc.once("exit", resolveRender));

    if (existsSync(page1Out)) {
      copyFileSync(page1Out, page1Artifact);
      console.log(`Rendered PDF Page 1 saved to:\n  ${page1Out}\n  ${page1Artifact}`);
    }

    console.log("\nSUCCESS: All auto-capture and PDF export steps completed!");
  } catch (err) {
    console.error("Pipeline error:", err);
  } finally {
    try {
      slideshowChild?.kill();
    } catch {}
    try {
      await browser?.close();
    } catch {}
    if (child && child.exitCode === null) child.kill();
    if (viteChild && viteChild.exitCode === null) viteChild.kill();
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {}
  }
}

run();
