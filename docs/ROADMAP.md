# Roadmap

Each milestone is completed and verified before the next begins. Status reflects the actual code in this repository.

| # | Milestone | Status |
|---|---|---|
| 1 | Application foundation and design system | **Complete** |
| 2 | Local session management | **Complete** |
| 3 | Basic capture | **Complete** |
| 4 | Event review | **Complete** |
| 5 | Playbook creation | **Complete** |
| 6 | Export | **Complete** |
| 7 | Version history | **Complete** |
| 8 | Advanced capture and integrations | **Complete** |
| 9 | Reliability and distribution | **Complete** |

## Milestone 1 — Application foundation and design system (complete)

Delivered:

- Tauri 2 + React 19 + TypeScript 6 + Rust + SQLite project with npm scripts for development, checks and builds.
- Centralized design tokens (light and dark, specification palette, accessible accent variants), base styles, reduced-motion support, and an automated token check.
- Shared component library (buttons, fields, select, search, switch, segmented control, tabs, data table, status badges, empty states, notices, dialogs, menus, tooltips, toasts, inspector, timeline, screenshot viewer, diff view).
- Application shell: sidebar with brand, workspace selector, grouped navigation, always-visible capture status, compact mode; contextual toolbar with back/forward and breadcrumbs; `Ctrl+1…8`, `Ctrl+,`, `Ctrl+\`, `Ctrl+F`, `Ctrl+N`.
- Screens: Overview, Capture, Sessions, Playbooks, Change History, Knowledge Library, Projects, Settings — all reading real data, with honest empty and unavailable states.
- SQLite schema v1 with migrations, pre-migration backups and newer-version protection; projects CRUD; persisted settings; degraded mode if storage fails.
- Tests: 37 Rust unit tests, 38 frontend tests, design-token check, and a 36-check end-to-end test against the real desktop binary (including persistence across restart and responsive layout).

## Milestone 2 — Local session management (complete)

Delivered:

- Sessions: create (title, project, application/platform, environment, notes), edit and rename, autosaved notes, mark completed / reopen (completed sessions keep steps and evidence read-only), and safe deletion with an exact impact summary and verified file removal.
- Session workspace (`/sessions/:id`): step timeline, evidence viewer and inspector; reachable from Sessions, Overview, Projects and the Capture page. Sessions list with New Session (`Ctrl+N`), step counts, search, filters and a URL-driven project filter.
- Event model: manually written **steps**, **notes** and **commands** (monospaced, stored as text, never executed) and **screenshot** steps; edit; delete. Every event records its source (`manual`, `file`, `clipboard`; `capture` reserved).
- Evidence storage: images supplied by the user through the file chooser, paste (`Ctrl+V`, e.g. after Win+Shift+S) or drag and drop; attach more images to an existing step; remove images. Content-based type detection (PNG/JPEG/GIF/WebP), 25 MB / 20 000 px limits, SHA-256, atomic writes, contained relative paths, rollback on failure, and an id-based `evidence` URI scheme for display.
- Migration 2 (`events`, `attachments`) with an upgrade test from a real version 1 workspace, including the automatic backup.
- Tests: 63 Rust unit tests, 52 frontend tests, design-token check, and a 77-check end-to-end test on the real binary (debug and release).

Deliberately not included (later milestones): screen or window capture, pause/resume (3); approving, rejecting, reordering, excluding and redacting events (4); playbook generation (5).

Known limitations: images must be provided by the user; event order is the order of entry; session deletion cannot be undone; single local workspace; verified on Windows only.

## Milestone 3 — Basic capture (complete)

Delivered:

- Capture workspace: choose a draft session (or create one) and a target — any display, or a visible application window (minimized windows and DevTrace's own windows are not listed) — then **Start capture**. While recording: **Capture now**, **Pause/Resume**, **Stop**; the live session (timeline, evidence viewer, inspector) stays on screen.
- Screenshots only on request: the Capture now button, a global capture shortcut (default `Ctrl+Alt+Shift+S`, configurable in Settings, registered only while recording) or the tray menu. No keyboard, mouse or click monitoring.
- Always-visible state: sidebar (Recording/Paused with count), capture bar (state, elapsed time, count), a tray icon with a red/amber status dot and menu, and a recording banner on the session page. DevTrace's own window is excluded from screen capture while recording.
- Windows implementation: displays through GDI, windows through `PrintWindow` with full-content rendering, cropped 1:1 to the visible frame (works for covered windows). Black results are refused; failures (locked screen, closed or minimized window) are explained in the capture workspace.
- Each screenshot becomes a screenshot step with `source = capture` and metadata (trigger, target, size, time) shown in the inspector.
- Non-destructive annotations: highlight boxes drawn on the image (Annotate) or added from the inspector, with labels; saved per screenshot.
- Lifecycle safety: one capture at a time; recording sessions cannot be completed, reopened or deleted; Stop returns the session to draft; captures interrupted by a crash are recovered as drafts at startup; exit ends the capture.
- Schema v3 (`attachments.annotations_json`, `attachments.redacted_at`, `review_decisions`), with the upgrade from v2 covered by tests.
- Tests: 84 Rust unit tests (state machine, session transitions and recovery, annotations, capture metadata, PNG encoding, frame cropping), 61 frontend tests (capture flow, settings, annotations), and an end-to-end run on the real binary with real window capture checked pixel by pixel, the window exclusion and tray state checked through Win32, and crash recovery.

Known limitations: verified on Windows only (other platforms report capture as unavailable). **Display capture and pressing the shortcut have not yet been verified on a visible desktop**: the automated environment runs DevTrace on a desktop that is not shown, where Windows refuses screen reads (there the test verifies the explained failure instead) and where keys are not injected. Run `npm run test:e2e -- --interactive` on a normal desktop to verify both. Protected content and some exclusive-fullscreen applications cannot be captured. "Private mode" is provided by Pause (nothing can be captured while paused); automatic capture and per-application exclusions arrive in Milestone 8.

## Milestone 4 — Event review (complete)

Delivered:

- A decision on every step: **Approve**, **Reject** (wrong or misleading), **Exclude** (irrelevant) or back to **Pending**, from the inspector (with an optional comment) or with `A` / `R` / `X` / `P` on the focused step. Decided steps show their status in the list; rejected and excluded steps are dimmed. A filter shows all, pending, approved, rejected or excluded steps.
- Reordering with Move up/down or `Alt+↑/↓`, saved atomically from the complete order.
- **Redaction**: mark areas on a screenshot, confirm, and DevTrace burns black rectangles into a new image file, switches the evidence to it and deletes the original; the screenshot shows when it was redacted.
- Audit trail (`review_decisions`): every decision, comment, reorder, redaction and review completion with time and reviewer, shown per step and for the whole session.
- Session review state: in review after the first action; **Mark reviewed** only when every step has a decision; reopened automatically when a step becomes pending or new evidence arrives, or explicitly.
- Tests: 93 Rust unit tests (incl. decisions, audit trail, review state transitions, reordering rules, redaction pixels and file replacement, limits and locks), 71 frontend tests, and end-to-end checks of decisions by button and key, filtering, reordering, a real redaction verified in the stored pixels, the audit trail and marking reviewed.

Known limitations: there is no bulk approval (each step is reviewed deliberately); redacted GIF/WebP screenshots become PNG; redaction cannot be undone by design.

## Milestone 5 — Playbook creation (complete)

Delivered:

- **Create playbook** from a session (toolbar after review, or the session menu, or New Playbook → Reviewed session): each approved step becomes a numbered step with its description, command, notes and screenshots; rejected, excluded and pending steps are left out. Blank playbooks can be created too (Overview, Playbooks).
- Document editor (`/playbooks/:id`): title and description, purpose, scope, prerequisites, required permissions, numbered steps (title, instruction, monospaced command or configuration, expected result, note, screenshots), verification, warnings, troubleshooting, rollback; add, remove and reorder; autosave.
- Provenance on every item (from session / edited after generation / written in playbook) with links back to the source step (`/sessions/:id?step=…`). Nothing is invented: verification, expected results and the other sections start empty, and the editor says so.
- Properties: project, platform, product, version, environment, task type, author; linked sessions; revisions.
- Workflow: draft → in review (locked) → published, with an immutable revision (number, snapshot, note, author) per publication; Edit as new draft starts the next version. Delete with impact summary.
- Evidence copies in `playbook-assets/`, served through the `evidence` scheme; redacting a screenshot also redacts its playbook copies.
- Schema v4 (`playbooks.content_json`, `playbook_assets`, `playbook_revisions`, outdated fields for Milestone 7).
- Tests: 103 Rust unit tests (generation, validation, provenance rules, asset cleanup, publish/revisions, deletion, redaction of copies), 80 frontend tests, and end-to-end checks of generation from a reviewed session, copied (already redacted) evidence, editing with autosave, publishing and the Knowledge Library.

Known limitations: no rich-text formatting (plain text sections); screenshots can be removed from a step but not added from other sessions in the editor; revision history browsing arrives in Milestone 7.

## Milestone 6 — Export (complete)

Delivered:

- **Export…** in the playbook editor: choose the version (the saved working copy of a draft or a playbook in review, or any published revision; published playbooks default to their newest revision) and the format.
- **Markdown**: a folder with `<title>.md` and an `images/` folder; CommonMark with GitHub task lists for verification. **HTML**: one self-contained file with embedded screenshots, no scripts, and a CSP that blocks everything except its own styles and `data:` images. **PDF** (Windows): the HTML printed by WebView2 in a hidden window with no access to app commands; A4 or Letter from the Windows region, header with title and date, page numbers.
- One document model renders every format: title, status line, notices (unpublished, superseded, out of date), metadata, purpose, scope, prerequisites, permissions, warnings, numbered steps (provenance, instruction, monospaced command, expected result, note, screenshots), verification checklist, troubleshooting, rollback, and a footer with version, time and playbook id. Plain text is escaped to stay literal in every format.
- Screenshots: redactions preserved (copies of redacted evidence are now marked redacted), highlight boxes drawn on a copy with numbered captions, missing files reported instead of failing.
- Files go to the workspace `exports/` folder with unique names (never overwritten), assembled atomically; **Show in folder** reveals only files inside that folder.
- Warnings moved before the steps in the editor, matching the exports.
- Tests: 127 Rust unit tests (escaping, structure and order, provenance and notices, image preparation and highlight drawing, file naming, atomic folders, revision snapshots vs drafts, missing evidence, reveal path validation, PDF signature check), 82 frontend tests (export dialog, version options), and end-to-end exports of a published revision in all three formats checked on disk — the redacted pixels in the exported image, script-free self-contained HTML, and the PDF opened with the Windows PDF renderer (page count, paper size, preview image).

Known limitations: no "save as" location chooser (files go to the exports folder); PDF on Windows only; large screenshots move to the next PDF page instead of splitting; no rich text in playbooks.

## Milestone 7 — Version history (complete)

Delivered:

- **Version history** page (`/playbooks/:id/history`, from the editor's **History** button, the inspector or a revision link): the working copy, every published revision (number, date, author, note) and saved drafts.
- **Read** any version as a read-only document (same section order and provenance as the editor and exports, screenshots with numbered highlights), with notices for superseded revisions and saved drafts.
- **Compare** any two versions as a line diff of a canonical text rendering (metadata, sections, steps, one line per screenshot), with collapsed unchanged lines and textual `+`/`−` indicators.
- **Restore** a revision (or a saved draft) as the draft, with confirmation. Unpublished work in the working copy is kept as a **restore point** ("saved draft") that can be read, compared and restored; published revisions never change; refused while in review. The editor shows "Restored from revision N" until the next publication.
- **Out of date**: mark a published procedure out of date with a note (editor menu), shown in the editor, Playbooks list, Knowledge Library (freshness filter) and exports; **Mark as current** or publishing clears it.
- **Duplicate** a playbook or one of its revisions as a new draft with its own screenshot copies and a link to its origin.
- Knowledge Library: shows playbooks with a published revision by default (also while a new version is drafted), a Revision column and the out-of-date badge.
- Schema v5 (`playbook_restore_points`, `playbooks.restored_from_revision`, `based_on_playbook_id`, `based_on_revision`).
- Tests: 134 Rust unit tests (revision reads, restore with and without restore points, restoring restore points, evidence retention, in-review refusal, out-of-date rules, duplication with evidence copies and origin), 90 frontend tests (history read/restore/compare flows, out-of-date, duplicate, text rendering, diff collapsing), and end-to-end checks of reading, comparing, restoring with a kept saved draft, marking out of date and duplicating on the real app.

Known limitations: comparison is line-based text (images are compared by identity and size, not pixels); restore points are kept until the playbook is deleted; saved drafts cannot be exported or duplicated directly (restore them first).

## Milestone 8 — Advanced capture and integrations (complete)

Delivered:

- **Automatic capture after screen changes** (opt-in per capture, off by default; switch in the capture setup and an **Auto capture** toggle while recording). The chosen target is sampled about once a second as a small grayscale image kept in memory; a screenshot is taken when the screen changed clearly and settled — at least 3 s apart, at most 12 per minute, never while paused. Screenshots say "Automatic capture". No keyboard, mouse or accessibility hooks: this is how "improved click detection" is delivered (D-061).
- **Terminal logs** (Session tab → Integrations): DevTrace creates a log file in the workspace and shows the command for the user's own PowerShell (`Start-Transcript -Path … -Append`, copyable) or the path for PuTTY and other tools. While on, commands and output are recorded as steps (pending review) — PowerShell prompt lines become command steps with their output, other text becomes terminal output steps — with secret-looking values masked first. Format adapters make new log formats pluggable. DevTrace never runs or attaches to a terminal.
- **Watched configuration files** (Session tab → Integrations): pick a text file (≤ 1 MB) in the system dialog; each settled change records a step with the changed lines and an **observed** change record with the full before and after text.
- **Change History** with real change tracking: **Record Change** (declared changes with target, summary, project, session, time, environment, platform, version, values before/after), edit while declared and pending, **approve / reject / reset** with a comment, **Mark verified…** only with a note on how the outcome was checked, delete; source, session and step links; evidence and approval filters.
- Settings → Integrations lists every integration, what it does and where it is started. The evidence pane now shows recorded terminal output and changed lines, and choosing a step always shows its details.
- Schema v6 (`change_records.event_id`, `source`, review and verification columns); new event types `log` and `change` and sources `terminal` and `file_watch` (no migration needed, D-066); `terminal-logs/` workspace folder, deleted with its session.
- Tests: 154 Rust unit tests (change detector thresholds, spacing and limits; tail reading with BOMs and partial lines; transcript parsing and secret masking; line diff; declare/edit/review/verify rules; recorded events joining an outer transaction), 96 frontend tests (Change History record/edit/approve/verify/delete and observed records, terminal log start/stop and command, watched files, locked sessions, automatic capture switch and toggle), and end-to-end checks on the real app: a window that changes color is captured automatically and nothing is captured while paused or switched off; a real PowerShell transcript and appended prompt lines become steps with a masked password; a watched file change becomes a step and an observed change; observed and declared changes are approved and verified (a note is required).

Known limitations: automatic capture reacts to visible changes only (it cannot tell which control was clicked, and a click that changes nothing is not captured); masking catches common patterns only; terminal logs are read from files written by the user's terminal (PowerShell transcripts and plain logs; other prompts are recorded as output); watched files are polled every second, so rapid successive saves are merged; verified on Windows only.

## Milestone 9 — Reliability and distribution (complete)

Delivered:

- **Workspace backup and restore** (Settings → Backup and restore): one zip file saved where the user chooses, with a consistent database copy, all evidence, playbook images and terminal logs, and a manifest with versions, counts and SHA-256 checksums. Restore validates the archive, shows its contents, verifies every file and the database in a staging folder, keeps the replaced data in `backups/before-restore-<time>/`, upgrades older backups, refuses newer or damaged ones, and undoes itself if the restored database cannot be opened (D-067).
- **Per-command permissions**: every application command is listed in the app manifest (`build.rs`) and allowed only for the main window; plugin commands are refused to the webview; a lint step keeps handlers, manifest and capability identical (D-068).
- **Error handling**: no panics on user input in commands; local crash reports in `logs/` (release builds abort on panic and have no console); a React error boundary instead of a blank window; file-watch errors are broadcast and cleared when the file is back; automatic screenshots refused because of a pause no longer show an error; watched-file steps and change records are stored atomically (D-069).
- **Accessibility**: an axe-core audit (WCAG 2.0/2.1 A and AA) of every screen the end-to-end test photographs, in both themes; fixes for contrast (secondary instead of tertiary text for information, light secondary text #636368 instead of the specification's #6E6E73, which falls short of 4.5:1 on tinted surfaces, darker annotation labels), keyboard-scrollable regions, underlined inline links, accessible names (capture status link, groups instead of named `code`/`pre`), toggle buttons with a stable name and `aria-pressed` (D-071).
- **Distribution**: NSIS (per-user) and MSI (per-machine) installers from `npm run tauri build`; [INSTALL.md](INSTALL.md) covers requirements, installation, SmartScreen and checksums, data location, updating without an automatic updater (D-070), backup and restore, uninstalling, troubleshooting and code signing (D-072).
- Tests: 160 Rust unit tests (backup contents, restore with kept previous data, damaged/tampered/escaping/unlisted/newer archives refused, failed swaps undone, crash report text), 102 frontend tests (backup save/cancel/reveal, restore validation error, confirmation and reload, notice after reload, capture blocks backup, error boundary), and the 191-check end-to-end run passing on the debug build, the release build and the executable extracted from the MSI: plugin commands denied, backup saved and restored after later changes (kept aside), restored playbook images served, and no accessibility violations on 42 audited screens.

Known limitations: installers are not code-signed and running them was not exercised by the automated tests (their executable was); no automatic updater; restores replace the whole workspace; automated accessibility checks only (no screen-reader testing yet); macOS and Linux remain untested.
