import { isAbsolute } from "node:path";
import * as vscode from "vscode";

export function validateProjectsDirectory(path: unknown): asserts path is string {
  if (typeof path !== "string" || (path !== "" &&
      (!isAbsolute(path) || /[\r\n\0]/u.test(path) ||
       (process.platform === "win32" && !/^(?:[a-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+)/i.test(path))))) {
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

export function projectsDirectoryUri(path: string, remote?: vscode.Uri): vscode.Uri {
  validateProjectsDirectory(path);
  const local = vscode.Uri.file(path);
  return remote ? remote.with({ path: local.path, query: "", fragment: "" }) : local;
}

export function projectsDirectoryPath(uri: vscode.Uri, remote?: vscode.Uri, remoteName = vscode.env.remoteName): string {
  if (uri.query || uri.fragment || (uri.scheme !== "file" &&
      (uri.scheme !== "vscode-remote" || !remote || (remoteName && !remote.authority.startsWith(`${remoteName}+`)) ||
       !uri.authority || uri.authority !== remote.authority))) {
    throw new Error("Select a folder on the active VS Code host. Soft Start could not verify the selected location.");
  }
  const path = uri.fsPath;
  validateProjectsDirectory(path);
  return path;
}
