import { useEffect, useId, useLayoutEffect, useRef, useState, type DragEvent, type ReactNode } from "react";
import type { QuickActionMessage } from "../../src/quickActions";
import { isPinnedProjectsMessage, isProjectActionMessage, isRecentProjectsMessage, type DashboardMessage, type SettingsRequest, type ProjectItem, type RecentProjectItem } from "../../src/webviewMessages";
import { visibleRecentProjects, type DashboardSettings } from "../../src/dashboardSettings";
import { applyDashboardTheme } from "./dashboardTheme";
import { SettingsView } from "./SettingsView";
import { useDashboardSettings } from "./useDashboardSettings";
import watermark from "./watermark.svg";
import "./App.css";

declare function acquireVsCodeApi(): { postMessage: (message: DashboardMessage) => void };

const vscode = typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : undefined;

const iconPaths = {
  settings: "m9 3-1 3-3 1-2 3 2 2v2l-1 2 2 3 3-1 2 3h3l1-3 3-1 2-3-2-2v-2l1-2-2-3-3 1-2-3Zm6 9a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z",
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
  accent?: string;
  children: ReactNode;
}) {
  return (
    <section className="dashboard-section" aria-labelledby={id}>
      <h2 id={id} className="section-title">
        {title}
        {accent && <Accent>{accent}</Accent>}
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

function PinnedProjectsPanel({ projects, busy }: { projects: ProjectItem[]; busy: boolean }) {
  const [drag, setDrag] = useState<{ id: string; over?: string }>();
  const source = drag ? projects.findIndex(({ id }) => id === drag.id) : -1;

  function move(from: number, to: number) {
    if (busy || from < 0 || to < 0 || to >= projects.length || from === to) {
      return;
    }
    const ids = projects.map(({ id }) => id);
    const [id] = ids.splice(from, 1);
    ids.splice(to, 0, id);
    vscode?.postMessage({ type: "reorderPinnedProjects", ids });
  }

  function allowDrop(event: DragEvent<HTMLLIElement>, id: string) {
    if (!busy && drag && source >= 0 && drag.id !== id) {
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
                  draggable={!busy}
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

function useProjectLists() {
  const [recent, setRecent] = useState<RecentProjectItem[]>([]);
  const [pinned, setPinned] = useState<ProjectItem[]>([]);
  const [now, setNow] = useState(Date.now);
  const [action, setAction] = useState<{ busy: boolean; error?: string }>({ busy: false });

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
      } else if (isProjectActionMessage(event.data)) {
        setAction(event.data);
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

  return { recent, pinned, now, action };
}

function RecentProjectsPanel({ projects, pinned, now, limit }: {
  projects: RecentProjectItem[];
  pinned: Set<string>;
  now: number;
  limit: number;
}) {
  return (
    <div className="project-panel recent-panel">
      <ul className="recent-list">
        {projects.length ? visibleRecentProjects(projects, limit).map((project) => (
          <RecentProjectRow key={project.id} project={project} now={now} pinned={pinned.has(project.id)} />
        )) : (
          <li className="recent-row">
            <Icon name="clock" />
            <span>No recent projects</span>
          </li>
        )}
      </ul>
      {projects.length > limit && (
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

function WelcomeWindow({ settings, preview = false }: { settings: DashboardSettings; preview?: boolean }) {
  const Heading = preview ? "h3" : "h1";
  return (
    <div className="welcome-window">
      <div className="window-bar">
        <div className="window-dots" aria-hidden="true">
          <i />
          <i />
          <i />
        </div>
        <span>Workspace</span>
      </div>
      <div className={preview ? "window-content preview-window-content" : "window-content"}>
        {preview && <img className="settings-preview-artwork artwork" src={watermark} alt="" aria-hidden="true" />}
        <Heading>{settings.welcomeMessage}{settings.decorativeSymbols && <> <Accent>‹𝟹</Accent></>}</Heading>
        {settings.decorativeSymbols && <Accent>・・・・・</Accent>}
      </div>
    </div>
  );
}

const postSettings = vscode && ((message: SettingsRequest) => vscode.postMessage(message));

function App() {
  const { recent, pinned, now, action: projectAction } = useProjectLists();
  const settings = useDashboardSettings(postSettings);
  const [showSettings, setShowSettings] = useState(false);
  const settingsButton = useRef<HTMLButtonElement>(null);
  const focusOnReturn = useRef(false);
  const active = showSettings ? settings.preview : settings.saved;
  const { backgroundColor, accentColor, panelOpacity, artworkVisible, artworkOpacity } = active;
  const symbols = settings.saved.decorativeSymbols;

  useLayoutEffect(() => applyDashboardTheme({ backgroundColor, accentColor, panelOpacity, artworkVisible, artworkOpacity }),
    [backgroundColor, accentColor, panelOpacity, artworkVisible, artworkOpacity]);

  useEffect(() => {
    if (showSettings) {
      document.querySelector<HTMLButtonElement>("[data-view-focus]")?.focus();
    } else if (focusOnReturn.current) {
      settingsButton.current?.focus();
    }
  }, [showSettings]);

  return (
    <>
      {!showSettings && <img className="dashboard-watermark artwork" src={watermark} alt="" aria-hidden="true" />}
      <main className="dashboard" hidden={showSettings}>
        <header className="dashboard-header">
          <div className="dashboard-brand">
            {symbols && <span className="brand-mark"><Accent>𓏲ּ𝄢</Accent></span>}
            <span>Soft Start</span>
          </div>
          {symbols && <Accent>{settings.saved.headerKaomoji}</Accent>}
          <button type="button" className="settings-gear" ref={settingsButton} aria-label="Open settings" title="Settings"
            onClick={() => {
              focusOnReturn.current = true;
              setShowSettings(true);
            }}>
            <Icon name="settings" />
          </button>
        </header>

        <WelcomeWindow settings={settings.saved} />

        <div className="project-actions" role="group" aria-label="Projects and quick actions"
          aria-disabled={projectAction.busy}
          onClickCapture={(event) => {
            if (projectAction.busy) {
              event.preventDefault();
              event.stopPropagation();
            }
          }}>
          <div className="project-columns">
            <DashboardSection id="pinned-projects" title="Pinned projects" accent={symbols ? "ഒ" : undefined}>
              <PinnedProjectsPanel projects={pinned} busy={projectAction.busy} />
            </DashboardSection>

            <DashboardSection id="recent-projects" title="Recent projects" accent={symbols ? "⸝⸝" : undefined}>
              <RecentProjectsPanel projects={recent} now={now} limit={settings.saved.recentProjectsLimit} pinned={new Set(pinned.map(({ id }) => id))} />
            </DashboardSection>
          </div>

          <DashboardSection id="quick-actions" title="Quick actions" accent={symbols ? "ʚ⠀ິɞ" : undefined}>
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
        </div>
        {projectAction.error && <p className="project-action-message" role="alert">{projectAction.error}</p>}
        {projectAction.busy && <p className="project-action-message" role="status">Working on a project action…</p>}
      </main>
      {showSettings && (
        <SettingsView settings={settings} back={() => setShowSettings(false)} preview={
          <>
            {active.decorativeSymbols && <div className="settings-preview-kaomoji"><Accent>{active.headerKaomoji}</Accent></div>}
            <WelcomeWindow settings={active} preview />
          </>
        } />
      )}
    </>
  );
}

export default App;
