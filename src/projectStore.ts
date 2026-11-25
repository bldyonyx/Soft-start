import { join } from "node:path";
import type * as vscode from "vscode";
import { ProjectJournal } from "./projectJournal";
import { currentProjectHost } from "./projectHost";
import { identifyProject, migrateProject, readIdentifiedProject, type IdentifiedProject, type Project, type ProjectOrigin } from "./projects";
import { recentProjectsKey } from "./recentProjects";
import { pinnedProjectsKey } from "./pinnedProjects";
import { isProjectTimestamp } from "./webviewMessages";

type Host = Extract<ProjectOrigin, { kind: "host" }>;
export type RecentEntry = IdentifiedProject & { lastOpened: number };
export type PinnedEntry = IdentifiedProject & { pinnedAt: number; displayName?: string };
export type ProjectSnapshot = { recent: RecentEntry[]; pins: PinnedEntry[] };

type ProjectEvent =
  | { type: "record"; project: RecentEntry }
  | { type: "pin"; project: PinnedEntry }
  | { type: "forget" | "unpin"; id: string }
  | { type: "rename"; id: string; name: string; pinnedAt: number }
  | { type: "reorder"; ids: string[] };

type Journal = Pick<ProjectJournal, "initialize" | "events" | "append">;

function entries<T>(raw: unknown, parse: (value: unknown) => T | undefined): T[] {
  return Array.isArray(raw) ? raw.flatMap((value) => parse(value) ?? []) : [];
}

function readRecent(raw: unknown, legacy = false): RecentEntry | undefined {
  if (raw && typeof raw === "object" && "lastOpened" in raw && isProjectTimestamp(raw.lastOpened)) {
    const project = legacy ? migrateProject(raw) : readIdentifiedProject(raw);
    if (project) {
      return { ...project, lastOpened: raw.lastOpened };
    }
  }
}

function readPin(raw: unknown, legacy = false): PinnedEntry | undefined {
  if (raw && typeof raw === "object" && "pinnedAt" in raw && isProjectTimestamp(raw.pinnedAt)) {
    const project = legacy ? migrateProject(raw) : readIdentifiedProject(raw);
    if (project) {
      const displayName = "displayName" in raw && typeof raw.displayName === "string" ? raw.displayName.trim() : "";
      return { ...project, pinnedAt: raw.pinnedAt, ...(displayName ? { displayName } : {}) };
    }
  }
}

function unique<T extends { id: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter(({ id }) => {
    if (seen.has(id)) {
      return false;
    }
    seen.add(id);
    return true;
  });
}

function byRecency(a: RecentEntry, b: RecentEntry) {
  return b.lastOpened - a.lastOpened || a.id.localeCompare(b.id);
}

function readEvent(raw: unknown): ProjectEvent {
  if (raw && typeof raw === "object" && "type" in raw) {
    switch (raw.type) {
      case "record": {
        const project = "project" in raw && readRecent(raw.project);
        if (project) {
          return { type: raw.type, project };
        }
        break;
      }
      case "pin": {
        const project = "project" in raw && readPin(raw.project);
        if (project) {
          return { type: raw.type, project };
        }
        break;
      }
      case "forget":
      case "unpin":
        if ("id" in raw && isId(raw.id)) {
          return { type: raw.type, id: raw.id };
        }
        break;
      case "rename":
        if ("id" in raw && isId(raw.id) && "name" in raw && typeof raw.name === "string" &&
            "pinnedAt" in raw && isProjectTimestamp(raw.pinnedAt)) {
          return { type: raw.type, id: raw.id, name: raw.name, pinnedAt: raw.pinnedAt };
        }
        break;
      case "reorder":
        if ("ids" in raw && Array.isArray(raw.ids) && raw.ids.every(isId) && new Set(raw.ids).size === raw.ids.length) {
          return { type: raw.type, ids: raw.ids };
        }
        break;
    }
  }
  throw new Error("Soft Start found an invalid project journal entry. Keep the project storage files for recovery.");
}

