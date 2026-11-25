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
};

const enableLabel = "Set as startup page";
const enableDetail = "This disables the native startup editor in VS Code’s user settings. Soft Start will open in empty windows with no restored editor tabs.";

const vscodeStartupApi: StartupApi = {
  workbench: () => vscode.workspace.getConfiguration("workbench"),
  softStart: () => vscode.workspace.getConfiguration("softStart"),
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

  private nativeUserValue(): string | undefined {
    const inspection = this.api.workbench().inspect<unknown>(nativeKey);
    if (!inspection || (inspection.globalValue !== undefined && typeof inspection.globalValue !== "string")) {
      throw new Error("Soft Start could not read the VS Code Startup Editor user preference.");
    }
    return inspection.globalValue;
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
    return this.nativeUserValue() === "none" && this.api.workbench().get(nativeKey) === "none" ? "active" : "changed";
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
      const previous = this.nativeUserValue();
      if (!backup || previous !== "none") {
        await this.state.update(welcomeBackupKey, { scope: this.scope, previous: previous ?? null } satisfies Backup);
      }
      try {
        if (previous !== "none") {
          await this.writeNative("none");
        }
        await this.writeMode("emptyWindow");
      } catch (error) {
        // Keep the backup if rollback fails, so the user can still restore the native preference.
        if (previous !== "none" && this.nativeUserValue() === "none") {
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
      const before = this.nativeUserValue();
      const choice = await this.api.confirmRestore(before !== "none");
      if (!choice) {
        return;
      }
      await this.writeMode("never");
      if (choice === "restore") {
        if (this.nativeUserValue() !== before) {
          throw new Error("VS Code’s startup preference changed during confirmation. Review it and try again.");
        }
        await this.writeNative(backup.previous ?? undefined);
      }
      await this.state.update(welcomeBackupKey, undefined);
      return choice === "restore" ? "Original VS Code startup preference restored." : "Current VS Code startup preference kept.";
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
