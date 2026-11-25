import type * as vscode from "vscode";
import { presentProject as presentStoredProject, projectId, readStoredProject, type Project, type StoredProject } from "./projects";
import { isProjectTimestamp, type RecentProjectItem } from "./webviewMessages";

export { currentProject, openProject as openRecentProject, projectId } from "./projects";

export const recentProjectsKey = "recentProjects.v1";
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
