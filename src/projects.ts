import { createHash } from "node:crypto";
import { posix } from "node:path";
import * as vscode from "vscode";
import type { ProjectItem, ProjectKind } from "./webviewMessages";

type ProjectUri = Pick<vscode.Uri, "scheme" | "authority" | "path" | "query" | "fragment">;
export type Project = { uri: vscode.Uri; name: string; kind: ProjectKind };
export type StoredProject = Omit<Project, "uri"> & { id: string; uri: ProjectUri };
export type ProjectOrigin =
  | { kind: "host"; key: string; label: string }
  | { kind: "addressed" }
  | { kind: "unknown" };
export type IdentifiedProject = StoredProject & { origin: ProjectOrigin };

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

export function identifyProject(project: Project, host?: Extract<ProjectOrigin, { kind: "host" }>): IdentifiedProject {
  const uri = serializeUri(project.uri);
  const origin: ProjectOrigin = uri.scheme === "file" ? host ?? { kind: "unknown" } :
    hasExplicitAddress(uri) ? { kind: "addressed" } : { kind: "unknown" };
  return { ...project, uri, origin, id: identifiedProjectId(uri, origin) };
}

function hasExplicitAddress(uri: ProjectUri): boolean {
  // An authority-less provider URI can be scoped to a different host or client.
  return uri.scheme !== "file" && uri.scheme !== "vscode-local" && Boolean(uri.authority);
}

function identifiedProjectId(uri: ProjectUri, origin: ProjectOrigin): string {
  return origin.kind === "host"
    ? createHash("sha256").update(JSON.stringify([origin.key, serializeUri(uri)])).digest("hex")
    : projectId(uri);
}

export function readIdentifiedProject(value: unknown): IdentifiedProject | undefined {
  if (typeof value !== "object" || value === null || !("id" in value) || !("uri" in value)) {
    return;
  }
  const uri = readProjectUri(value.uri);
  if (!uri) {
    return;
  }
  const base = readStoredProject({ ...value, id: projectId(uri) });
  if (!base) {
    return;
  }
  const origin = "origin" in value ? value.origin : undefined;
  if (typeof origin !== "object" || origin === null || !("kind" in origin)) {
    return;
  }
  if (origin.kind === "host" && uri.scheme === "file" && "key" in origin && typeof origin.key === "string" &&
      /^[a-f0-9]{64}$/.test(origin.key) && "label" in origin && typeof origin.label === "string") {
    const host: ProjectOrigin = { kind: "host", key: origin.key, label: origin.label };
    const id = identifiedProjectId(uri, host);
    if (id === value.id) {
      return { ...base, id, origin: host };
    }
  } else if (origin.kind === "unknown" || (origin.kind === "addressed" && hasExplicitAddress(uri))) {
    if (base.id === value.id) {
      return { ...base, origin: { kind: origin.kind } };
    }
  }
}

export function migrateProject(value: unknown): IdentifiedProject | undefined {
  const migrated = readIdentifiedProject(value);
  if (migrated) {
    return migrated;
  }
  const legacy = readStoredProject(value);
  if (legacy) {
    return identifyProject({ ...legacy, uri: vscode.Uri.from(legacy.uri) });
  }
}

export function assertProjectOrigin(entry: IdentifiedProject, host?: Extract<ProjectOrigin, { kind: "host" }>): void {
  if (entry.origin.kind === "unknown") {
    throw new Error("Soft Start cannot verify this saved project's original host. From a VS Code window connected to the project, use Locate project in its menu.");
  }
  if (entry.origin.kind === "host" && entry.origin.key !== host?.key) {
    throw new Error(`Open this project from its original ${entry.origin.label} environment.`);
  }
}

export function presentProject(entry: StoredProject | IdentifiedProject): ProjectItem {
  const { id, uri: components, name, kind } = entry;
  const uri = vscode.Uri.from(components);
  const path = uri.scheme === "file" ? uri.fsPath :
    uri.authority ? `${uri.authority}${uri.path}` : `${uri.scheme}:${uri.path}`;
  const origin = "origin" in entry ? entry.origin : undefined;
  const originLabel = origin?.kind === "host" ? origin.label : undefined;
  return { id, name, kind, path, ...(originLabel ? { hostLabel: originLabel } : {}),
    ...(origin?.kind === "unknown" ? { unresolved: true } : {}) };
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
    const detail = error instanceof vscode.FileSystemError
      ? "Check that the location still exists and that you have access."
      : error instanceof Error ? error.message : String(error);
    const recovery = uri.scheme === "vscode-remote" && uri.authority
      ? ` Connect to ${uri.authority} and verify the original project exists.` : "";
    throw new Error(`Could not open "${entry.name}". ${detail}${recovery}`);
  }
}
