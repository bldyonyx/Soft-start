import { mkdir } from "node:fs/promises";
import * as vscode from "vscode";
import { pickProjectsDirectory, projectsDirectoryPath, projectsDirectoryUri, validateProjectsDirectory } from "./projectsDirectory";

type ProjectApi = {
  window: Pick<typeof vscode.window, "showInputBox" | "showOpenDialog"> & {
    showErrorMessage(message: string): Thenable<unknown>;
  };
  workspace: {
    getConfiguration(section: string): {
      get(key: string, defaultValue: string): unknown;
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

export async function createNativeProjectDirectory(uri: vscode.Uri): Promise<void> {
  if (uri.scheme === "file") {
    // Exclusive creation catches a competing mkdir between the existence check and creation.
    await mkdir(uri.fsPath);
  } else {
    await vscode.workspace.fs.createDirectory(uri);
  }
}

export async function createProject(
  api: ProjectApi = vscode,
  verifiedRemote?: vscode.Uri,
  makeDirectory: (uri: vscode.Uri) => Thenable<void> = api === vscode
    ? createNativeProjectDirectory : (uri) => api.workspace.fs.createDirectory(uri),
): Promise<void> {
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
    validateProjectsDirectory(configuredPath);
    let parent: vscode.Uri | undefined;
    if (configuredPath) {
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
    projectsDirectoryPath(parent, verifiedRemote);
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

    try {
      await makeDirectory(destination);
    } catch (error) {
      if (error instanceof Error && "code" in error && (error.code === "EEXIST" || error.code === "FileExists")) {
        throw new Error(`A file or folder named "${name}" already exists in the projects directory.`);
      }
      throw error;
    }
    created = true;
    await api.commands.executeCommand("vscode.openFolder", destination);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const message = created ? "Project created, but VS Code could not open it." : "Could not create project.";
    void api.window.showErrorMessage(`${message} ${detail}`);
  }
}
