import { useMemo, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router";
import { Folder, FolderPlus, ListVideo, Pencil, Plus, SearchX, Trash2 } from "lucide-react";

import {
  Button,
  ConfirmDialog,
  DataTable,
  EmptyState,
  Inspector,
  InspectorSection,
  Notice,
  PropertyList,
  SearchField,
  useToast,
  type Column,
  type SortState,
} from "../../components";
import { Page } from "../../layout/Page";
import { api, type Project } from "../../lib/api";
import { formatDateTime, formatRelative, pluralize } from "../../lib/format";
import { useHotkeys, useResource } from "../../lib/hooks";
import { formatShortcut } from "../../lib/platform";
import list from "../shared/ListPage.module.css";
import { ProjectFormDialog } from "./ProjectFormDialog";

const columns: Column<Project>[] = [
  {
    id: "name",
    header: "Project",
    width: "34%",
    sortValue: (project) => project.name,
    cell: (project) => (
      <span className={list.primaryCell}>
        <span className={list.primaryText}>{project.name}</span>
        {project.description && <span className={list.secondaryText}>{project.description}</span>}
      </span>
    ),
  },
  { id: "sessions", header: "Sessions", width: "96px", align: "end", tone: "secondary", sortValue: (p) => p.sessionCount, cell: (p) => p.sessionCount },
  { id: "playbooks", header: "Playbooks", width: "96px", align: "end", tone: "secondary", sortValue: (p) => p.playbookCount, cell: (p) => p.playbookCount },
  { id: "changes", header: "Changes", width: "96px", align: "end", tone: "secondary", sortValue: (p) => p.changeCount, cell: (p) => p.changeCount },
  { id: "updated", header: "Updated", width: "150px", tone: "secondary", sortValue: (p) => p.updatedAt, cell: (p) => formatRelative(p.updatedAt) },
];

type DialogState = { kind: "create" } | { kind: "edit"; project: Project } | null;

export function ProjectsPage() {
  const projects = useResource(api.projects.list);
  const navigate = useNavigate();
  const toast = useToast();
  const { projectId } = useParams();
  const [params, setParams] = useSearchParams();
  const searchRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortState>({ columnId: "updated", direction: "desc" });
  const [dialog, setDialog] = useState<DialogState>(null);
  const [deleting, setDeleting] = useState<Project | null>(null);

  // "?new=1" (from the Overview or Sessions empty state) opens the create dialog once.
  const wantsNew = params.get("new") === "1";
  const createOpen = dialog?.kind === "create" || wantsNew;

  useHotkeys(
    useMemo(
      () => [
        { key: "f", mod: true, handler: () => searchRef.current?.focus() },
        { key: "n", mod: true, handler: () => setDialog({ kind: "create" }) },
      ],
      [],
    ),
  );

  const all = projects.data ?? [];
  const selected = projectId ? (all.find((project) => project.id === projectId) ?? null) : null;
  const missing = Boolean(projectId) && Boolean(projects.data) && !selected;

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return projects.data ?? [];
    return (projects.data ?? []).filter((project) =>
      [project.name, project.description].some((value) => value.toLowerCase().includes(needle)),
    );
  }, [projects.data, query]);

  const closeCreate = () => {
    setDialog(null);
    if (wantsNew) setParams({}, { replace: true });
  };

  const onSaved = (project: Project, created: boolean) => {
    toast.success(created ? "Project created" : "Project updated", project.name);
    setDialog(null);
    if (wantsNew) setParams({}, { replace: true });
    projects.reload();
    navigate(`/projects/${project.id}`, { replace: !created });
  };

  const confirmDelete = async () => {
    if (!deleting) return;
    const result = await api.projects.remove(deleting.id);
    const kept = result.unassignedSessions + result.unassignedPlaybooks + result.unassignedChanges;
    toast.success("Project deleted", kept > 0 ? `${pluralize(kept, "related record")} kept as unassigned.` : deleting.name);
    setDeleting(null);
    projects.reload();
    navigate("/projects", { replace: true });
  };

  const empty =
    all.length === 0 ? (
      <EmptyState
        icon={Folder}
        title="No projects yet"
        description="Projects organize related capture sessions, playbooks, attachments and changes - for example a firewall migration, a customer environment or a release."
        actions={
          <Button variant="primary" icon={FolderPlus} onClick={() => setDialog({ kind: "create" })}>
            Create project
          </Button>
        }
      />
    ) : (
      <EmptyState
        icon={SearchX}
        title="No projects match"
        description="Try a different search term."
        actions={<Button onClick={() => setQuery("")}>Clear search</Button>}
      />
    );

  return (
    <Page
      title={selected ? selected.name : "Projects"}
      breadcrumbs={selected ? [{ label: "Projects", to: "/projects" }] : []}
      actions={
        <Button variant="primary" icon={FolderPlus} onClick={() => setDialog({ kind: "create" })} shortcut={formatShortcut("N")} tooltip="Create a project">
          New Project
        </Button>
      }
      inspector={
        selected ? (
          <ProjectInspector
            project={selected}
            onClose={() => navigate("/projects")}
            onEdit={() => setDialog({ kind: "edit", project: selected })}
            onDelete={() => setDeleting(selected)}
          />
        ) : undefined
      }
    >
      <div className={list.container}>
        {projects.error && (
          <Notice
            tone="danger"
            role="alert"
            title="Projects could not be loaded"
            action={
              <Button size="sm" onClick={projects.reload}>
                Retry
              </Button>
            }
          >
            {projects.error.message}
          </Notice>
        )}
        {missing && (
          <Notice tone="warning" title="Project not found" action={<Button size="sm" onClick={() => navigate("/projects")}>Show all projects</Button>}>
            The project may have been deleted.
          </Notice>
        )}
        <div className={list.filters} role="search">
          <SearchField
            ref={searchRef}
            label="Search projects"
            placeholder="Search name or description"
            value={query}
            onValueChange={setQuery}
            className={list.search}
          />
          <span className={list.count} aria-live="polite">
            {query.trim() ? `${filtered.length} of ${pluralize(all.length, "project")}` : pluralize(all.length, "project")}
          </span>
        </div>
        <div className={list.table}>
          <DataTable
            label="Projects"
            columns={columns}
            rows={filtered}
            getRowId={(project) => project.id}
            loading={projects.loading && !projects.data}
            sort={sort}
            onSortChange={setSort}
            onRowActivate={(project) => navigate(`/projects/${project.id}`)}
            selectedId={selected?.id ?? null}
            empty={empty}
          />
        </div>
      </div>

      {createOpen && <ProjectFormDialog onClose={closeCreate} onSaved={(project) => onSaved(project, true)} />}
      {dialog?.kind === "edit" && (
        <ProjectFormDialog project={dialog.project} onClose={() => setDialog(null)} onSaved={(project) => onSaved(project, false)} />
      )}
      <ConfirmDialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        title={deleting ? `Delete \u201c${deleting.name}\u201d?` : "Delete project?"}
        confirmLabel="Delete project"
        tone="danger"
        onConfirm={confirmDelete}
      >
        {deleting && <DeleteMessage project={deleting} />}
      </ConfirmDialog>
    </Page>
  );
}

