import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { PlaybookContent, PlaybookDetail, PlaybookInput, SessionDetail, VersionSnapshot } from "../../lib/api";
import { collapseUnchanged, diffLines } from "../../lib/diff";
import { createFakeBackend, type FakeBackend, type InvokeOptions } from "../../test/fakeBackend";
import { replacedByText, versionEntries, versionText, WORKING_COPY } from "./historyModel";

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

/** A playbook generated from a reviewed session, given a purpose, and published as revision 1. */
async function publishedPlaybook(): Promise<PlaybookDetail> {
  const session = (await backend().invoke("create_session", {
    input: { title: "Rotate the VPN certificate", projectId: null, application: "FortiGate 7.4", environment: "Lab" },
    notes: "",
  })) as SessionDetail;
  await backend().invoke("create_event", {
    sessionId: session.id,
    eventType: "step",
    input: { title: "Open the certificate list", description: "System > Certificates", notes: "", code: "" },
  });
  await backend().invoke("review_events", { sessionId: session.id, eventIds: [backend().events[0]!.id], status: "approved", comment: null });
  const generated = (await backend().invoke("create_playbook_from_session", { sessionId: session.id })) as PlaybookDetail;
  const purpose = Array.from({ length: 8 }, (_, index) => `Purpose line ${index + 1}`).join("\n");
  await backend().invoke("save_playbook", {
    id: generated.id,
    input: inputOf(generated, generated.title),
    content: { ...generated.content, purpose },
  });
  return (await backend().invoke("set_playbook_status", { id: generated.id, status: "published", note: "First release" })) as PlaybookDetail;
}

function inputOf(playbook: PlaybookDetail, title: string): PlaybookInput {
  return {
    title,
    summary: "",
    projectId: null,
    platform: playbook.platform,
    product: "",
    productVersion: "",
    environment: playbook.environment,
    taskType: "",
    author: "",
  };
}

/** Starts the next version: a draft with a new title and a verification item. */
async function editDraft(playbook: PlaybookDetail): Promise<PlaybookDetail> {
  await backend().invoke("set_playbook_status", { id: playbook.id, status: "draft", note: null });
  const content: PlaybookContent = {
    ...playbook.content,
    verification: [{ id: "v1", text: "Clients reconnect", origin: "authored" }],
  };
  return (await backend().invoke("save_playbook", { id: playbook.id, input: inputOf(playbook, "Rotate the VPN certificate v2"), content })) as PlaybookDetail;
}

