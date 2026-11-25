import * as assert from "node:assert/strict";
import * as vscode from "vscode";
import {
  currentProject, openRecentProject, presentProject, projectId, RecentProjects,
} from "./legacyProjectFixtures";
import { recentProjectsKey } from "../recentProjects";
import { isDashboardMessage, isRecentProjectsMessage } from "../webviewMessages";

class MemoryState implements Pick<vscode.Memento, "get" | "update"> {
  value: unknown;
  failNextWrite = false;

  get<T>(key: string): T | undefined;
  get<T>(key: string, fallback: T): T;
  get<T>(key: string, fallback?: T): T | undefined {
    assert.equal(key, recentProjectsKey);
    return (this.value as T | undefined) ?? fallback;
  }

  async update(key: string, value: unknown) {
    assert.equal(key, recentProjectsKey);
    await Promise.resolve();
    if (this.failNextWrite) {
      this.failNextWrite = false;
      throw new Error("Storage unavailable");
    }
    this.value = value;
  }
}

function folder(name: string) {
  return { uri: vscode.Uri.file(`/projects/${name}`), name, kind: "folder" as const };
}

const directory = { type: vscode.FileType.Directory, ctime: 0, mtime: 0, size: 0 };

suite("Recent projects history", () => {
  test("starts empty when state is missing or invalid", () => {
    const state = new MemoryState();
    const history = new RecentProjects(state);
    for (const value of [undefined, null, {}, "history", 50]) {
      state.value = value;
      assert.deepEqual(history.list(), []);
    }
  });

  test("records a folder and reloads its serialized entry from global state", async () => {
    const state = new MemoryState();
    const history = new RecentProjects(state);
    const project = folder("one");
    await history.record(project, 100);
    const [entry] = new RecentProjects(state).list();

    assert.match(entry.id, /^[a-f0-9]{64}$/);
    assert.deepEqual(entry, {
      id: entry.id,
      uri: { scheme: "file", authority: "", path: project.uri.path, query: "", fragment: "" },
      name: "one",
      kind: "folder",
      lastOpened: 100,
    });
  });

  test("deduplicates the same URI, updates its display name and timestamp, and sorts by recency", async () => {
    const history = new RecentProjects(new MemoryState());
    const project = folder("one");
    await history.record(project, 100);
    const id = history.list()[0].id;
    await history.record(folder("two"), 300);
    await history.record(folder("three"), 200);
    assert.deepEqual(history.list().map((entry) => entry.name), ["two", "three", "one"]);

    await history.record({ ...project, name: "Renamed label" }, 400);
    const entries = history.list();
    assert.deepEqual(entries.map((entry) => entry.name), ["Renamed label", "two", "three"]);
    assert.equal(entries[0].id, id);
    assert.equal(entries[0].lastOpened, 400);
  });

  test("keeps only the newest 50 entries after overlapping writes", async () => {
    const state = new MemoryState();
    const history = new RecentProjects(state);
    await Promise.all(Array.from({ length: 55 }, (_, i) => history.record(folder(`project-${i}`), 55 - i)));
    const entries = history.list();

    assert.equal(entries.length, 50);
    assert.equal(entries[0].name, "project-0");
    assert.equal(entries.at(-1)?.name, "project-49");
    assert.deepEqual(state.value, entries);
  });

  test("removes a single entry and leaves unrelated entries intact", async () => {
    const state = new MemoryState();
    const history = new RecentProjects(state);
    await history.record(folder("one"), 10);
    const id = history.list()[0].id;
    await history.record(folder("two"), 20);
    await history.remove(id);
    await history.remove(id);

    assert.deepEqual(new RecentProjects(state).list().map((entry) => entry.name), ["two"]);
  });

  test("filters invalid persisted entries and keeps the newest valid duplicate", async () => {
    const state = new MemoryState();
    const history = new RecentProjects(state);
    await history.record(folder("valid"), 100);
    const [entry] = history.list();
    const newest = { ...entry, lastOpened: 200 };
    state.value = [null, {}, entry, { ...entry, kind: "other" }, { ...entry, id: "other" },
      { ...entry, name: " " }, { ...entry, uri: "invalid uri" }, { ...entry, uri: { ...entry.uri, scheme: "untitled" } },
      { ...entry, lastOpened: Infinity }, { ...entry, lastOpened: -1 },
      { ...entry, lastOpened: 8.65e15 }, { ...entry, lastOpened: "500" }, newest];

    assert.deepEqual(history.list(), [newest]);
  });

  test("recovers after a storage failure", async () => {
    const state = new MemoryState();
    const history = new RecentProjects(state);
    state.failNextWrite = true;
    await assert.rejects(history.record(folder("failed"), 100), /Storage unavailable/);
    await history.record(folder("saved"), 200);

    assert.deepEqual(history.list().map((entry) => entry.name), ["saved"]);
  });

  test("keeps remote projects with identical paths on different authorities distinct", async () => {
    const state = new MemoryState();
    const history = new RecentProjects(state);
    const wsl = vscode.Uri.parse("vscode-remote://wsl+Ubuntu/home/user/project%20one");
    const ssh = vscode.Uri.parse("vscode-remote://ssh-remote+host/home/user/project%20one");
    await history.record({ uri: wsl, name: "project one", kind: "folder" }, 10);
    await history.record({ uri: ssh, name: "project one", kind: "folder" }, 20);
    const [remote, linux] = new RecentProjects(state).list();

    assert.notEqual(remote.id, linux.id);
    assert.equal(projectId(remote.uri), projectId(ssh));
    assert.equal(projectId(linux.uri), projectId(wsl));
    assert.equal(linux.uri.authority, "wsl+Ubuntu");
    assert.match(presentProject(linux).path, /wsl\+Ubuntu.*project one/);
  });
});

