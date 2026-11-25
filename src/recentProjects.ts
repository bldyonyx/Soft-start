import { createHash } from "node:crypto";
import { posix } from "node:path";
import * as vscode from "vscode";
import type { RecentProjectItem, RecentProjectKind } from "./webviewMessages";

export const recentProjectsKey = "recentProjects.v1";
const historyLimit = 50;
const maxTimestamp = 8.64e15;

type Project = { uri: vscode.Uri; name: string; kind: RecentProjectKind };
type ProjectUri = Pick<vscode.Uri, "scheme" | "authority" | "path" | "query" | "fragment">;

export type RecentProject = {
  id: string;
  uri: ProjectUri;
  name: string;
  kind: RecentProjectKind;
  lastOpened: number;
};

function serializeUri({ scheme, authority, path, query, fragment }: ProjectUri): ProjectUri {
  // Uri.toString() can lowercase the authority, including a WSL distribution name.
  return { scheme, authority, path, query, fragment };
}

export function projectId(uri: ProjectUri): string {
  return createHash("sha256").update(JSON.stringify(serializeUri(uri))).digest("hex");
}

function readProjectUri(value: unknown): ProjectUri | undefined {
  if (typeof value !== "object" || value === null ||
      !("scheme" in value) || typeof value.scheme !== "string" ||
      !/^[a-z][a-z\d+.-]*$/i.test(value.scheme) || value.scheme.toLowerCase() === "untitled" ||
      !("authority" in value) || typeof value.authority !== "string" ||
      !("path" in value) || typeof value.path !== "string" ||
      (!value.path.startsWith("/") && !value.authority) ||
      !("query" in value) || typeof value.query !== "string" ||
      !("fragment" in value) || typeof value.fragment !== "string") {
    return;
  }
  try {
    const { scheme, authority, path, query, fragment } = value;
    return serializeUri(vscode.Uri.from({ scheme, authority, path, query, fragment }));
  } catch {
    return;
  }
}

function validateEntry(value: unknown): RecentProject | undefined {
  if (typeof value !== "object" || value === null ||
      !("uri" in value) ||
      !("id" in value) ||
      !("name" in value) || typeof value.name !== "string" || !value.name.trim() ||
      !("kind" in value) || (value.kind !== "folder" && value.kind !== "workspace") ||
      !("lastOpened" in value) || typeof value.lastOpened !== "number" ||
      !Number.isInteger(value.lastOpened) || value.lastOpened < 0 || value.lastOpened > maxTimestamp) {
    return;
  }
  const uri = readProjectUri(value.uri);
  if (uri && projectId(uri) === value.id) {
    return { id: value.id, uri, name: value.name, kind: value.kind, lastOpened: value.lastOpened };
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

export function currentProject(
  workspace: Pick<typeof vscode.workspace, "workspaceFile" | "workspaceFolders" | "name">,
): Project | undefined {
  const file = workspace.workspaceFile;
  if (file) {
    if (file.scheme !== "untitled") {
      return { uri: file, name: workspace.name || posix.basename(file.path) || file.authority, kind: "workspace" };
    }
    return;
  }
  const folders = workspace.workspaceFolders;
  if (folders?.length === 1) {
    return { uri: folders[0].uri, name: folders[0].name, kind: "folder" };
  }
}

export function presentProject(entry: RecentProject): RecentProjectItem {
  const uri = vscode.Uri.from(entry.uri);
  const path = uri.scheme === "file" ? uri.fsPath :
    uri.authority ? `${uri.authority}${uri.path}` : `${uri.scheme}:${uri.path}`;
  return { id: entry.id, name: entry.name, kind: entry.kind, lastOpened: entry.lastOpened, path };
}

export async function openRecentProject(
  entry: RecentProject,
  stat: typeof vscode.workspace.fs.stat = (uri) => vscode.workspace.fs.stat(uri),
  open: (uri: vscode.Uri) => Thenable<unknown> = (uri) => vscode.commands.executeCommand("vscode.openFolder", uri),
): Promise<void> {
  const uri = vscode.Uri.from(entry.uri);
  try {
    const { type } = await stat(uri);
    const expected = entry.kind === "folder" ? vscode.FileType.Directory : vscode.FileType.File;
    if (!(type & expected)) {
      throw new Error(entry.kind === "folder" ? "The location is no longer a folder." : "The workspace file is unavailable.");
    }
    await open(uri);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not open "${entry.name}". ${detail}`);
  }
}
