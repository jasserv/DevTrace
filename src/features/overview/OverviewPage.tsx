import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { CircleDot, FileDiff, FilePlus2, Folder, FolderPlus, Inbox, ListVideo, NotebookText, Plus } from "lucide-react";

import {
  Button,
  DataTable,
  EmptyState,
  Icon,
  Notice,
  StatusBadge,
  Tabs,
  tabPanelId,
  type Column,
} from "../../components";
import { useCapture, useSettings } from "../../app/contexts";
import { Page, Section } from "../../layout/Page";
import { api, type PlaybookSummary, type ReviewItem, type SessionSummary } from "../../lib/api";
import { formatRelative, pluralize } from "../../lib/format";
import { useResource } from "../../lib/hooks";
import { changeAssertion, playbookStatus, sessionStatus } from "../../lib/status";
import styles from "./OverviewPage.module.css";

const sessionColumns: Column<SessionSummary>[] = [
  {
    id: "title",
    header: "Session",
    width: "40%",
    cell: (session) => session.title,
  },
  { id: "project", header: "Project", tone: "secondary", cell: (session) => session.projectName ?? "Unassigned" },
  { id: "updated", header: "Updated", width: "120px", tone: "secondary", cell: (session) => formatRelative(session.updatedAt) },
  { id: "status", header: "Status", width: "120px", cell: (session) => <StatusBadge status={sessionStatus[session.status]} plain /> },
];

const playbookColumns: Column<PlaybookSummary>[] = [
  { id: "title", header: "Playbook", width: "44%", cell: (playbook) => playbook.title },
  { id: "project", header: "Project", tone: "secondary", cell: (playbook) => playbook.projectName ?? "Unassigned" },
  { id: "updated", header: "Updated", width: "120px", tone: "secondary", cell: (playbook) => formatRelative(playbook.updatedAt) },
  { id: "status", header: "Status", width: "120px", cell: (playbook) => <StatusBadge status={playbookStatus[playbook.status]} plain /> },
];

const REVIEW_KIND = {
  session: { label: "Session", icon: ListVideo, path: "/sessions" },
  playbook: { label: "Playbook", icon: NotebookText, path: "/playbooks" },
  change: { label: "Change", icon: FileDiff, path: "/changes" },
} as const;

type PlaybookTab = "draft" | "published";

