import { PinnedProjects, RecentProjects } from "./legacyProjectFixtures";
import * as assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as vscode from "vscode";
import { defaultSettings, settingKeys, visibleRecentProjects } from "../dashboardSettings";
import { pinnedProjectsKey } from "../pinnedProjects";
import { projectsDirectoryPath, projectsDirectoryUri } from "../projectsDirectory";
import { recentProjectsKey } from "../recentProjects";
import { browseProjectsDirectory, onSettingsChanged, SettingsConfiguration } from "../settingsConfiguration";
import { SettingsWebview } from "../settingsWebview";
import { isDashboardMessage, isSettingsMessage, type SettingsMessage } from "../webviewMessages";

function fixture() {
  const values = new Map<string, unknown>();
  const updates: string[] = [];
  let failedKey: string | undefined;
  const configuration = {
    get: <T>(key: string) => values.get(key) as T | undefined,
    update: async (key: string, value: unknown, target?: vscode.ConfigurationTarget | boolean | null) => {
      assert.equal(target, vscode.ConfigurationTarget.Global);
      if (key === failedKey) {
        throw new Error("Write failed");
      }
      updates.push(key);
      if (value === undefined) {
        values.delete(key);
      } else {
        values.set(key, value);
      }
    },
  };
  return { values, updates, configuration, settings: new SettingsConfiguration(() => configuration),
    failOn: (key: string) => { failedKey = key; } };
}

