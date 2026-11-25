import { posix } from "node:path";
import * as vscode from "vscode";
import type { Project, StoredProject } from "./projects";
import type { ProjectKind } from "./webviewMessages";

export const pinnedProjectsKey = "pinnedProjects.v1";

export type PinnedProject = StoredProject & { pinnedAt: number; displayName?: string };

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
