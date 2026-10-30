import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ChangeRecord, SessionDetail } from "../../lib/api";
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

function renderAt(hash: string) {
  window.location.hash = hash;
  const user = userEvent.setup();
  render(<App />);
  return user;
}

const inspector = () => screen.findByRole("complementary", { name: "Change details" });

describe("Change History", () => {
  beforeEach(() => {
    harness.backend = createFakeBackend();
  });

  it("records, edits, reviews, verifies and deletes a declared change", async () => {
    const user = renderAt("#/changes");
    expect(await screen.findByText("No changes recorded")).toBeInTheDocument();

    // Validation happens before anything is saved.
    await user.click(screen.getByRole("button", { name: "Record Change" }));
    let dialog = screen.getByRole("dialog", { name: "Record a change" });
    await user.click(within(dialog).getByRole("button", { name: "Record change" }));
    expect(within(dialog).getByText("Describe what changed.")).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText("What changed"), "sshd_config: PermitRootLogin");
    await user.click(within(dialog).getByRole("button", { name: "Record change" }));
    expect(within(dialog).getByText(/value before or after/)).toBeInTheDocument();
    expect(backend().changes).toHaveLength(0);

    await user.type(within(dialog).getByLabelText(/^Value before/), "yes");
    await user.type(within(dialog).getByLabelText(/^Value after/), "no");
    await user.click(within(dialog).getByRole("button", { name: "Record change" }));

    // A recorded change is declared and pending: a statement, not a verified fact.
    let details = await inspector();
    expect(within(details).getByText("Declared")).toBeInTheDocument();
    expect(within(details).getByText("Pending")).toBeInTheDocument();
    expect(within(details).getByText("Recorded by a person")).toBeInTheDocument();
    expect(backend().changes[0]).toMatchObject({ assertion: "declared", approvalState: "pending", beforeValue: "yes", afterValue: "no" });

    // Declared changes can be edited until they are reviewed.
    await user.click(within(details).getByRole("button", { name: "Edit…" }));
    dialog = screen.getByRole("dialog", { name: "Edit declared change" });
    await user.type(within(dialog).getByLabelText(/^Environment/), "Production");
    await user.click(within(dialog).getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(backend().changes[0]!.environment).toBe("Production"));

    // Approve with a comment; afterwards the record is no longer editable.
    details = await inspector();
    await user.type(within(details).getByLabelText(/^Comment/), "Matches the change request");
    await user.click(within(details).getByRole("button", { name: "Approve" }));
    expect(await screen.findByText("Change approved")).toBeInTheDocument();
    details = await inspector();
    expect(await within(details).findByText("Approved")).toBeInTheDocument();
    expect(within(details).getByText("Matches the change request")).toBeInTheDocument();
    const edit = within(details).getByRole("button", { name: "Edit…" });
    expect(edit).toHaveAttribute("aria-disabled", "true");
    expect(edit).toHaveAccessibleDescription(/not reviewed yet/);

    // Verification needs a note on how the outcome was checked.
    await user.click(within(details).getByRole("button", { name: "Mark verified…" }));
    const confirm = screen.getByRole("dialog", { name: "Mark this change as verified?" });
    await user.click(within(confirm).getByRole("button", { name: "Mark verified" }));
    expect(await within(confirm).findByText(/How the outcome was verified is required/)).toBeInTheDocument();
    expect(backend().changes[0]!.assertion).toBe("declared");
    await user.type(within(confirm).getByLabelText("How the outcome was verified"), "sshd -T shows permitrootlogin no");
    await user.click(within(confirm).getByRole("button", { name: "Mark verified" }));
    expect(await screen.findByText("Change verified")).toBeInTheDocument();

    details = await inspector();
    expect(await within(details).findByText("sshd -T shows permitrootlogin no")).toBeInTheDocument();
    expect(within(details).getAllByText("Verified").length).toBeGreaterThanOrEqual(1);
    expect(backend().changes[0]).toMatchObject({ assertion: "verified", approvalState: "approved", verificationNote: "sshd -T shows permitrootlogin no" });
    expect(within(details).getByRole("button", { name: "Reject" })).toHaveAccessibleDescription(/verified change cannot be rejected/);
    expect(within(details).getByRole("button", { name: "Mark verified…" })).toHaveAttribute("aria-disabled", "true");

    // Delete asks first and removes only the record.
    await user.click(within(details).getByRole("button", { name: "Delete…" }));
    const remove = screen.getByRole("dialog", { name: "Delete this change record?" });
    await user.click(within(remove).getByRole("button", { name: "Delete change" }));
    expect(await screen.findByText("No changes recorded")).toBeInTheDocument();
    expect(backend().changes).toHaveLength(0);
  });

  it("shows observed changes from a watched file as read-only evidence linked to the session", async () => {
    const session = (await backend().invoke("create_session", {
      input: { title: "Harden SSH", projectId: null, application: "", environment: "" },
      notes: "",
    })) as SessionDetail;
    const now = new Date().toISOString();
    const observed: ChangeRecord = {
      id: "change-observed",
      projectId: null,
      projectName: null,
      sessionId: session.id,
      sessionTitle: session.title,
      eventId: "event-watch",
      eventTitle: "Changed: sshd_config",
      occurredAt: now,
      target: "C:/lab/sshd_config",
      summary: "1 line changed",
      environment: "",
      platform: "",
      version: "",
      beforeValue: "PermitRootLogin yes\n",
      afterValue: "PermitRootLogin no\n",
      assertion: "observed",
      approvalState: "pending",
      source: "file_watch",
      reviewComment: "",
      reviewer: "",
      reviewedAt: null,
      verificationNote: "",
      verifiedBy: "",
      verifiedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    backend().changes.push(observed);

    const user = renderAt(`#/changes?selected=${observed.id}`);
    const details = await inspector();
    expect(within(details).getByText("Observed")).toBeInTheDocument();
    expect(within(details).getByText("Watched configuration file")).toBeInTheDocument();
    expect(within(details).getByText(/cannot be edited/)).toBeInTheDocument();
    expect(within(details).getByRole("link", { name: "Harden SSH" })).toHaveAttribute("href", `#/sessions/${session.id}`);
    expect(within(details).getByRole("link", { name: "Changed: sshd_config" })).toHaveAttribute("href", `#/sessions/${session.id}?step=event-watch`);
    expect(within(details).getByRole("button", { name: "Edit…" })).toHaveAttribute("aria-disabled", "true");

    // Evidence filters.
    const table = screen.getByRole("table", { name: "Change history" });
    await user.selectOptions(screen.getByRole("combobox", { name: "Filter by evidence level" }), "verified");
    expect(await screen.findByText("No changes match these filters")).toBeInTheDocument();
    await user.selectOptions(screen.getByRole("combobox", { name: "Filter by evidence level" }), "observed");
    expect(await within(table).findByText("C:/lab/sshd_config")).toBeInTheDocument();
  });
});
