import * as assert from "node:assert/strict";
import * as vscode from "vscode";
import { DashboardPanel } from "../dashboardPanel";
import { Startup, welcomeBackupKey } from "../startup";
import { shouldOpenAtStartup } from "../startupPolicy";
import { isDashboardMessage } from "../webviewMessages";

function fixture(initial?: string) {
  const state = new Map<string, unknown>();
  const writes: [string, unknown, unknown][] = [];
  const choices = { offer: false, enable: false, restore: undefined as "restore" | "keep" | undefined,
    beforeRestore: undefined as (() => void) | undefined };
  const calls = { offer: 0, enable: 0, restore: [] as boolean[] };
  const config: { native?: string; workspace?: string; mode: unknown; fail?: string } = { native: initial, mode: "never" };
  const update = async (key: string, value: unknown, target?: vscode.ConfigurationTarget | boolean | null) => {
    if (key === config.fail) {
      throw new Error("Configuration write failed");
    }
    assert.equal(target, vscode.ConfigurationTarget.Global);
    writes.push([key, value, target]);
    if (key === "startupEditor") {
      config.native = value as string | undefined;
    } else {
      config.mode = value;
    }
  };
  const memento = {
    get: <T>(key: string, fallback?: T) => (state.get(key) ?? fallback) as T,
    update: async (key: string, value: unknown) => { state.set(key, value); },
  };
  let nativeListener: (() => void) | undefined;
  const api = {
    watchNative: (changed: () => void) => {
      nativeListener = changed;
      return { dispose: () => { nativeListener = undefined; } };
    },
    workbench: () => ({
      get: <T>() => (config.workspace ?? config.native ?? "welcomePage") as T,
      inspect: <T>() => ({ key: "workbench.startupEditor", globalValue: config.native as T | undefined,
        workspaceValue: config.workspace as T | undefined, defaultValue: "welcomePage" as T }),
      update,
    }),
    softStart: () => ({ get: <T>() => config.mode as T, update }),
    offer: async () => { calls.offer++; return choices.offer; },
    confirmEnable: async () => { calls.enable++; return choices.enable; },
    confirmRestore: async (changed: boolean) => { calls.restore.push(changed); choices.beforeRestore?.(); return choices.restore; },
  };
  const create = (scope = "local") => new Startup(memento, scope, api);
  return { create, state, writes, choices, calls, config, startup: create(),
    notifyNative: () => nativeListener?.(), watchingNative: () => nativeListener !== undefined };
}

const blank = { hasWorkspaceFile: false, folderCount: 0, hasTabs: false };

