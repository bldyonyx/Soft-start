import * as vscode from "vscode";
import type { ProjectActionMessage, ProjectActionTarget, ProjectRequest } from "./webviewMessages";

export class ProjectActions {
  private busy = false;

  constructor(private readonly publish: (status: ProjectActionMessage) => void) {}

  private pending?: { detail?: string; target?: ProjectActionTarget };

  status(): ProjectActionMessage {
    return { type: "projectAction", busy: this.busy, ...this.pending };
  }

  async run(
    action: (focus: (target: ProjectActionTarget, detail?: string) => void) => Promise<string | void>,
    target?: ProjectActionTarget,
    pendingDetail?: string,
  ): Promise<void> {
    if (this.busy) {
      this.publish({ ...this.status(), error: "A project action is already running. Try again when it finishes." });
      return;
    }
    this.busy = true;
    this.pending = { detail: pendingDetail, target };
    this.publish(this.status());
    let detail: string | void = undefined;
    let error: string | undefined;
    const focus = (next: ProjectActionTarget, detail = pendingDetail) => {
      if (next.section === target?.section && next.id === target.id && detail === this.pending?.detail) {
        return;
      }
      target = next;
      this.pending = { detail, target };
      this.publish(this.status());
    };
    try {
      detail = await action(focus);
    } catch (reason) {
      error = reason instanceof Error ? reason.message : String(reason);
    } finally {
      this.busy = false;
      this.pending = undefined;
      this.publish({ ...this.status(), error, target, detail: detail || undefined });
    }
  }
}

export function pendingProjectAction(request: ProjectRequest): string {
  switch (request.type) {
    case "addPinnedProject": return "Adding pinned project…";
    case "pinRecentProject": return "Pinning project…";
    case "unpinProject": return "Unpinning project…";
    case "renamePinnedProject": return "Renaming pinned project…";
    case "restorePinnedProjectName": return "Restoring original project name…";
    case "removeRecentProject": return "Removing recent project…";
    case "reorderPinnedProjects": return "Moving pinned project…";
    case "locatePinnedProject":
    case "locateRecentProject": return "Locating project…";
    case "openPinnedProject":
    case "openRecentProject": return "Opening project…";
    case "viewAllRecentProjects": return "Selecting a recent project…";
    case "quickAction": return "Working on a project action…";
  }
}

export async function cloneProject(
  extensions: Pick<typeof vscode.extensions, "getExtension"> = vscode.extensions,
  commands: Pick<typeof vscode.commands, "executeCommand" | "getCommands"> = vscode.commands,
): Promise<void> {
  const git = extensions.getExtension("vscode.git");
  if (git && !git.isActive) {
    await git.activate();
  }
  if (!(await commands.getCommands()).includes("git.clone")) {
    throw new Error("Git Clone is unavailable. Enable the built-in Git extension in this VS Code environment and try again.");
  }
  await commands.executeCommand("git.clone");
}
