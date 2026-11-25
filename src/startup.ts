import { hostname } from "node:os";
import * as vscode from "vscode";
import { shouldOpenAtStartup, type StartupBehavior, type WelcomeState } from "./startupPolicy";

export const welcomeBackupKey = "welcomeReplacement.v1";
const onboardingKey = "startupOnboarding.v1";
const nativeKey = "startupEditor";

type Backup = { scope: string; previous: string | null };
type State = Pick<vscode.Memento, "get" | "update">;
type Configuration = Pick<vscode.WorkspaceConfiguration, "get" | "inspect" | "update">;
type StartupApi = {
  workbench: () => Configuration;
  softStart: () => Pick<Configuration, "get" | "update">;
  offer: () => Thenable<boolean>;
  confirmEnable: () => Thenable<boolean>;
  confirmRestore: (changed: boolean) => Thenable<"restore" | "keep" | undefined>;
  watchNative?: (changed: () => void) => vscode.Disposable;
};

const enableLabel = "Set as startup page";
const enableDetail = "This disables the native startup editor in VS Code’s user settings. Soft Start will open in empty windows with no restored editor tabs.";

const vscodeStartupApi: StartupApi = {
  workbench: () => vscode.workspace.getConfiguration("workbench", null),
  softStart: () => vscode.workspace.getConfiguration("softStart"),
  watchNative: (changed) => vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration("workbench.startupEditor")) {
      changed();
    }
  }),
  offer: async () => await vscode.window.showInformationMessage(
    `Set Soft Start as your startup page? ${enableDetail}`, enableLabel, "Not now",
  ) === enableLabel,
  confirmEnable: async () => await vscode.window.showWarningMessage(
    "Set Soft Start as your startup page?", { modal: true, detail: enableDetail }, enableLabel,
  ) === enableLabel,
  confirmRestore: async (changed) => {
    const restore = "Restore original";
    const keep = "Keep current setting";
    const selection = await vscode.window.showWarningMessage(
      "Restore the original VS Code startup page?",
      {
        modal: true,
        detail: changed
          ? "Your VS Code startup preference has changed since Soft Start took over. Choose whether to restore the saved preference or keep your current preference. Both choices turn off Soft Start’s automatic opening."
          : "Soft Start will restore the previous VS Code user preference and turn off automatic opening.",
      },
      ...(changed ? [keep, restore] : [restore]),
    );
    return selection === restore ? "restore" : selection === keep ? "keep" : undefined;
  },
};

export function startupScope(context: Pick<vscode.ExtensionContext, "globalStorageUri">): string {
  const remote = vscode.env.remoteName;
  return remote
    ? JSON.stringify([remote, process.env.WSL_DISTRO_NAME ?? hostname(), context.globalStorageUri.toString()])
    : "local";
}

export class Startup {
  private updating = false;

  constructor(
    private readonly state: State,
    private readonly scope: string,
    private readonly api: StartupApi = vscodeStartupApi,
  ) {}

  private backup(): Backup | undefined {
    const value = this.state.get<unknown>(welcomeBackupKey);
    if (typeof value === "object" && value !== null && "scope" in value && typeof value.scope === "string" &&
        "previous" in value && (value.previous === null || typeof value.previous === "string")) {
      return { scope: value.scope, previous: value.previous };
    }
  }

  private nativePreference() {
    const config = this.api.workbench();
    const inspection = config.inspect<unknown>(nativeKey);
    if (!inspection || (inspection.globalValue !== undefined && typeof inspection.globalValue !== "string")) {
      throw new Error("Soft Start could not read the VS Code Startup Editor user preference.");
    }
    return {
      user: inspection.globalValue,
      fingerprint: JSON.stringify([inspection.globalValue, inspection.defaultValue,
        inspection.workspaceValue, inspection.workspaceFolderValue, config.get(nativeKey)]),
    };
  }

  welcomeRestoreGuidance(): string | undefined {
    const backup = this.backup();
    if (!backup || backup.scope === "local" || backup.scope !== this.scope) {
      return;
    }
    const previous = backup.previous === null
      ? "No explicit user value was visible before opt-in."
      : `Before opt-in, VS Code reported "${backup.previous}" as the user value.`;
    return `The User and Remote settings layers cannot be distinguished safely. ${previous} Open VS Code Settings, search for Workbench: Startup Editor, and compare the User and Remote tabs. Restore or reset only the setting you can identify as the original target, and keep any newer preference you want to retain.`;
  }

