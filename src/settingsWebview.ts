import type { Startup } from "./startup";
import type * as vscode from "vscode";
import type { SettingsMessage, SettingsRequest } from "./webviewMessages";
import { browseProjectsDirectory, SettingsConfiguration } from "./settingsConfiguration";

type Webview = Pick<vscode.Webview, "postMessage">;
type Result = Omit<Extract<SettingsMessage, { type: "settingsResult" }>, "type" | "settings" | "welcome">;

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class SettingsWebview {
  private inProgress = false;

  constructor(
    private readonly configuration: Pick<SettingsConfiguration, "read" | "update" | "restoreDefaults"> = new SettingsConfiguration(),
    private readonly browse = browseProjectsDirectory,
    private readonly reportError = (error: unknown) => console.error("Soft Start could not read dashboard settings.", error),
    private readonly startup?: Pick<Startup, "welcomeState" | "enable" | "restore">,
  ) {}

  async publish(webview: Webview, result?: Result): Promise<void> {
    let message: SettingsMessage;
    try {
      const settings = this.configuration.read();
      const welcome = this.startup?.welcomeState();
      message = result ? { type: "settingsResult", settings, ...result } : { type: "settings", settings };
      if (welcome) {
        message.welcome = welcome;
      }
    } catch (error) {
      this.reportError(error);
      message = { type: "settingsLoadError", error: describeError(error) };
    }
    await webview.postMessage(message);
  }

  async handle(message: SettingsRequest, webview: Webview): Promise<void> {
    if (message.type === "requestSettings") {
      await this.publish(webview);
      return;
    }
    if (this.inProgress) {
      await this.publish(webview, { error: "A settings action is already running. Try again." });
      return;
    }
    this.inProgress = true;
    let result: Result = {};
    try {
      if (message.type === "browseProjectsDirectory") {
        result = { directory: await this.browse() };
      } else if (message.type === "saveSettings") {
        await this.configuration.update(message.changes);
        result = { status: "Settings saved." };
      } else if (message.type === "enableWelcomeReplacement") {
        result = { status: await this.startup?.enable() };
      } else if (message.type === "restoreWelcomeReplacement") {
        result = { status: await this.startup?.restore() };
      } else if (await this.configuration.restoreDefaults()) {
        result = { status: "Defaults restored." };
      }
    } catch (error) {
      result = { error: describeError(error) };
    } finally {
      this.inProgress = false;
    }
    await this.publish(webview, result);
  }
}
