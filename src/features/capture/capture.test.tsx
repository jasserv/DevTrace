import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SessionDetail } from "../../lib/api";
import { createFakeBackend, pngBytes, type FakeBackend, type InvokeOptions } from "../../test/fakeBackend";

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

function renderAt(hash: string) {
  window.location.hash = hash;
  const user = userEvent.setup();
  render(<App />);
  return user;
}

const heading = (name: string) => screen.findByRole("heading", { level: 1, name });
const sidebarStatus = () => within(screen.getByRole("navigation", { name: "Main" })).getByRole("link", { name: /^Capture status/ });

describe("Capture", () => {
  beforeEach(() => {
    harness.backend = createFakeBackend();
  });

  it("starts a capture into a new session, takes, pauses and stops", async () => {
    const user = renderAt("#/capture");
    await heading("Capture");

    // Displays and windows are listed; the primary display is preselected.
    const display = await screen.findByRole("radio", { name: /Display 1/ });
    expect(display).toBeChecked();
    await user.click(screen.getByRole("radio", { name: /FortiGate - System Settings/ }));

    const title = screen.getByLabelText("New session title");
    await user.clear(title);
    await user.click(screen.getByRole("button", { name: "Start capture" }));
    expect(await screen.findByText("Session title is required.")).toBeInTheDocument();
    expect(backend().sessions).toHaveLength(0);

    await user.type(title, "Firewall policy export");
    await user.click(screen.getByRole("button", { name: "Start capture" }));

    // The capture workspace shows the live session with recording controls.
    expect(await screen.findByText("Firewall policy export")).toBeInTheDocument();
    expect(backend().sessions[0]!.status).toBe("recording");
    expect(backend().sessions[0]!.application).toBe("Browser");
    expect(screen.getByRole("status", { name: /Capture status: Recording, 0 screenshots/ })).toBeInTheDocument();
    expect(sidebarStatus()).toHaveAccessibleName(/Recording/);

    await user.click(screen.getByRole("button", { name: "Capture now" }));
    const steps = await screen.findByRole("listbox", { name: "Session steps" });
    expect(await within(steps).findByText("Screenshot of FortiGate - System Settings")).toBeInTheDocument();
    expect(backend().attachments).toHaveLength(1);
    expect(backend().attachments[0]!.source).toBe("capture");
    await waitFor(() => expect(screen.getByRole("status", { name: /Recording, 1 screenshots/ })).toBeInTheDocument());
    // The new screenshot is selected and shown.
    expect(await screen.findByRole("img", { name: /Screenshot of FortiGate/ })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Pause capture" }));
    expect(await screen.findByRole("status", { name: /Capture status: Paused/ })).toBeInTheDocument();
    expect(backend().sessions[0]!.status).toBe("paused");
    const captureNow = screen.getByRole("button", { name: "Capture now" });
    expect(captureNow).toHaveAttribute("aria-disabled", "true");
    expect(captureNow).toHaveAccessibleDescription(/Resume to take screenshots/);

    await user.click(screen.getByRole("button", { name: "Resume capture" }));
    expect(await screen.findByRole("status", { name: /Capture status: Recording/ })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Stop" }));
    expect(await screen.findByText("Capture stopped")).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Start a capture" })).toBeInTheDocument();
    expect(backend().sessions[0]!.status).toBe("draft");
    expect(backend().capture.state).toBe("idle");
    expect(sidebarStatus()).toHaveAccessibleName(/Not recording/);
  });

  it("captures into an existing draft session and blocks completing it while recording", async () => {
    const session = (await backend().invoke("create_session", {
      input: { title: "Rotate VPN keys", projectId: null, application: "", environment: "" },
      notes: "",
    })) as SessionDetail;
    await backend().invoke("start_capture", { sessionId: session.id, targetId: "monitor:1" });
    const user = renderAt(`#/sessions/${session.id}`);
    await heading("Rotate VPN keys");

    // The session page explains that it is being recorded and links to the capture.
    expect(await screen.findByText(/Screenshots of Display 1 are added to this session/)).toBeInTheDocument();
    const complete = screen.getByRole("button", { name: "Complete" });
    expect(complete).toHaveAttribute("aria-disabled", "true");
    expect(complete).toHaveAccessibleDescription(/Stop the capture first/);

    await user.click(screen.getByRole("button", { name: "Open Capture" }));
    expect(await heading("Capture")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Capture now" })).toBeInTheDocument();
  });

  it("offers only draft sessions and explains why a capture could not start", async () => {
    const create = async (title: string) =>
      (await backend().invoke("create_session", { input: { title, projectId: null, application: "", environment: "" }, notes: "" })) as SessionDetail;
    const complete = async (id: string) => {
      await backend().invoke("create_event", { sessionId: id, eventType: "step", input: { title: "Done", description: "", notes: "", code: "" } });
      await backend().invoke("set_session_status", { id, status: "completed" });
    };
    const finished = await create("Finished work");
    await complete(finished.id);
    const draft = await create("Rotate VPN keys");
    const user = renderAt("#/capture");
    await screen.findByRole("radio", { name: /Display 1/ });

    const destination = screen.getByRole("combobox", { name: "Add screenshots to" });
    expect(within(destination).queryByRole("option", { name: "Finished work" })).not.toBeInTheDocument();
    await user.selectOptions(destination, draft.id);

    // Someone completes the session before the capture starts.
    await complete(draft.id);
    await user.click(screen.getByRole("button", { name: "Start capture" }));
    expect(await screen.findByText("The capture could not be started")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(/completed/);
    expect(backend().capture.state).toBe("idle");
  });

  it("starts with automatic capture only when switched on and toggles it while recording", async () => {
    const user = renderAt("#/capture");
    await screen.findByRole("radio", { name: /Display 1/ });

    const auto = screen.getByRole("switch", { name: "Also capture automatically when the screen changes" });
    expect(auto).toHaveAttribute("aria-checked", "false");
    expect(auto).toHaveAccessibleDescription(/does not detect clicks or keystrokes/);
    await user.click(auto);
    expect(auto).toHaveAttribute("aria-checked", "true");

    const title = screen.getByLabelText("New session title");
    await user.clear(title);
    await user.type(title, "Automatic capture run");
    await user.click(screen.getByRole("button", { name: "Start capture" }));
    expect(await screen.findByRole("status", { name: /Recording, 0 screenshots, automatic capture on/ })).toBeInTheDocument();
    expect(backend().capture.autoCapture).toBe(true);

    const toggle = screen.getByRole("button", { name: "Auto capture" });
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    await user.click(toggle);
    await waitFor(() => expect(backend().capture.autoCapture).toBe(false));
    expect(screen.getByRole("button", { name: "Auto capture" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("status", { name: /Capture status: Recording/ })).not.toHaveAccessibleName(/automatic capture on/);
  });

  it("changes the capture shortcut in Settings", async () => {
    const user = renderAt("#/settings");
    await heading("Settings");
    const select = screen.getByRole("combobox", { name: "Capture shortcut" });
    expect(select).toHaveValue("Ctrl+Alt+Shift+S");
    await user.selectOptions(select, "Ctrl+Shift+F9");
    await waitFor(() => expect(backend().settings.captureShortcut).toBe("Ctrl+Shift+F9"));
    expect(screen.getByRole("row", { name: /Take a screenshot while recording/ })).toHaveTextContent("Ctrl+Shift+F9");
  });

  it("adds, labels and removes highlight annotations", async () => {
    const session = (await backend().invoke("create_session", {
      input: { title: "Annotate evidence", projectId: null, application: "", environment: "" },
      notes: "",
    })) as SessionDetail;
    await backend().invoke("import_image", pngBytes(), { headers: { "x-session-id": session.id, "x-source": "file", "x-file-name": "console.png" } });
    const user = renderAt(`#/sessions/${session.id}`);
    await heading("Annotate evidence");

    const inspector = screen.getByRole("complementary", { name: "Session inspector" });
    await user.click(await within(inspector).findByRole("button", { name: "Add box" }));
    await waitFor(() => expect(backend().attachments[0]!.annotations).toHaveLength(1));
    const box = backend().attachments[0]!.annotations[0]!;
    expect(box.width).toBeGreaterThan(0);
    expect(box.x + box.width).toBeLessThanOrEqual(640);

    const label = await within(inspector).findByRole("textbox", { name: "Label for annotation 1" });
    await user.type(label, "Apply button{Enter}");
    await waitFor(() => expect(backend().attachments[0]!.annotations[0]!.label).toBe("Apply button"));

    await user.click(within(inspector).getByRole("button", { name: "Remove annotation 1" }));
    await waitFor(() => expect(backend().attachments[0]!.annotations).toHaveLength(0));
    expect(await within(inspector).findByText(/No highlight boxes/)).toBeInTheDocument();
  });
});
