import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { Camera, MousePointerClick } from "lucide-react";
import { describe, expect, it, vi } from "vitest";

import { sessionStatus } from "../lib/status";
import { Button, IconButton } from "./Button";
import { SegmentedControl, Tabs } from "./Choice";
import { DataTable, type Column, type SortState } from "./DataTable";
import { Dialog } from "./Dialog";
import { DiffView } from "./DiffView";
import { EmptyState, StatusBadge } from "./Feedback";
import { Menu } from "./Menu";
import { ScreenshotViewer } from "./ScreenshotViewer";
import { Timeline, type TimelineEvent } from "./Timeline";

describe("Button", () => {
  it("explains unavailable actions and blocks activation", async () => {
    const onClick = vi.fn();
    render(
      <Button onClick={onClick} disabledReason="Arrives in a later milestone.">
        Export
      </Button>,
    );
    const button = screen.getByRole("button", { name: "Export" });
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(button).toHaveAccessibleDescription("Arrives in a later milestone.");
    expect(button).not.toBeDisabled(); // stays focusable so the reason is discoverable
    await userEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("icon buttons always have an accessible name", () => {
    render(<IconButton icon={Camera} label="Take screenshot" />);
    expect(screen.getByRole("button", { name: "Take screenshot" })).toBeInTheDocument();
  });
});

describe("StatusBadge", () => {
  it("conveys status with text, not color alone", () => {
    render(<StatusBadge status={sessionStatus.completed} />);
    expect(screen.getByText("Completed")).toBeInTheDocument();
  });
});

interface Row {
  id: string;
  name: string;
  count: number;
}

const rows: Row[] = [
  { id: "a", name: "Beta", count: 2 },
  { id: "b", name: "Alpha", count: 10 },
];

const columns: Column<Row>[] = [
  { id: "name", header: "Name", sortValue: (row) => row.name, cell: (row) => row.name },
  { id: "count", header: "Count", sortValue: (row) => row.count, cell: (row) => row.count },
];

function SortableTable({ onActivate }: { onActivate: (row: Row) => void }) {
  const [sort, setSort] = useState<SortState>({ columnId: "name", direction: "asc" });
  return <DataTable label="Rows" columns={columns} rows={rows} getRowId={(row) => row.id} sort={sort} onSortChange={setSort} onRowActivate={onActivate} />;
}

describe("DataTable", () => {
  it("sorts by column and exposes aria-sort", async () => {
    render(<SortableTable onActivate={() => undefined} />);
    const bodyRows = () => within(screen.getByRole("table")).getAllByRole("row").slice(1);
    expect(bodyRows()[0]).toHaveTextContent("Alpha");
    expect(screen.getByRole("columnheader", { name: /Name/ })).toHaveAttribute("aria-sort", "ascending");
    await userEvent.click(screen.getByRole("button", { name: /Name/ }));
    expect(bodyRows()[0]).toHaveTextContent("Beta");
    expect(screen.getByRole("columnheader", { name: /Name/ })).toHaveAttribute("aria-sort", "descending");
  });

  it("activates rows with the keyboard", async () => {
    const onActivate = vi.fn();
    render(<SortableTable onActivate={onActivate} />);
    const firstRow = within(screen.getByRole("table")).getAllByRole("row")[1]!;
    firstRow.focus();
    await userEvent.keyboard("{Enter}");
    expect(onActivate).toHaveBeenCalledWith(expect.objectContaining({ name: "Alpha" }));
  });

  it("shows the empty state while keeping column headers", () => {
    render(
      <DataTable label="Rows" columns={columns} rows={[]} getRowId={(row) => row.id} empty={<EmptyState icon={Camera} title="Nothing here" />} />,
    );
    expect(screen.getByRole("columnheader", { name: "Name" })).toBeInTheDocument();
    expect(screen.getByText("Nothing here")).toBeInTheDocument();
  });
});

describe("Tabs and SegmentedControl", () => {
  function TabsHarness() {
    const [value, setValue] = useState("one");
    return (
      <Tabs
        label="Sample"
        idPrefix="t"
        value={value}
        onChange={setValue}
        options={[
          { value: "one", label: "One" },
          { value: "two", label: "Two" },
        ]}
      />
    );
  }

  it("moves between tabs with arrow keys", async () => {
    render(<TabsHarness />);
    screen.getByRole("tab", { name: "One" }).focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: "Two" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "Two" })).toHaveFocus();
  });

  it("selects segmented options by click", async () => {
    const onChange = vi.fn();
    render(
      <SegmentedControl
        label="Theme"
        value="light"
        onChange={onChange}
        options={[
          { value: "light", label: "Light" },
          { value: "dark", label: "Dark" },
        ]}
      />,
    );
    expect(screen.getByRole("radio", { name: "Light" })).toHaveAttribute("aria-checked", "true");
    await userEvent.click(screen.getByRole("radio", { name: "Dark" }));
    expect(onChange).toHaveBeenCalledWith("dark");
  });
});

