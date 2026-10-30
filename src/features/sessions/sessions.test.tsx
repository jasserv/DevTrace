import { act, render, screen, waitFor, within } from "@testing-library/react";
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

async function seedSession(title: string, projectId: string | null = null): Promise<SessionDetail> {
  return (await backend().invoke("create_session", {
    input: { title, projectId, application: "", environment: "" },
    notes: "",
  })) as SessionDetail;
}

async function seedStep(sessionId: string, title: string) {
  await backend().invoke("create_event", { sessionId, eventType: "step", input: { title, description: "", notes: "", code: "" } });
}

/** Simulates Ctrl+V of clipboard images (jsdom has no ClipboardEvent or DataTransfer). */
function paste(files: File[]) {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", { value: { files } });
  act(() => {
    document.body.dispatchEvent(event);
  });
}

const heading = (name: string) => screen.findByRole("heading", { level: 1, name });
const timeline = () => screen.findByRole("listbox", { name: "Session steps" });

describe("Sessions", () => {
  beforeEach(() => {
    harness.backend = createFakeBackend();
  });

  it("creates a session, validating input, and opens its workspace", async () => {
    const user = renderAt("#/sessions");
    expect(await screen.findByText("No sessions yet")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "New Session" }));
    const dialog = screen.getByRole("dialog", { name: "New session" });
    await user.click(within(dialog).getByRole("button", { name: "Create session" }));
    expect(within(dialog).getByText("Session title is required.")).toBeInTheDocument();

    await user.type(within(dialog).getByLabelText("Title"), "Configure NTP");
    await user.type(within(dialog).getByLabelText(/Application or platform/), "FortiGate 7.4");
    await user.click(within(dialog).getByRole("button", { name: "Create session" }));

    expect(await heading("Configure NTP")).toBeInTheDocument();
    expect(backend().sessions).toHaveLength(1);
    expect(backend().sessions[0]!.application).toBe("FortiGate 7.4");
    expect(screen.getByText("No steps yet")).toBeInTheDocument();
    const complete = screen.getByRole("button", { name: "Complete" });
    expect(complete).toHaveAttribute("aria-disabled", "true");
    expect(complete).toHaveAccessibleDescription(/at least one step/);
  });

  it("filters the list by project from the URL and opens a session from its row", async () => {
    const project = (await backend().invoke("create_project", { input: { name: "Branch firewall", description: "" } })) as { id: string };
    await seedSession("Export policies", project.id);
    await seedSession("Unrelated task");
    const user = renderAt(`#/sessions?project=${project.id}`);

    const table = await screen.findByRole("table", { name: "Capture sessions" });
    expect(await within(table).findByText("Export policies")).toBeInTheDocument();
    expect(within(table).queryByText("Unrelated task")).not.toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Filter by project" })).toHaveValue(project.id);

    await user.click(within(table).getByText("Export policies"));
    expect(await heading("Export policies")).toBeInTheDocument();
  });

  it("adds steps and commands, then completes and reopens the session", async () => {
    const session = await seedSession("Rotate certificates");
    const user = renderAt(`#/sessions/${session.id}`);
    await heading("Rotate certificates");

    await user.click(screen.getByRole("button", { name: "Add" }));
    await user.click(screen.getByRole("menuitem", { name: /^Step/ }));
    let dialog = screen.getByRole("dialog", { name: "Add step" });
    await user.type(within(dialog).getByLabelText("Title"), "Open the certificate console");
    await user.click(within(dialog).getByRole("button", { name: "Add step" }));
    expect(await within(await timeline()).findByText("Open the certificate console")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Add" }));
    await user.click(screen.getByRole("menuitem", { name: /^Command/ }));
    dialog = screen.getByRole("dialog", { name: "Add command" });
    await user.type(within(dialog).getByLabelText("Title"), "List certificates");
    await user.click(within(dialog).getByRole("button", { name: "Add command" }));
    expect(within(dialog).getByText("Command is required.")).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText("Command"), "certutil -store My");
    await user.click(within(dialog).getByRole("button", { name: "Add command" }));

    // The new command is selected and shown as text; it is never executed.
    expect(await screen.findByText("certutil -store My")).toBeInTheDocument();
    expect(screen.getByText(/never run by DevTrace/)).toBeInTheDocument();
    expect(backend().events.map((event) => event.eventType)).toEqual(["step", "command"]);

    const complete = screen.getByRole("button", { name: "Complete" });
    await waitFor(() => expect(complete).not.toHaveAttribute("aria-disabled"));
    await user.click(complete);
    expect(await screen.findByText(/Steps and evidence are read-only/)).toBeInTheDocument();
    expect(backend().sessions[0]!.status).toBe("completed");
    expect(screen.getByRole("button", { name: "Add" })).toHaveAttribute("aria-disabled", "true");

    // Pasting into a completed session explains why nothing happened.
    paste([new File([pngBytes()], "image.png", { type: "image/png" })]);
    expect(await screen.findByText("Screenshot not added")).toBeInTheDocument();
    expect(backend().attachments).toHaveLength(0);

    await user.click(screen.getByRole("button", { name: "Reopen" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Add" })).not.toHaveAttribute("aria-disabled"));
    expect(backend().sessions[0]!.status).toBe("draft");
  });

  it("adds a pasted screenshot and shows it through the evidence scheme", async () => {
    const session = await seedSession("Patch servers");
    renderAt(`#/sessions/${session.id}`);
    await heading("Patch servers");

    paste([new File([pngBytes()], "image.png", { type: "image/png" })]);

    expect(await within(await timeline()).findByText("Pasted screenshot")).toBeInTheDocument();
    const [attachment] = backend().attachments;
    expect(attachment!.source).toBe("clipboard");
    expect(backend().files.get(attachment!.id)).toEqual(pngBytes());
    const image = await screen.findByRole("img", { name: /Screenshot for .Pasted screenshot./ });
    // The content hash in the URL makes the webview reload the image after it changes.
    expect(image).toHaveAttribute("src", `evidence://localhost/${attachment!.id}?v=${attachment!.sha256.slice(0, 16)}`);
    expect(within(screen.getByRole("toolbar", { name: "Screenshot controls" })).getByText(/640 × 400 · PNG/)).toBeInTheDocument();
    expect(within(screen.getByRole("list", { name: "Attached screenshots" })).getByText(/640 × 400 · PNG/)).toBeInTheDocument();
  });

  it("attaches a chosen image to the selected step instead of creating a new one", async () => {
    const session = await seedSession("Harden SSH");
    await seedStep(session.id, "Edit sshd_config");
    const user = renderAt(`#/sessions/${session.id}`);
    await heading("Harden SSH");
    await within(await timeline()).findByText("Edit sshd_config");

    const inspector = screen.getByRole("complementary", { name: "Session inspector" });
    await user.click(within(inspector).getByRole("button", { name: "Attach screenshot…" }));
    await user.upload(screen.getByTestId("image-file-input"), new File([pngBytes()], "sshd.png", { type: "image/png" }));

    await waitFor(() => expect(backend().attachments).toHaveLength(1));
    expect(backend().attachments[0]!.eventId).toBe(backend().events[0]!.id);
    expect(backend().events).toHaveLength(1);
    expect(await within(inspector).findByText("sshd.png")).toBeInTheDocument();
    expect(await screen.findByText("Screenshot attached")).toBeInTheDocument();
  });

  it("explains why an image was rejected", async () => {
    const session = await seedSession("Investigate outage");
    renderAt(`#/sessions/${session.id}`);
    await heading("Investigate outage");

    paste([new File(["definitely not a png"], "fake.png", { type: "image/png" })]);

    expect(await screen.findByText("This file is not a supported image. Use a PNG, JPEG, GIF or WebP file.")).toBeInTheDocument();
    expect(backend().attachments).toHaveLength(0);
    expect(backend().events).toHaveLength(0);
  });

  it("autosaves session notes and keeps them when switching tabs", async () => {
    const session = await seedSession("Document VLANs");
    const user = renderAt(`#/sessions/${session.id}`);
    await heading("Document VLANs");

    await user.click(screen.getByRole("tab", { name: "Session" }));
    await user.type(screen.getByLabelText("Session notes"), "Change ticket CHG-1042");
    expect(screen.getByText("Saving\u2026")).toBeInTheDocument();
    await waitFor(() => expect(backend().sessions[0]!.notes).toBe("Change ticket CHG-1042"), { timeout: 3000 });
    expect(await screen.findByText(/Saved at/)).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Step" }));
    await user.click(screen.getByRole("tab", { name: "Session" }));
    expect(screen.getByLabelText("Session notes")).toHaveValue("Change ticket CHG-1042");
  });

  it("deletes a session after showing exactly what will be removed", async () => {
    const session = await seedSession("Old procedure");
    await seedStep(session.id, "Step one");
    await backend().invoke("import_image", pngBytes(), { headers: { "x-session-id": session.id, "x-source": "file", "x-file-name": "shot.png" } });
    const user = renderAt(`#/sessions/${session.id}`);
    await heading("Old procedure");

    await user.click(screen.getByRole("button", { name: "More session actions" }));
    await user.click(screen.getByRole("menuitem", { name: /Delete session/ }));
    const confirm = screen.getByRole("dialog", { name: /Delete .Old procedure./ });
    expect(within(confirm).getByText("2 steps")).toBeInTheDocument();
    expect(within(confirm).getByText(/1 screenshot/)).toBeInTheDocument();
    expect(within(confirm).getByText("This cannot be undone.")).toBeInTheDocument();
    await user.click(within(confirm).getByRole("button", { name: "Delete session" }));

    expect(await heading("Sessions")).toBeInTheDocument();
    expect(backend().sessions).toHaveLength(0);
    expect(backend().files.size).toBe(0);
    expect(await screen.findByText("No sessions yet")).toBeInTheDocument();
  });

  it("shows a clear page for a session that no longer exists", async () => {
    renderAt("#/sessions/0190f5c2-7a3b-7c3d-8e4f-123456789abc");
    expect(await heading("Session not found")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Show all sessions" })).toBeInTheDocument();
  });
});