describe("Version history", () => {
  beforeEach(() => {
    harness.backend = createFakeBackend();
  });

  it("reads a revision and restores it without losing the unpublished draft", async () => {
    const playbook = await editDraft(await publishedPlaybook());
    const user = renderAt(`#/playbooks/${playbook.id}/history`);
    const versions = await screen.findByRole("navigation", { name: "Versions" });
    expect(within(versions).getByRole("button", { name: /Current draft/ })).toBeInTheDocument();
    const revision = within(versions).getByRole("button", { name: /Revision 1/ });
    expect(revision).toHaveAttribute("aria-current", "true");
    expect(within(revision).getByText("First release")).toBeInTheDocument();

    const document = await screen.findByRole("article", { name: "Revision 1" });
    expect(within(document).getByRole("heading", { name: "Rotate the VPN certificate" })).toBeInTheDocument();
    expect(within(document).queryByText("Clients reconnect")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Restore as draft…" }));
    const dialog = screen.getByRole("dialog", { name: "Restore revision 1 as the draft?" });
    expect(within(dialog).getByText(/kept as a saved draft/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Restore as draft" }));

    const editor = await screen.findByRole("article", { name: "Playbook document" });
    expect(within(editor).getByRole("textbox", { name: "Playbook title" })).toHaveValue("Rotate the VPN certificate");
    expect(within(editor).getByText("Restored from revision 1")).toBeInTheDocument();
    const stored = backend().playbooks[0]!;
    expect(stored.restorePoints).toHaveLength(1);
    expect(stored.restorePoints[0]!.title).toBe("Rotate the VPN certificate v2");
    expect(stored.revisions).toHaveLength(1);

    await user.click(screen.getByRole("button", { name: "History" }));
    const history = await screen.findByRole("navigation", { name: "Versions" });
    const savedDraft = within(history).getByRole("button", { name: /Saved draft/ });
    expect(within(savedDraft).getByText(/Replaced by revision 1/)).toBeInTheDocument();
    await user.click(savedDraft);
    expect(await screen.findByText("Clients reconnect")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Export…" })).toHaveAttribute("aria-disabled", "true");
  });

  it("compares versions line by line", async () => {
    const playbook = await editDraft(await publishedPlaybook());
    const user = renderAt(`#/playbooks/${playbook.id}/history?view=compare`);
    const diff = await screen.findByRole("figure", { name: "Changes to Revision 1 → Current draft" });
    expect(within(diff).getByText("+4 additions")).toBeInTheDocument();
    expect(within(diff).getByText("−1 removal")).toBeInTheDocument();
    expect(within(diff).getByText("Title: Rotate the VPN certificate v2")).toBeInTheDocument();
    expect(within(diff).getByText("[ ] Clients reconnect")).toBeInTheDocument();
    expect(within(diff).getByText(/^\d+ unchanged lines$/)).toBeInTheDocument();
    expect(within(diff).queryByText("## Steps")).not.toBeInTheDocument();

    await user.click(screen.getByRole("switch", { name: "Show unchanged lines" }));
    expect(within(diff).queryByText(/^\d+ unchanged lines$/)).not.toBeInTheDocument();
    expect(within(diff).getByText("## Steps")).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText("From"), WORKING_COPY);
    expect(await screen.findByText("No differences between the values.")).toBeInTheDocument();
  });

  it("marks a published procedure out of date and current again", async () => {
    const playbook = await publishedPlaybook();
    const user = renderAt(`#/playbooks/${playbook.id}`);
    await screen.findByRole("article", { name: "Playbook document" });
    await user.click(screen.getByRole("button", { name: "More playbook actions" }));
    await user.click(screen.getByRole("menuitem", { name: /Mark as out of date/ }));
    const dialog = screen.getByRole("dialog", { name: "Mark this procedure as out of date?" });
    await user.type(within(dialog).getByLabelText(/What changed/), "FortiOS 7.6 moved the certificate list");
    await user.click(within(dialog).getByRole("button", { name: "Mark as out of date" }));
    expect(await screen.findByText(/Marked out of date on/)).toBeInTheDocument();
    expect(screen.getByText(/FortiOS 7\.6 moved the certificate list/)).toBeInTheDocument();
    expect(backend().playbooks[0]!.outdatedAt).not.toBeNull();

    window.location.hash = "#/library";
    const table = await screen.findByRole("table", { name: "Library playbooks" });
    expect(await within(table).findByText("Out of date")).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("Filter by freshness"), "current");
    expect(within(table).queryByText("Rotate the VPN certificate")).not.toBeInTheDocument();

    window.location.hash = `#/playbooks/${playbook.id}`;
    await user.click(await screen.findByRole("button", { name: "Mark as current" }));
    await waitFor(() => expect(screen.queryByText(/Marked out of date on/)).not.toBeInTheDocument());
    expect(backend().playbooks[0]!.outdatedAt).toBeNull();
  });

  it("only offers marking out of date for published procedures", async () => {
    const created = (await backend().invoke("create_playbook", {
      input: { title: "Draft only", summary: "", projectId: null, platform: "", product: "", productVersion: "", environment: "", taskType: "", author: "" },
    })) as PlaybookDetail;
    const user = renderAt(`#/playbooks/${created.id}`);
    await screen.findByRole("article", { name: "Playbook document" });
    await user.click(screen.getByRole("button", { name: "More playbook actions" }));
    expect(screen.getByRole("menuitem", { name: /Mark as out of date/ })).toHaveAttribute("aria-disabled", "true");
  });

  it("duplicates a playbook as a new draft that remembers its origin", async () => {
    const playbook = await publishedPlaybook();
    const user = renderAt(`#/playbooks/${playbook.id}`);
    await screen.findByRole("article", { name: "Playbook document" });
    await user.click(screen.getByRole("button", { name: "More playbook actions" }));
    await user.click(screen.getByRole("menuitem", { name: /Duplicate as new playbook/ }));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Playbook title" })).toHaveValue("Copy of Rotate the VPN certificate"));
    const properties = screen.getByRole("complementary", { name: "Playbook properties" });
    expect(within(properties).getByText(/Duplicated from/)).toBeInTheDocument();
    const origin = within(properties)
      .getAllByRole("link", { name: "Rotate the VPN certificate" })
      .filter((link) => link.getAttribute("href")?.endsWith(`/playbooks/${playbook.id}`));
    expect(origin).toHaveLength(1);
    expect(backend().playbooks).toHaveLength(2);
    expect(backend().playbooks[1]!.status).toBe("draft");
  });
});

describe("history model", () => {
  const snapshot = (patch: Partial<VersionSnapshot> = {}): VersionSnapshot => ({
    title: "Patch servers",
    summary: "",
    projectId: null,
    projectName: null,
    platform: "Ubuntu",
    product: "",
    productVersion: "",
    environment: "",
    taskType: "",
    author: "",
    content: {
      schemaVersion: 1,
      purpose: "Keep hosts patched.",
      scope: "",
      prerequisites: [],
      permissions: [],
      steps: [
        {
          id: "s1",
          title: "Update packages",
          instruction: "Run the update.",
          command: "sudo apt upgrade",
          expectedResult: "",
          note: "",
          assetIds: ["0190aaaa-bbbb-7ccc-8ddd-123456789abc"],
          origin: "edited",
          sourceSessionId: "x",
          sourceEventId: "y",
          sourceKind: "capture",
        },
      ],
      verification: [{ id: "v1", text: "Reboot not required", origin: "authored" }],
      warnings: [{ id: "w1", text: "Services restart", origin: "authored" }],
      troubleshooting: [],
      rollback: [{ id: "r1", text: "Restore the snapshot", origin: "authored" }],
    },
    ...patch,
  });

  it("renders versions as comparable text in document order", () => {
    const text = versionText(snapshot(), new Map());
    const lines = text.split("\n");
    expect(lines[0]).toBe("Title: Patch servers");
    expect(text).toContain("Platform: Ubuntu");
    expect(text.indexOf("## Warnings")).toBeLessThan(text.indexOf("## Steps"));
    expect(text).toContain("### 1. Update packages (edited from session)");
    expect(text).toContain("Command:\n    sudo apt upgrade");
    expect(text).toContain("Screenshot 1: unavailable · image 56789abc");
    expect(text).toContain("## Verification\n[ ] Reboot not required");
    expect(text).toContain("## Rollback and recovery\n1. Restore the snapshot");
  });

  it("collapses long unchanged runs but keeps context around changes", () => {
    const before = Array.from({ length: 20 }, (_, index) => `line ${index}`).join("\n");
    const after = before.replace("line 10", "line ten");
    const rows = collapseUnchanged(diffLines(before, after), 2);
    expect(rows.filter((row) => row.type === "gap").map((row) => (row.type === "gap" ? row.count : 0))).toEqual([8, 7]);
    expect(rows.filter((row) => row.type === "line")).toHaveLength(6);
  });

  it("lists the working copy, revisions and saved drafts", () => {
    const detail = {
      status: "draft",
      updatedAt: "2026-01-01T00:00:00.000Z",
      revisions: [{ id: "r1", revisionNumber: 1, title: "T", note: "First", author: "Ana", createdAt: "2026-01-01T00:00:00.000Z" }],
      restorePoints: [{ id: "p1", title: "Old draft", replacedBy: "revision:1", createdAt: "2026-01-02T00:00:00.000Z" }],
    } as unknown as PlaybookDetail;
    const entries = versionEntries(detail);
    expect(entries.map((entry) => [entry.kind, entry.label])).toEqual([
      ["working", "Current draft"],
      ["revision", "Revision 1"],
      ["restorePoint", "Saved draft"],
    ]);
    expect(entries[1]!.detail).toMatch(/by Ana$/);
    expect(replacedByText({ id: "p", title: "", replacedBy: "restore-point:x", createdAt: "" })).toBe("Replaced by an earlier saved draft");
  });
});
