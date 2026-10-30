import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SessionDetail } from "../../lib/api";
import { createFakeBackend, type FakeBackend, type InvokeOptions } from "../../test/fakeBackend";

const harness = vi.hoisted(() => ({ backend: null as FakeBackend | null }));

vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => true,
  invoke: (command: string, args?: Record<string, unknown>, options?: InvokeOptions) => harness.backend!.invoke(command, args, options),
  convertFileSrc: (path: string, protocol = "asset") => `${protocol}://localhost/${encodeURIComponent(path)}`,
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    setTheme: async () => undefined,
    show: async () => undefined,
    setFocus: async () => undefined,
  }),
}));

vi.mock("../../lib/reload", async (importOriginal) => {
  const actual = await importOriginal<typeof ReloadModule>();
  return { ...actual, reloadApp: vi.fn() };
});

import { App } from "../../app/App";
import { reloadApp } from "../../lib/reload";
import type * as ReloadModule from "../../lib/reload";

const backend = () => harness.backend!;

function renderSettings() {
  window.location.hash = "#/settings";
  const user = userEvent.setup();
  render(<App />);
  return user;
}

const backupGroup = () => screen.getByRole("region", { name: "Backup and restore" });

describe("Backup and restore", () => {
  beforeEach(() => {
    harness.backend = createFakeBackend();
    sessionStorage.clear();
    vi.mocked(reloadApp).mockClear();
  });

  it("saves a backup where the user chooses and can show it in the folder", async () => {
    const user = renderSettings();
    await screen.findByRole("heading", { level: 1, name: "Settings" });

    // Cancelling the save dialog changes nothing.
    backend().saveBackupTo(null);
    await user.click(within(backupGroup()).getByRole("button", { name: "Back up workspace…" }));
    await waitFor(() => expect(backend().calls).toContain("create_backup"));
    expect(within(backupGroup()).queryByText("Backup saved")).not.toBeInTheDocument();

    const target = "D:\\Backups\\DevTrace backup 2026-10-23 0900.zip";
    backend().saveBackupTo(target);
    await user.click(within(backupGroup()).getByRole("button", { name: "Back up workspace…" }));
    expect(await within(backupGroup()).findByText(target)).toBeInTheDocument();
    expect(within(backupGroup()).getByText(/47 KB · 1 file/)).toBeInTheDocument();

    const reveal = within(backupGroup()).getAllByRole("button").find((button) => /Show in|Reveal in/.test(button.textContent ?? ""));
    await user.click(reveal!);
    await waitFor(() => expect(backend().revealed).toContain(target));
  });

  it("checks a backup, asks for confirmation, restores it and reloads", async () => {
    const user = renderSettings();
    await screen.findByRole("heading", { level: 1, name: "Settings" });

    backend().pickBackup("damaged");
    await user.click(within(backupGroup()).getByRole("button", { name: "Restore from backup…" }));
    expect(await within(backupGroup()).findByRole("alert")).toHaveTextContent(/not a usable DevTrace backup/);
    expect(backend().restores).toHaveLength(0);

    backend().pickBackup("DevTrace backup 2026-10-20.zip");
    await user.click(within(backupGroup()).getByRole("button", { name: "Restore from backup…" }));
    const dialog = await screen.findByRole("dialog", { name: "Restore this backup?" });
    expect(within(dialog).getByText("DevTrace backup 2026-10-20.zip")).toBeInTheDocument();
    expect(within(dialog).getByText("Network Lab")).toBeInTheDocument();
    expect(within(dialog).getByText("2 projects, 5 sessions, 3 playbooks, 4 changes")).toBeInTheDocument();
    expect(within(dialog).getByText(/moved to the workspace's backups folder and kept/)).toBeInTheDocument();
    expect(within(dialog).getByText(/upgraded to the current format/)).toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: "Restore backup" }));
    await waitFor(() => expect(reloadApp).toHaveBeenCalledTimes(1));
    expect(backend().restores).toHaveLength(1);
    expect(sessionStorage.getItem("devtrace.restored")).toBe("backups/before-restore-20261023T090000Z");
  });

  it("says where the replaced data is after the reload", async () => {
    sessionStorage.setItem("devtrace.restored", "backups/before-restore-20261023T090000Z");
    renderSettings();
    await screen.findByRole("heading", { level: 1, name: "Settings" });
    expect(within(backupGroup()).getByText(/kept in the workspace folder under backups\/before-restore-20261023T090000Z/)).toBeInTheDocument();
    expect(sessionStorage.getItem("devtrace.restored")).toBeNull();
  });

  it("explains that backup and restore wait for a running capture to stop", async () => {
    const session = (await backend().invoke("create_session", {
      input: { title: "Rotate VPN keys", projectId: null, application: "", environment: "" },
      notes: "",
    })) as SessionDetail;
    await backend().invoke("start_capture", { sessionId: session.id, targetId: "monitor:1" });
    renderSettings();
    await screen.findByRole("heading", { level: 1, name: "Settings" });
    const backUp = await within(backupGroup()).findByRole("button", { name: "Back up workspace…" });
    await waitFor(() => expect(backUp).toHaveAttribute("aria-disabled", "true"));
    expect(backUp).toHaveAccessibleDescription(/Stop the capture first/);
    expect(within(backupGroup()).getByRole("button", { name: "Restore from backup…" })).toHaveAttribute("aria-disabled", "true");
  });
});
