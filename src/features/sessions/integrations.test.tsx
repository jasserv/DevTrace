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

import { App } from "../../app/App";

const backend = () => harness.backend!;

async function openSessionTab(title: string, prepare?: (session: SessionDetail) => Promise<void>) {
  const session = (await backend().invoke("create_session", {
    input: { title, projectId: null, application: "", environment: "" },
    notes: "",
  })) as SessionDetail;
  await prepare?.(session);
  window.location.hash = `#/sessions/${session.id}`;
  const user = userEvent.setup();
  render(<App />);
  await screen.findByRole("heading", { level: 1, name: title });
  await user.click(screen.getByRole("tab", { name: "Session" }));
  return { user, session };
}

describe("Session integrations", () => {
  beforeEach(() => {
    harness.backend = createFakeBackend();
  });

  it("starts a terminal log, shows the command to run in the user's own terminal, and stops it", async () => {
    const { user, session } = await openSessionTab("Patch web servers");
    const terminal = screen.getByRole("group", { name: "Terminal log" });
    expect(within(terminal).getByText(/DevTrace never runs commands/)).toBeInTheDocument();

    await user.click(within(terminal).getByRole("button", { name: "Start terminal log" }));
    const command = await within(terminal).findByLabelText("Command to start the transcript");
    expect(command).toHaveTextContent(`Start-Transcript -Path "C:/test/workspace/terminal-logs/${session.id}/log.log" -Append`);
    expect(within(terminal).getByRole("status")).toHaveTextContent(/Reading the log/);
    expect(backend().terminalLogs.get(session.id)).toMatchObject({ format: "powershell", active: true });

    await user.click(within(terminal).getByRole("button", { name: "Stop terminal log" }));
    expect(await screen.findByText("Terminal logging stopped")).toBeInTheDocument();
    expect(backend().terminalLogs.has(session.id)).toBe(false);

    // Plain logs (PuTTY and similar tools) show the file path to log to instead of a command.
    await user.selectOptions(within(terminal).getByRole("combobox", { name: "Log format" }), "plain");
    await user.click(within(terminal).getByRole("button", { name: "Start terminal log" }));
    expect(await within(terminal).findByLabelText("Log file path")).toHaveTextContent(`terminal-logs/${session.id}/log.log`);
    expect(backend().terminalLogs.get(session.id)?.format).toBe("plain");
  });

  it("watches a configuration file chosen in the system dialog and stops watching it", async () => {
    const { user } = await openSessionTab("Harden SSH");
    const watched = screen.getByRole("group", { name: "Watched files" });

    // Cancelling the file dialog changes nothing.
    backend().pickFile(null);
    await user.click(within(watched).getByRole("button", { name: "Watch a file…" }));
    await waitFor(() => expect(backend().calls).toContain("watch_config_file"));
    expect(backend().fileWatches).toHaveLength(0);

    backend().pickFile("C:\\lab\\sshd_config");
    await user.click(within(watched).getByRole("button", { name: "Watch a file…" }));
    expect(await within(watched).findByText("sshd_config")).toBeInTheDocument();
    expect(within(watched).getByText("C:\\lab\\sshd_config")).toBeInTheDocument();
    expect(within(watched).getByText("No changes yet")).toBeInTheDocument();

    await user.click(within(watched).getByRole("button", { name: "Stop watching sshd_config" }));
    await waitFor(() => expect(within(watched).queryByText("sshd_config")).not.toBeInTheDocument());
    expect(backend().fileWatches).toHaveLength(0);
  });

  it("explains why integrations cannot start on a completed session", async () => {
    await openSessionTab("Finished rollout", async (session) => {
      await backend().invoke("create_event", { sessionId: session.id, eventType: "step", input: { title: "Done", description: "", notes: "", code: "" } });
      await backend().invoke("set_session_status", { id: session.id, status: "completed" });
    });
    const start = within(screen.getByRole("group", { name: "Terminal log" })).getByRole("button", { name: "Start terminal log" });
    expect(start).toHaveAttribute("aria-disabled", "true");
    expect(start).toHaveAccessibleDescription(/completed/i);
    const watch = within(screen.getByRole("group", { name: "Watched files" })).getByRole("button", { name: "Watch a file…" });
    expect(watch).toHaveAttribute("aria-disabled", "true");
  });
});
