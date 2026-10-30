import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeBackend, type FakeBackend, type InvokeOptions } from "../test/fakeBackend";

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

import { App } from "./App";

function renderApp() {
  const user = userEvent.setup();
  render(<App />);
  return user;
}

const pageHeading = () => screen.getByRole("heading", { level: 1 });
const mainNav = () => screen.getByRole("navigation", { name: "Main" });

describe("DevTrace app", () => {
  beforeEach(() => {
    harness.backend = createFakeBackend();
  });

  it("starts on the Overview with data loaded from the backend", async () => {
    renderApp();
    expect(await screen.findByRole("heading", { level: 1, name: "Overview" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Local Workspace" })).toBeInTheDocument();
    await waitFor(() => expect(harness.backend!.calls).toContain("get_overview"));
    expect(await screen.findByText("No sessions yet")).toBeInTheDocument();
  });

  it("navigates to every primary section from the sidebar", async () => {
    const user = renderApp();
    await screen.findByRole("heading", { level: 1, name: "Overview" });
    for (const label of ["Capture", "Sessions", "Playbooks", "Change History", "Knowledge Library", "Projects", "Settings", "Overview"]) {
      await user.click(within(mainNav()).getByRole("link", { name: label }));
      expect(pageHeading()).toHaveTextContent(label);
    }
  });

  it("navigates with Ctrl+digit shortcuts", async () => {
    const user = renderApp();
    await screen.findByRole("heading", { level: 1, name: "Overview" });
    await user.keyboard("{Control>}7{/Control}");
    expect(pageHeading()).toHaveTextContent("Projects");
    await user.keyboard("{Control>}2{/Control}");
    expect(pageHeading()).toHaveTextContent("Capture");
  });

  it("reports the capture state honestly and opens shipped features instead of placeholders", async () => {
    const user = renderApp();
    await screen.findByRole("heading", { level: 1, name: "Overview" });
    expect(screen.getByRole("link", { name: /Capture status: Not recording/ })).toBeInTheDocument();
    await user.click(within(mainNav()).getByRole("link", { name: "Change History" }));
    const record = await screen.findByRole("button", { name: "Record Change" });
    expect(record).not.toHaveAttribute("aria-disabled");
    await user.click(record);
    expect(screen.getByRole("dialog", { name: "Record a change" })).toBeInTheDocument();
  });

  it("opens the Capture workspace from Start Capture", async () => {
    const user = renderApp();
    const start = await screen.findByRole("button", { name: "Start Capture" });
    expect(start).not.toHaveAttribute("aria-disabled");
    await user.click(start);
    expect(pageHeading()).toHaveTextContent("Capture");
    expect(await screen.findByRole("radio", { name: /Display 1/ })).toBeInTheDocument();
  });

  it("switches theme immediately and persists it", async () => {
    const user = renderApp();
    await user.click(within(mainNav()).getByRole("link", { name: "Settings" }));
    await user.click(screen.getByRole("radio", { name: "Dark" }));
    expect(document.documentElement.dataset.theme).toBe("dark");
    await waitFor(() => expect(harness.backend!.settings.theme).toBe("dark"));
    expect(JSON.parse(localStorage.getItem("devtrace.appearance") ?? "{}").theme).toBe("dark");
    await user.click(screen.getByRole("radio", { name: "Light" }));
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("creates, validates, renames and deletes a project", async () => {
    const user = renderApp();
    await user.click(within(mainNav()).getByRole("link", { name: "Projects" }));
    expect(await screen.findByText("No projects yet")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "New Project" }));
    let dialog = screen.getByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Create project" }));
    expect(within(dialog).getByText("Project name is required.")).toBeInTheDocument();

    await user.type(within(dialog).getByLabelText("Name"), "Core Network");
    await user.click(within(dialog).getByRole("button", { name: "Create project" }));
    await waitFor(() => expect(pageHeading()).toHaveTextContent("Core Network"));
    expect(harness.backend!.projects).toHaveLength(1);

    await user.click(screen.getByRole("button", { name: "New Project" }));
    dialog = screen.getByRole("dialog");
    await user.type(within(dialog).getByLabelText("Name"), "core network");
    await user.click(within(dialog).getByRole("button", { name: "Create project" }));
    expect(await within(dialog).findByText(/already exists/)).toBeInTheDocument();
    expect(within(dialog).getByLabelText("Name")).toHaveValue("core network");
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));

    const inspector = screen.getByRole("complementary", { name: "Project details" });
    await user.click(within(inspector).getByRole("button", { name: "Edit" }));
    dialog = screen.getByRole("dialog");
    const name = within(dialog).getByLabelText("Name");
    await user.clear(name);
    await user.type(name, "Core Network Lab");
    await user.click(within(dialog).getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(pageHeading()).toHaveTextContent("Core Network Lab"));

    await user.click(within(screen.getByRole("complementary", { name: "Project details" })).getByRole("button", { name: "Delete" }));
    const confirm = screen.getByRole("dialog", { name: /Delete/ });
    expect(within(confirm).getByText(/permanently removed/)).toBeInTheDocument();
    await user.click(within(confirm).getByRole("button", { name: "Delete project" }));
    expect(await screen.findByText("No projects yet")).toBeInTheDocument();
    expect(harness.backend!.projects).toHaveLength(0);
  });

  it("renames the workspace from the workspace selector", async () => {
    const user = renderApp();
    await screen.findByRole("heading", { level: 1, name: "Overview" });
    await user.click(screen.getByRole("button", { name: /Local Workspace/ }));
    await user.click(screen.getByRole("menuitem", { name: /Rename workspace/ }));
    const dialog = screen.getByRole("dialog");
    const input = within(dialog).getByLabelText("Workspace name");
    await user.clear(input);
    await user.type(input, "Network Lab");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(harness.backend!.settings.workspaceName).toBe("Network Lab"));
    expect(screen.getByRole("heading", { name: "Network Lab" })).toBeInTheDocument();
  });
});