function isId(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function apply(state: ProjectSnapshot, event: ProjectEvent): void {
  switch (event.type) {
    case "record": {
      const index = state.recent.findIndex(({ id }) => id === event.project.id);
      if (index === -1) {
        state.recent.push(event.project);
      } else if (state.recent[index].lastOpened <= event.project.lastOpened) {
        state.recent[index] = event.project;
      }
      if (state.recent.length > 50) {
        state.recent = state.recent.sort(byRecency).slice(0, 50);
      }
      break;
    }
    case "forget":
      state.recent = state.recent.filter(({ id }) => id !== event.id);
      break;
    case "pin":
      if (!state.pins.some(({ id }) => id === event.project.id)) {
        state.pins.push(event.project);
      }
      break;
    case "unpin":
      state.pins = state.pins.filter(({ id }) => id !== event.id);
      break;
    case "rename": {
      const pin = state.pins.find(({ id, pinnedAt }) => id === event.id && pinnedAt === event.pinnedAt);
      if (pin) {
        if (event.name && event.name !== pin.name) {
          pin.displayName = event.name;
        } else {
          delete pin.displayName;
        }
      }
      break;
    }
    case "reorder": {
      const byId = new Map(state.pins.map((pin) => [pin.id, pin]));
      const reordered = event.ids.flatMap((id) => byId.get(id) ?? []);
      const moved = new Set(reordered.map(({ id }) => id));
      let index = 0;
      // A concurrent add or remove does not get replaced by an older order.
      state.pins = state.pins.map((pin) => moved.has(pin.id) ? reordered[index++] : pin);
      break;
    }
  }
}

export class ProjectStore {
  constructor(
    private readonly journal: Journal,
    readonly host: Host | undefined,
    private readonly legacy: Pick<vscode.Memento, "get">,
  ) {}

  async read(): Promise<ProjectSnapshot> {
    const baseline = await this.journal.initialize({
      version: 2,
      recent: this.legacy.get(recentProjectsKey) ?? null,
      pins: this.legacy.get(pinnedProjectsKey) ?? null,
    });
    if (!baseline || typeof baseline !== "object" || !("version" in baseline) || baseline.version !== 2 ||
        !("recent" in baseline) || !("pins" in baseline)) {
      throw new Error("Soft Start could not read the project migration record. Keep the legacy values and project storage files for recovery.");
    }
    const state = {
      recent: unique(entries(baseline.recent, (value) => readRecent(value, true)).sort(byRecency)).slice(0, 50),
      pins: unique(entries(baseline.pins, (value) => readPin(value, true))),
    };
    for (const event of await this.journal.events()) {
      apply(state, readEvent(event));
    }
    state.recent = state.recent.sort(byRecency).slice(0, 50);
    return state;
  }

  async record(project: Project | IdentifiedProject, lastOpened = Date.now()): Promise<void> {
    const entry = "origin" in project ? project : identifyProject(project, this.host);
    if (entry.origin.kind !== "unknown") {
      await this.commit({ type: "record", project: { ...entry, lastOpened } });
    }
  }

  async pin(project: Project | IdentifiedProject, pinnedAt = Date.now()): Promise<void> {
    const entry = "origin" in project ? project : identifyProject(project, this.host);
    if (entry.origin.kind === "unknown") {
      throw new Error("Soft Start cannot verify this project’s original host. Open it from the correct VS Code window and pin it again.");
    }
    await this.commit({ type: "pin", project: { ...entry, pinnedAt } });
  }

  forget(id: string): Promise<void> {
    return this.commit({ type: "forget", id });
  }

  unpin(id: string): Promise<void> {
    return this.commit({ type: "unpin", id });
  }

  async rename(pin: Pick<PinnedEntry, "id" | "pinnedAt">, name: string): Promise<void> {
    const event: ProjectEvent = { type: "rename", id: pin.id, pinnedAt: pin.pinnedAt, name: name.trim() };
    await this.commit(event, (snapshot) => {
      if (!snapshot.pins.some(({ id, pinnedAt }) => id === pin.id && pinnedAt === pin.pinnedAt)) {
        throw new Error("This pin was removed or replaced in another window.");
      }
    });
  }

  reorder(ids: string[]): Promise<void> {
    return this.commit({ type: "reorder", ids }, (snapshot) => {
      const current = new Set(snapshot.pins.map(({ id }) => id));
      if (ids.some((id) => !current.has(id))) {
        throw new Error("The pinned project order changed. Refresh and try again.");
      }
    });
  }

  private async commit(event: ProjectEvent, validate?: (snapshot: ProjectSnapshot) => void): Promise<void> {
    readEvent(event);
    const snapshot = await this.read();
    validate?.(snapshot);
    await this.journal.append(event);
  }
}

export async function workspaceProjectStore(context: Pick<vscode.ExtensionContext, "globalStorageUri" | "globalState">) {
  if (context.globalStorageUri.scheme !== "file") {
    throw new Error("Soft Start project storage requires a native filesystem on the extension host.");
  }
  const host = await currentProjectHost();
  const journal = new ProjectJournal(join(context.globalStorageUri.fsPath, "projects-v2", host?.key ?? "unverified-host"));
  return { store: new ProjectStore(journal, host, context.globalState), journal };
}
