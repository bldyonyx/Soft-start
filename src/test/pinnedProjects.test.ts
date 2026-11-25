import * as assert from "node:assert/strict";
import * as vscode from "vscode";
import {
  pinnedProjectsKey, promptPinnedProjectName, selectPinnedProject,
} from "../pinnedProjects";
import { openProject, projectId } from "../projects";
import { PinnedProjects, RecentProjects } from "./legacyProjectFixtures";
import { isDashboardMessage, isPinnedProjectsMessage } from "../webviewMessages";

class MemoryState implements Pick<vscode.Memento, "get" | "update"> {
  readonly values = new Map<string, unknown>();
  failNextWrite = false;

  get<T>(key: string): T | undefined;
  get<T>(key: string, fallback: T): T;
  get<T>(key: string, fallback?: T): T | undefined {
    return (this.values.get(key) as T | undefined) ?? fallback;
  }

  async update(key: string, value: unknown) {
    // Model a Memento cache that changes even when persistence fails.
    this.values.set(key, value);
    if (this.failNextWrite) {
      this.failNextWrite = false;
      throw new Error("Storage unavailable");
    }
  }
}

function folder(name: string) {
  return { uri: vscode.Uri.file(`/projects/${name}`), name, kind: "folder" as const };
}

suite("Pinned projects", () => {
  let state: MemoryState;
  let pins: PinnedProjects;

  setup(() => {
    state = new MemoryState();
    pins = new PinnedProjects(state);
  });

  test("starts empty with absent or malformed storage", () => {
    for (const stored of [undefined, null, {}, "pins", 12, [null, {}]]) {
      state.values.set(pinnedProjectsKey, stored);
      assert.deepEqual(pins.list(), []);
    }
  });

  test("pins and unpins independently of recent history", async () => {
    const recent = new RecentProjects(state);
    const project = folder("one");
    const id = projectId(project.uri);
    await recent.record(project);
    await pins.pin(project, 10);
    assert.equal(recent.list().length, 1);
    await recent.remove(id);
    assert.equal(pins.list()[0].id, id);
    await recent.record(project);
    await pins.unpin(id);
    assert.deepEqual(new PinnedProjects(state).list(), []);
    assert.equal(recent.list()[0].id, id);
  });

  test("prevents duplicate pins during overlapping writes and keeps the original metadata", async () => {
    const project = folder("one");
    await Promise.all([pins.pin(project, 10), pins.pin({ ...project, name: "duplicate" }, 20)]);
    assert.deepEqual(new PinnedProjects(state).list().map(({ name, pinnedAt }) => ({ name, pinnedAt })), [
      { name: "one", pinnedAt: 10 },
    ]);
  });

  test("persists custom display names and restores the original name with blank input", async () => {
    await pins.pin(folder("one"), 10);
    const [original] = pins.list();
    await pins.rename(original.id, "  Favorite  ");
    assert.deepEqual(new PinnedProjects(state).list(), [{ ...original, displayName: "Favorite" }]);
    await pins.rename(original.id, "  ");
    assert.deepEqual(new PinnedProjects(state).list(), [original]);
  });

  test("persists custom order without applying the recent history limit", async () => {
    await Promise.all(Array.from({ length: 55 }, (_, i) => pins.pin(folder(`project-${i}`), i)));
    assert.equal(pins.list().length, 55);
    const ids = pins.list().map(({ id }) => id).reverse();
    await pins.reorder(ids);
    assert.deepEqual(new PinnedProjects(state).list().map(({ id }) => id), ids);
  });

  test("rejects unknown, missing and duplicated IDs without changing order", async () => {
    await pins.pin(folder("one"));
    await pins.pin(folder("two"));
    const entries = pins.list();
    const [a, b] = entries.map(({ id }) => id);
    for (const ids of [[a], [a, a], [a, b, "extra"], [a, "f".repeat(64)]]) {
      await assert.rejects(pins.reorder(ids), /order has changed/);
    }
    assert.deepEqual(pins.list(), entries);
  });

  test("filters invalid persisted entries and retains valid original metadata", async () => {
    await pins.pin(folder("one"), 10);
    const [entry] = pins.list();
    state.values.set(pinnedProjectsKey, [
      { ...entry, id: "invalid" }, { ...entry, uri: { ...entry.uri, path: "relative" } },
      { ...entry, kind: "file" }, { ...entry, pinnedAt: Infinity }, { ...entry, name: "" },
      { ...entry, displayName: 42 }, { ...entry, displayName: "duplicate" },
    ]);
    assert.deepEqual(pins.list(), [entry]);
  });

  test("preserves remote URI components and order after opening a pinned workspace", async () => {
    const uri = vscode.Uri.parse("vscode-remote://wsl+Ubuntu/projects/one%20two.code-workspace?q=1#root");
    await pins.pin({ uri, name: "one two", kind: "workspace" });
    await pins.pin(folder("local"));
    const entries = new PinnedProjects(state).list();
    const [entry] = entries;
    assert.equal(entry.uri.authority, "wsl+Ubuntu");
    assert.equal(entry.uri.query, "q=1");
    assert.equal(entry.uri.fragment, "root");
    assert.equal(entry.id, projectId(uri));
    const recent = new RecentProjects(state);
    await openProject(entry, async (target) => {
      assert.equal(projectId(target), projectId(uri));
      return { type: vscode.FileType.File, ctime: 0, mtime: 0, size: 0 };
    }, async (target) => {
      assert.equal(projectId(target), projectId(uri));
      await recent.record({ ...entry, uri: target });
    });
    assert.equal(recent.list()[0].id, entry.id);
    assert.deepEqual(new PinnedProjects(state).list(), entries);
  });

  test("retains pins when a project is missing or inaccessible", async () => {
    await pins.pin(folder("unavailable"));
    const [entry] = pins.list();
    for (const error of [vscode.FileSystemError.FileNotFound(), vscode.FileSystemError.NoPermissions()]) {
      await assert.rejects(openProject(entry, async () => { throw error; }, async () => {
        assert.fail("An inaccessible project must not be opened");
      }), /Could not open "unavailable"/);
      assert.deepEqual(pins.list(), [entry]);
    }
  });

  test("keeps the confirmed order after a storage failure and recovers on retry", async () => {
    await pins.pin(folder("one"));
    await pins.pin(folder("two"));
    const entries = pins.list();
    const ids = entries.map(({ id }) => id).reverse();
    state.failNextWrite = true;
    await assert.rejects(pins.reorder(ids), /Storage unavailable/);
    assert.deepEqual(pins.list(), entries);
    await pins.reorder(ids);
    assert.deepEqual(new PinnedProjects(state).list().map(({ id }) => id), ids);
  });

  test("handles cancellation at either add prompt and at rename", async () => {
    assert.equal(await selectPinnedProject({
      showQuickPick: async () => undefined,
      showOpenDialog: async () => assert.fail("Picker should not open after cancellation"),
    }), undefined);
    assert.equal(await selectPinnedProject({
      showQuickPick: async ([choice]) => choice,
      showOpenDialog: async () => undefined,
    }), undefined);
    await pins.pin(folder("original"));
    const [entry] = pins.list();
    assert.equal(await promptPinnedProjectName(entry, async (options) => {
      assert.equal(options?.value, "original");
      return undefined;
    }), undefined);
    assert.deepEqual(pins.list(), [entry]);
  });

  test("uses separate folder and workspace picker options and retains the selected URI", async () => {
    for (const kind of ["folder", "workspace"] as const) {
      const isFolder = kind === "folder";
      const name = isFolder ? "demo" : "demo.code-workspace";
      const uri = vscode.Uri.parse(`vscode-remote://wsl+Ubuntu/projects/${name}`);
      const selected = await selectPinnedProject({
        showQuickPick: async (choices) => choices.find((choice) => choice.projectKind === kind),
        showOpenDialog: async (options) => {
          assert.equal(options?.canSelectFolders, isFolder);
          assert.equal(options?.canSelectFiles, !isFolder);
          assert.equal(options?.canSelectMany, false);
          return [uri];
        },
      });
      assert.deepEqual(selected, { uri, kind, name });
    }
  });

  test("validates pinned messages and rejects malformed identifiers, orders and project data", () => {
    const id = "a".repeat(64);
    for (const type of ["pinRecentProject", "openPinnedProject", "renamePinnedProject", "unpinProject"]) {
      assert.equal(isDashboardMessage({ type, id }), true);
      assert.equal(isDashboardMessage({ type, id: "file:///tmp/project" }), false);
      assert.equal(isDashboardMessage({ type, path: "/tmp/project" }), false);
    }
    assert.equal(isDashboardMessage({ type: "addPinnedProject" }), true);
    assert.equal(isDashboardMessage({ type: "reorderPinnedProjects", ids: [id] }), true);
    for (const ids of [undefined, id, [id, id], [1], Array(1)]) {
      assert.equal(isDashboardMessage({ type: "reorderPinnedProjects", ids }), false);
    }
    const project = { id, name: "one", path: "/projects/one", kind: "folder" };
    assert.equal(isPinnedProjectsMessage({ type: "pinnedProjects", projects: [project] }), true);
    assert.equal(isPinnedProjectsMessage({ type: "pinnedProjects", projects: [{ ...project, kind: "invalid" }] }), false);
  });
});
