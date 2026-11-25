import { posix } from "node:path";
import * as vscode from "vscode";
import { projectId, readStoredProject, type Project, type StoredProject } from "./projects";
import { isProjectTimestamp, type ProjectKind } from "./webviewMessages";

export const pinnedProjectsKey = "pinnedProjects.v1";

export type PinnedProject = StoredProject & { pinnedAt: number; displayName?: string };

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

type ProjectChoice = { label: string; projectKind: ProjectKind };
type ProjectPicker = {
  showQuickPick(items: readonly ProjectChoice[], options: vscode.QuickPickOptions): Thenable<ProjectChoice | undefined>;
  showOpenDialog: typeof vscode.window.showOpenDialog;
};

export async function selectPinnedProject(
  window: ProjectPicker = vscode.window,
): Promise<Project | undefined> {
  const choice = await window.showQuickPick([
    { label: "Folder", projectKind: "folder" },
    { label: "Saved workspace file", projectKind: "workspace" },
  ], { title: "Add a pinned project" });
  if (!choice) {
    return;
  }
  const folder = choice.projectKind === "folder";
  const selection = await window.showOpenDialog({
    title: folder ? "Select a project folder" : "Select a saved workspace file",
    openLabel: "Pin project",
    canSelectFolders: folder,
    canSelectFiles: !folder,
    canSelectMany: false,
    filters: folder ? undefined : { "VS Code workspaces": ["code-workspace"] },
  });
  const uri = selection?.[0];
  if (uri) {
    if (!folder && !uri.path.toLowerCase().endsWith(".code-workspace")) {
      throw new Error("Select a saved .code-workspace file.");
    }
    return { uri, name: posix.basename(uri.path) || uri.authority || uri.path, kind: choice.projectKind };
  }
}

export function promptPinnedProjectName(
  entry: PinnedProject,
  input: typeof vscode.window.showInputBox = (options) => vscode.window.showInputBox(options),
): Thenable<string | undefined> {
  return input({
    title: "Rename pinned project",
    value: entry.displayName ?? entry.name,
    prompt: `Clear the name to restore "${entry.name}".`,
  });
}
