# DevTrace

**Perform a task, capture what happened, review the evidence, and turn the result into a repeatable procedure.**

DevTrace is a desktop-first, local-first engineering workflow capture and documentation application. It is designed to record user-approved technical workflows (screenshots, events, commands, configuration changes) and transform reviewed evidence into structured, editable, versioned technical playbooks — for IT support, networking, security, software development, cloud infrastructure, system administration, QA and other technical work.

> [!IMPORTANT]
> **Current status: all nine roadmap milestones are complete** (Windows-verified; see [Known limitations](#known-limitations)). You can capture screenshots of a display or an application window you choose — while a capture you started is recording, when you press **Capture now**, the capture shortcut or the tray menu item, and, if you switch it on, automatically after the screen visibly changes — document tasks with steps, notes, commands and your own images, record commands and output from a terminal you log yourself, watch configuration files for changes, review every step (approve, reject, exclude, reorder, permanently redact screenshot areas) with an audit trail, turn the approved steps into structured playbooks that you edit and publish as revisions, export any version as Markdown, self-contained HTML or PDF, read, compare and restore published revisions, record, review and verify configuration changes, and back up and restore the whole workspace. Installers are built for Windows (unsigned). See [docs/ROADMAP.md](docs/ROADMAP.md) and [docs/INSTALL.md](docs/INSTALL.md).

## What works in this build

| Area | Status |
|---|---|
| Application shell: sidebar, workspace selector, contextual toolbar, breadcrumbs, back/forward | Working |
| Light, dark and system themes (persisted; native title bar follows) | Working |
| Overview with real counts and lists from the database; New Session; Start Capture | Working |
| Projects: create, rename/edit, search, sort, inspect, delete (related records are kept); open or start a project's sessions | Working |
| Sessions: create, rename/edit details, search, filter (status, review, project), sort, open, complete/reopen, delete with an exact impact summary | Working |
| Session workspace: timeline of steps, notes and commands; screenshots from file, paste or drop; attach and remove images; highlight annotations; autosaved session notes | Working |
| Capture (Windows): choose a display or window, start/pause/resume/stop, Capture now, global shortcut, tray icon and menu, live status everywhere, DevTrace hidden from its own screenshots, crash recovery | Working — see limitations |
| Automatic capture after screen changes (opt-in per capture; no input hooks) | Working (Windows) |
| Terminal logs: commands and output from a PowerShell transcript or a plain log you start yourself, with secret masking | Working |
| Watched configuration files: each change becomes a step and an observed change | Working |
| Review: approve / reject / exclude each step (buttons or A/R/X/P), comments, filter, reorder (Alt+↑/↓), permanent redaction of screenshot areas, audit trail, Mark reviewed | Working |
| Settings: theme, reduced motion, compact sidebar, workspace name, author name, capture shortcut, data location, backup and restore, integrations, diagnostics | Working |
| Playbooks: create from approved steps or blank, document editor with provenance, autosave, review and publish with immutable revisions, delete | Working |
| Export: Markdown with an images folder, self-contained HTML, PDF (Windows); the working draft or any published revision | Working |
| Version history: read and compare any versions, restore a revision without losing the draft, mark out of date, duplicate | Working |
| Knowledge Library: search/filter/sort published playbooks, freshness, open from the library | Working |
| Change History: record declared changes, observed changes from watched files, approve/reject with comments, verify with a required note, filters, links to sessions and steps | Working |
| Backup and restore: the whole workspace as one verified zip; restore keeps the replaced data | Working |
| Windows installers (NSIS per-user, MSI per-machine) | Built, not code-signed — see [INSTALL.md](docs/INSTALL.md) |
| Accessibility: keyboard operation, screen-reader names, WCAG 2.1 AA contrast; automated axe-core audit of 40+ screens in both themes | Automated checks pass; no manual screen-reader testing yet |

## Capturing a task (Milestone 3)

1. Open **Capture** (or **Start Capture** on the Overview). Choose where screenshots go (a draft session or a new one) and what to capture: a display, or a visible application window. Optionally switch on **Also capture automatically when the screen changes**. **Start capture**.
2. Work as usual. Take a screenshot whenever something worth documenting is on screen: **Capture now**, the capture shortcut (default `Ctrl+Alt+Shift+S`, configurable in Settings) or the tray icon's menu. With automatic capture on (also switchable with **Auto capture** while recording), DevTrace additionally takes a screenshot when the target changed visibly and settled — at most one every 3 seconds and 12 per minute. Each screenshot becomes a step with its time, target and how it was taken.
3. **Pause** when you do something private: nothing can be captured until you resume, automatically or otherwise. The sidebar, the capture bar and the tray icon (red dot recording, amber paused) always show the state.
4. **Stop** when done. Review the screenshots, add steps, notes, commands and highlight boxes (**Annotate** in the viewer, or **Add box** in the inspector), then **Complete** the session.

DevTrace never records keystrokes, clicks or typed text. Automatic capture compares small grayscale samples of the chosen target in memory; it notices visible changes, not input. While recording, DevTrace's own window is hidden from screenshots.

## Recording terminal work and configuration changes (Milestone 8)

Both are opt-in per session, in the session's **Session** tab under **Integrations**, show their state while on, stop with one click, and add steps that still need review.

- **Terminal log**: choose the format (PowerShell transcript, or a plain text log for PuTTY and similar tools) and **Start terminal log**. DevTrace creates a log file in the workspace and shows what to do: in PowerShell, run the shown `Start-Transcript -Path "…" -Append` command (copy button) and `Stop-Transcript` when done; for other tools, set their log file to the shown path. Each command becomes a command step with its output; other output becomes a terminal output step. Values that look like secrets (`password=…`, `-Password …`, tokens, `Bearer …`) are replaced with `********` before anything is stored — a safety net, not a guarantee. DevTrace never runs or attaches to a terminal.
- **Watched files**: **Watch a file…** and pick a text configuration file (up to 1 MB) in the system dialog. Each saved change becomes a step listing the removed and added lines, and an **observed** change in Change History with the full text before and after.
- **Change History**: **Record Change** to declare a change you made (what, where, values before and after, linked session). Approve or reject each change with a comment, and **Mark verified…** with a note on how you checked the outcome — DevTrace never verifies anything by itself, and an observed change is never shown as confirmed.

## Reviewing a session (Milestone 4)

1. Open the session. For each step, choose **Approve** (correct and relevant), **Reject** (wrong or misleading) or **Exclude** (irrelevant) in the inspector, optionally with a comment — or focus the step list and press `A`, `R`, `X` (`P` sets a step back to pending). Only approved steps will be used for playbooks.
2. Use the **Show steps** filter to see what is still pending. Reorder steps with **Move up/down** or `Alt+↑/↓`.
3. To hide a password, token or personal data, open the screenshot, choose **Redact**, drag over each sensitive area, then **Apply redaction…** and confirm. The areas are blacked out in the image file itself and the original image is deleted.
4. When every step has a decision, **Mark reviewed**. The inspector's **Session** tab shows the full review history (who decided what, when, and why).

## Writing a playbook (Milestone 5)

1. In a reviewed session choose **Create playbook** (or **New Playbook** on the Playbooks page or **Create Playbook** on the Overview). Each approved step becomes a numbered step with its description, command and screenshots; nothing else is copied and nothing is invented.
2. Complete the document: purpose, scope, prerequisites, permissions, instructions, expected results, verification, warnings, troubleshooting and rollback. Labels show which content came from the session, which was edited afterwards and which was written in the playbook. Changes save automatically.
3. **Submit for review** (editing is locked) or **Publish…** directly. Publishing records an immutable revision with an optional note; **Edit as new draft** starts the next version.

## Exporting a playbook (Milestone 6)

1. In the playbook, choose **Export…**, pick the version (the current draft, or any published revision — a published playbook defaults to its newest revision) and the format:
   - **Markdown** — a `.md` file with an `images` folder, for Git repositories, wikis and editors.
   - **HTML** — one self-contained `.html` file with the screenshots embedded; no scripts, nothing loaded from the network.
   - **PDF** (Windows) — the HTML export printed by WebView2, on A4 or Letter paper following your Windows region, with the title, date and page numbers.
2. Files are written to the workspace `exports` folder (never overwriting an earlier export). **Show in folder** opens it in File Explorer.

Exports keep the document structure, numbered steps, monospaced commands, warnings, verification checklists, and where each step came from. Screenshots keep their redactions, and highlight boxes are drawn with numbers that match a caption list. Unpublished, superseded and out-of-date versions are labeled as such inside the file.

## Working with versions (Milestone 7)

1. In a playbook, choose **History**. The list shows the working copy, every published revision (date, author, note) and saved drafts.
2. **Read** shows any version as a read-only document. **Compare** shows the line-by-line differences between any two versions (unchanged lines are collapsed; switch **Show unchanged lines** to see everything).
3. **Restore as draft…** puts a revision's content back into the working copy. If the working copy had unpublished changes, they are kept as a **saved draft** you can restore later; published revisions never change.
4. In the editor's **⋯** menu: **Mark as out of date…** warns readers (editor, lists, library and exports) that a published procedure no longer matches reality, until you mark it current or publish a new revision; **Duplicate as new playbook** starts an independent copy (for example for another environment) that remembers where it came from.

## Documenting a task manually (Milestone 2)

1. **Sessions → New Session** (or `Ctrl+N`). Give it a title and, optionally, a project, application or platform, environment and notes.
2. In the session, use **Add** to record a **Step** (what you did), a **Note** (context or a decision) or a **Command** (stored as text; DevTrace never runs it). `Ctrl+N` adds a step; double-click a step to edit it.
3. Add screenshots you take yourself: press **Ctrl+V** after copying a screenshot (for example with Win+Shift+S), **drag image files** into the session, or choose **Add → Screenshot from file**. Use **Attach screenshot…** to add an image to an existing step. PNG, JPEG, GIF and WebP up to 25 MB are accepted; the file content is checked, not just its name.
4. Session notes in the inspector's **Session** tab save automatically.
5. **Complete** the session when the documentation is finished: steps and screenshots become read-only until you **Reopen** it (review decisions remain possible).

## Backing up, restoring and installing (Milestone 9)

- **Settings → Backup and restore → Back up workspace…** saves the database, screenshots, playbook images and terminal logs as one `.zip` file wherever you choose, with a checksum for every file. **Restore from backup…** checks a backup completely before anything changes, shows what it contains, and keeps the data it replaces in the workspace's `backups/before-restore-<time>/` folder.
- `npm run tauri build` creates a per-user NSIS installer and a per-machine MSI in `src-tauri/target/release/bundle/`. They are not code-signed. Installing, updating (there is no automatic updater), uninstalling and signing are described in [docs/INSTALL.md](docs/INSTALL.md).
- If DevTrace ever stops because of an internal error, a crash report is written to `logs/` in the workspace. It stays on your computer.

## Requirements

Developed and verified on **Windows 11** (x64). macOS and Linux are expected to work with Tauri's platform prerequisites but have not been tested.

- Node.js **22.12+** (verified with 24.15) and npm
- Rust **1.90+** stable, MSVC toolchain on Windows (verified with 1.99)
- Visual Studio 2022 Build Tools with the "Desktop development with C++" workload and a Windows SDK
- Microsoft Edge WebView2 Runtime (preinstalled on Windows 11)

See the [Tauri prerequisites](https://tauri.app/start/prerequisites/) for other platforms.

## Getting started

```powershell
npm install
npm run tauri dev
```

The first Rust build compiles all dependencies and takes a few minutes; later builds are incremental.

## Commands

| Command | Purpose |
|---|---|
| `npm run tauri dev` | Run the desktop app with hot reload |
| `npm run tauri build` | Build an optimized app and installers (`src-tauri/target/release/bundle`) |
| `npm run tauri build -- --debug --no-bundle` | Fast debug build with the frontend embedded (used by the E2E test) |
| `npm run typecheck` | TypeScript type checks (app and tooling) |
| `npm run lint` | ESLint, the design-token check (`scripts/check-tokens.mjs`) and the command-permission check (`scripts/check-permissions.mjs`) |
| `npm test` | Frontend unit and integration tests (Vitest + Testing Library) |
| `npm run test:rust` | Rust unit tests (`cargo test`) |
| `npm run test:e2e` | End-to-end test against the built desktop app (Windows), including an axe-core accessibility audit; `-- --binary <path>` tests another build, e.g. `src-tauri/target/release/devtrace.exe` |
| `npm run test:e2e -- --interactive` | Also verifies display capture and the capture shortcut; run it on a desktop you are watching (it captures the screen, then deletes the screenshots, and presses `Ctrl+Alt+Shift+S`) |
| `npm run check` | Type check, lint, frontend tests and Rust tests |

Rust formatting and linting: `cargo fmt --manifest-path src-tauri/Cargo.toml` and `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`.

## Where data is stored

Everything is stored locally in one **workspace directory**:

| Platform | Default location |
|---|---|
| Windows | `%APPDATA%\com.devtrace.desktop\` |
| macOS | `~/Library/Application Support/com.devtrace.desktop/` |
| Linux | `~/.local/share/com.devtrace.desktop/` |

It contains `devtrace.sqlite3` (the database) and the managed folders `attachments/` (screenshots, one folder per session), `playbook-assets/` (screenshots copied into playbooks), `exports/` (exported Markdown, HTML and PDF files), `terminal-logs/` (log files your terminal writes while a terminal log is on, one folder per session), `backups/` (database copies made before schema upgrades, and data replaced by a restore) and, if needed, `logs/` (local crash reports). Before any schema migration of an existing database, DevTrace writes a full copy of the database to `backups/`. Settings → Workspace shows the exact path and can open it in the file manager.

Set `DEVTRACE_DATA_DIR` to use a different workspace directory (the automated tests use this so they never touch real data).

**Back up** with **Settings → Backup and restore**, or by closing DevTrace and copying the whole workspace directory (the database and the folders belong together).

## Privacy

- Local-first: no account, no cloud service, no hosted backend.
- No telemetry, analytics or crash reporting. Crash reports, if any, are written only to the workspace's `logs/` folder.
- The interface's Content Security Policy blocks connections to external servers.
- The webview is granted only core window permissions and an explicit list of DevTrace's own commands — no file system, shell, dialog, HTTP or shortcut plugins. Screenshots reach the backend as bytes you explicitly chose, pasted or dropped, or as captures you triggered; no file paths are sent by the webview, and images are displayed through an id-based `evidence` scheme that never exposes file locations or caches evidence elsewhere. Files to watch, backups to restore and where to save a backup are chosen in system dialogs, which the backend opens.
- Capture runs only while you record and only for the display or window you chose: when you press Capture now, the capture shortcut or the tray menu item, and — only if you switch automatic capture on — after the chosen target visibly changed (small grayscale samples compared in memory and discarded). Pause guarantees nothing is captured or sampled. Keystrokes, clicks and typed text are never recorded; there are no keyboard or mouse hooks; the capture shortcut is registered with Windows only while recording.
- Terminal logs and watched files are opt-in per session, visible while on and stopped with the session. DevTrace reads only the log file it created for you and the files you picked; it never runs commands or attaches to terminals. Secret-looking values in terminal text are masked before they are stored (the raw log file in the workspace is not modified).
- DevTrace reads the clipboard only when you paste into a session. Commands you document are stored as text and never executed.
- Exports are written only when you ask, only into the workspace `exports` folder. Exported HTML contains no scripts and loads nothing from the network; PDFs are rendered locally in a hidden window that has no access to DevTrace's commands.
- Backups are written only when you ask, only where you choose; DevTrace never uploads them. Restoring keeps the data it replaces.
- The sidebar always shows the capture status; while recording, a tray icon is shown and DevTrace hides its own window from screenshots (this also hides it from screen-sharing tools until the capture stops).

## Project structure

```
src/                 React + TypeScript frontend
  styles/            Design tokens (tokens.css) and base styles
  components/        Shared UI components
  layout/            Application shell, sidebar, page scaffold
  features/          Screens (overview, capture, sessions, playbooks, changes, library, projects, settings)
  lib/               API client, hooks, formatting, validation, status vocabulary
  app/               Providers, routing, system screens
src-tauri/           Rust backend (Tauri 2)
  src/db/            SQLite connection, migrations and SQL
  src/features/      Domain types, queries and Tauri commands per feature
  src/capture/       Native capture: controller, screen/window capture, automatic capture, tray and shortcut
  src/integrations/  Terminal logs (log formats, secret masking) and watched configuration files
  src/export/        Export: document model, Markdown and HTML renderers, PDF printing
  src/backup.rs      Workspace backup (zip with checksums) and verified, reversible restore
  src/dialogs.rs     System file dialogs, opened from Rust
  src/crash.rs       Local crash reports
  src/storage.rs     Evidence file storage (validation, hashing, atomic writes, contained paths)
  src/protocol.rs    `evidence` URI scheme that serves stored images by id
  build.rs           Command list for the per-command permission manifest
  capabilities/      What the main window may call (core window APIs and the listed commands)
scripts/             Token and permission checks, E2E test and its Windows helpers
docs/                Installation, architecture, data model, roadmap and decision records
```

## Documentation

- [Installing, updating and backing up](docs/INSTALL.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Data model](docs/DATA_MODEL.md)
- [Roadmap](docs/ROADMAP.md)
- [Decisions](docs/DECISIONS.md)

## Known limitations

- Playbook text is plain text (no rich formatting). Version comparison is line-based text; screenshots are compared by identity and size, not pixel by pixel.
- Exports are saved to the workspace `exports` folder; there is no "save as" location chooser yet. PDF export is available on Windows only. Large screenshots move to the next PDF page rather than being split, which can leave space at the bottom of a page.
- Capture is implemented and verified on **Windows only**; other platforms show it as unavailable. Display capture and pressing the shortcut have not yet been verified on a visible desktop (the automated tests ran on a desktop that is not shown, where Windows refuses screen reads); window capture, automatic capture of a window, the tray, window exclusion and crash recovery were verified automatically. Run `npm run test:e2e -- --interactive` to verify display capture on your machine.
- Protected content (for example DRM video) and some exclusive-fullscreen applications capture as black; DevTrace refuses to store such images. Windows refuses screen capture while the screen is locked or a remote session is disconnected. Minimized windows cannot be captured and are not listed.
- Automatic capture reacts to visible changes of the chosen target only: it cannot tell which control was clicked, and a click that changes nothing on screen is not captured. Fast animations or videos in the target settle rarely, so they produce few automatic screenshots.
- Terminal logs read PowerShell transcripts and plain text logs written by your own terminal; prompts other than `PS …>` are recorded as output rather than commands. Secret masking catches common patterns only — review recorded steps before publishing. Watched files are checked every second, so several saves within about two seconds become one change.
- Deleting a session or step cannot be undone, and neither can redaction (by design). Redacted GIF and WebP screenshots are stored as PNG.
- One local workspace per installation; switching workspaces is not supported yet. A restore replaces the whole workspace (no merging).
- Installers are not code-signed (SmartScreen warns), there is no automatic updater, and running the installers was not exercised by the automated tests (the release executable and the one inside the MSI were). Accessibility was checked automatically (axe-core) but not yet with screen readers.
- Verified on Windows 11 only; macOS and Linux builds are untested.
- The E2E test uses WebView2's DevTools protocol and is Windows-specific.
