import { useEffect, useId, useRef, useState, type DragEvent, type ReactNode } from "react";
import type { QuickActionMessage } from "../../src/quickActions";
import { isPinnedProjectsMessage, isRecentProjectsMessage, type DashboardMessage, type ProjectItem, type RecentProjectItem } from "../../src/webviewMessages";
import "./App.css";

declare function acquireVsCodeApi(): { postMessage: (message: DashboardMessage) => void };

const vscode = typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : undefined;

const iconPaths = {
  grip: "M9 5h.01M15 5h.01M9 12h.01M15 12h.01M9 19h.01M15 19h.01",
  pin: "M8 3h8l-1 5 3 3v2H6v-2l3-3-1-5Zm4 10v7",
  clock: "M12 8v4l2.5 1.5M20 12a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z",
  folderPlus: "M3 6h7l2 2h9v11H3V6Zm9 5v5m-2.5-2.5h5",
  folder: "M3 6h7l2 2h9v11H3V6Z",
  workspace: "M4 5h16v14H4V5Zm0 4h16M10 9v10",
  more: "M5 12h.01M12 12h.01M19 12h.01",
  branch: "M7 9v7m10-7a5 5 0 0 1-5 5H7m2-7a2 2 0 1 1-4 0 2 2 0 0 1 4 0Zm10 0a2 2 0 1 1-4 0 2 2 0 0 1 4 0ZM9 18a2 2 0 1 1-4 0 2 2 0 0 1 4 0Z",
} as const;

const quickActions = [
  { label: "New project", icon: "folderPlus", action: "newProject" },
  { label: "Open folder", icon: "folder", action: "openFolder" },
  { label: "Clone repository", icon: "branch", action: "cloneRepository" },
] satisfies { label: string; icon: keyof typeof iconPaths; action: QuickActionMessage["action"] }[];

function Icon({ name }: { name: keyof typeof iconPaths }) {
  return (
    <svg className="icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d={iconPaths[name]} />
    </svg>
  );
}

function Accent({ children }: { children: string }) {
  return <span className="accent" aria-hidden="true">{children}</span>;
}

function DashboardSection({
  id,
  title,
  accent,
  children,
}: {
  id: string;
  title: string;
  accent: string;
  children: ReactNode;
}) {
  return (
    <section className="dashboard-section" aria-labelledby={id}>
      <h2 id={id} className="section-title">
        {title}
        <Accent>{accent}</Accent>
      </h2>
      {children}
    </section>
  );
}

const relativeTime = new Intl.RelativeTimeFormat(undefined, { style: "short", numeric: "always" });
const timeUnits = [
  ["year", 365 * 24 * 60],
  ["month", 30 * 24 * 60],
  ["day", 24 * 60],
  ["hour", 60],
  ["minute", 1],
] as const;

function formatLastOpened(timestamp: number, now: number) {
  const minutes = Math.floor((now - timestamp) / 60_000);
  for (const [unit, size] of timeUnits) {
    if (minutes >= size) {
      return relativeTime.format(-Math.floor(minutes / size), unit);
    }
  }
  return "Just now";
}

type ProjectAction = { label: string; run: () => void; disabled?: boolean };