export function OverviewPage() {
  const { settings } = useSettings();
  const capture = useCapture();
  const navigate = useNavigate();
  const overview = useResource(api.overview.get);
  const [playbookTab, setPlaybookTab] = useState<PlaybookTab>("draft");
  const data = overview.data;
  const counts = data?.counts;

  const totalPlaybooks = counts ? counts.playbooksDraft + counts.playbooksInReview + counts.playbooksPublished : 0;
  const awaitingCount = counts ? counts.sessionsAwaitingReview + counts.playbooksInReview + counts.changesPending : 0;
  const summary = counts
    ? [
        pluralize(counts.projects, "project"),
        pluralize(counts.sessions, "session"),
        pluralize(totalPlaybooks, "playbook"),
      ].join(" \u00b7 ")
    : overview.error
      ? "Workspace data is unavailable"
      : "Loading workspace\u2026";

  const playbooks = playbookTab === "draft" ? (data?.draftPlaybooks ?? []) : (data?.publishedPlaybooks ?? []);

  return (
    <Page title="Overview">
      <div className={styles.container}>
        <header className={styles.header}>
          <div className={styles.identity}>
            <span className={styles.eyebrow}>Current workspace</span>
            <h2 className={styles.workspaceName}>{settings.workspaceName}</h2>
            <p className={styles.summary}>{summary} · Stored locally on this device</p>
          </div>
          <div className={styles.actions}>
            <Button icon={FilePlus2} onClick={() => navigate("/playbooks?new=1")}>
              Create Playbook
            </Button>
            <Button
              icon={CircleDot}
              onClick={() => navigate("/capture")}
              disabledReason={capture.status.supported ? undefined : (capture.status.unsupportedReason ?? undefined)}
              tooltip={capture.status.state === "idle" ? "Choose a session and a display or window to capture" : "Go to the running capture"}
            >
              {capture.status.state === "idle" ? "Start Capture" : "Open Capture"}
            </Button>
            <Button variant="primary" icon={Plus} onClick={() => navigate("/sessions?new=1")}>
              New Session
            </Button>
          </div>
        </header>

        <Notice tone="neutral" title="What this build records" className={styles.notice}>
          Screenshots of a display or window you choose, taken only when you press Capture now, the capture shortcut or the
          tray menu item, plus the steps, notes, commands and images you add yourself. Review the steps, then turn the approved
          ones into a playbook.
        </Notice>

        {overview.error && (
          <Notice
            tone="danger"
            role="alert"
            title="The overview could not be loaded"
            action={
              <Button size="sm" onClick={overview.reload}>
                Retry
              </Button>
            }
          >
            {overview.error.message}
          </Notice>
        )}

        <div className={styles.grid}>
          <div className={styles.column}>
            <Section title="Recent sessions" count={counts?.sessions} action={{ label: "All sessions", to: "/sessions" }}>
              <div className={styles.tableBleed}>
                <DataTable
                  label="Recent sessions"
                  columns={sessionColumns}
                  rows={data?.recentSessions ?? []}
                  getRowId={(session) => session.id}
                  loading={overview.loading && !data}
                  onRowActivate={(session) => navigate(`/sessions/${session.id}`)}
                  empty={
                    <EmptyState
                      compact
                      headingLevel={3}
                      icon={ListVideo}
                      title="No sessions yet"
                      description="A session documents the steps, notes, commands and screenshots of one technical task so it can be reviewed and turned into a playbook."
                      actions={
                        <Button size="sm" icon={Plus} onClick={() => navigate("/sessions?new=1")}>
                          New session
                        </Button>
                      }
                    />
                  }
                />
              </div>
            </Section>

            <Section title="Playbooks" count={counts ? totalPlaybooks : undefined} action={{ label: "All playbooks", to: "/playbooks" }}>
              <div className={styles.tabs}>
                <Tabs<PlaybookTab>
                  label="Playbook status"
                  idPrefix="overview-playbooks"
                  value={playbookTab}
                  onChange={setPlaybookTab}
                  options={[
                    { value: "draft", label: "Drafts", count: counts?.playbooksDraft },
                    { value: "published", label: "Published", count: counts?.playbooksPublished },
                  ]}
                />
              </div>
              <div
                className={styles.tableBleed}
                role="tabpanel"
                id={tabPanelId("overview-playbooks", playbookTab)}
                aria-labelledby={`overview-playbooks-tab-${playbookTab}`}
              >
                <DataTable
                  label={playbookTab === "draft" ? "Draft playbooks" : "Published playbooks"}
                  columns={playbookColumns}
                  rows={playbooks}
                  getRowId={(playbook) => playbook.id}
                  loading={overview.loading && !data}
                  empty={
                    <EmptyState
                      compact
                      headingLevel={3}
                      icon={NotebookText}
                      title={playbookTab === "draft" ? "No draft playbooks" : "No published playbooks"}
                      description="Playbooks are built from reviewed capture evidence and stay editable and versioned. Create one from a reviewed session or start from a blank draft."
                    />
                  }
                />
              </div>
            </Section>
          </div>

          <div className={styles.column}>
            <Section title="Awaiting review" count={counts ? awaitingCount : undefined}>
              {data && data.awaitingReview.length > 0 ? (
                <ul className={styles.list}>
                  {data.awaitingReview.map((item) => (
                    <ReviewRow key={`${item.kind}-${item.id}`} item={item} />
                  ))}
                </ul>
              ) : (
                <EmptyState
                  compact
                  headingLevel={3}
                  icon={Inbox}
                  title="Nothing is awaiting review"
                  description="Completed sessions, playbooks in review and pending changes will appear here."
                />
              )}
            </Section>

            <Section title="Recently updated projects" action={{ label: "All projects", to: "/projects" }}>
              {data && data.recentProjects.length > 0 ? (
                <ul className={styles.list}>
                  {data.recentProjects.map((project) => (
                    <li key={project.id}>
                      <Link to={`/projects/${project.id}`} className={styles.listItem}>
                        <Icon icon={Folder} size={16} className={styles.listIcon} />
                        <span className={styles.listText}>
                          <span className={styles.listTitle}>{project.name}</span>
                          <span className={styles.listMeta}>
                            {pluralize(project.sessionCount, "session")} · {pluralize(project.playbookCount, "playbook")}
                          </span>
                        </span>
                        <span className={styles.listAside}>{formatRelative(project.updatedAt)}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              ) : (
                <EmptyState
                  compact
                  headingLevel={3}
                  icon={Folder}
                  title="No projects yet"
                  description="Projects group related sessions, playbooks and changes, such as a migration or a customer environment."
                  actions={
                    <Button size="sm" icon={FolderPlus} onClick={() => navigate("/projects?new=1")}>
                      Create project
                    </Button>
                  }
                />
              )}
            </Section>

            <Section title="Recent configuration changes" action={{ label: "Change history", to: "/changes" }}>
              {data && data.recentChanges.length > 0 ? (
                <ul className={styles.list}>
                  {data.recentChanges.map((change) => (
                    <li key={change.id}>
                      <Link to={`/changes?selected=${change.id}`} className={styles.listItem}>
                        <span className={styles.listText}>
                          <span className={`${styles.listTitle} ${styles.mono}`}>{change.target}</span>
                          <span className={styles.listMeta}>{change.projectName ?? "Unassigned"}</span>
                        </span>
                        <StatusBadge status={changeAssertion[change.assertion]} plain />
                      </Link>
                    </li>
                  ))}
                </ul>
              ) : (
                <EmptyState
                  compact
                  headingLevel={3}
                  icon={FileDiff}
                  title="No configuration changes recorded"
                  description="Changes are recorded only when declared or verified, never inferred from screenshots."
                />
              )}
            </Section>
          </div>
        </div>
      </div>
    </Page>
  );
}

function ReviewRow({ item }: { item: ReviewItem }) {
  const kind = REVIEW_KIND[item.kind];
  const to = item.kind === "session" ? `/sessions/${item.id}` : kind.path;
  return (
    <li>
      <Link to={to} className={styles.listItem}>
        <Icon icon={kind.icon} size={16} className={styles.listIcon} />
        <span className={styles.listText}>
          <span className={styles.listTitle}>{item.title}</span>
          <span className={styles.listMeta}>
            {kind.label} · {item.projectName ?? "Unassigned"}
          </span>
        </span>
        <span className={styles.listAside}>{formatRelative(item.updatedAt)}</span>
      </Link>
    </li>
  );
}