  private writeNative(value: string | undefined) {
    return this.api.workbench().update(nativeKey, value, vscode.ConfigurationTarget.Global);
  }

  private writeMode(mode: StartupBehavior) {
    return this.api.softStart().update("startupBehavior", mode, vscode.ConfigurationTarget.Global);
  }

  welcomeState(): WelcomeState {
    const backup = this.backup();
    if (!backup) {
      return "available";
    }
    if (backup.scope !== this.scope) {
      return "otherHost";
    }
    try {
      return this.nativePreference().user === "none" && this.api.workbench().get(nativeKey) === "none" ? "active" : "changed";
    } catch {
      return "changed";
    }
  }

  shouldOpen(window: Parameters<typeof shouldOpenAtStartup>[2]): boolean {
    return shouldOpenAtStartup(this.api.softStart().get("startupBehavior"), this.api.workbench().get(nativeKey), window);
  }

  async onboard(): Promise<void> {
    if (this.state.get(onboardingKey) || this.backup()) {
      return;
    }
    await this.state.update(onboardingKey, true);
    if (await this.api.offer() && !this.backup()) {
      await this.enable(true);
    }
  }

  async enable(confirmed = false): Promise<string | undefined> {
    return this.change(async () => {
      const backup = this.backup();
      if (backup && backup.scope !== this.scope) {
        throw new Error("Restore the startup preference from the original VS Code host before replacing it here.");
      }
      if (!confirmed && !await this.api.confirmEnable()) {
        return;
      }
      const before = this.nativePreference();
      const previous = before.user;
      if (!backup) {
        await this.state.update(welcomeBackupKey, { scope: this.scope, previous: previous ?? null } satisfies Backup);
      }
      let attemptedNative = false;
      try {
        if (this.nativePreference().fingerprint !== before.fingerprint) {
          throw new Error("VS Code’s startup preference changed during setup. Review it and try again.");
        }
        if (previous !== "none") {
          attemptedNative = true;
          await this.writeNative("none");
        }
        await this.writeMode("emptyWindow");
      } catch (error) {
        if (attemptedNative && this.scope !== "local") {
          throw new Error("Automatic startup could not be enabled. The previous VS Code preference is saved for manual restoration.", { cause: error });
        }
        if (attemptedNative && this.nativePreference().user === "none") {
          await this.writeNative(previous);
        }
        await this.state.update(welcomeBackupKey, backup);
        throw error;
      }
      return this.api.workbench().get(nativeKey) === "none"
        ? "Soft Start is set as the startup page."
        : "Startup preference saved. A workspace or policy setting still overrides the startup editor in this window.";
    });
  }

  async restore(): Promise<string | undefined> {
    return this.change(async () => {
      const backup = this.backup();
      if (!backup || backup.scope !== this.scope) {
        throw new Error("Open the original VS Code host to restore its saved startup preference.");
      }
      const guidance = this.welcomeRestoreGuidance();
      if (guidance) {
        // Global resolves through VS Code's current user layer. A merged value cannot prove
        // that it still points to the layer written during opt-in, even if it is unchanged.
        await this.writeMode("never");
        return "Soft Start automatic startup disabled. Follow the manual restoration instructions in Startup.";
      }

      const before = this.nativePreference();
      let changed = false;
      const watcher = this.api.watchNative?.(() => { changed = true; });
      try {
        const choice = await this.api.confirmRestore(before.user !== "none");
        if (!choice) {
          return;
        }
        const requireUnchanged = () => {
          const latestBackup = this.backup();
          if (changed || this.nativePreference().fingerprint !== before.fingerprint ||
              latestBackup?.scope !== backup.scope || latestBackup.previous !== backup.previous) {
            throw new Error("VS Code’s startup preference changed during confirmation. Review it and try again.");
          }
        };
        if (choice === "restore") {
          requireUnchanged();
        }
        await this.writeMode("never");
        if (choice === "restore") {
          requireUnchanged();
          await this.writeNative(backup.previous ?? undefined);
        }
        await this.state.update(welcomeBackupKey, undefined);
        return choice === "restore" ? "Original VS Code startup preference restored." : "Current VS Code startup preference kept.";
      } finally {
        watcher?.dispose();
      }
    });
  }

  private async change(action: () => Promise<string | undefined>): Promise<string | undefined> {
    if (this.updating) {
      throw new Error("A startup preference change is already running.");
    }
    this.updating = true;
    try {
      return await action();
    } finally {
      this.updating = false;
    }
  }
}
