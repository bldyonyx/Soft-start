import * as vscode from "vscode";
import {
  customizationKeys, defaultSettings, isSettingsPatch, isSettingValue, settingKeys, type DashboardSettings,
} from "./dashboardSettings";
import { pickProjectsDirectory, projectsDirectoryPath, validateProjectsDirectory } from "./projectsDirectory";

const section = "softStart";
type Configuration = Pick<vscode.WorkspaceConfiguration, "get" | "update">;

export class SettingsConfiguration {
  constructor(private readonly configuration: () => Configuration = () => vscode.workspace.getConfiguration(section)) {}

  read(): DashboardSettings {
    const config = this.configuration();
    const readValue = <K extends keyof DashboardSettings>(key: K): DashboardSettings[K] => {
      const value = config.get<unknown>(key);
      return isSettingValue(key, value) ? value : defaultSettings[key];
    };
    return {
      backgroundColor: readValue("backgroundColor"),
      accentColor: readValue("accentColor"),
      panelOpacity: readValue("panelOpacity"),
      artworkVisible: readValue("artworkVisible"),
      artworkOpacity: readValue("artworkOpacity"),
      welcomeMessage: readValue("welcomeMessage"),
      headerKaomoji: readValue("headerKaomoji"),
      decorativeSymbols: readValue("decorativeSymbols"),
      recentProjectsLimit: readValue("recentProjectsLimit"),
      projectsDirectory: readValue("projectsDirectory"),
    };
  }

  async update(changes: unknown): Promise<void> {
    if (!isSettingsPatch(changes)) {
      throw new Error("Invalid dashboard settings.");
    }
    if (changes.projectsDirectory !== undefined) {
      validateProjectsDirectory(changes.projectsDirectory);
    }
    const config = this.configuration();
    for (const key of settingKeys) {
      if (Object.hasOwn(changes, key)) {
        await config.update(key, changes[key], vscode.ConfigurationTarget.Global);
      }
    }
  }

  async restoreDefaults(confirm: () => Thenable<boolean> = confirmRestore): Promise<boolean> {
    if (!await confirm()) {
      return false;
    }
    const config = this.configuration();
    for (const key of customizationKeys) {
      await config.update(key, undefined, vscode.ConfigurationTarget.Global);
    }
    return true;
  }
}

async function confirmRestore(): Promise<boolean> {
  const restore = "Restore Defaults";
  return await vscode.window.showWarningMessage(
    "Restore Soft Start’s appearance and dashboard defaults?",
    { modal: true, detail: "The projects directory, recent projects, and pinned projects will be kept." },
    restore,
  ) === restore;
}

export function onSettingsChanged(
  notify: () => void,
  subscribe: typeof vscode.workspace.onDidChangeConfiguration = vscode.workspace.onDidChangeConfiguration,
): vscode.Disposable {
  return subscribe((event) => {
    if (event.affectsConfiguration(section)) {
      notify();
    }
  });
}

export async function browseProjectsDirectory(
  picker: typeof vscode.window.showOpenDialog = (options) => vscode.window.showOpenDialog(options),
): Promise<string | undefined> {
  const uri = await pickProjectsDirectory(picker, "Select a projects directory", "Select folder");
  return uri && projectsDirectoryPath(uri);
}