suite("Dashboard settings", () => {
  test("uses the declared defaults when settings are absent and falls back for invalid external values", () => {
    const { settings, values } = fixture();
    const manifest = JSON.parse(readFileSync(join(__dirname, "../../package.json"), "utf8"));
    for (const key of settingKeys) {
      assert.equal(manifest.contributes.configuration.properties[`softStart.${key}`].default, defaultSettings[key]);
      values.set(key, null);
    }
    assert.deepEqual(settings.read(), defaultSettings);
  });

  test("persists valid settings to the VS Code user configuration", async () => {
    const { settings, configuration, updates } = fixture();
    const changes = {
      backgroundColor: "#ffffff", accentColor: "#131b2a", panelOpacity: 0, artworkVisible: false,
      artworkOpacity: 100, welcomeMessage: "<b>hello</b>", headerKaomoji: "hello",
      decorativeSymbols: false, recentProjectsLimit: 10, projectsDirectory: process.cwd(), startupBehavior: "always" as const,
    };
    await settings.update(changes);
    assert.deepEqual(new SettingsConfiguration(() => configuration).read(), changes);
    assert.equal(updates.length, settingKeys.length);
    await settings.update({ projectsDirectory: "" });
    assert.equal(settings.read().projectsDirectory, "");
  });

  test("rejects invalid colors, ranges, and relative paths before writing any field", async () => {
    const { settings, updates } = fixture();
    for (const changes of [
      { backgroundColor: "red" }, { accentColor: "#abcdef; color:red" }, { panelOpacity: 100.1 },
      { artworkOpacity: -1 }, { artworkOpacity: NaN }, { recentProjectsLimit: 0 },
      { recentProjectsLimit: 11 }, { projectsDirectory: "../relative" },
    ]) {
      await assert.rejects(settings.update({ welcomeMessage: "Changed", ...changes }), /Invalid dashboard settings|absolute directory path/);
    }
    assert.deepEqual(updates, []);
  });

  test("validates settings requests and full host snapshots", () => {
    for (const type of ["requestSettings", "restoreSettings", "browseProjectsDirectory"]) {
      assert.equal(isDashboardMessage({ type }), true);
    }
    assert.equal(isDashboardMessage({ type: "saveSettings", changes: { recentProjectsLimit: 6 } }), true);
    for (const changes of [null, [], {}, { command: "vscode.openFolder" }, { artworkVisible: "true" },
      { welcomeMessage: "a".repeat(161) }, { headerKaomoji: "a\nb" }, { panelOpacity: "80" }]) {
      assert.equal(isDashboardMessage({ type: "saveSettings", changes }), false);
    }
    assert.equal(isSettingsMessage({ type: "settings", settings: defaultSettings }), true);
    assert.equal(isSettingsMessage({ type: "settingsResult", settings: defaultSettings, error: "Failed" }), true);
    assert.equal(isSettingsMessage({ type: "settings", settings: { welcomeMessage: "Only one key" } }), false);
  });

  test("reacts to external Soft Start configuration changes and ignores unrelated changes", () => {
    const { settings, values } = fixture();
    const events = new vscode.EventEmitter<vscode.ConfigurationChangeEvent>();
    const snapshots: string[] = [];
    const listener = onSettingsChanged(() => snapshots.push(settings.read().welcomeMessage), events.event);
    try {
      values.set("welcomeMessage", "Native edit");
      events.fire({ affectsConfiguration: (section) => section === "editor" });
      events.fire({ affectsConfiguration: (section) => section === "softStart" });
      assert.deepEqual(snapshots, ["Native edit"]);
    } finally {
      listener.dispose();
      events.dispose();
    }
  });

  test("uses real VS Code configuration for persistence and external notifications", async () => {
    const config = () => vscode.workspace.getConfiguration("softStart");
    const oldLimit = config().inspect<number>("recentProjectsLimit")?.globalValue;
    const newLimit = oldLimit === 10 ? 9 : 10;
    const service = new SettingsConfiguration();
    const observed: number[] = [];
    const listener = onSettingsChanged(() => observed.push(service.read().recentProjectsLimit));
    try {
      await service.update({ recentProjectsLimit: newLimit });
      assert.equal(new SettingsConfiguration().read().recentProjectsLimit, newLimit);
      assert.equal(config().inspect<number>("recentProjectsLimit")?.globalValue, newLimit);
      await config().update("recentProjectsLimit", 1, vscode.ConfigurationTarget.Global);
      assert.ok(observed.includes(1));
      assert.equal(service.read().recentProjectsLimit, 1);
    } finally {
      listener.dispose();
      await config().update("recentProjectsLimit", oldLimit, vscode.ConfigurationTarget.Global);
    }
  });

  test("exchanges validated settings messages across startup, retry, save, reopen and external updates", async () => {
    const { settings, values } = fixture();
    const errors: unknown[] = [];
    const replies: SettingsMessage[] = [];
    let failRead = true;
    const host = new SettingsWebview({
      read: () => {
        if (failRead) {
          throw new Error("Configuration unavailable");
        }
        return settings.read();
      },
      update: (changes) => settings.update(changes),
      restoreDefaults: () => settings.restoreDefaults(async () => true),
    }, async () => undefined, (error) => errors.push(error));
    const webview = {
      postMessage: async (message: unknown) => {
        const wire: unknown = JSON.parse(JSON.stringify(message));
        assert.ok(isSettingsMessage(wire));
        replies.push(wire);
        return true;
      },
    };
    const send = async (request: unknown) => {
      const wire: unknown = JSON.parse(JSON.stringify(request));
      assert.ok(isDashboardMessage(wire));
      assert.ok(wire.type === "requestSettings" || wire.type === "saveSettings");
      await host.handle(wire, webview);
      return replies.at(-1);
    };

    assert.deepEqual(await send({ type: "requestSettings" }),
      { type: "settingsLoadError", error: "Configuration unavailable" });
    assert.equal(errors.length, 1);
    failRead = false;
    assert.deepEqual(await send({ type: "requestSettings" }), { type: "settings", settings: defaultSettings });

    const edited = { ...defaultSettings, backgroundColor: "#131b2a" };
    assert.deepEqual(await send({ type: "saveSettings", changes: { backgroundColor: edited.backgroundColor } }),
      { type: "settingsResult", settings: edited, status: "Settings saved." });
    assert.deepEqual(await send({ type: "requestSettings" }), { type: "settings", settings: edited });

    values.set("welcomeMessage", "External change");
    await host.publish(webview);
    assert.deepEqual(replies.at(-1), { type: "settings", settings: { ...edited, welcomeMessage: "External change" } });
  });

  test("confirms Restore Defaults and keeps the directory and project stores", async () => {
    const { settings, values } = fixture();
    const state: Pick<vscode.Memento, "get" | "update"> = {
      get: <T>(key: string, fallback?: T) => (values.get(key) ?? fallback) as T,
      update: async (key, value) => { values.set(key, value); },
    };
    const history = new RecentProjects(state);
    const pinned = new PinnedProjects(state);
    const project = { uri: vscode.Uri.file(process.cwd()), name: "Test project", kind: "folder" as const };
    await history.record(project);
    await pinned.pin(project);
    await settings.update({ welcomeMessage: "Changed", projectsDirectory: process.cwd(), startupBehavior: "always" });
    values.set("editor.fontSize", 16);
    assert.equal(await settings.restoreDefaults(async () => false), false);
    assert.equal(settings.read().welcomeMessage, "Changed");

    const recentBefore = values.get(recentProjectsKey);
    const pinnedBefore = values.get(pinnedProjectsKey);
    assert.equal(await settings.restoreDefaults(async () => true), true);
    assert.deepEqual(settings.read(), { ...defaultSettings, projectsDirectory: process.cwd(), startupBehavior: "always" });
    assert.equal(values.get(recentProjectsKey), recentBefore);
    assert.equal(values.get(pinnedProjectsKey), pinnedBefore);
    assert.equal(values.get("editor.fontSize"), 16);
  });

  test("returns the last saved state after a rejected write, including earlier successful fields", async () => {
    const { settings, failOn } = fixture();
    await settings.update({ accentColor: "#abcdef" });
    failOn("accentColor");
    await assert.rejects(settings.update({ backgroundColor: "#ffffff", accentColor: "#123456" }), /Write failed/);
    assert.equal(settings.read().accentColor, "#abcdef");
    assert.equal(settings.read().backgroundColor, "#ffffff");
  });

  test("cancels directory browsing without returning a value", async () => {
    assert.equal(await browseProjectsDirectory(async (options) => {
      assert.equal(options?.canSelectFolders, true);
      assert.equal(options?.canSelectFiles, false);
      return undefined;
    }), undefined);
  });

  test("round-trips the projects directory on a WSL host and rejects a different authority", () => {
    const remote = vscode.Uri.parse("vscode-remote://wsl+Ubuntu/home/me/projects%20folder");
    const path = projectsDirectoryPath(remote, remote, "wsl");
    assert.equal(projectsDirectoryUri(path, remote).authority, "wsl+Ubuntu");
    assert.equal(projectsDirectoryUri(path, remote).path, remote.path);
    assert.throws(() => projectsDirectoryPath(remote, undefined, "wsl"), /active VS Code host/);
    assert.throws(() => projectsDirectoryPath(remote.with({ authority: "wsl+Debian" }), remote, "wsl"), /active VS Code host/);
  });

  test("limits visible rows without truncating project history", () => {
    const projects = Array.from({ length: 50 }, (_, i) => i);
    for (const size of [1, 4, 10]) {
      assert.deepEqual(visibleRecentProjects(projects, size), projects.slice(0, size));
    }
    assert.equal(visibleRecentProjects(projects, 11).length, 4);
    assert.equal(projects.length, 50);
  });
});
