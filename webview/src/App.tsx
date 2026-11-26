import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type DragEvent, type ReactNode } from "react";
import type { QuickActionMessage } from "../../src/quickActions";
import { isPinnedProjectsMessage, isProjectActionMessage, isProjectLoadError, isRecentProjectsMessage, type DashboardMessage, type SettingsRequest, type ProjectActionMessage, type ProjectLoadError, type ProjectRequest, type ProjectItem, type RecentProjectItem } from "../../src/webviewMessages";
import { defaultSettings, visibleRecentProjects, type DashboardSettings } from "../../src/dashboardSettings";
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

function Accent({ children, className }: { children: string; className?: string }) {
  return <span className={className ? `accent ${className}` : "accent"} aria-hidden="true">{children}</span>;
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
      <h2 id={id} className="section-title" tabIndex={-1}>
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

type SendProject = (request: ProjectRequest) => void;
type ProjectAction = { label: string; run: () => void; disabled?: boolean; destructive?: boolean };

function ProjectMenu({ name, actions, guidanceId }: { name: string; actions: ProjectAction[]; guidanceId?: string }) {
  const [expanded, setExpanded] = useState(false);
  const menuId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const closeMenu = useCallback(() => {
    setExpanded(false);
    trigger.current?.focus({ preventScroll: true });
  }, []);

  useLayoutEffect(() => {
    const anchor = trigger.current;
    const menu = popup.current;
    if (!expanded || !anchor || !menu) {
      return;
    }

    function position() {
      if (!anchor || !menu) return;
      const { top, bottom, right } = anchor.getBoundingClientRect();
      const viewport = document.documentElement;
      if (bottom <= 0 || top >= viewport.clientHeight) {
        closeMenu();
        return;
      }
      const below = viewport.clientHeight - bottom - 12;
      const above = top - 12;
      const openAbove = below < menu.scrollHeight + 2 && above > below;
      menu.style.maxHeight = `${Math.max(0, openAbove ? above : below)}px`;
      menu.style.left = `${Math.max(8, Math.min(right - menu.offsetWidth, viewport.clientWidth - menu.offsetWidth - 8))}px`;
      menu.style.top = `${openAbove ? top - menu.offsetHeight - 4 : bottom + 4}px`;
    }

    function dismissOutside(event: PointerEvent) {
      if (event.target instanceof Node && !anchor?.parentElement?.contains(event.target)) {
        closeMenu();
        window.requestAnimationFrame(() => {
          if (document.activeElement === document.body && anchor?.isConnected) {
            anchor.focus({ preventScroll: true });
          }
        });
      }
    }

    menu.showPopover();
    position();
    menu.querySelector<HTMLButtonElement>("button:enabled")?.focus({ preventScroll: true });
    document.addEventListener("pointerdown", dismissOutside);
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    return () => {
      menu.hidePopover();
      document.removeEventListener("pointerdown", dismissOutside);
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", position, true);
    };
  }, [closeMenu, expanded]);

  return (
    <div
      className="recent-menu"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          setExpanded(false);
        }
      }}
      onKeyDown={(event) => {
        if (!expanded) return;
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          closeMenu();
        } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          const buttons = Array.from(popup.current?.querySelectorAll<HTMLButtonElement>("button:enabled") ?? []);
          if (buttons.length === 0) return;
          event.preventDefault();
          const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
          const next = event.key === "ArrowDown" ? (index + 1) % buttons.length : (index <= 0 ? buttons.length - 1 : index - 1);
          buttons[next].focus();
        }
      }}
    >
      <button
        ref={trigger}
        type="button"
        className="recent-menu-trigger"
        aria-label={`Actions for ${name}`}
        aria-expanded={expanded}
        aria-describedby={guidanceId}
        aria-controls={menuId}
        onClick={() => expanded ? closeMenu() : setExpanded(true)}
      >
        <Icon name="more" />
      </button>
      <div ref={popup} id={menuId} className="recent-menu-items" popover="manual" hidden={!expanded}>
        {actions.map(({ label, run, disabled, destructive }) => (
          <button key={label} type="button" disabled={disabled} data-destructive={destructive || undefined}
            onClick={() => { closeMenu(); run(); }}>
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}

function ProjectOpenButton({ project, open, pinned }: { project: ProjectItem; open: () => void; pinned?: boolean }) {
  const id = useId();
  const description = [pinned && `${id}-pin`, project.hostLabel && `${id}-host`, `${id}-path`].filter(Boolean).join(" ");
  const location = project.hostLabel ? `${project.hostLabel} · ${project.path}` : project.path;
  return (
    <button type="button" className="recent-open" disabled={project.unresolved} onClick={open}
      aria-labelledby={`${id}-name`} aria-describedby={description} title={`${project.name}\n${location}`}>
      <Icon name={project.kind} />
      <span className="recent-project-info">
        <span className="recent-heading">
          <span className="recent-name" id={`${id}-name`}>{project.name}</span>
          {pinned && <span className="recent-pin" id={`${id}-pin`} title="Pinned project" role="img" aria-label="Pinned project"><Icon name="pin" /></span>}
        </span>
        {project.hostLabel && <span className="recent-host" id={`${id}-host`}>{project.hostLabel}</span>}
        <span className="recent-path" id={`${id}-path`}>{project.path}</span>
      </span>
    </button>
  );
}

function ProjectFeedback({ guidanceId, error }: { guidanceId?: string; error?: string }) {
  return <>
    {guidanceId && <p id={guidanceId} className="project-row-message">Confirm this location with Locate project in the menu.</p>}
    {error && <p className="project-row-message" role="alert">{error}</p>}
  </>;
}

function RecentProjectRow({ project, now, pinned, error, pending, send }: { project: RecentProjectItem; now: number; pinned: boolean; error?: string; pending: boolean; send: SendProject }) {
  const open = () => send({ type: "openRecentProject", id: project.id });
  const guidanceId = project.unresolved ? `recent-${project.id}-guidance` : undefined;
  return (
    <li className="recent-row recent-project-row" aria-busy={pending || undefined}>
      <ProjectOpenButton project={project} open={open} pinned={pinned} />
      <time
        className="recent-time"
        dateTime={new Date(project.lastOpened).toISOString()}
        title={new Date(project.lastOpened).toLocaleString()}
      >
        {formatLastOpened(project.lastOpened, now)}
      </time>
      <ProjectMenu name={project.name} guidanceId={guidanceId} actions={[
        project.unresolved
          ? { label: "Locate project", run: () => send({ type: "locateRecentProject", id: project.id }) }
          : { label: "Open project", run: open },
        { disabled: project.unresolved, label: pinned ? "Unpin project" : "Pin project", destructive: pinned, run: () => send({
          ...(pinned ? { type: "unpinProject", section: "recent" } : { type: "pinRecentProject" }), id: project.id,
        }) },
        { label: "Remove from recent projects", destructive: true, run: () => send({ type: "removeRecentProject", id: project.id }) },
      ]} />
      <ProjectFeedback guidanceId={guidanceId} error={error} />
    </li>
  );
}

function PinnedProjectsPanel({ projects, action, send }: { projects: ProjectItem[]; action: ProjectActionMessage; send: SendProject }) {
  const [drag, setDrag] = useState<{ id: string; over?: string }>();
  const list = useRef<HTMLUListElement>(null);
  const change = action.change;

  useLayoutEffect(() => {
    if (!change || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const row = list.current?.querySelector<HTMLElement>(`[data-project-id="${change.id}"]`);
    if (!row || row.closest("[hidden]")) return;

    function clear() {
      row?.removeAttribute("data-project-change");
      row?.removeEventListener("animationend", clear);
      row?.removeEventListener("animationcancel", clear);
    }
    row.setAttribute("data-project-change", change.kind);
    row.addEventListener("animationend", clear);
    row.addEventListener("animationcancel", clear);
    return clear;
  }, [change]);
  const source = drag ? projects.findIndex(({ id }) => id === drag.id) : -1;

  function move(from: number, to: number) {
    if (action.busy || from < 0 || to < 0 || to >= projects.length || from === to) {
      return;
    }
    const ids = projects.map(({ id }) => id);
    const [id] = ids.splice(from, 1);
    ids.splice(to, 0, id);
    send({ type: "reorderPinnedProjects", ids, id });
  }

  function allowDrop(event: DragEvent<HTMLLIElement>, id: string) {
    if (!action.busy && drag && source >= 0 && drag.id !== id) {
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
        <ul className="recent-list" ref={list}>
          {projects.map((project, index) => {
            const open = () => send({ type: "openPinnedProject", id: project.id });
            const guidanceId = project.unresolved ? `pin-${project.id}-guidance` : undefined;
            const dragging = drag?.id === project.id;
            const over = drag?.over === project.id && source >= 0;
            return (
              <li
                key={project.id}
                className="recent-row recent-project-row pinned-row"
                aria-busy={(action.busy && action.target?.section === "pins" && action.target.id === project.id) || undefined}
                data-project-id={project.id}
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
                  draggable={!action.busy}
                  onDragStart={(event) => {
                    event.dataTransfer.effectAllowed = "move";
                    event.dataTransfer.setData("text/plain", project.id);
                    const row = event.currentTarget.closest("li");
                    if (row) event.dataTransfer.setDragImage(row, 16, 16);
                    setDrag({ id: project.id });
                  }}
                  onDragEnd={() => setDrag(undefined)}
                >
                  <Icon name="grip" />
                </span>
                <ProjectOpenButton project={project} open={open} />
                <ProjectMenu name={project.name} guidanceId={guidanceId} actions={[
                  project.unresolved
                    ? { label: "Locate project", run: () => send({ type: "locatePinnedProject", id: project.id }) }
                    : { label: "Open project", run: open },
                  { label: "Rename", run: () => send({ type: "renamePinnedProject", id: project.id }) },
                  ...(project.canRestoreName ? [{ label: "Restore original name", run: () => send({ type: "restorePinnedProjectName", id: project.id }) }] : []),
                  { label: "Move up", disabled: index === 0, run: () => move(index, index - 1) },
                  { label: "Move down", disabled: index === projects.length - 1, run: () => move(index, index + 1) },
                  { label: "Unpin project", destructive: true, run: () => send({ type: "unpinProject", id: project.id }) },
                ]} />
                <ProjectFeedback guidanceId={guidanceId} error={action.target?.section === "pins" && action.target.id === project.id ? action.error : undefined} />
              </li>
            );
          })}
        </ul>
      ) : (
        <div className="project-empty">
          <span className="shortcut-icon"><Icon name="pin" /></span>
          <span>No pinned projects</span>
          <span className="project-empty-hint">Use Add project to pin a folder or workspace.</span>
        </div>
      )}
      <button type="button" className="recent-view-all" disabled={!vscode}
        onClick={() => send({ type: "addPinnedProject" })}>
        Add project
      </button>
      {action.target?.section === "pins" && !projects.some(({ id }) => id === action.target?.id) && action.error &&
        <p className="project-action-message" role="alert">{action.error}</p>}
    </div>
  );
}

function ProjectPlaceholder({ loading }: { loading: boolean }) {
  return (
    <div className="project-panel project-placeholder" aria-busy={loading || undefined}>
      {loading ? (
        <div className="project-loading-row" aria-hidden="true"><span /><span /></div>
      ) : <span>Projects unavailable</span>}
    </div>
  );
}

function useProjectLists() {
  const [recent, setRecent] = useState<RecentProjectItem[] | undefined>(vscode ? undefined : []);
  const [pinned, setPinned] = useState<ProjectItem[] | undefined>(vscode ? undefined : []);
  const [loadError, setLoadError] = useState<Pick<ProjectLoadError, "error" | "unsupportedStorage">>();
  const loadTimer = useRef<number>(undefined);
  const [now, setNow] = useState(Date.now);
  const [action, setAction] = useState<ProjectActionMessage>({ type: "projectAction", busy: false });
  const locked = useRef(false);
  const pinsAtRequest = useRef<Set<string>>(undefined);
  const focusOrigin = useRef<{ control: HTMLElement; section: HTMLElement }>(undefined);

  const load = useCallback(() => {
    window.clearTimeout(loadTimer.current);
    loadTimer.current = window.setTimeout(() => setLoadError({ error: "Soft Start is still waiting for project data." }), 12000);
    vscode?.postMessage({ type: "requestRecentProjects" });
  }, []);

  const send: SendProject = (request) => {
    if (!vscode || locked.current) return;
    locked.current = true;
    if (request.type === "pinRecentProject" || request.type === "addPinnedProject") {
      pinsAtRequest.current = new Set(pinned?.map(({ id }) => id));
    }
    const control = document.activeElement;
    const section = control?.closest(".dashboard-section")?.querySelector<HTMLElement>(".section-title");
    if (control instanceof HTMLElement && section) {
      focusOrigin.current = { control, section };
    }
    try {
      vscode.postMessage(request);
    } catch {
      locked.current = false;
      pinsAtRequest.current = undefined;
      focusOrigin.current = undefined;
      setAction({ type: "projectAction", busy: false, error: "Could not send the project action. Try again." });
    }
  };

  useLayoutEffect(() => {
    const origin = focusOrigin.current;
    if (!origin) return;
    if (document.activeElement === document.body && !origin.section.closest("[hidden]")) {
      (origin.control.isConnected ? origin.control : origin.section).focus();
    }
    if (!locked.current) focusOrigin.current = undefined;
  }, [action, pinned, recent]);

  useEffect(() => {
    if (!vscode) return;
    let haveRecent = false;
    let havePins = false;
    const receive = (event: MessageEvent<unknown>) => {
      if (isRecentProjectsMessage(event.data)) {
        haveRecent = true;
        setRecent(event.data.projects);
        setNow(Date.now());
      } else if (isPinnedProjectsMessage(event.data)) {
        havePins = true;
        setPinned(event.data.projects);
      } else if (isProjectLoadError(event.data)) {
        window.clearTimeout(loadTimer.current);
        setLoadError(event.data);
        return;
      } else if (isProjectActionMessage(event.data)) {
        const { change, busy } = event.data;
        const alreadyPinned = change?.kind === "pinned" && pinsAtRequest.current?.has(change.id);
        locked.current = busy;
        if (!busy) pinsAtRequest.current = undefined;
        setAction(alreadyPinned ? { ...event.data, change: undefined } : event.data);
        return;
      } else {
        return;
      }
      if (haveRecent && havePins) {
        window.clearTimeout(loadTimer.current);
        setLoadError(undefined);
      }
    };
    window.addEventListener("message", receive);
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    load();
    return () => {
      window.removeEventListener("message", receive);
      window.clearInterval(timer);
      window.clearTimeout(loadTimer.current);
    };
  }, [load]);

  return { recent, pinned, now, action, loadError, send, retry: () => {
    setLoadError(undefined);
    load();
  } };
}

function RecentProjectsPanel({ projects, pinned, now, limit, action, send }: {
  projects: RecentProjectItem[];
  pinned: Set<string>;
  now: number;
  limit: number;
  action: ProjectActionMessage;
  send: SendProject;
}) {
  const visible = visibleRecentProjects(projects, limit);
  const errorId = action.target?.section === "recent" ? action.target.id : undefined;
  return (
    <div className="project-panel recent-panel">
      {projects.length ? (
        <ul className="recent-list">
          {visible.map((project) => (
            <RecentProjectRow key={project.id} project={project} now={now} pinned={pinned.has(project.id)} error={errorId === project.id ? action.error : undefined} pending={action.busy && errorId === project.id} send={send} />
          ))}
        </ul>
      ) : (
        <div className="project-empty">
          <span className="shortcut-icon"><Icon name="clock" /></span>
          <span>No recent projects</span>
          <span className="project-empty-hint">Open projects while Soft Start is active to see them here.</span>
        </div>
      )}
      {projects.length > limit && (
        <button
          className="recent-view-all"
          type="button"
          onClick={() => send({ type: "viewAllRecentProjects" })}
        >
          View all recent projects
        </button>
      )}
      {action.target?.section === "recent" && !visible.some(({ id }) => id === errorId) && action.error &&
        <p className="project-action-message" role="alert">{action.error}</p>}
    </div>
  );
}

function WelcomeWindow({ settings, preview = false }: { settings: DashboardSettings; preview?: boolean }) {
  const Heading = preview ? "h3" : "h1";
  const hasWelcome = Boolean(settings.welcomeMessage.trim());
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
        <Heading id={preview ? undefined : "dashboard-title"}>
          {hasWelcome ? settings.welcomeMessage : <span className="screen-reader-only">{preview ? "Welcome message" : "Soft Start dashboard"}</span>}
          {settings.decorativeSymbols && <> <Accent>‹𝟹</Accent></>}
        </Heading>
        {settings.decorativeSymbols && <Accent>・・・・・</Accent>}
      </div>
    </div>
  );
}

const postSettings = vscode && ((message: SettingsRequest) => vscode.postMessage(message));

function App() {
  const { recent, pinned, now, action: projectAction, retry, loadError, send } = useProjectLists();
  const listsReady = !loadError?.unsupportedStorage && recent !== undefined && pinned !== undefined;
  const settings = useDashboardSettings(postSettings);
  const [showSettings, setShowSettings] = useState(false);
  const settingsButton = useRef<HTMLButtonElement>(null);
  const scrollPositions = useRef<{ dashboard?: number; settings?: number }>({});
  const active = showSettings ? settings.preview : settings.saved;
  const { backgroundColor, accentColor, panelOpacity, artworkVisible, artworkOpacity } = active;
  const symbols = settings.saved.decorativeSymbols;
  const recentCount = Math.min(recent?.length ?? 0, settings.saved.recentProjectsLimit);
  const balancePanels = Math.abs((pinned?.length ?? 0) - recentCount) <= 1;

  useLayoutEffect(() => applyDashboardTheme({ backgroundColor, accentColor, panelOpacity, artworkVisible, artworkOpacity }),
    [backgroundColor, accentColor, panelOpacity, artworkVisible, artworkOpacity]);

  useLayoutEffect(() => {
    const position = scrollPositions.current[showSettings ? "settings" : "dashboard"];
    if (!showSettings && position === undefined) return;
    window.scrollTo({ top: position ?? 0, behavior: "instant" });
    const visible = (element: HTMLElement | null) => {
      const bounds = element?.getBoundingClientRect();
      return Boolean(bounds && bounds.top >= 0 && bounds.bottom <= window.innerHeight);
    };
    const title = showSettings ? document.getElementById("settings-title") : settingsButton.current;
    const saveState = showSettings ? document.getElementById("settings-save-state") : null;
    if (visible(title)) {
      title?.focus({ preventScroll: true });
    } else if (visible(saveState)) {
      saveState?.focus({ preventScroll: true });
    } else {
      title?.focus();
    }
  }, [showSettings]);

  return (
    <>
      {!showSettings && <img className="dashboard-watermark artwork" src={watermark} alt="" aria-hidden="true" />}
      <main className="dashboard" aria-labelledby="dashboard-title" hidden={showSettings}>
        <header className="dashboard-header">
          <div className="dashboard-brand">
            {symbols && <span className="brand-mark"><Accent>𓏲ּ𝄢</Accent></span>}
            <span>Soft Start</span>
          </div>
          {symbols && <Accent className={settings.saved.headerKaomoji === defaultSettings.headerKaomoji ? "default-header-kaomoji" : undefined}>
            {settings.saved.headerKaomoji}
          </Accent>}
          <button type="button" className="settings-gear" ref={settingsButton} aria-label="Open settings" title="Settings"
            onClick={() => {
              scrollPositions.current.dashboard = window.scrollY;
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
          {loadError && <div className="project-load-error project-panel">
            <p className="project-action-message" role="alert">{loadError.error}</p>
            {!loadError.unsupportedStorage && <button type="button" className="recent-view-all" onClick={() => {
              document.getElementById("pinned-projects")?.focus({ preventScroll: true });
              retry();
            }}>Retry loading projects</button>}
          </div>}
          <div className="project-columns" data-balanced={balancePanels || undefined}>
            <DashboardSection id="pinned-projects" title="Pinned projects" accent={symbols ? "ഒ" : undefined}>
              {listsReady ? <PinnedProjectsPanel projects={pinned} action={projectAction} send={send} /> :
                <ProjectPlaceholder loading={!loadError} />}
            </DashboardSection>

            <DashboardSection id="recent-projects" title="Recent projects" accent={symbols ? "⸝⸝" : undefined}>
              {listsReady ? <RecentProjectsPanel projects={recent} action={projectAction} now={now} limit={settings.saved.recentProjectsLimit} pinned={new Set(pinned.map(({ id }) => id))} send={send} /> :
                <ProjectPlaceholder loading={!loadError} />}
            </DashboardSection>
          </div>

          <DashboardSection id="quick-actions" title="Quick actions" accent={symbols ? "ʚ⠀ິɞ" : undefined}>
            <div className="quick-actions">
              {quickActions.map(({ label, icon, action }) => (
                <button
                  type="button"
                  className="utility-tile"
                  key={action}
                  disabled={!vscode}
                  onClick={() => send({ type: "quickAction", action })}
                >
                  <span className="shortcut-icon"><Icon name={icon} /></span>
                  <span>{label}</span>
                </button>
              ))}
            </div>
          </DashboardSection>
        </div>
        {(!projectAction.target || projectAction.target.section === "quick") && projectAction.error && <p className="project-action-message" role="alert">{projectAction.error}</p>}
        {!showSettings && <p className="project-action-message project-status" role="status" aria-atomic="true">
          {projectAction.detail ?? (projectAction.busy ? "Working on a project action…" :
            !listsReady && !loadError ? "Loading projects…" : "")}
        </p>}
      </main>
      {showSettings && (
        <SettingsView settings={settings} back={() => {
          scrollPositions.current.settings = window.scrollY;
          setShowSettings(false);
        }} preview={
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
