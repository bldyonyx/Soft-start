import { basename, dirname, join } from "node:path";
import * as vscode from "vscode";
import { ProjectJournal } from "./projectJournal";
import { currentProjectHost } from "./projectHost";
import { assertProjectOrigin, identifyProject, migrateProject, projectId, readIdentifiedProject, type IdentifiedProject, type Project, type ProjectOrigin } from "./projects";
import { recentProjectsKey } from "./recentProjects";
import { pinnedProjectsKey } from "./pinnedProjects";
import { isProjectTimestamp } from "./webviewMessages";

type Host = Extract<ProjectOrigin, { kind: "host" }>;
export type RecentEntry = IdentifiedProject & { lastOpened: number };
export type PinnedEntry = IdentifiedProject & { pinnedAt: number; displayName?: string };
export type ProjectSnapshot = { recent: RecentEntry[]; pins: PinnedEntry[] };

type ProjectEvent =
  | { type: "recoverPublisherPins"; pins: PinnedEntry[] }
  | { type: "record"; project: RecentEntry }
  | { type: "pin"; project: PinnedEntry }
  | { type: "forget" | "unpin"; id: string }
  | { type: "rename"; id: string; name: string; pinnedAt: number }
  | { type: "reorder"; ids: string[] }
  | { type: "locate"; list: "pins" | "recent"; id: string; project: IdentifiedProject };

type Journal = Pick<ProjectJournal, "initialize" | "events" | "append" | "publishPublisherRecovery">;
type HistoricalJournal = Pick<ProjectJournal, "readBaseline" | "events">;

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
      case "recoverPublisherPins": {
        if ("pins" in raw && Array.isArray(raw.pins)) {
          const pins = entries(raw.pins, readPin);
          if (pins.length === raw.pins.length && unique(pins).length === pins.length) {
            return { type: raw.type, pins };
          }
        }
        break;
      }
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
      case "locate": {
        const project = "project" in raw && readIdentifiedProject(raw.project);
        if (project && project.origin.kind !== "unknown" && "id" in raw && isId(raw.id) &&
            "list" in raw && (raw.list === "pins" || raw.list === "recent")) {
          return { type: raw.type, list: raw.list, id: raw.id, project };
        }
        break;
      }
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