suite("Soft Start startup lifecycle", () => {
  test("offers onboarding once across activations and dismissal leaves preferences alone", async () => {
    const f = fixture();
    await f.startup.onboard();
    await f.create().onboard();
    assert.equal(f.calls.offer, 1);
    assert.deepEqual(f.writes, []);
    assert.equal(f.startup.shouldOpen(blank), false);
  });

  test("accepting onboarding saves the original user value before opting into empty windows", async () => {
    const f = fixture("readme");
    f.choices.offer = true;
    await f.startup.onboard();
    assert.deepEqual(f.state.get(welcomeBackupKey), { scope: "local", previous: "readme" });
    assert.equal(f.config.native, "none");
    assert.equal(f.config.mode, "emptyWindow");
    assert.equal(f.calls.enable, 0);
    assert.equal(f.create().shouldOpen(blank), true);
    assert.equal(f.create().welcomeState(), "active");
  });

  test("manual replacement requires confirmation and restores an inherited startup preference by removal", async () => {
    const f = fixture();
    assert.equal(await f.startup.enable(), undefined);
    assert.deepEqual(f.writes, []);
    f.choices.enable = true;
    await f.startup.enable();
    assert.deepEqual(f.state.get(welcomeBackupKey), { scope: "local", previous: null });
    f.choices.restore = "restore";
    await f.startup.restore();
    assert.equal(f.config.native, undefined);
    assert.equal(f.config.mode, "never");
    assert.equal(f.startup.welcomeState(), "available");
  });

  test("restores an explicit user value at Global scope and preserves workspace overrides", async () => {
    const f = fixture("readme");
    f.choices.enable = true;
    f.choices.restore = "restore";
    f.config.workspace = "newUntitledFile";
    assert.match(await f.startup.enable() ?? "", /workspace or policy/);
    assert.equal(f.startup.shouldOpen(blank), false);
    await f.startup.restore();
    assert.equal(f.config.workspace, "newUntitledFile");
    assert.equal(f.config.native, "readme");
    assert.deepEqual(f.writes.map(([key, value]) => [key, value]), [
      ["startupEditor", "none"], ["startupBehavior", "emptyWindow"],
      ["startupBehavior", "never"], ["startupEditor", "readme"],
    ]);
  });

  test("never overwrites an external preference on startup and offers to keep it on restore", async () => {
    const f = fixture("readme");
    f.choices.offer = true;
    await f.startup.onboard();
    f.config.native = "terminal";
    assert.equal(f.create().welcomeState(), "changed");
    await f.create().onboard();
    assert.equal(f.create().shouldOpen(blank), false);
    assert.equal(await f.startup.restore(), undefined);
    assert.equal(f.config.mode, "emptyWindow");
    assert.equal(f.config.native, "terminal");
    f.choices.restore = "keep";
    await f.startup.restore();
    assert.deepEqual(f.calls.restore, [true, true]);
    assert.equal(f.config.native, "terminal");
    assert.equal(f.config.mode, "never");
  });

  test("restores the saved value over a newer native preference only after explicit confirmation", async () => {
    const f = fixture("readme");
    await f.startup.enable(true);
    f.config.native = "terminal";
    f.choices.restore = "restore";
    await f.startup.restore();
    assert.deepEqual(f.calls.restore, [true]);
    assert.equal(f.config.native, "readme");
  });

  test("keeps backup restoration in the original local or remote environment", async () => {
    const f = fixture("welcomePage");
    const wsl = f.create("wsl:Ubuntu");
    await wsl.enable(true);
    assert.equal(f.create("wsl:Debian").welcomeState(), "otherHost");
    assert.equal(f.startup.welcomeState(), "otherHost");
    await assert.rejects(f.startup.restore(), /original VS Code host/);
    assert.equal(f.config.native, "none");
    f.choices.restore = "restore";
    assert.match(await wsl.restore() ?? "", /manual restoration/);
    assert.equal(f.config.native, "none");
    assert.equal(f.config.mode, "never");
    assert.deepEqual(f.state.get(welcomeBackupKey), { scope: "wsl:Ubuntu", previous: "welcomePage" });
  });

  test("retains the backup and does not write either native layer after WSL overrides are added or removed", async () => {
    for (const { user, remoteBefore, change } of [
      { user: "readme", remoteBefore: undefined, change: "add" },
      { user: "none", remoteBefore: "readme", change: "remove" },
      { user: "welcomePage", remoteBefore: undefined, change: "add identical" },
    ]) {
      const f = fixture();
      let local = user;
      let remote = remoteBefore;
      const state = {
        get: <T>(key: string) => f.state.get(key) as T,
        update: async (key: string, value: unknown) => { f.state.set(key, value); },
      };
      const native = {
        get: <T>() => (remote ?? local) as T,
        inspect: <T>() => ({ key: "startupEditor", globalValue: (remote ?? local) as T }),
        update: async (_key: string, value: unknown) => {
          if (remote === undefined) {
            local = value as string;
          } else {
            remote = value as string;
          }
        },
      };
      const remoteStartup = new Startup(state, "wsl:Ubuntu", {
        workbench: () => native,
        softStart: () => ({
          get: <T>() => f.config.mode as T,
          update: async (_key, value) => { f.config.mode = value; },
        }),
        offer: async () => true, confirmEnable: async () => true,
        confirmRestore: async () => assert.fail("Remote restoration must use manual guidance"),
      });
      await remoteStartup.enable();
      remote = change === "remove" ? undefined : change === "add identical" ? "none" : "terminal";
      const previous = [local, remote];
      assert.match(remoteStartup.welcomeRestoreGuidance() ?? "", /User and Remote/);
      await remoteStartup.restore();
      assert.deepEqual([local, remote], previous);
      assert.equal(f.config.mode, "never");
      assert.deepEqual(f.state.get(welcomeBackupKey), { scope: "wsl:Ubuntu", previous: remoteBefore ?? user });
    }
  });

  test("aborts native restoration if the setting changes during confirmation", async () => {
    const f = fixture("readme");
    await f.startup.enable(true);
    f.choices.restore = "restore";
    f.choices.beforeRestore = () => { f.config.native = "terminal"; };
    await assert.rejects(f.startup.restore(), /changed during confirmation/);
    assert.equal(f.config.native, "terminal");
    assert.ok(f.state.get(welcomeBackupKey));
  });

  test("observes native edits even if the value returns to its earlier value during confirmation", async () => {
    const f = fixture("readme");
    await f.startup.enable(true);
    f.choices.restore = "restore";
    f.choices.beforeRestore = () => {
      f.config.native = "terminal";
      f.notifyNative();
      f.config.native = "none";
    };
    await assert.rejects(f.startup.restore(), /changed during confirmation/);
    assert.equal(f.watchingNative(), false);
    assert.equal(f.config.native, "none");
    assert.deepEqual(f.state.get(welcomeBackupKey), { scope: "local", previous: "readme" });
  });

  test("re-enabling in WSL retains the original restoration backup", async () => {
    const f = fixture("readme");
    const remote = f.create("wsl:Ubuntu");
    await remote.enable(true);
    await remote.restore();
    f.config.native = "terminal";
    await remote.enable(true);
    assert.equal(f.config.native, "none");
    assert.equal(f.config.mode, "emptyWindow");
    assert.deepEqual(f.state.get(welcomeBackupKey), { scope: "wsl:Ubuntu", previous: "readme" });
  });

  test("keeps the backup when enabling in WSL fails after changing the native setting", async () => {
    const f = fixture("welcomePage");
    f.config.fail = "startupBehavior";
    await assert.rejects(f.create("wsl:Ubuntu").enable(true), /manual restoration/);
    assert.equal(f.config.native, "none");
    assert.deepEqual(f.state.get(welcomeBackupKey), { scope: "wsl:Ubuntu", previous: "welcomePage" });
  });

  test("rolls back a partial opt-in if saving the startup mode fails", async () => {
    const f = fixture("welcomePage");
    f.config.fail = "startupBehavior";
    await assert.rejects(f.startup.enable(true), /Configuration write failed/);
    assert.equal(f.config.native, "welcomePage");
    assert.equal(f.config.mode, "never");
    assert.equal(f.state.get(welcomeBackupKey), undefined);
  });

  test("keeps the backup if native restoration fails and disables auto-opening", async () => {
    const f = fixture();
    await f.startup.enable(true);
    f.choices.restore = "restore";
    f.config.fail = "startupEditor";
    await assert.rejects(f.startup.restore(), /Configuration write failed/);
    assert.equal(f.config.mode, "never");
    assert.equal(f.config.native, "none");
    assert.ok(f.state.get(welcomeBackupKey));
  });

  test("uses all startup modes and skips native startup editors and invalid configurations", () => {
    const samples = [
      [blank, true],
      [{ ...blank, folderCount: 1 }, false],
      [{ ...blank, folderCount: 2, hasWorkspaceFile: true }, false],
      [{ ...blank, hasWorkspaceFile: true }, false],
      [{ ...blank, hasTabs: true }, false],
    ] as const;
    for (const [window, empty] of samples) {
      assert.equal(shouldOpenAtStartup("emptyWindow", "none", window), empty);
      assert.equal(shouldOpenAtStartup("always", "none", window), true);
      assert.equal(shouldOpenAtStartup("never", "none", window), false);
      assert.equal(shouldOpenAtStartup("automatic", "none", window), false);
      assert.equal(shouldOpenAtStartup("always", "welcomePage", window), false);
    }
    assert.equal(isDashboardMessage({ type: "saveSettings", requestId: "invalid", expected: { startupBehavior: "never" }, changes: { startupBehavior: "automatic" } }), false);
  });

  test("opens at most once, reuses the dashboard and keeps manual opening after it closes", () => {
    let reveals = 0;
    const created: { preserveFocus: boolean; reveal: () => void }[] = [];
    const dashboard = new DashboardPanel((preserveFocus) => {
      const panel = { preserveFocus, reveal: () => { reveals++; } };
      created.push(panel);
      return panel;
    });
    dashboard.openAtStartup(() => true, true);
    dashboard.open();
    assert.equal(reveals, 1);
    assert.deepEqual(created.map(({ preserveFocus }) => preserveFocus), [true]);
    dashboard.closed(created[0]);
    dashboard.openAtStartup(() => true, true);
    assert.equal(created.length, 1);
    dashboard.open();
    assert.deepEqual(created.map(({ preserveFocus }) => preserveFocus), [true, false]);
  });

  test("a failed or bypassed startup does not retry automatically and manual opening still works", () => {
    let attempts = 0;
    const dashboard = new DashboardPanel(() => {
      if (++attempts === 1) {
        throw new Error("Panel unavailable");
      }
      return { reveal: () => {} };
    });
    assert.throws(() => dashboard.openAtStartup(() => true, false), /Panel unavailable/);
    dashboard.openAtStartup(() => true, false);
    assert.equal(attempts, 1);
    dashboard.open();
    assert.equal(attempts, 2);
    const manual = new DashboardPanel(() => ({ reveal: () => { attempts++; } }));
    manual.open();
    manual.openAtStartup(() => assert.fail("Manual opening already consumed startup"), false);
    assert.equal(attempts, 2);
  });
});
