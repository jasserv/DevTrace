import { useState } from "react";
import { Camera, Download, MousePointerClick, Plus, Settings2, StickyNote, Terminal, Trash2 } from "lucide-react";

import {
  Button,
  ConfirmDialog,
  DataTable,
  DiffView,
  EmptyState,
  IconButton,
  Menu,
  Notice,
  ScreenshotViewer,
  SearchField,
  SegmentedControl,
  Select,
  StatusBadge,
  Switch,
  Tabs,
  TextArea,
  TextField,
  Timeline,
  useToast,
  type Column,
  type TimelineEvent,
} from "../../components";
import { Page, Section } from "../../layout/Page";
import { approvalState, changeAssertion, playbookStatus, reviewState, sessionStatus } from "../../lib/status";

/*
 * DEVELOPMENT ONLY. Renders every shared component with clearly labeled sample content so the
 * design system can be verified visually in both themes. This route is compiled out of
 * production builds and never reads or writes workspace data.
 */

const SAMPLE_IMAGE = `data:image/svg+xml;utf8,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="600"><rect width="960" height="600" fill="#f5f5f7"/><rect width="960" height="48" fill="#ffffff"/><rect x="24" y="16" width="160" height="16" rx="3" fill="#d2d2d7"/><rect x="24" y="80" width="280" height="20" rx="3" fill="#1d1d1f"/><rect x="24" y="120" width="912" height="1" fill="#e5e5e7"/><rect x="24" y="144" width="420" height="14" rx="3" fill="#86868b"/><rect x="24" y="172" width="380" height="14" rx="3" fill="#86868b"/><rect x="760" y="520" width="176" height="40" rx="4" fill="#0071e3"/><text x="848" y="545" font-family="sans-serif" font-size="15" fill="#ffffff" text-anchor="middle">SAMPLE</text></svg>`,
)}`;

const sampleEvents: TimelineEvent[] = [
  { id: "1", occurredAt: "2026-10-22T15:01:02.000Z", title: "Sample: opened settings", typeLabel: "Screenshot", icon: Camera, status: reviewState.reviewed },
  { id: "2", occurredAt: "2026-10-22T15:01:40.000Z", title: "Sample: clicked Save", typeLabel: "Click", icon: MousePointerClick, status: reviewState.unreviewed },
  { id: "3", occurredAt: "2026-10-22T15:02:05.000Z", title: "Sample: scrolled list", typeLabel: "Navigation", icon: Settings2, excluded: true },
  { id: "4", occurredAt: "2026-10-22T15:03:11.000Z", title: "Sample: ran a command", typeLabel: "Command", icon: Terminal },
  { id: "5", occurredAt: "2026-10-22T15:04:00.000Z", title: "Sample: added a note", typeLabel: "Note", icon: StickyNote },
];

interface SampleRow {
  id: string;
  name: string;
  owner: string;
  count: number;
}

const sampleRows: SampleRow[] = [
  { id: "a", name: "Sample row A", owner: "Sample owner", count: 3 },
  { id: "b", name: "Sample row B", owner: "Sample owner", count: 12 },
  { id: "c", name: "Sample row C", owner: "Sample owner", count: 7 },
];

const sampleColumns: Column<SampleRow>[] = [
  { id: "name", header: "Name", sortValue: (row) => row.name, cell: (row) => row.name },
  { id: "owner", header: "Owner", tone: "secondary", sortValue: (row) => row.owner, cell: (row) => row.owner },
  { id: "count", header: "Count", align: "end", width: "100px", sortValue: (row) => row.count, cell: (row) => row.count },
];

export default function ComponentGallery() {
  const toast = useToast();
  const [tab, setTab] = useState("one");
  const [segment, setSegment] = useState("a");
  const [toggle, setToggle] = useState(true);
  const [query, setQuery] = useState("");
  const [selectedEvent, setSelectedEvent] = useState<string | null>("2");
  const [selectedRow, setSelectedRow] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  return (
    <Page title="Component gallery" breadcrumbs={[{ label: "Settings", to: "/settings" }]}>
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-8)", padding: "var(--space-6) var(--space-8) var(--space-12)", maxWidth: 1100 }}>
        <Notice tone="warning" title="Development only">
          Sample content for visual verification of the design system. Not workspace data; excluded from production builds.
        </Notice>

        <Section title="Buttons">
          <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-2)", alignItems: "center", paddingTop: "var(--space-3)" }}>
            <Button variant="primary" icon={Plus}>Primary</Button>
            <Button>Secondary</Button>
            <Button variant="ghost">Ghost</Button>
            <Button variant="danger" icon={Trash2}>Danger</Button>
            <Button variant="primary" loading>Saving</Button>
            <Button disabledReason="Explains why this action is unavailable.">Unavailable</Button>
            <Button size="sm">Small</Button>
            <Button size="lg" variant="primary">Large</Button>
            <IconButton icon={Download} label="Icon button" />
            <Menu
              label="Sample menu"
              entries={[
                { id: "one", label: "First action", icon: Plus, onSelect: () => toast.info("First action selected") },
                { id: "two", label: "Checked option", checked: true },
                { type: "separator", id: "s" },
                { id: "three", label: "Unavailable option", disabled: true, description: "Explains why it is unavailable." },
                { id: "four", label: "Delete", icon: Trash2, tone: "danger" },
              ]}
              renderTrigger={(props) => (
                <button {...props} type="button" style={{ height: "var(--control-height-md)", padding: "0 var(--space-3)", border: "var(--border-width) solid var(--color-border-strong)", borderRadius: "var(--radius-md)", background: "var(--button-bg)" }}>
                  Open menu
                </button>
              )}
            />
          </div>
        </Section>

        <Section title="Form controls">
          <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: "var(--space-4)", paddingTop: "var(--space-3)" }}>
            <TextField label="Text field" placeholder="Placeholder" hint="Helpful hint text." />
            <TextField label="Invalid field" defaultValue="Bad value" error="Explains what to fix." />
            <TextArea label="Text area" optional rows={3} placeholder="Multiple lines" />
            <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
              <Select label="Select" options={[{ value: "a", label: "Option A" }, { value: "b", label: "Option B" }]} />
              <SearchField label="Search" placeholder="Search" value={query} onValueChange={setQuery} />
              <SegmentedControl label="Segmented" value={segment} onChange={setSegment} options={[{ value: "a", label: "One" }, { value: "b", label: "Two" }, { value: "c", label: "Three" }]} />
              <Switch label="Switch" description="Toggle description." checked={toggle} onCheckedChange={setToggle} />
            </div>
          </div>
        </Section>

        <Section title="Status badges">
          <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-2)", paddingTop: "var(--space-3)" }}>
            {[...Object.values(sessionStatus), ...Object.values(reviewState), ...Object.values(playbookStatus), ...Object.values(changeAssertion), ...Object.values(approvalState)].map((status, index) => (
              <StatusBadge key={`${status.label}-${index}`} status={status} />
            ))}
          </div>
        </Section>

        <Section title="Notices">
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)", paddingTop: "var(--space-3)" }}>
            <Notice tone="info" title="Information">Neutral explanatory message.</Notice>
            <Notice tone="success" title="Success">Something completed.</Notice>
            <Notice tone="warning" title="Warning">Something needs attention.</Notice>
            <Notice tone="danger" title="Error" action={<Button size="sm">Retry</Button>}>Something failed.</Notice>
            <div style={{ display: "flex", gap: "var(--space-2)" }}>
              <Button onClick={() => toast.success("Saved", "Sample confirmation")}>Success toast</Button>
              <Button onClick={() => toast.error("Failed", "Sample error")}>Error toast</Button>
              <Button variant="danger" onClick={() => setConfirming(true)}>Confirm dialog</Button>
            </div>
          </div>
        </Section>

        <Section title="Tabs and table">
          <Tabs label="Sample tabs" idPrefix="gallery" value={tab} onChange={setTab} options={[{ value: "one", label: "First", count: 3 }, { value: "two", label: "Second", count: 0 }]} />
          <DataTable label="Sample table" columns={sampleColumns} rows={sampleRows} getRowId={(row) => row.id} onRowActivate={(row) => setSelectedRow(row.id)} selectedId={selectedRow} sort={{ columnId: "name", direction: "asc" }} onSortChange={() => undefined} />
        </Section>

        <Section title="Timeline, viewer and diff">
          <div style={{ display: "grid", gridTemplateColumns: "300px 1fr", height: 420, border: "var(--border-width) solid var(--color-border)", marginTop: "var(--space-3)" }}>
            <div style={{ borderRight: "var(--border-width) solid var(--color-border)", overflow: "auto" }}>
              <Timeline label="Sample timeline" events={sampleEvents} selectedId={selectedEvent} onSelect={setSelectedEvent} />
            </div>
            <ScreenshotViewer
              label="Sample viewer"
              image={{ src: SAMPLE_IMAGE, alt: "Sample screenshot", width: 960, height: 600 }}
              highlights={[{ id: "h", x: 760, y: 520, width: 176, height: 40, label: "Click" }]}
              position={{ index: 2, total: 5 }}
            />
          </div>
          <div style={{ marginTop: "var(--space-4)" }}>
            <DiffView label="sample.conf" before={"PermitRootLogin yes\nPasswordAuthentication yes\nPort 22\n"} after={"PermitRootLogin no\nPasswordAuthentication yes\nPort 2222\nMaxAuthTries 3\n"} />
          </div>
        </Section>

        <Section title="Empty state">
          <EmptyState icon={StickyNote} title="Sample empty state" description="Explains what is missing and what the user can do next." actions={<Button variant="primary">Next action</Button>} />
        </Section>
      </div>
      <ConfirmDialog open={confirming} onClose={() => setConfirming(false)} title="Delete sample?" confirmLabel="Delete" tone="danger" onConfirm={() => undefined}>
        <p>This is a sample confirmation. Nothing will be deleted.</p>
      </ConfirmDialog>
    </Page>
  );
}
