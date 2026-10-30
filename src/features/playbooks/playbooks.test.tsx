import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { PlaybookDetail, PlaybookStep, SessionDetail } from "../../lib/api";
import { createFakeBackend, type FakeBackend, type InvokeOptions } from "../../test/fakeBackend";
import { CURRENT_VERSION, editItem, editStep, exportVersionOptions, moveBy, publishBlocker, sourceText, touched } from "./playbookModel";

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

const heading = (name: string | RegExp) => screen.findByRole("heading", { level: 1, name });

async function reviewedSession(): Promise<SessionDetail> {
  const session = (await backend().invoke("create_session", {
    input: { title: "Rotate the VPN certificate", projectId: null, application: "FortiGate 7.4", environment: "Lab" },
    notes: "",
  })) as SessionDetail;
  const add = (eventType: string, title: string, code = "") =>
    backend().invoke("create_event", { sessionId: session.id, eventType, input: { title, description: `${title} details`, notes: "", code } });
  await add("step", "Open the certificate list");
  await add("command", "Check the expiry date", "get vpn certificate local");
  await add("step", "Browse unrelated settings");
  const [first, second, third] = backend().events.map((event) => event.id);
  await backend().invoke("review_events", { sessionId: session.id, eventIds: [first, second], status: "approved", comment: null });
  await backend().invoke("review_events", { sessionId: session.id, eventIds: [third], status: "excluded", comment: null });
  return session;
}