function DeleteMessage({ project }: { project: Project }) {
  const related = project.sessionCount + project.playbookCount + project.changeCount;
  return (
    <>
      <p>The project will be permanently removed from this workspace.</p>
      <p>
        {related > 0
          ? `Its ${pluralize(project.sessionCount, "session")}, ${pluralize(project.playbookCount, "playbook")} and ${pluralize(project.changeCount, "change")} will be kept and become unassigned.`
          : "It has no sessions, playbooks or changes."}
      </p>
    </>
  );
}

interface ProjectInspectorProps {
  project: Project;
  onClose: () => void;
  onEdit: () => void;
  onDelete: () => void;
}

function ProjectInspector({ project, onClose, onEdit, onDelete }: ProjectInspectorProps) {
  const navigate = useNavigate();
  return (
    <Inspector
      label="Project details"
      eyebrow="Project"
      title={project.name}
      onClose={onClose}
      footer={
        <>
          <Button icon={Pencil} onClick={onEdit}>
            Edit
          </Button>
          <Button icon={Trash2} variant="ghost" onClick={onDelete}>
            Delete
          </Button>
        </>
      }
    >
      <InspectorSection title="Description">
        <p style={{ color: project.description ? "var(--color-text)" : "var(--color-text-tertiary)", whiteSpace: "pre-wrap", userSelect: "text" }}>
          {project.description || "No description."}
        </p>
      </InspectorSection>
      <InspectorSection title="Contents">
        <PropertyList
          items={[
            { label: "Sessions", value: project.sessionCount },
            { label: "Playbooks", value: project.playbookCount },
            { label: "Changes", value: project.changeCount },
          ]}
        />
        <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-2)" }}>
          <Button
            size="sm"
            icon={ListVideo}
            onClick={() => navigate(`/sessions?project=${project.id}`)}
            disabledReason={project.sessionCount === 0 ? "This project has no sessions yet." : undefined}
          >
            View sessions
          </Button>
          <Button size="sm" icon={Plus} onClick={() => navigate(`/sessions?new=1&project=${project.id}`)}>
            New session
          </Button>
        </div>
      </InspectorSection>
      <InspectorSection title="Details">
        <PropertyList
          items={[
            { label: "Created", value: formatDateTime(project.createdAt) },
            { label: "Updated", value: formatDateTime(project.updatedAt) },
            { label: "Identifier", value: project.id, mono: true },
          ]}
        />
      </InspectorSection>
    </Inspector>
  );
}
