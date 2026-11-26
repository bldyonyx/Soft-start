import * as vscode from "vscode";
import type { ProjectActionMessage, ProjectActionTarget } from "./webviewMessages";

export class ProjectActions {
  private busy = false;

  constructor(private readonly publish: (status: ProjectActionMessage) => void) {}

  status(error?: string, target?: ProjectActionTarget): ProjectActionMessage {
    return { type: "projectAction", busy: this.busy, error, target };
  }

  async run(action: (focus: (target: ProjectActionTarget) => void) => Promise<void>, target?: ProjectActionTarget): Promise<void> {
    if (this.busy) {
      this.publish(this.status("A project action is already running. Try again when it finishes."));
      return;
    }
    this.busy = true;
    this.publish(this.status());
    let error: string | undefined;
    const focus = (next: ProjectActionTarget) => { target = next; };
    try {
      await action(focus);
    } catch (reason) {
      error = reason instanceof Error ? reason.message : String(reason);
    } finally {
      this.busy = false;
      this.publish(this.status(error, target));
    }
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