describe("DiffView", () => {
  it("labels additions and removals textually", () => {
    render(<DiffView label="sshd_config" before={"PermitRootLogin yes\n"} after={"PermitRootLogin no\n"} />);
    expect(screen.getByText("+1 addition")).toBeInTheDocument();
    expect(screen.getByText(/1 removal/)).toBeInTheDocument();
    expect(screen.getByText("Removed:", { exact: false })).toBeInTheDocument();
    expect(screen.getByText("Added:", { exact: false })).toBeInTheDocument();
  });

  it("reports identical values", () => {
    render(<DiffView label="x" before="same" after="same" />);
    expect(screen.getByText("No differences between the values.")).toBeInTheDocument();
  });
});

describe("Timeline", () => {
  const excludedStatus = { label: "Excluded", tone: "neutral" as const, icon: Camera, description: "Irrelevant" };
  const events: TimelineEvent[] = [
    { id: "1", occurredAt: "2026-10-22T15:00:00.000Z", title: "First", typeLabel: "Screenshot", icon: Camera },
    { id: "2", occurredAt: "2026-10-22T15:01:00.000Z", title: "Second", typeLabel: "Click", icon: MousePointerClick, excluded: true, status: excludedStatus },
  ];

  it("selects events with arrow keys and labels excluded events", async () => {
    const onSelect = vi.fn();
    render(<Timeline label="Events" events={events} selectedId="1" onSelect={onSelect} />);
    expect(screen.getByText(/Excluded/)).toBeInTheDocument();
    screen.getByRole("option", { name: /First/ }).focus();
    await userEvent.keyboard("{ArrowDown}");
    expect(onSelect).toHaveBeenCalledWith("2");
  });

  it("lets callers handle keys before navigation", async () => {
    const onSelect = vi.fn();
    const onItemKeyDown = vi.fn((event: { key: string; altKey: boolean; preventDefault: () => void }, id: string) => {
      if (event.key === "a" || (event.key === "ArrowDown" && event.altKey)) event.preventDefault();
      return id;
    });
    render(<Timeline label="Events" events={events} selectedId="1" onSelect={onSelect} onItemKeyDown={onItemKeyDown} />);
    screen.getByRole("option", { name: /First/ }).focus();
    await userEvent.keyboard("a");
    await userEvent.keyboard("{Alt>}{ArrowDown}{/Alt}");
    const keys = onItemKeyDown.mock.calls.map(([event]) => event.key);
    expect(keys).toEqual(expect.arrayContaining(["a", "ArrowDown"]));
    expect(onItemKeyDown.mock.calls[0]![1]).toBe("1");
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("renders the empty state without events", () => {
    render(<Timeline label="Events" events={[]} empty={<p>No events</p>} />);
    expect(screen.getByText("No events")).toBeInTheDocument();
  });
});

describe("ScreenshotViewer", () => {
  it("disables controls with a reason when there is no image", () => {
    render(<ScreenshotViewer label="Viewer" image={null} unavailableReason="No screenshot." empty={<p>Empty</p>} />);
    expect(screen.getByRole("button", { name: "Zoom in" })).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByText("Empty")).toBeInTheDocument();
  });

  it("renders the image with highlighted regions", () => {
    render(
      <ScreenshotViewer
        label="Viewer"
        image={{ src: "data:image/png;base64,AA==", alt: "Settings page", width: 100, height: 50 }}
        highlights={[{ id: "h", x: 10, y: 10, width: 20, height: 10, label: "Click" }]}
      />,
    );
    expect(screen.getByRole("img", { name: "Settings page" })).toBeInTheDocument();
    expect(screen.getByText("Click")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Zoom in" })).not.toHaveAttribute("aria-disabled");
  });
});

describe("Dialog", () => {
  it("shows its content when open and closes on cancel (Escape)", () => {
    const onClose = vi.fn();
    render(
      <Dialog open title="Rename" onClose={onClose}>
        <p>Body</p>
      </Dialog>,
    );
    const dialog = screen.getByRole("dialog", { name: "Rename" });
    expect(within(dialog).getByText("Body")).toBeInTheDocument();
    fireEvent(dialog, new Event("cancel", { cancelable: true }));
    expect(onClose).toHaveBeenCalled();
  });
});

describe("Menu", () => {
  it("opens, navigates with arrows, selects, and restores focus", async () => {
    const onSelect = vi.fn();
    render(
      <Menu
        label="Actions"
        entries={[
          { id: "a", label: "First" },
          { id: "b", label: "Second", onSelect },
        ]}
        renderTrigger={(props) => (
          <button {...props} type="button">
            Open
          </button>
        )}
      />,
    );
    const trigger = screen.getByRole("button", { name: "Open" });
    await userEvent.click(trigger);
    expect(screen.getByRole("menuitem", { name: "First" })).toHaveFocus();
    await userEvent.keyboard("{ArrowDown}");
    expect(screen.getByRole("menuitem", { name: "Second" })).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    expect(onSelect).toHaveBeenCalled();
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("closes on Escape", async () => {
    render(
      <Menu
        label="Actions"
        entries={[{ id: "a", label: "First" }]}
        renderTrigger={(props) => (
          <button {...props} type="button">
            Open
          </button>
        )}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Open" }));
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });
});