suite("Current project selection", () => {
  const root = { uri: folder("root").uri, name: "root", index: 0 };
  const second = { uri: folder("second").uri, name: "second", index: 1 };

  test("chooses the single folder URI and display name", () => {
    const selected = currentProject({ workspaceFile: undefined, workspaceFolders: [root], name: "root" });
    assert.deepEqual(selected, { uri: root.uri, name: "root", kind: "folder" });
  });

  test("records a saved multi-root workspace as one reopenable workspace file", async () => {
    const uri = vscode.Uri.parse("vscode-remote://ssh-remote+host/home/user/work.code-workspace");
    const selected = currentProject({ workspaceFile: uri, workspaceFolders: [root, second], name: "work" });
    assert.deepEqual(selected, { uri, name: "work", kind: "workspace" });
    assert.ok(selected);
    const history = new RecentProjects(new MemoryState());
    await history.record(selected, 10);
    const [project] = history.list();
    assert.equal(projectId(project.uri), projectId(uri));
    assert.equal(project.kind, "workspace");
  });

  test("tracks saved workspace files even when they have no roots", () => {
    const workspaceFile = vscode.Uri.file("/projects/empty.code-workspace");
    assert.equal(currentProject({ workspaceFile, workspaceFolders: [], name: undefined })?.kind, "workspace");
  });

  test("skips empty windows and untitled workspaces", () => {
    for (const workspaceFolders of [undefined, []]) {
      assert.equal(currentProject({ workspaceFile: undefined, workspaceFolders, name: undefined }), undefined);
    }
    const workspaceFile = vscode.Uri.parse("untitled:Untitled-1");
    assert.equal(currentProject({ workspaceFile, workspaceFolders: [root, second], name: "Untitled" }), undefined);
  });
});

suite("Opening recent projects", () => {
  test("passes a remote folder or workspace file URI to the open command unchanged", async () => {
    for (const kind of ["folder", "workspace"] as const) {
      const uri = vscode.Uri.parse(`vscode-remote://wsl+Ubuntu/projects/${kind === "folder" ? "demo" : "demo.code-workspace"}`);
      const history = new RecentProjects(new MemoryState());
      await history.record({ uri, name: "demo", kind }, 10);
      const [entry] = history.list();
      const opened: string[] = [];
      await openRecentProject(entry, async (target) => {
        assert.equal(projectId(target), projectId(uri));
        return { ...directory, type: kind === "folder" ? vscode.FileType.Directory : vscode.FileType.File };
      }, async (target) => {
        opened.push(projectId(target));
      });
      assert.deepEqual(opened, [projectId(uri)]);
    }
  });

  test("reports missing or inaccessible projects without invoking the open command", async () => {
    const history = new RecentProjects(new MemoryState());
    await history.record(folder("unavailable"), 10);
    const [entry] = history.list();
    for (const error of [
      vscode.FileSystemError.FileNotFound("missing path"),
      vscode.FileSystemError.NoPermissions("permission denied"),
      vscode.FileSystemError.Unavailable("remote filesystem unavailable"),
    ]) {
      await assert.rejects(openRecentProject(entry, async () => { throw error; }, async () => {
        assert.fail("An unavailable project must not reach the open command");
      }), { message: `Could not open "unavailable". ${error.message}` });
      assert.deepEqual(history.list(), [entry]);
    }
  });

  test("reports when a folder was replaced by a file", async () => {
    const history = new RecentProjects(new MemoryState());
    await history.record(folder("changed"), 10);
    const [entry] = history.list();
    await assert.rejects(
      openRecentProject(entry, async () => ({ ...directory, type: vscode.FileType.File }), async () => {
        assert.fail("A file must not be opened as a folder");
      }),
      /no longer a folder/,
    );
  });
});

suite("Recent projects messages", () => {
  const id = "a".repeat(64);

  test("accepts typed ready, view-all, open, remove, and existing quick action messages", () => {
    for (const request of [
      { type: "requestRecentProjects" }, { type: "viewAllRecentProjects" },
      { type: "openRecentProject", id }, { type: "removeRecentProject", id },
      { type: "quickAction", action: "openFolder" },
    ]) {
      assert.equal(isDashboardMessage(request), true);
    }
  });

  test("rejects malformed messages and URI or command payloads in place of project IDs", () => {
    for (const request of [
      undefined, null, {}, "openRecentProject", { type: "openRecentProject" },
      { type: "openRecentProject", id: "file:///projects/demo" },
      { type: "removeRecentProject", id: 7 },
      { type: "removeRecentProject", id: "g".repeat(64) },
      { type: "vscode.openFolder", id }, { type: "recentProjects", projects: [] },
      { type: "quickAction", action: "invalid" },
    ]) {
      assert.equal(isDashboardMessage(request), false);
    }
  });

  test("validates history payloads before the webview renders them", () => {
    const project = { id, name: "demo", path: "/projects/demo", kind: "folder", lastOpened: 100 };
    assert.equal(isRecentProjectsMessage({ type: "recentProjects", projects: [project] }), true);
    assert.equal(isRecentProjectsMessage({ type: "recentProjects", projects: [] }), true);
    assert.equal(isRecentProjectsMessage({ type: "recentProjects", projects: [{ ...project, lastOpened: Infinity }] }), false);
    assert.equal(isRecentProjectsMessage({ type: "recentProjects", projects: [{ ...project, kind: "file" }] }), false);
  });
});