describe("Playbooks", () => {
  beforeEach(() => {
    harness.backend = createFakeBackend();
  });

  it("creates a playbook from the approved steps of a session", async () => {
    const session = await reviewedSession();
    const user = renderAt(`#/sessions/${session.id}`);
    await heading("Rotate the VPN certificate");

    await user.click(screen.getByRole("button", { name: "More session actions" }));
    await user.click(screen.getByRole("menuitem", { name: /Create playbook from approved steps/ }));

    const document = await screen.findByRole("article", { name: "Playbook document" });
    expect(within(document).getByRole("textbox", { name: "Playbook title" })).toHaveValue("Rotate the VPN certificate");
    // Only the two approved steps, in order, marked as coming from the session.
    expect(within(document).getByRole("textbox", { name: "Step 1 title" })).toHaveValue("Open the certificate list");
    expect(within(document).getByRole("textbox", { name: "Step 2 command" })).toHaveValue("get vpn certificate local");
    expect(within(document).queryByRole("textbox", { name: "Step 3 title" })).not.toBeInTheDocument();
    expect(within(document).getAllByText("From session")).toHaveLength(2);
    expect(within(document).getAllByText(/From session \u201cRotate the VPN certificate\u201d/)).toHaveLength(2);
    // Nothing is invented for verification.
    expect(within(document).getByText(/No verification steps yet/)).toBeInTheDocument();
    const playbook = backend().playbooks[0]!;
    expect(playbook.platform).toBe("FortiGate 7.4");
    expect(playbook.sessions.map((item) => item.id)).toEqual([session.id]);
  });

  it("refuses to create a playbook when no step is approved", async () => {
    const session = (await backend().invoke("create_session", {
      input: { title: "Nothing approved", projectId: null, application: "", environment: "" },
      notes: "",
    })) as SessionDetail;
    await backend().invoke("create_event", { sessionId: session.id, eventType: "step", input: { title: "Pending", description: "", notes: "", code: "" } });
    const user = renderAt(`#/sessions/${session.id}`);
    await heading("Nothing approved");
    await user.click(screen.getByRole("button", { name: "More session actions" }));
    const item = screen.getByRole("menuitem", { name: /Create playbook from approved steps/ });
    expect(item).toHaveAttribute("aria-disabled", "true");
    expect(backend().playbooks).toHaveLength(0);
  });

  it("edits with provenance, autosaves, and adds steps and verification", async () => {
    const session = await reviewedSession();
    const created = (await backend().invoke("create_playbook_from_session", { sessionId: session.id })) as { id: string };
    const user = renderAt(`#/playbooks/${created.id}`);
    const document = await screen.findByRole("article", { name: "Playbook document" });

    const instruction = within(document).getByRole("textbox", { name: "Step 1 instruction" });
    await user.clear(instruction);
    await user.type(instruction, "Open VPN > Certificates.");
    expect(await within(document).findByText("Edited after generation")).toBeInTheDocument();

    await user.click(within(document).getByRole("button", { name: "Add step" }));
    await user.type(within(document).getByRole("textbox", { name: "Step 3 title" }), "Restart the tunnel");

    const verification = within(document).getByRole("region", { name: "Verification" });
    await user.click(within(verification).getByRole("button", { name: "Add item" }));
    await user.type(within(verification).getByRole("textbox", { name: "Verification item 1" }), "Clients reconnect within a minute");

    await waitFor(
      () => {
        const saved = backend().playbooks[0]!.content;
        expect(saved.steps[0]!.instruction).toBe("Open VPN > Certificates.");
        expect(saved.steps[0]!.origin).toBe("edited");
        expect(saved.steps[2]!.title).toBe("Restart the tunnel");
        expect(saved.steps[2]!.origin).toBe("authored");
        expect(saved.verification[0]!.text).toBe("Clients reconnect within a minute");
      },
      { timeout: 4000 },
    );
    expect(await screen.findByText(/Saved at/)).toBeInTheDocument();

    await user.click(within(document).getByRole("button", { name: "Move step 3 up" }));
    await waitFor(() => expect(backend().playbooks[0]!.content.steps[1]!.title).toBe("Restart the tunnel"), { timeout: 4000 });
  });

  it("submits, publishes with a revision note and starts a new draft", async () => {
    const session = await reviewedSession();
    const created = (await backend().invoke("create_playbook_from_session", { sessionId: session.id })) as { id: string };
    const user = renderAt(`#/playbooks/${created.id}`);
    await screen.findByRole("article", { name: "Playbook document" });

    await user.click(screen.getByRole("button", { name: "Submit for review" }));
    expect(await screen.findByText(/Editing is locked while the playbook is in review/)).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Playbook title" })).toHaveAttribute("readonly");
    expect(backend().playbooks[0]!.status).toBe("in_review");

    await user.click(screen.getByRole("button", { name: "Publish…" }));
    const dialog = screen.getByRole("dialog", { name: "Publish this playbook?" });
    expect(within(dialog).getByText(/does not add verification results/)).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText(/Revision note/), "First release");
    await user.click(within(dialog).getByRole("button", { name: "Publish" }));
    expect(await screen.findByText(/This version is published and read-only/)).toBeInTheDocument();
    expect(backend().playbooks[0]!.revisions[0]).toMatchObject({ revisionNumber: 1, note: "First release" });
    expect(within(screen.getByRole("complementary", { name: "Playbook properties" })).getByText("Revision 1")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Edit as new draft" }));
    await waitFor(() => expect(backend().playbooks[0]!.status).toBe("draft"));
    expect(await screen.findByRole("button", { name: "Submit for review" })).toBeInTheDocument();
  });

  it("creates a blank playbook from the Playbooks page and deletes it", async () => {
    const user = renderAt("#/playbooks");
    await heading("Playbooks");
    await user.click(screen.getByRole("button", { name: "New Playbook" }));
    const dialog = screen.getByRole("dialog", { name: "New playbook" });
    await user.click(within(dialog).getByRole("radio", { name: "Blank" }));
    await user.click(within(dialog).getByRole("button", { name: "Create playbook" }));
    expect(await within(dialog).findByText("Playbook title is required.")).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText("Title"), "Reset a user's MFA");
    await user.click(within(dialog).getByRole("button", { name: "Create playbook" }));

    const document = await screen.findByRole("article", { name: "Playbook document" });
    expect(within(document).getByText("No steps yet. Add the first step of the procedure.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Submit for review" })).toHaveAttribute("aria-disabled", "true");

    await user.click(screen.getByRole("button", { name: "More playbook actions" }));
    await user.click(screen.getByRole("menuitem", { name: /Delete playbook/ }));
    await user.click(within(screen.getByRole("dialog", { name: /Delete/ })).getByRole("button", { name: "Delete playbook" }));
    expect(await heading("Playbooks")).toBeInTheDocument();
    expect(backend().playbooks).toHaveLength(0);
  });

  it("opens the create dialog from the Overview", async () => {
    const user = renderAt("#/overview");
    await heading("Overview");
    await user.click(screen.getByRole("button", { name: "Create Playbook" }));
    expect(await screen.findByRole("dialog", { name: "New playbook" })).toBeInTheDocument();
  });

  it("exports the saved draft or a published revision and shows the file", async () => {
    const session = await reviewedSession();
    const created = (await backend().invoke("create_playbook_from_session", { sessionId: session.id })) as { id: string };
    const user = renderAt(`#/playbooks/${created.id}`);
    const document = await screen.findByRole("article", { name: "Playbook document" });

    // Unsaved edits are saved before the working copy is exported.
    await user.type(within(document).getByRole("textbox", { name: "Purpose" }), "Keep remote access working.");
    await user.click(screen.getByRole("button", { name: "Export…" }));
    let dialog = screen.getByRole("dialog", { name: "Export playbook" });
    expect(within(dialog).getByLabelText("Version")).toHaveDisplayValue("Current draft (not published)");
    await user.click(within(dialog).getByRole("radio", { name: "Markdown" }));
    expect(within(dialog).getByText(/\.md file with an images folder/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Export" }));

    dialog = await screen.findByRole("dialog", { name: "Export complete" });
    expect(within(dialog).getByText("Exported rotate-the-vpn-certificate.md")).toBeInTheDocument();
    expect(within(dialog).getByText(/Draft · 0 screenshots/)).toBeInTheDocument();
    expect(backend().playbooks[0]!.content.purpose).toBe("Keep remote access working.");
    expect(backend().exports[0]).toMatchObject({ format: "markdown", versionLabel: "Draft" });

    await user.click(within(dialog).getByRole("button", { name: "Show in folder" }));
    await waitFor(() => expect(backend().revealed).toEqual([backend().exports[0]!.relativePath]));
    await user.click(within(dialog).getByRole("button", { name: "Done" }));
    expect(screen.queryByRole("dialog", { name: "Export complete" })).not.toBeInTheDocument();

    // After publishing, the published revision is exported.
    await user.click(screen.getByRole("button", { name: "Publish…" }));
    await user.click(within(screen.getByRole("dialog", { name: "Publish this playbook?" })).getByRole("button", { name: "Publish" }));
    expect(await screen.findByText(/This version is published and read-only/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Export…" }));
    dialog = screen.getByRole("dialog", { name: "Export playbook" });
    expect(within(dialog).getByLabelText("Version")).toHaveDisplayValue(/Revision 1 — published .* \(current\)/);
    await user.click(within(dialog).getByRole("radio", { name: "PDF" }));
    await user.click(within(dialog).getByRole("button", { name: "Export" }));
    expect(await screen.findByText(/Exported rotate-the-vpn-certificate-r1-.*\.pdf/)).toBeInTheDocument();
    expect(backend().exports[1]).toMatchObject({ format: "pdf", versionLabel: "Revision 1" });
  });
});

describe("playbook model", () => {
  const step = (patch: Partial<PlaybookStep> = {}): PlaybookStep => ({
    id: "s1",
    title: "Open console",
    instruction: "",
    command: "",
    expectedResult: "",
    note: "",
    assetIds: [],
    origin: "session",
    sourceSessionId: "session-1",
    sourceEventId: "event-1",
    sourceKind: "capture",
    ...patch,
  });

  it("marks copied content as edited when it changes", () => {
    expect(touched("session")).toBe("edited");
    expect(touched("authored")).toBe("authored");
    expect(editStep(step(), { title: "Open the console" }).origin).toBe("edited");
    expect(editItem({ id: "i", text: "a", origin: "authored" }, "b").origin).toBe("authored");
  });

  it("describes where a step came from", () => {
    const sessions = [{ id: "session-1", title: "Rotate keys", status: "draft" as const, reviewState: "reviewed" as const }];
    expect(sourceText(step(), sessions)).toBe("From session \u201cRotate keys\u201d \u00b7 captured screenshot");
    expect(sourceText(step({ origin: "edited" }), [])).toBe("Edited from a deleted session \u00b7 captured screenshot");
    expect(sourceText(step({ origin: "authored", sourceEventId: null }), sessions)).toBeNull();
  });

  it("moves items and explains what blocks publishing", () => {
    expect(moveBy(["a", "b", "c"], 2, -1)).toEqual(["a", "c", "b"]);
    expect(moveBy(["a", "b"], 0, -1)).toEqual(["a", "b"]);
    const content = { schemaVersion: 1, purpose: "", scope: "", prerequisites: [], permissions: [], steps: [], verification: [], warnings: [], troubleshooting: [], rollback: [] };
    expect(publishBlocker(content)).toBe("Add at least one step first.");
    expect(publishBlocker({ ...content, steps: [step({ title: " " })] })).toBe("Step 1 needs a title.");
    expect(publishBlocker({ ...content, steps: [step()] })).toBeUndefined();
  });

  it("lists exportable versions: the unpublished working copy, then revisions", () => {
    const revision = (revisionNumber: number) => ({
      id: `r${revisionNumber}`,
      revisionNumber,
      title: "T",
      note: "",
      author: "",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    const base = { revisions: [revision(2), revision(1)] } as unknown as PlaybookDetail;
    const draft = exportVersionOptions({ ...base, status: "draft" });
    expect(draft.map((option) => option.value)).toEqual([CURRENT_VERSION, "r2", "r1"]);
    expect(draft[0]!.label).toBe("Current draft (changes after revision 2)");
    const published = exportVersionOptions({ ...base, status: "published" });
    expect(published.map((option) => option.value)).toEqual(["r2", "r1"]);
    expect(published[0]!.label).toMatch(/^Revision 2 — published .* \(current\)$/);
    expect(exportVersionOptions({ ...base, status: "in_review", revisions: [] })[0]!.label).toBe("Version in review (not published)");
  });
});
