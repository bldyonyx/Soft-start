import { createHash } from "node:crypto";
import { posix } from "node:path";
import * as vscode from "vscode";
import type { ProjectItem, ProjectKind } from "./webviewMessages";

type ProjectUri = Pick<vscode.Uri, "scheme" | "authority" | "path" | "query" | "fragment">;
export type Project = { uri: vscode.Uri; name: string; kind: ProjectKind };
export type StoredProject = Omit<Project, "uri"> & { id: string; uri: ProjectUri };

export function serializeUri({ scheme, authority, path, query, fragment }: ProjectUri): ProjectUri {
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

export function readStoredProject(value: unknown): StoredProject | undefined {
  if (typeof value !== "object" || value === null ||
      !("uri" in value) || !("id" in value) ||
      !("name" in value) || typeof value.name !== "string" || !value.name.trim() ||
      !("kind" in value) || (value.kind !== "folder" && value.kind !== "workspace")) {
    return;
  }
  const uri = readProjectUri(value.uri);
  if (uri && projectId(uri) === value.id) {
    return { id: value.id, uri, name: value.name, kind: value.kind };
  }
}

export function presentProject({ id, uri: components, name, kind }: StoredProject): ProjectItem {
  const uri = vscode.Uri.from(components);
  const path = uri.scheme === "file" ? uri.fsPath :
    uri.authority ? `${uri.authority}${uri.path}` : `${uri.scheme}:${uri.path}`;
  return { id, name, kind, path };
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

export async function openProject(
  entry: StoredProject,
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
