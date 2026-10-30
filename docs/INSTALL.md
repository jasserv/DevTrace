# Installing, updating and backing up DevTrace

This guide covers the Windows installers produced by this repository, where DevTrace keeps its data, how to update safely, and how to back up and restore a workspace. DevTrace is local-first: it has no account, no cloud service and no automatic network updates.

## Requirements

| | |
|---|---|
| Operating system | Windows 10 (version 1809 or later) or Windows 11, 64-bit (x64). Verified on Windows 11. |
| Runtime | Microsoft Edge WebView2 Runtime. Preinstalled on Windows 11; the NSIS installer downloads it if it is missing (internet needed only in that case). |
| Disk | About 30 MB for the app, plus your workspace (screenshots dominate). |

macOS and Linux builds are expected to work with Tauri's platform prerequisites but have not been tested; build them from source (below). Capture, automatic capture and PDF export are Windows-only in this version.

## Installing on Windows

`npm run tauri build` writes two installers to `src-tauri/target/release/bundle/`:

| File | Use |
|---|---|
| `nsis/DevTrace_<version>_x64-setup.exe` | Recommended for individuals. Installs for the current user (no administrator rights), adds a Start menu entry and an uninstaller. |
| `msi/DevTrace_<version>_x64_en-US.msi` | For managed deployment (Group Policy, Intune, `msiexec /i … /qn`). Installs for all users and needs administrator rights. |

> [!WARNING]
> The installers built by this repository are **not code-signed**. Windows SmartScreen will show "Windows protected your PC"; choose **More info → Run anyway** only for an installer you built yourself or whose SHA-256 checksum you verified (`Get-FileHash .\DevTrace_<version>_x64-setup.exe`). See [Code signing](#code-signing-for-maintainers) to sign releases.

## Where your data lives

Everything DevTrace records stays in one **workspace folder**:

| Platform | Default location |
|---|---|
| Windows | `%APPDATA%\com.devtrace.desktop\` |
| macOS | `~/Library/Application Support/com.devtrace.desktop/` |
| Linux | `~/.local/share/com.devtrace.desktop/` |

It contains the database (`devtrace.sqlite3`), screenshots (`attachments/`), playbook images (`playbook-assets/`), terminal logs (`terminal-logs/`), exports (`exports/`), automatic and restore backups (`backups/`) and local crash reports (`logs/`). **Settings → Workspace** shows the exact path and opens it. Installing, updating or uninstalling the app never deletes this folder.

## Updating

DevTrace does not check for updates or download anything by itself (see [DECISIONS.md](DECISIONS.md), D-070). To update:

1. In **Settings → Backup and restore**, choose **Back up workspace…** and save the file somewhere outside the workspace.
2. Close DevTrace (stop any capture first).
3. Run the new installer of the same type (NSIS over NSIS, MSI over MSI). It replaces the program files and keeps your workspace.
4. Start DevTrace. If the new version uses a newer database schema, it first writes a copy of the database to `backups/devtrace-schema-v<N>-<time>.sqlite3` and then upgrades it. **Settings → About** shows the schema version.

An older DevTrace refuses to open a workspace upgraded by a newer one (your data is left untouched); install the newer version again, or restore a backup made before the upgrade.

## Backing up and restoring

**Settings → Backup and restore**:

- **Back up workspace…** saves one `.zip` file where you choose (for example another drive or a folder your own backup tool covers). It contains a consistent copy of the database, all screenshots, playbook images and terminal logs, and a `manifest.json` with the DevTrace and schema versions, counts and a SHA-256 checksum of every file. Exports are not included (create them again from the playbooks), nor are earlier backups or crash reports. Stop a running capture first.
- **Restore from backup…** asks for a backup file, checks it (format, versions, every entry name and size) and shows what it contains. After you confirm, DevTrace extracts it into a staging folder, verifies every checksum and the database integrity, stops terminal logs and watched files, moves the **current data** to `backups/before-restore-<time>/` (it is kept, not deleted), puts the backup in place and reloads. A backup made by an older version is upgraded on restore; one made by a newer version is refused.

To undo a restore, restore an earlier backup, or close DevTrace and move the folders from `backups/before-restore-<time>/` back into the workspace folder. Those folders are never deleted automatically; remove them yourself once you no longer need them.

A manual backup also works: close DevTrace and copy the whole workspace folder.

## Uninstalling

Use **Settings → Apps → Installed apps → DevTrace → Uninstall** (or uninstall the MSI). The workspace folder stays. To remove all data as well, make a backup if you might need it, then delete `%APPDATA%\com.devtrace.desktop\`. Nothing was ever uploaded, so deleting the folder removes everything.

## Troubleshooting

- **"DevTrace could not open its local database"**: the window explains why (for example a workspace from a newer version, or a folder that is not accessible). Your data has not been modified.
- **DevTrace closed unexpectedly**: a crash report is written to `logs/crash-<time>.txt` in the workspace folder. It contains the error message, where it happened and a backtrace — no workspace content. It stays on your computer; share it only if you want to.
- **Screenshots of a window are black**: protected or some hardware-accelerated windows cannot be captured; capture the whole display instead.
- **Use a different workspace folder**: start DevTrace with the environment variable `DEVTRACE_DATA_DIR` set to another folder (the automated tests do this).

## Building from source

```powershell
npm install
npm run check                                  # type check, lint, unit and Rust tests
npm run tauri build                            # release binary and installers
npm run test:e2e -- --binary src-tauri/target/release/devtrace.exe
```

Requirements: Node.js 22.12+, Rust 1.90+ (MSVC), Visual Studio 2022 Build Tools with the C++ workload, WebView2. The first `tauri build` downloads the NSIS and WiX tool sets used to create the installers.

## Code signing (for maintainers)

Unsigned installers trigger SmartScreen warnings and may be blocked by company policy. To sign releases with a code-signing certificate installed in the Windows certificate store, add to `src-tauri/tauri.conf.json`:

```json
"bundle": {
  "windows": {
    "certificateThumbprint": "<SHA-1 thumbprint of the certificate>",
    "digestAlgorithm": "sha256",
    "timestampUrl": "http://timestamp.digicert.com"
  }
}
```

For certificates in a cloud HSM (for example Azure Trusted Signing), use `bundle.windows.signCommand` instead. Signing applies to the executable and both installers. Publish the SHA-256 checksums of release files alongside them.