function apply(state: ProjectSnapshot, event: Exclude<ProjectEvent, { type: "recoverPublisherPins" }>): void {
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
    case "locate": {
      const list = state[event.list];
      const index = list.findIndex(({ id }) => id === event.id);
      const original = list[index];
      if (original?.origin.kind === "unknown" && original.kind === event.project.kind &&
          !list.some(({ id }, position) => position !== index && id === event.project.id)) {
        list[index] = { ...original, ...event.project };
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

function replay(baseline: unknown, events: ProjectEvent[], host: Host | undefined, strictBaseline = false): ProjectSnapshot {
  if (!baseline || typeof baseline !== "object" || !("version" in baseline) || baseline.version !== 2 ||
      !("recent" in baseline) || !("pins" in baseline)) {
    throw new Error("Soft Start could not read the project migration record. Keep the legacy values and project storage files for recovery.");
  }
  const recent = entries(baseline.recent, (value) => readRecent(value, true));
  const pins = entries(baseline.pins, (value) => readPin(value, true));
  if (strictBaseline && ((baseline.pins !== null && (!Array.isArray(baseline.pins) || pins.length !== baseline.pins.length)) ||
      (baseline.recent !== null && (!Array.isArray(baseline.recent) || recent.length !== baseline.recent.length)))) {
    throw new Error("Soft Start found invalid entries in the historical project migration record.");
  }
  const state = { recent: unique(recent.sort(byRecency)).slice(0, 50), pins: unique(pins) };
  const removed = new Set<string>();
  const recoveryAliases = new Map<string, PinnedEntry>();
  let recovered = false;
  for (const event of events) {
    if (event.type === "recoverPublisherPins") {
      if (!recovered) {
        const blocked = new Set([...removed, ...state.pins.map(({ id }) => id)]);
        for (const pin of event.pins) {
          // Compare both identities for a native URI without changing an unresolved pin's origin.
          const alias = pin.origin.kind === "unknown" && host
            ? identifyProject({ ...pin, uri: vscode.Uri.from(pin.uri) }, host).id
            : projectId(pin.uri);
          if (!blocked.has(pin.id) && !blocked.has(alias)) {
            state.pins.push(pin);
            blocked.add(pin.id);
            if (alias !== pin.id) {
              recoveryAliases.set(alias, pin);
            }
          }
        }
        recovered = true;
      }
    } else {
      if (event.type === "unpin") {
        removed.add(event.id);
        const recoveredPin = recoveryAliases.get(event.id);
        if (recoveredPin && state.pins.includes(recoveredPin)) {
          apply(state, { type: "unpin", id: recoveredPin.id });
        }
      }
      apply(state, event);
    }
  }
  state.recent = state.recent.sort(byRecency).slice(0, 50);
  return state;
}

export class ProjectStore {
  private publisherRecovery?: Promise<boolean>;

  constructor(
    private readonly journal: Journal,
    readonly host: Host | undefined,
    private readonly legacy: Pick<vscode.Memento, "get">,
    private readonly historical?: HistoricalJournal,
  ) {}

  async read(): Promise<ProjectSnapshot> {
    const baseline = await this.journal.initialize({
      version: 2,
      recent: this.legacy.get(recentProjectsKey) ?? null,
      pins: this.legacy.get(pinnedProjectsKey) ?? null,
    });
    let events = (await this.journal.events()).map(readEvent);
    const state = replay(baseline, events, this.host);
    if (this.host && this.historical && !events.some(({ type }) => type === "recoverPublisherPins")) {
      const recovery = this.publisherRecovery ??= this.recoverPublisherPins(this.historical, this.host).catch((error: unknown) => {
        console.error("Soft Start could not recover publisher-less project pins. The historical journal was left intact.", error);
        return false;
      });
      if (await recovery) {
        events = (await this.journal.events()).map(readEvent);
        return replay(baseline, events, this.host);
      }
      if (this.publisherRecovery === recovery) {
        this.publisherRecovery = undefined;
      }
    }
    return state;
  }

  private async recoverPublisherPins(historical: HistoricalJournal, host: Host): Promise<boolean> {
    const baseline = await historical.readBaseline();
    if (baseline === undefined) {
      return false;
    }
    const { pins } = replay(baseline, (await historical.events()).map(readEvent), host, true);
    const verified = pins.filter(({ origin }) => origin.kind !== "host" || origin.key === host.key);
    // The atomic publication is both the import and its completion record.
    await this.journal.publishPublisherRecovery({ type: "recoverPublisherPins", pins: verified } satisfies ProjectEvent);
    return true;
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
      throw new Error("Soft Start cannot verify where this location belongs. Browse for it from a VS Code window connected to the project.");
    }
    await this.commit({ type: "pin", project: { ...entry, pinnedAt } });
  }

  async locate(list: "pins" | "recent", id: string, selection: Project): Promise<void> {
    const project = identifyProject(selection, this.host);
    assertProjectOrigin(project, this.host);
    const stat = await vscode.workspace.fs.stat(selection.uri).then((stat) => stat, () => undefined);
    const expected = selection.kind === "folder" ? vscode.FileType.Directory : vscode.FileType.File;
    if (!stat || !(stat.type & expected)) {
      throw new Error("The selected location is unavailable. Check your access and choose the project again.");
    }
    await this.commit({ type: "locate", list, id, project }, (snapshot) => {
      const original = snapshot[list].find((entry) => entry.id === id);
      if (original?.origin.kind !== "unknown" || original.kind !== project.kind) {
        throw new Error("This project has changed. Refresh the dashboard and try again.");
      }
      if (snapshot[list].some((entry) => entry.id === project.id && entry.id !== id)) {
        throw new Error(list === "pins"
          ? "This location is already pinned. Keep the existing pin or unpin it before locating this one."
          : "This location is already in Recent Projects. You can remove the older entry from its menu.");
      }
    });
    const latest = (await this.read())[list];
    if (latest.some((entry) => entry.id === id && entry.origin.kind === "unknown") ||
        !latest.some((entry) => entry.id === project.id)) {
      throw new Error("The project list changed in another window. Review the entries and try again.");
    }
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

export class UnsupportedProjectStorageError extends Error {
  constructor() {
    super("Pinned and recent projects cannot be saved or loaded in this VS Code window. Soft Start requires native filesystem storage for project history.");
  }
}

export async function workspaceProjectStore(context: Pick<vscode.ExtensionContext, "globalStorageUri" | "globalState">) {
  if (context.globalStorageUri.scheme !== "file") {
    throw new UnsupportedProjectStorageError();
  }
  const host = await currentProjectHost();
  return projectStoreAt(context.globalStorageUri.fsPath, host, context.globalState);
}

export function projectStoreAt(storage: string, host: Host | undefined, legacy: Pick<vscode.Memento, "get">) {
  const journal = new ProjectJournal(join(storage, "projects-v2", host?.key ?? "unverified-host"));
  const historical = host && basename(storage) === "bldyonyx.soft-start"
    ? new ProjectJournal(join(dirname(storage), "undefined_publisher.soft-start", "projects-v2", host.key))
    : undefined;
  return { store: new ProjectStore(journal, host, legacy, historical), journal };
}