function ProjectMenu({ name, actions }: { name: string; actions: ProjectAction[] }) {
  const [expanded, setExpanded] = useState(false);
  const menuId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const closeMenu = () => {
    setExpanded(false);
    trigger.current?.focus();
  };

  return (
    <div
      className="recent-menu"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          setExpanded(false);
        }
      }}
      onKeyDown={(event) => {
        if (expanded && event.key === "Escape") {
          event.stopPropagation();
          closeMenu();
        }
      }}
    >
      <button
        ref={trigger}
        type="button"
        className="recent-menu-trigger"
        aria-label={`Actions for ${name}`}
        aria-expanded={expanded}
        aria-controls={menuId}
        onClick={() => setExpanded(!expanded)}
      >
        <Icon name="more" />
      </button>
      <div id={menuId} className="recent-menu-items" hidden={!expanded}>
        {actions.map(({ label, run, disabled }) => (
          <button key={label} type="button" disabled={disabled} onClick={() => { closeMenu(); run(); }}>
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}

function ProjectOpenButton({ project, open }: { project: ProjectItem; open: () => void }) {
  return (
    <button type="button" className="recent-open" onClick={open} title={project.path}>
      <Icon name={project.kind} />
      <span className="recent-project-info">
        <span className="recent-name">{project.name}</span>
        <span className="recent-path">{project.path}</span>
      </span>
    </button>
  );
}

function RecentProjectRow({ project, now, pinned }: { project: RecentProjectItem; now: number; pinned: boolean }) {
  const open = () => vscode?.postMessage({ type: "openRecentProject", id: project.id });
  return (
    <li className="recent-row recent-project-row">
      <ProjectOpenButton project={project} open={open} />
      {pinned && <span className="recent-pin" title="Pinned project" role="img" aria-label="Pinned project"><Icon name="pin" /></span>}
      <time
        className="recent-time"
        dateTime={new Date(project.lastOpened).toISOString()}
        title={new Date(project.lastOpened).toLocaleString()}
      >
        {formatLastOpened(project.lastOpened, now)}
      </time>
      <ProjectMenu name={project.name} actions={[
        { label: "Open project", run: open },
        { label: pinned ? "Unpin project" : "Pin project", run: () => vscode?.postMessage({
          type: pinned ? "unpinProject" : "pinRecentProject", id: project.id,
        }) },
        { label: "Remove from recent projects", run: () => vscode?.postMessage({ type: "removeRecentProject", id: project.id }) },
      ]} />
    </li>
  );
}

function PinnedProjectsPanel({ projects }: { projects: ProjectItem[] }) {
  const [drag, setDrag] = useState<{ id: string; over?: string }>();
  const source = drag ? projects.findIndex(({ id }) => id === drag.id) : -1;

  function move(from: number, to: number) {
    if (from < 0 || to < 0 || to >= projects.length || from === to) {
      return;
    }
    const ids = projects.map(({ id }) => id);
    const [id] = ids.splice(from, 1);
    ids.splice(to, 0, id);
    vscode?.postMessage({ type: "reorderPinnedProjects", ids });
  }

  function allowDrop(event: DragEvent<HTMLLIElement>, id: string) {
    if (drag && source >= 0 && drag.id !== id) {
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      if (drag.over !== id) {
        setDrag({ id: drag.id, over: id });
      }
    }
  }

  return (
    <div className="project-panel recent-panel">
      {projects.length ? (
        <ul className="recent-list">
          {projects.map((project, index) => {
            const open = () => vscode?.postMessage({ type: "openPinnedProject", id: project.id });
            const dragging = drag?.id === project.id;
            const over = drag?.over === project.id && source >= 0;
            return (
              <li
                key={project.id}
                className="recent-row recent-project-row pinned-row"
                data-dragging={dragging || undefined}
                data-drop={over ? (source < index ? "after" : "before") : undefined}
                onDragOver={(event) => allowDrop(event, project.id)}
                onDragLeave={(event) => {
                  if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) {
                    setDrag((current) => current?.over === project.id ? { id: current.id } : current);
                  }
                }}
                onDrop={(event) => {
                  if (source >= 0) {
                    event.preventDefault();
                    move(source, index);
                    setDrag(undefined);
                  }
                }}
              >
                <span
                  className="pinned-drag-handle"
                  title="Drag to reorder"
                  aria-hidden="true"
                  draggable
                  onDragStart={(event) => {
                    event.dataTransfer.effectAllowed = "move";
                    event.dataTransfer.setData("text/plain", project.id);
                    setDrag({ id: project.id });
                  }}
                  onDragEnd={() => setDrag(undefined)}
                >
                  <Icon name="grip" />
                </span>
                <ProjectOpenButton project={project} open={open} />
                <ProjectMenu name={project.name} actions={[
                  { label: "Open project", run: open },
                  { label: "Rename", run: () => vscode?.postMessage({ type: "renamePinnedProject", id: project.id }) },
                  { label: "Move up", disabled: index === 0, run: () => move(index, index - 1) },
                  { label: "Move down", disabled: index === projects.length - 1, run: () => move(index, index + 1) },
                  { label: "Unpin project", run: () => vscode?.postMessage({ type: "unpinProject", id: project.id }) },
                ]} />
              </li>
            );
          })}
        </ul>
      ) : (
        <div className="pinned-empty">
          <span className="shortcut-icon"><Icon name="pin" /></span>
          <span>No pinned projects</span>
        </div>
      )}
      <button type="button" className="recent-view-all" disabled={!vscode}
        onClick={() => vscode?.postMessage({ type: "addPinnedProject" })}>
        Add project
      </button>
    </div>
  );
}

const visibleRecentProjects = 4;

function useProjectLists() {
  const [recent, setRecent] = useState<RecentProjectItem[]>([]);
  const [pinned, setPinned] = useState<ProjectItem[]>([]);
  const [now, setNow] = useState(Date.now);

  useEffect(() => {
    if (!vscode) {
      return;
    }

    const receive = (event: MessageEvent<unknown>) => {
      if (isRecentProjectsMessage(event.data)) {
        setRecent(event.data.projects);
        setNow(Date.now());
      } else if (isPinnedProjectsMessage(event.data)) {
        setPinned(event.data.projects);
      }
    };
    window.addEventListener("message", receive);
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    vscode.postMessage({ type: "requestRecentProjects" });
    return () => {
      window.removeEventListener("message", receive);
      window.clearInterval(timer);
    };
  }, []);

  return { recent, pinned, now };
}

function RecentProjectsPanel({ projects, pinned, now }: {
  projects: RecentProjectItem[];
  pinned: Set<string>;
  now: number;
}) {
  return (
    <div className="project-panel recent-panel">
      <ul className="recent-list">
        {projects.length ? projects.slice(0, visibleRecentProjects).map((project) => (
          <RecentProjectRow key={project.id} project={project} now={now} pinned={pinned.has(project.id)} />
        )) : (
          <li className="recent-row">
            <Icon name="clock" />
            <span>No recent projects</span>
          </li>
        )}
      </ul>
      {projects.length > visibleRecentProjects && (
        <button
          className="recent-view-all"
          type="button"
          onClick={() => vscode?.postMessage({ type: "viewAllRecentProjects" })}
        >
          View all recent projects
        </button>
      )}
    </div>
  );
}

function App() {
  const { recent, pinned, now } = useProjectLists();
  return (
    <main className="dashboard">
      <header className="dashboard-header">
        <div className="dashboard-brand">
          <span className="brand-mark"><Accent>𓏲ּ𝄢</Accent></span>
          <span>Soft Start</span>
        </div>
        <Accent>૮ ᴗ͈ ˕ ✙╿ྀི꒱</Accent>
      </header>

      <div className="welcome-window">
        <div className="window-bar">
          <span className="window-dots" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          <span>Workspace</span>
        </div>
        <div className="window-content">
          <h1>Ready when you are <Accent>‹𝟹</Accent></h1>
          <Accent>・・・・・</Accent>
        </div>
      </div>

      <div className="project-columns">
        <DashboardSection id="pinned-projects" title="Pinned projects" accent="ഒ">
          <PinnedProjectsPanel projects={pinned} />
        </DashboardSection>

        <DashboardSection id="recent-projects" title="Recent projects" accent="⸝⸝">
          <RecentProjectsPanel projects={recent} now={now} pinned={new Set(pinned.map(({ id }) => id))} />
        </DashboardSection>
      </div>

      <DashboardSection id="quick-actions" title="Quick actions" accent="ʚ⠀ິɞ">
        <div className="quick-actions" role="group" aria-labelledby="quick-actions">
          {quickActions.map(({ label, icon, action }) => (
            <button
              type="button"
              className="utility-tile"
              key={action}
              disabled={!vscode}
              onClick={() => vscode?.postMessage({ type: "quickAction", action })}
            >
              <span className="shortcut-icon"><Icon name={icon} /></span>
              <span>{label}</span>
            </button>
          ))}
        </div>
      </DashboardSection>
    </main>
  );
}

export default App;
