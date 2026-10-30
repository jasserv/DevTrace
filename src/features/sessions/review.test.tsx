import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SessionDetail } from "../../lib/api";
import { createFakeBackend, pngBytes, type FakeBackend, type InvokeOptions } from "../../test/fakeBackend";
import { decisionSummary, markReviewedBlocker, moveInOrder, reviewCounts } from "./review";

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

async function seed(): Promise<SessionDetail> {
  const session = (await backend().invoke("create_session", {
    input: { title: "Rotate certificates", projectId: null, application: "", environment: "" },
    notes: "",
  })) as SessionDetail;
  for (const title of ["Open the console", "Check unrelated mail", "Renew the certificate"]) {
    await backend().invoke("create_event", { sessionId: session.id, eventType: "step", input: { title, description: "", notes: "", code: "" } });
  }
  return session;
}

function renderSession(id: string) {
  window.location.hash = `#/sessions/${id}`;
  const user = userEvent.setup();
  render(<App />);
  return user;
}

const steps = () => screen.findByRole("listbox", { name: "Session steps" });
const inspector = () => screen.getByRole("complementary", { name: "Session inspector" });
const statuses = () => backend().events.map((event) => `${event.title}:${event.reviewStatus}`);

describe("Event review", () => {
  beforeEach(() => {
    harness.backend = createFakeBackend();
  });

  it("approves, rejects and excludes steps with buttons and keys, with an audit trail", async () => {
    const session = await seed();
    const user = renderSession(session.id);
    const list = await steps();
    await within(list).findByText("Open the console");

    // Buttons in the inspector, with a comment.
    const decision = within(inspector()).getByRole("group", { name: "Review decision" });
    await user.type(within(inspector()).getByLabelText(/Review comment/), "Matches the runbook");
    await user.click(within(decision).getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(statuses()[0]).toBe("Open the console:approved"));
    expect(backend().decisions[0]).toMatchObject({ decision: "approve", comment: "Matches the runbook" });
    expect(await within(decision).findByRole("button", { name: "Approve" })).toHaveAttribute("aria-pressed", "true");
    expect(within(inspector()).getByRole("list", { name: "Review history of this step" })).toHaveTextContent("Matches the runbook");

    // Single-letter keys on the focused step.
    await user.click(within(list).getByText("Check unrelated mail"));
    await user.keyboard("x");
    await waitFor(() => expect(statuses()[1]).toBe("Check unrelated mail:excluded"));
    await user.click(within(list).getByText("Renew the certificate"));
    await user.keyboard("r");
    await waitFor(() => expect(statuses()[2]).toBe("Renew the certificate:rejected"));
    await user.keyboard("p");
    await waitFor(() => expect(statuses()[2]).toBe("Renew the certificate:pending"));

    // Decided steps show their status in the list; excluded and rejected ones are dimmed.
    expect(await within(list).findByText("Excluded")).toBeInTheDocument();
    expect(within(list).getByText("Approved")).toBeInTheDocument();
    expect(screen.getByText(/2 of 3 reviewed/)).toBeInTheDocument();
  });

  it("filters the step list by review status", async () => {
    const session = await seed();
    await backend().invoke("review_events", { sessionId: session.id, eventIds: [backend().events[1]!.id], status: "excluded", comment: null });
    const user = renderSession(session.id);
    const list = await steps();
    await within(list).findByText("Open the console");

    await user.selectOptions(screen.getByRole("combobox", { name: "Show steps" }), "excluded");
    expect(within(list).queryByText("Open the console")).not.toBeInTheDocument();
    expect(within(list).getByText("Check unrelated mail")).toBeInTheDocument();

    await user.selectOptions(screen.getByRole("combobox", { name: "Show steps" }), "rejected");
    expect(await screen.findByText("No matching steps")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Show all steps" }));
    expect(await within(await steps()).findByText("Open the console")).toBeInTheDocument();
  });

  it("marks the session reviewed only when every step has a decision", async () => {
    const session = await seed();
    const user = renderSession(session.id);
    await within(await steps()).findByText("Open the console");
    const mark = screen.getByRole("button", { name: "Mark reviewed" });
    expect(mark).toHaveAttribute("aria-disabled", "true");
    expect(mark).toHaveAccessibleDescription(/3 steps still need a decision/);

    const ids = backend().events.map((event) => event.id);
    await backend().invoke("review_events", { sessionId: session.id, eventIds: ids, status: "approved", comment: null });
    await user.click(within(await steps()).getByText("Check unrelated mail"));
    await user.keyboard("x");
    await waitFor(() => expect(screen.getByRole("button", { name: "Mark reviewed" })).not.toHaveAttribute("aria-disabled"));

    await user.click(screen.getByRole("button", { name: "Mark reviewed" }));
    expect(await screen.findByText("Review finished")).toBeInTheDocument();
    expect(backend().sessions[0]!.reviewState).toBe("reviewed");
    await waitFor(() => expect(screen.queryByRole("button", { name: "Mark reviewed" })).not.toBeInTheDocument());

    // The Session tab shows the outcome and the full history; the review can be reopened.
    await user.click(screen.getByRole("tab", { name: "Session" }));
    const history = within(inspector()).getByRole("list", { name: "Review history" });
    expect(history).toHaveTextContent("Marked the session reviewed");
    await user.click(within(inspector()).getByRole("button", { name: "Reopen review" }));
    await waitFor(() => expect(backend().sessions[0]!.reviewState).toBe("in_review"));
  });

  it("reorders steps with buttons and Alt+arrow keys", async () => {
    const session = await seed();
    const user = renderSession(session.id);
    const list = await steps();
    await user.click(within(list).getByText("Renew the certificate"));
    await user.click(within(inspector()).getByRole("button", { name: "Move step up" }));
    await waitFor(() =>
      expect([...backend().events].sort((a, b) => a.position - b.position).map((event) => event.title)).toEqual([
        "Open the console",
        "Renew the certificate",
        "Check unrelated mail",
      ]),
    );
    expect(backend().decisions[0]!.decision).toBe("reorder");

    within(await steps())
      .getByRole("option", { name: /Renew the certificate/ })
      .focus();
    await user.keyboard("{Alt>}{ArrowUp}{/Alt}");
    await waitFor(() => expect([...backend().events].sort((a, b) => a.position - b.position)[0]!.title).toBe("Renew the certificate"));
    expect(within(inspector()).getByRole("button", { name: "Move step up" })).toHaveAttribute("aria-disabled", "true");
  });

  it("keeps the order locked but decisions open in a completed session", async () => {
    const session = await seed();
    await backend().invoke("set_session_status", { id: session.id, status: "completed" });
    const user = renderSession(session.id);
    await within(await steps()).findByText("Open the console");
    expect(within(inspector()).getByRole("button", { name: "Move step down" })).toHaveAccessibleDescription(/Reopen it/);
    await user.click(within(within(inspector()).getByRole("group", { name: "Review decision" })).getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(statuses()[0]).toBe("Open the console:approved"));
  });

  it("enters redaction mode without changing the image until areas are confirmed", async () => {
    const session = (await backend().invoke("create_session", {
      input: { title: "Router password reset", projectId: null, application: "", environment: "" },
      notes: "",
    })) as SessionDetail;
    await backend().invoke("import_image", pngBytes(), { headers: { "x-session-id": session.id, "x-source": "file", "x-file-name": "router.png" } });
    const before = backend().attachments[0]!.sha256;
    const user = renderSession(session.id);
    await within(await steps()).findByText("router");

    await user.click(screen.getByRole("button", { name: "Redact" }));
    expect(screen.getByRole("button", { name: "Redact" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("Drag over sensitive areas")).toBeInTheDocument();
    // jsdom has no layout, so drawing is exercised in the E2E test; here the confirmation flow is.
    expect(screen.queryByRole("button", { name: "Apply redaction…" })).not.toBeInTheDocument();
    expect(backend().attachments[0]!.sha256).toBe(before);
  });
});

describe("review helpers", () => {
  it("counts decisions and explains what blocks finishing", () => {
    const events = [{ reviewStatus: "approved" }, { reviewStatus: "pending" }, { reviewStatus: "excluded" }] as Parameters<typeof reviewCounts>[0];
    const counts = reviewCounts(events);
    expect(counts).toEqual({ total: 3, pending: 1, approved: 1, rejected: 0, excluded: 1, decided: 2 });
    expect(markReviewedBlocker(counts)).toBe("1 step still needs a decision.");
    expect(markReviewedBlocker({ ...counts, pending: 0 })).toBeUndefined();
    expect(markReviewedBlocker(reviewCounts([]))).toMatch(/Add steps/);
  });

  it("moves an id within an order", () => {
    expect(moveInOrder(["a", "b", "c"], "c", -1)).toEqual(["a", "c", "b"]);
    expect(moveInOrder(["a", "b", "c"], "a", 1)).toEqual(["b", "a", "c"]);
    expect(moveInOrder(["a", "b", "c"], "a", -1)).toBeNull();
    expect(moveInOrder(["a", "b", "c"], "z", 1)).toBeNull();
  });

  it("summarizes decisions for the history", () => {
    const base = { id: "d", sessionId: "s", comment: "", reviewer: "", details: {}, createdAt: "" };
    expect(decisionSummary({ ...base, eventId: "e", eventTitle: "Open console", decision: "approve" })).toBe("Approved \u00b7 Open console");
    expect(decisionSummary({ ...base, eventId: "e", eventTitle: null, decision: "reject" })).toBe("Rejected \u00b7 deleted step");
    expect(decisionSummary({ ...base, eventId: null, eventTitle: null, decision: "mark_reviewed" })).toBe("Marked the session reviewed");
  });
});
