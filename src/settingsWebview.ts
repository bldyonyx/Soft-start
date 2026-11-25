import type { Startup } from "./startup";
import type * as vscode from "vscode";
import type { SettingsMessage, SettingsOutcome, SettingsRequest, SettingsWriteReport } from "./webviewMessages";
import { browseProjectsDirectory, SettingsConfiguration, SettingsValidationError } from "./settingsConfiguration";

type Webview = Pick<vscode.Webview, "postMessage">;

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function writeOutcome(requestId: string, writes: SettingsWriteReport, detail: string): SettingsOutcome {
  const rejected = Object.keys(writes.rejected).length;
  return {
    requestId,
    writes,
    outcome: rejected ? (writes.applied.length ? "partial" : "rejected") : "success",
    detail: rejected ? `${writes.applied.length} saved, ${rejected} not saved.` : detail,
  };
}

export class SettingsWebview {
  private active?: string;
  private revision = 0;
  private readonly results = new WeakMap<Webview, SettingsOutcome>();
  private readonly disposed = new WeakSet<Webview>();

  constructor(
    private readonly configuration: Pick<SettingsConfiguration, "read" | "update" | "restoreDefaults"> = new SettingsConfiguration(),
    private readonly browse = browseProjectsDirectory,
    private readonly reportError = (error: unknown) => console.error("Soft Start could not read dashboard settings.", error),
    private readonly startup?: Pick<Startup, "welcomeState" | "welcomeRestoreGuidance" | "enable" | "restore">,
  ) {}

  dispose(webview: Webview): void {
    this.disposed.add(webview);
    this.results.delete(webview);
  }

  async publish(webview: Webview, result?: SettingsOutcome, recover?: string): Promise<void> {
    if (this.disposed.has(webview)) {
      return;
    }
    const revision = ++this.revision;
    let message: SettingsMessage;
    try {
      const snapshot = {
        revision,
        settings: this.configuration.read(),
        welcome: this.startup?.welcomeState(),
        welcomeGuidance: this.startup?.welcomeRestoreGuidance(),
        busy: this.active !== undefined,
      };
      message = result ? { type: "settingsResult", ...snapshot, ...result } : { type: "settings", ...snapshot, recover };
    } catch (error) {
      this.reportError(error);
      message = { type: "settingsLoadError", revision, error: describeError(error) };
    }
    await webview.postMessage(message);
  }

  async handle(message: SettingsRequest, webview: Webview): Promise<void> {
    if (this.disposed.has(webview)) {
      return;
    }
    if (message.type === "requestSettings") {
      const completed = this.results.get(webview);
      await this.publish(webview, completed?.requestId === message.recover ? completed : undefined, message.recover);
      return;
    }
    const { requestId } = message;
    const completed = this.results.get(webview);
    if (completed?.requestId === requestId) {
      await this.publish(webview, completed);
      return;
    }
    if (this.active) {
      if (this.active !== requestId) {
        await this.publish(webview, { requestId, outcome: "rejected", detail: "Another settings action is running. Check saved settings before trying again." });
      }
      return;
    }
    this.active = requestId;
    let result: SettingsOutcome = { requestId, outcome: "cancelled" };
    try {
      switch (message.type) {
        case "saveSettings":
          result = writeOutcome(requestId, await this.configuration.update(message.changes, message.expected), "Settings saved.");
          break;
        case "restoreSettings": {
          const writes = await this.configuration.restoreDefaults();
          if (writes) {
            result = writeOutcome(requestId, writes, "Defaults restored.");
          }
          break;
        }
        case "browseProjectsDirectory": {
          const directory = await this.browse();
          if (directory !== undefined) {
            result = { requestId, outcome: "success", directory };
          }
          break;
        }
        case "enableWelcomeReplacement":
        case "restoreWelcomeReplacement": {
          const detail = await (message.type === "enableWelcomeReplacement" ? this.startup?.enable() : this.startup?.restore());
          if (detail) {
            result = { requestId, outcome: "success", detail };
          }
          break;
        }
      }
    } catch (error) {
      result = error instanceof SettingsValidationError
        ? { requestId, outcome: "rejected", detail: "Nothing was saved. Correct the invalid setting and save again.",
          writes: { applied: [], rejected: { [error.key]: error.message } } }
        : { requestId, outcome: "rejected", detail: describeError(error) };
    } finally {
      this.active = undefined;
    }
    if (!this.disposed.has(webview)) {
      this.results.set(webview, result);
      await this.publish(webview, result);
    }
  }
}
