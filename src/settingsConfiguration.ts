import * as vscode from "vscode";
import {
  customizationKeys, defaultSettings, isSettingsPatch, isSettingValue, settingKeys, type DashboardSettings, type SettingKey, type SettingsPatch,
} from "./dashboardSettings";
import type { SettingsWriteReport } from "./webviewMessages";
import { pickProjectsDirectory, projectsDirectoryPath, validateProjectsDirectory } from "./projectsDirectory";

const section = "softStart";
type Configuration = Pick<vscode.WorkspaceConfiguration, "get" | "update">;

export class SettingsValidationError extends Error {
  constructor(readonly key: SettingKey, message: string) {
    super(message);
  }
}

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
      startupBehavior: readValue("startupBehavior"),
    };
  }

  async update(changes: unknown, expected?: SettingsPatch): Promise<SettingsWriteReport> {
    if (!isSettingsPatch(changes)) {
      throw new Error("Invalid dashboard settings.");
    }
    if (changes.projectsDirectory !== undefined) {
      try {
        validateProjectsDirectory(changes.projectsDirectory);
      } catch (error) {
        throw new SettingsValidationError("projectsDirectory", error instanceof Error ? error.message : String(error));
      }
    }
    return this.write(settingKeys.filter((key) => Object.hasOwn(changes, key)), changes, expected ?? this.read());
  }

  async restoreDefaults(confirm: () => Thenable<boolean> = confirmRestore): Promise<SettingsWriteReport | undefined> {
    const expected = this.read();
    if (!await confirm()) {
      return;
    }
    return this.write(customizationKeys, {}, expected, true);
  }

  private async write(
    keys: readonly SettingKey[], changes: SettingsPatch, expected: SettingsPatch, reset = false,
  ): Promise<SettingsWriteReport> {
    const report: SettingsWriteReport = { applied: [], rejected: {} };
    for (const key of keys) {
      try {
        const config = this.configuration();
        const value = config.get<unknown>(key);
        const current = isSettingValue(key, value) ? value : defaultSettings[key];
        if (reset || current !== changes[key]) {
          if (current !== expected[key]) {
            throw new Error("Changed in VS Code since this edit was prepared.");
          }
          await config.update(key, reset ? undefined : changes[key], vscode.ConfigurationTarget.Global);
        }
        if (this.read()[key] !== (reset ? defaultSettings[key] : changes[key])) {
          throw new Error("The effective VS Code value differs after the write.");
        }
        report.applied.push(key);
      } catch (error) {
        report.rejected[key] = error instanceof Error ? error.message : String(error);
      }
    }
    return report;
  }

}

async function confirmRestore(): Promise<boolean> {
  const restore = "Restore Defaults";
  return await vscode.window.showWarningMessage(
    "Restore Soft Start’s appearance and dashboard defaults?",
    { modal: true, detail: "The projects directory, recent projects, pinned projects, and startup preferences will be kept." },
    restore,
  ) === restore;
}

export function onSettingsChanged(
  notify: () => void,
  subscribe: typeof vscode.workspace.onDidChangeConfiguration = vscode.workspace.onDidChangeConfiguration,
): vscode.Disposable {
  return subscribe((event) => {
    if (event.affectsConfiguration(section) || event.affectsConfiguration("workbench.startupEditor")) {
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
