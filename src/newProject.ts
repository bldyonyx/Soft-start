import * as vscode from "vscode";
import { pickProjectsDirectory, projectsDirectoryUri } from "./projectsDirectory";

type ProjectApi = {
  window: Pick<typeof vscode.window, "showInputBox" | "showOpenDialog"> & {
    showErrorMessage(message: string): Thenable<unknown>;
  };
  workspace: {
    getConfiguration(section: string): {
      get(key: string, defaultValue: string): string;
    };
    fs: Pick<typeof vscode.workspace.fs, "stat" | "createDirectory">;
  };
  commands: {
    executeCommand(command: string, uri: vscode.Uri): Thenable<unknown>;
  };
};

function validateProjectName(name: string): string | undefined {
  if (!name.trim()) {
    return "Enter a project name.";
  }
  if (name !== name.trim() || name.endsWith(".") ||
    /[<>:"/\\|?*]/u.test(name) || /\p{Cc}/u.test(name) ||
    Buffer.byteLength(name, "utf8") > 255 ||
    /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³]) *(?:\.|$)/iu.test(name)) {
    return "Enter a valid folder name without path separators, reserved names, or trailing dots.";
  }
}

export async function createProject(api: ProjectApi = vscode): Promise<void> {
  let created = false;
  try {
    const name = await api.window.showInputBox({
      title: "New project",
      prompt: "Enter a name for the new project folder",
      validateInput: validateProjectName,
    });
    if (name === undefined) {
      return;
    }
    const validationError = validateProjectName(name);
    if (validationError) {
      throw new Error(validationError);
    }

    const configuredPath = api.workspace.getConfiguration("softStart")
      .get("projectsDirectory", "");
    let parent: vscode.Uri | undefined;
    if (configuredPath.trim()) {
      parent = projectsDirectoryUri(configuredPath);
    } else {
      parent = await pickProjectsDirectory(
        (options) => api.window.showOpenDialog(options),
        "Select a parent folder for the new project",
        "Select parent folder",
      );
    }
    if (!parent) {
      return;
    }
    const parentStat = await api.workspace.fs.stat(parent);
    if (!(parentStat.type & vscode.FileType.Directory)) {
      throw new Error("The projects directory must be a folder.");
    }

    const destination = vscode.Uri.joinPath(parent, name);
    try {
      await api.workspace.fs.stat(destination);
      throw new Error(`A file or folder named "${name}" already exists in the projects directory.`);
    } catch (error) {
      if (!(error instanceof vscode.FileSystemError && error.code === "FileNotFound")) {
        throw error;
      }
    }

    await api.workspace.fs.createDirectory(destination);
    created = true;
    await api.commands.executeCommand("vscode.openFolder", destination);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const message = created ? "Project created, but VS Code could not open it." : "Could not create project.";
    void api.window.showErrorMessage(`${message} ${detail}`);
  }
}
