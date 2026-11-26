import * as assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as vscode from "vscode";
import { cloneProject, ProjectActions } from "../projectActions";
import { projectHostIdentity } from "../projectHost";
import { ProjectJournal } from "../projectJournal";
import { ProjectStore } from "../projectStore";
import { assertProjectOrigin, identifyProject, projectId, serializeUri } from "../projects";
import { addPinnedProject, pinnedProjectsKey, selectProjectLocation } from "../pinnedProjects";
import { recentProjectsKey } from "../recentProjects";

const folder = (name: string, uri = vscode.Uri.file(join(tmpdir(), name))) => ({ uri, name, kind: "folder" as const });
const host = projectHostIdentity(undefined, "local-machine");
const legacy = { get: <T>(_key: string) => undefined as T | undefined };

suite("Project origins and journal", () => {
  let path: string;
  setup(async () => { path = await mkdtemp(join(tmpdir(), "soft-start-journal-")); });
  teardown(async () => { await rm(path, { recursive: true, force: true }); });

  test("distinguishes native paths on local, WSL distributions and SSH hosts", () => {
    const project = folder("same");
    const hosts = [
      host, projectHostIdentity("wsl", "cloned-id", "Ubuntu"), projectHostIdentity("wsl", "cloned-id", "Debian"),
      projectHostIdentity("ssh-remote", "ssh-machine-1"), projectHostIdentity("ssh-remote", "ssh-machine-2"),
    ];
    const identities = hosts.map((item) => identifyProject(project, item));
    assert.equal(new Set(identities.map(({ id }) => id)).size, hosts.length);
    assert.throws(() => assertProjectOrigin(identities[1], hosts[2]), /original WSL/);
    assert.doesNotThrow(() => assertProjectOrigin(identities[1], hosts[1]));
  });

  test("preserves explicit WSL authorities and saved workspace URIs", () => {
    const uri = vscode.Uri.parse("vscode-remote://wsl+Ubuntu/home/test/a.code-workspace?q=1#top");
    const project = { ...folder("workspace", uri), kind: "workspace" as const };
    const ubuntu = identifyProject(project, host);
    const debian = identifyProject({ ...project, uri: uri.with({ authority: "wsl+Debian" }) }, host);
    assert.notEqual(ubuntu.id, debian.id);
    assert.deepEqual(ubuntu.uri, serializeUri(uri));
    assert.equal(ubuntu.origin.kind, "addressed");
    assert.throws(() => assertProjectOrigin(identifyProject(folder("unverified"))), /cannot verify/);
  });

  test("migrates legacy entries in place without guessing a host and retains a raw recovery record", async () => {
    const native = folder("native");
    const remote = folder("workspace", vscode.Uri.parse("vscode-remote://ssh-remote+lab/saved.code-workspace"));
    const plain = { ...native, id: projectId(native.uri), uri: serializeUri(native.uri) };
    const addressed = { ...remote, kind: "workspace", id: projectId(remote.uri), uri: serializeUri(remote.uri) };
    const partiallyMigrated = identifyProject(folder("already migrated"), host);
    const contents: Record<string, unknown> = {
      [recentProjectsKey]: [{ ...plain, lastOpened: 11 }, { ...addressed, lastOpened: 13 }],
      [pinnedProjectsKey]: [{ ...plain, displayName: "Custom", pinnedAt: 4 }, { invalid: true },
        { ...addressed, pinnedAt: 3 }, { ...partiallyMigrated, pinnedAt: 5 }],
    };
    const original = { get: <T>(key: string) => contents[key] as T };
    const store = new ProjectStore(new ProjectJournal(path), host, original);
    const snapshot = await store.read();
    assert.deepEqual(snapshot.pins.map(({ name, pinnedAt }) => [name, pinnedAt]), [
      ["native", 4], ["workspace", 3], ["already migrated", 5],
    ]);
    assert.equal(snapshot.pins[0].displayName, "Custom");
    assert.equal(snapshot.pins[0].origin.kind, "unknown");
    assert.throws(() => assertProjectOrigin(snapshot.pins[0], host), /original host/);
    assert.equal(snapshot.pins[1].kind, "workspace");
    assert.equal(snapshot.pins[1].uri.authority, "ssh-remote+lab");
    assert.deepEqual(snapshot.recent.map(({ lastOpened }) => lastOpened), [13, 11]);
    assert.equal(JSON.parse(await readFile(join(path, "legacy.json"), "utf8")).pins[1].invalid, true);
    contents[pinnedProjectsKey] = [];
    assert.deepEqual(await new ProjectStore(new ProjectJournal(path), host, original).read(), snapshot);
    await store.unpin(snapshot.pins[0].id);
    assert.ok(!(await store.read()).pins.some(({ id }) => id === snapshot.pins[0].id));
  });

  test("adds unopened folders outside the New Project directory and saved workspaces without opening them", async () => {
    const store = new ProjectStore(new ProjectJournal(path), host, legacy);
    const settings = vscode.workspace.getConfiguration("softStart");
    const projectsDirectory = settings.inspect<string>("projectsDirectory");
    const root = join(path, "new-projects");
    const outside = join(path, "unopened");
    const file = join(path, "saved.code-workspace");
    await mkdir(root);
    await mkdir(outside);
    await writeFile(file, '{"folders":[]}');
    const originalWorkspace = vscode.workspace.workspaceFolders;
    const originalWorkspaceFile = vscode.workspace.workspaceFile;
    await settings.update("projectsDirectory", root, vscode.ConfigurationTarget.Global);
    try {
      for (const [kind, location] of [["folder", outside], ["workspace", file]] as const) {
        await addPinnedProject(store, {
          showQuickPick: async (choices) => choices.find((choice) => choice.projectKind === kind),
          showOpenDialog: async (options) => {
            assert.equal(options?.defaultUri, undefined);
            return [vscode.Uri.file(location)];
          },
        });
      }
      const { pins, recent } = await store.read();
      assert.deepEqual(pins.map(({ uri, kind }) => [vscode.Uri.from(uri).fsPath, kind]),
        [[outside, "folder"], [file, "workspace"]]);
      assert.deepEqual(recent, []);
      assert.deepEqual(vscode.workspace.workspaceFolders, originalWorkspace);
      assert.deepEqual(vscode.workspace.workspaceFile, originalWorkspaceFile);
    } finally {
      await settings.update("projectsDirectory", projectsDirectory?.globalValue, vscode.ConfigurationTarget.Global);
    }
  });

  test("cancelling folder selection leaves the journal untouched", async () => {
    const store = new ProjectStore(new ProjectJournal(path), host, legacy);
    await addPinnedProject(store, {
      showQuickPick: async ([choice]) => choice,
      showOpenDialog: async () => undefined,
    });
    assert.deepEqual(await readdir(path), []);
  });

  test("locates a legacy workspace in place and retains its custom name, kind and timestamps", async () => {
    const project = { ...folder("legacy.code-workspace"), kind: "workspace" as const };
    const raw = { ...project, id: projectId(project.uri), uri: serializeUri(project.uri) };
    const wsl = projectHostIdentity("wsl", "remote-machine", "Ubuntu");
    const source = { get: <T>(key: string) => (key === pinnedProjectsKey
      ? [{ ...raw, displayName: "Custom", pinnedAt: 2 }]
      : [{ ...raw, lastOpened: 9 }]) as T };
    const journal = new ProjectJournal(path);
    const store = new ProjectStore(journal, wsl, source);
    await store.pin(folder("first"), 3);
    await store.pin(folder("last"), 4);
    const [old, first, last] = (await store.read()).pins;
    await store.reorder([first.id, old.id, last.id]);
    const uri = vscode.Uri.file(join(path, "found.code-workspace"));
    await writeFile(uri.fsPath, '{"folders":[]}');
    const selection = await selectProjectLocation(old.kind, async (options) => {
      assert.equal(options?.openLabel, "Use this location");
      assert.equal(options?.canSelectFiles, true);
      return [uri];
    }, true);
    assert.ok(selection);
    await store.locate("pins", old.id, selection);
    await store.locate("recent", old.id, selection);
    const snapshot = await new ProjectStore(journal, wsl, source).read();
    const found = identifyProject(selection, wsl);
    assert.deepEqual(snapshot.pins, [first, { ...found, pinnedAt: 2, displayName: "Custom" }, last]);
    assert.deepEqual(snapshot.recent, [{ ...found, lastOpened: 9 }]);
    assert.throws(() => assertProjectOrigin(snapshot.pins[1], host), /original WSL/);
  });

  test("rejects ambiguous recovery and keeps both entries when a location is already pinned", async () => {
    const project = folder("legacy", vscode.Uri.file(join(path, "legacy")));
    await mkdir(project.uri.fsPath);
    const raw = { ...project, id: projectId(project.uri), uri: serializeUri(project.uri), pinnedAt: 1 };
    const source = { get: <T>(key: string) => (key === pinnedProjectsKey ? [raw] : undefined) as T };
    const journal = new ProjectJournal(path);
    const store = new ProjectStore(journal, host, source);
    await store.pin(project, 3);
    await store.pin(project, 4);
    const before = await store.read();
    assert.equal(before.pins.length, 2);
    await assert.rejects(store.locate("pins", raw.id, project), /already pinned/);
    const unverified = new ProjectStore(journal, undefined, source);
    await assert.rejects(unverified.locate("pins", raw.id, project), /cannot verify/);
    assert.deepEqual(await store.read(), before);
  });

  test("recovers after a migration failure without modifying the original values", async () => {
    const project = folder("migration");
    const raw = [{ ...project, id: projectId(project.uri), uri: serializeUri(project.uri), pinnedAt: 1 }];
    const source = { get: <T>(key: string) => (key === pinnedProjectsKey ? raw : undefined) as T };
    const journal = new ProjectJournal(path);
    let fail = true;
    const store = new ProjectStore({
      initialize(value) {
        if (fail) {
          return Promise.reject(new Error("migration failed"));
        }
        return journal.initialize(value);
      },
      events: () => journal.events(),
      append: (event) => journal.append(event),
    }, host, source);
    await assert.rejects(store.read(), /migration failed/);
    assert.deepEqual(await readdir(path), []);
    assert.equal(raw.length, 1);
    fail = false;
    assert.equal((await store.read()).pins[0].name, "migration");
  });

  test("preserves concurrent pin and recent additions from independent stores using real files", async () => {
    const a = new ProjectStore(new ProjectJournal(path), host, legacy);
    const b = new ProjectStore(new ProjectJournal(path), host, legacy);
    const alpha = folder("alpha");
    const beta = folder("beta");
    await Promise.all([a.pin(alpha), b.pin(beta), a.record(alpha, 10), b.record(beta, 20)]);
    const first = await a.read();
    assert.deepEqual(await b.read(), first);
    assert.deepEqual(new Set(first.pins.map(({ name }) => name)), new Set(["alpha", "beta"]));
    assert.deepEqual(first.recent.map(({ name }) => name), ["beta", "alpha"]);
  });

  test("merges a stale reorder with concurrent additions and never recreates a removed pin on rename", async () => {
    const a = new ProjectStore(new ProjectJournal(path), host, legacy);
    const b = new ProjectStore(new ProjectJournal(path), host, legacy);
    await a.pin(folder("alpha"));
    await b.pin(folder("beta"));
    const [alpha, beta] = (await a.read()).pins;
    await Promise.all([a.reorder([beta.id, alpha.id]), b.pin(folder("gamma"))]);
    assert.deepEqual((await b.read()).pins.map(({ name }) => name), ["beta", "alpha", "gamma"]);
    const results = await Promise.allSettled([a.rename(alpha, "Renamed"), b.unpin(alpha.id)]);
    assert.equal(results[1].status, "fulfilled");
    assert.deepEqual((await a.read()).pins.map(({ name }) => name), ["beta", "gamma"]);
  });

  test("never exposes a rejected append and reads later external changes after failure", async () => {
    const journal = new ProjectJournal(path);
    const a = new ProjectStore({
      initialize: (raw) => journal.initialize(raw),
      events: () => journal.events(),
      append: async () => { throw new Error("write unavailable"); },
    }, host, legacy);
    const b = new ProjectStore(new ProjectJournal(path), host, legacy);
    await assert.rejects(a.pin(folder("failed")), /write unavailable/);
    assert.deepEqual((await a.read()).pins, []);
    await b.pin(folder("external"));
    assert.deepEqual((await a.read()).pins.map(({ name }) => name), ["external"]);
  });

  test("observes another store's published operation through the native directory watcher", async () => {
    const journal = new ProjectJournal(path);
    const a = new ProjectStore(journal, host, legacy);
    const b = new ProjectStore(new ProjectJournal(path), host, legacy);
    await a.read();
    const abort = new AbortController();
    let watcher: ReturnType<ProjectJournal["watch"]> | undefined;
    try {
      const notified = new Promise<void>((resolve, reject) => {
        watcher = journal.watch(resolve, reject);
        abort.signal.addEventListener("abort", () => reject(new Error("directory watch timed out")), { once: true });
      });
      const timer = setTimeout(() => abort.abort(), 4000);
      try {
        await Promise.all([b.pin(folder("external")), notified]);
      } finally {
        clearTimeout(timer);
      }
      assert.equal((await a.read()).pins[0].name, "external");
    } finally {
      watcher?.close();
    }
  });
});

suite("Project action feedback", () => {
  test("announces busy status, rejects overlapping work, and reports failures", async () => {
    const messages: string[] = [];
    const actions = new ProjectActions(({ busy, error }) => messages.push(error ?? (busy ? "busy" : "idle")));
    let finish!: () => void;
    const first = actions.run(() => new Promise<void>((resolve) => { finish = resolve; }));
    await actions.run(async () => assert.fail("Overlapping action must not execute"));
    finish();
    await first;
    await actions.run(async () => { throw new Error("project unavailable"); });
    assert.deepEqual(messages, ["busy", "A project action is already running. Try again when it finishes.",
      "idle", "busy", "project unavailable"]);
  });

  test("explains unavailable Git and delegates only to the built-in clone command when present", async () => {
    const extensions = { getExtension: () => undefined };
    const calls: string[] = [];
    const commands = {
      getCommands: async () => [] as string[],
      executeCommand: async <T>(command: string) => { calls.push(command); return undefined as T; },
    };
    await assert.rejects(cloneProject(extensions, commands), /Git Clone is unavailable/);
    assert.deepEqual(calls, []);
    await cloneProject(extensions, { ...commands, getCommands: async () => ["git.clone"] });
    assert.deepEqual(calls, ["git.clone"]);
  });
});
