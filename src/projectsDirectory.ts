import { isAbsolute } from "node:path";
import * as vscode from "vscode";

export function validateProjectsDirectory(path: string): void {
  if (path !== "" && (!isAbsolute(path) || /[\r\n\0]/u.test(path))) {
    throw new Error("Set softStart.projectsDirectory to an absolute directory path on the active VS Code host.");
  }
}

export async function pickProjectsDirectory(
  picker: typeof vscode.window.showOpenDialog,
  title: string,
  openLabel: string,
): Promise<vscode.Uri | undefined> {
  const selected = await picker({
    title,
    openLabel,
    canSelectFolders: true,
    canSelectFiles: false,
    canSelectMany: false,
  });
  return selected?.[0];
}

export function remoteWorkspaceUri(): vscode.Uri | undefined {
  return [vscode.workspace.workspaceFile, ...vscode.workspace.workspaceFolders?.map(({ uri }) => uri) ?? []]
    .find((uri) => uri?.scheme === "vscode-remote");
}

export function projectsDirectoryUri(path: string, remote = remoteWorkspaceUri()): vscode.Uri {
  validateProjectsDirectory(path);
  const local = vscode.Uri.file(path);
  return remote ? remote.with({ path: local.path, query: "", fragment: "" }) : local;
}

export function projectsDirectoryPath(uri: vscode.Uri, remote = remoteWorkspaceUri(), remoteName = vscode.env.remoteName): string {
  if (uri.scheme !== "file" && (uri.scheme !== "vscode-remote" || !(remote
    ? uri.authority === remote.authority
    : remoteName && uri.authority.startsWith(`${remoteName}+`)))) {
    throw new Error("Select a folder on the active VS Code host.");
  }
  const path = uri.fsPath;
  validateProjectsDirectory(path);
  return path;
}
