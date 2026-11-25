// Recreates v1 writes for the legacy format and migration regression tests.
import type * as vscode from "vscode";
import { presentProject as presentStoredProject, projectId, readStoredProject, type Project, type StoredProject } from "../projects";
import { isProjectTimestamp, type RecentProjectItem } from "../webviewMessages";
import { pinnedProjectsKey, type PinnedProject } from "../pinnedProjects";
import { recentProjectsKey } from "../recentProjects";

export { currentProject, openProject as openRecentProject, projectId } from "../projects";

const historyLimit = 50;

export type RecentProject = StoredProject & { lastOpened: number };

function validateEntry(value: unknown): RecentProject | undefined {
  if (typeof value === "object" && value !== null &&
      "lastOpened" in value && isProjectTimestamp(value.lastOpened)) {
    const project = readStoredProject(value);
    if (project) {
      return { ...project, lastOpened: value.lastOpened };
    }
  }
}

export class RecentProjects {
  private pending = Promise.resolve();

  constructor(private readonly state: Pick<vscode.Memento, "get" | "update">) {}

  list(): RecentProject[] {
    const stored = this.state.get<unknown>(recentProjectsKey);
    if (!Array.isArray(stored)) {
      return [];
    }
    const sorted = stored.flatMap((value: unknown) => validateEntry(value) ?? [])
      .sort((a, b) => b.lastOpened - a.lastOpened);
    const unique = new Map<string, RecentProject>();
    for (const entry of sorted) {
      if (!unique.has(entry.id)) {
        unique.set(entry.id, entry);
      }
      if (unique.size === historyLimit) {
        break;
      }
    }
    return [...unique.values()];
  }

  record(project: Project, lastOpened = Date.now()): Promise<void> {
    const entry = validateEntry({ ...project, id: projectId(project.uri), lastOpened });
    if (!entry) {
      return Promise.reject(new Error("Invalid recent project."));
    }
    return this.update((entries) => [entry, ...entries.filter((item) => item.id !== entry.id)]
      .sort((a, b) => b.lastOpened - a.lastOpened));
  }

  remove(id: string): Promise<void> {
    return this.update((entries) => entries.filter((item) => item.id !== id));
  }

  private update(change: (entries: RecentProject[]) => RecentProject[]): Promise<void> {
    const write = this.pending.then(() => this.state.update(recentProjectsKey, change(this.list()).slice(0, historyLimit)));
    this.pending = write.catch(() => {});
    return write;
  }
}

export function presentProject(entry: RecentProject): RecentProjectItem {
  return { ...presentStoredProject(entry), lastOpened: entry.lastOpened };
}

function readPin(value: unknown): PinnedProject | undefined {
  if (typeof value !== "object" || value === null ||
      !("pinnedAt" in value) || !isProjectTimestamp(value.pinnedAt)) {
    return;
  }
  const project = readStoredProject(value);
  if (project) {
    const entry: PinnedProject = { ...project, pinnedAt: value.pinnedAt };
    if ("displayName" in value && typeof value.displayName === "string" && value.displayName.trim()) {
      entry.displayName = value.displayName.trim();
    }
    return entry;
  }
}

function readPins(value: unknown): PinnedProject[] {
  const entries = new Map<string, PinnedProject>();
  if (Array.isArray(value)) {
    for (const item of value) {
      const entry = readPin(item);
      if (entry && !entries.has(entry.id)) {
        entries.set(entry.id, entry);
      }
    }
  }
  return [...entries.values()];
}

export class PinnedProjects {
  private pending = Promise.resolve();
  private lastConfirmed?: PinnedProject[];

  constructor(private readonly state: Pick<vscode.Memento, "get" | "update">) {}

  list(): PinnedProject[] {
    // VS Code's Memento can update its cache before persistence succeeds.
    return readPins(this.lastConfirmed ?? this.state.get<unknown>(pinnedProjectsKey));
  }

  pin(project: Project, pinnedAt = Date.now()): Promise<void> {
    const entry = readPin({ ...project, id: projectId(project.uri), pinnedAt });
    if (!entry) {
      return Promise.reject(new Error("Invalid pinned project."));
    }
    return this.update((entries) => {
      if (!entries.some(({ id }) => id === entry.id)) {
        return [...entries, entry];
      }
    });
  }

  unpin(id: string): Promise<void> {
    return this.update((entries) => entries.filter((entry) => entry.id !== id));
  }

  rename(id: string, name: string): Promise<void> {
    return this.update((entries) => {
      const index = entries.findIndex((item) => item.id === id);
      if (index === -1) {
        throw new Error("This project is no longer pinned.");
      }
      const entry = { ...entries[index] };
      const displayName = name.trim();
      if (!displayName || displayName === entry.name) {
        delete entry.displayName;
      } else {
        entry.displayName = displayName;
      }
      return entries.map((item, i) => i === index ? entry : item);
    });
  }

  reorder(ids: readonly string[]): Promise<void> {
    return this.update((entries) => {
      const byId = new Map(entries.map((entry) => [entry.id, entry]));
      if (ids.length !== entries.length || new Set(ids).size !== entries.length) {
        throw new Error("The pinned project order has changed. Try again.");
      }
      return Array.from(ids, (id) => {
        const entry = byId.get(id);
        if (!entry) {
          throw new Error("The pinned project order has changed. Try again.");
        }
        return entry;
      });
    });
  }

  private update(change: (entries: PinnedProject[]) => PinnedProject[] | undefined): Promise<void> {
    const write = this.pending.then(async () => {
      const before = this.list();
      const next = change(before);
      if (!next) {
        return;
      }
      this.lastConfirmed = before;
      await this.state.update(pinnedProjectsKey, next);
      this.lastConfirmed = undefined;
    });
    this.pending = write.catch(() => {});
    return write;
  }
}
