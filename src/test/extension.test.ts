import * as assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as vscode from "vscode";
import { createProject } from "../newProject";
import { isQuickActionMessage } from "../quickActions";

const directory = { type: vscode.FileType.Directory, ctime: 0, mtime: 0, size: 0 };

function projectFixture(options: {
  name?: string;
  configuredPath?: string;
  pickedParent?: vscode.Uri;
  fs?: Pick<typeof vscode.workspace.fs, "stat" | "createDirectory">;
  parentStat?: vscode.FileStat | vscode.FileSystemError;
  destinationStat?: vscode.FileStat | vscode.FileSystemError;
  createError?: vscode.FileSystemError;
  openError?: Error;
} = {}) {
  const checked: string[] = [];
  const created: string[] = [];
  const opened: [string, string][] = [];
  const errors: string[] = [];
  const prompts: vscode.OpenDialogOptions[] = [];
  const api: Parameters<typeof createProject>[0] = {
    window: {
      showInputBox: async (input) => {
        assert.equal(input?.title, "New project");
        assert.ok(input.validateInput);
        return options.name;
      },
      showOpenDialog: async (dialog) => {
        assert.ok(dialog);
        prompts.push(dialog);
        return options.pickedParent ? [options.pickedParent] : undefined;
      },
      showErrorMessage: async (message) => {
        errors.push(message);
        return undefined;
      },
    },
    workspace: {
      getConfiguration: (section) => {
        assert.equal(section, "softStart");
        return {
          get: (key: string) => {
            assert.equal(key, "projectsDirectory");
            return options.configuredPath ?? "";
          },
        };
      },
      fs: options.fs ?? {
        stat: async (uri) => {
          checked.push(uri.toString());
          if (checked.length === 1) {
            if (options.parentStat instanceof vscode.FileSystemError) {
              throw options.parentStat;
            }
            return options.parentStat ?? directory;
          }
          if (options.destinationStat instanceof vscode.FileSystemError) {
            throw options.destinationStat;
          }
          if (options.destinationStat) {
            return options.destinationStat;
          }
          throw vscode.FileSystemError.FileNotFound(uri);
        },
        createDirectory: async (uri) => {
          if (options.createError) {
            throw options.createError;
          }
          created.push(uri.toString());
        },
      },
    },
    commands: {
      executeCommand: async (command, uri) => {
        opened.push([command, uri.toString()]);
        if (options.openError) {
          throw options.openError;
        }
      },
    },
  };
  return { run: () => createProject(api), checked, created, opened, errors, prompts };
}

suite("New project", () => {
  test("creates an empty project on disk through the VS Code filesystem", async () => {
    const parent = vscode.Uri.file(await mkdtemp(join(tmpdir(), "soft-start-")));
    const destination = vscode.Uri.joinPath(parent, "demo");
    try {
      const fixture = projectFixture({ name: "demo", pickedParent: parent, fs: vscode.workspace.fs });
      await fixture.run();

      assert.deepEqual(fixture.errors, []);
      assert.deepEqual(fixture.opened, [["vscode.openFolder", destination.toString()]]);
      assert.deepEqual(await vscode.workspace.fs.readDirectory(destination), []);
    } finally {
      await vscode.workspace.fs.delete(parent, { recursive: true });
    }
  });

  test("creates and opens a single folder under the configured directory", async () => {
    const parent = vscode.Uri.file(process.platform === "win32" ? "C:\\projects" : "/projects");
    const fixture = projectFixture({ name: "My project", configuredPath: parent.fsPath });
    const destination = vscode.Uri.joinPath(parent, "My project");
    await fixture.run();

    assert.deepEqual(fixture.prompts, []);
    assert.deepEqual(fixture.checked, [parent.toString(), destination.toString()]);
    assert.deepEqual(fixture.created, [destination.toString()]);
    assert.deepEqual(fixture.opened, [["vscode.openFolder", destination.toString()]]);
    assert.deepEqual(fixture.errors, []);
  });

  test("preserves a remote folder picker's URI and authority", async () => {
    const parent = vscode.Uri.parse("vscode-remote://wsl+test/projects");
    const fixture = projectFixture({ name: "demo", pickedParent: parent });
    const destination = vscode.Uri.joinPath(parent, "demo");
    await fixture.run();

    assert.equal(fixture.prompts.length, 1);
    assert.equal(fixture.prompts[0].canSelectFolders, true);
    assert.equal(fixture.prompts[0].canSelectFiles, false);
    assert.deepEqual(fixture.created, [destination.toString()]);
    assert.deepEqual(fixture.opened, [["vscode.openFolder", destination.toString()]]);
  });

  for (const name of ["", " ", ".", "..", "../escape", "..\\escape", "/absolute", "C:drive",
    "invalid?", "nul.txt", "COM1", "trailing.", "leading ", "line\nbreak", "é".repeat(128)]) {
    test(`rejects invalid project name ${JSON.stringify(name)}`, async () => {
      const fixture = projectFixture({ name });
      await fixture.run();
      assert.equal(fixture.errors.length, 1);
      assert.deepEqual(fixture.prompts, []);
      assert.deepEqual(fixture.checked, []);
      assert.deepEqual(fixture.created, []);
      assert.deepEqual(fixture.opened, []);
    });
  }

  test("rejects a relative configured directory", async () => {
    const fixture = projectFixture({ name: "demo", configuredPath: "../projects" });
    await fixture.run();

    assert.match(fixture.errors[0], /absolute directory path/);
    assert.deepEqual(fixture.prompts, []);
    assert.deepEqual(fixture.checked, []);
  });

  for (const name of [undefined, "demo"]) {
    test(name ? "handles folder picker cancellation" : "handles name input cancellation", async () => {
      const fixture = projectFixture({ name });
      await fixture.run();

      assert.equal(fixture.prompts.length, name ? 1 : 0);
      assert.deepEqual(fixture.checked, []);
      assert.deepEqual(fixture.created, []);
      assert.deepEqual(fixture.opened, []);
      assert.deepEqual(fixture.errors, []);
    });
  }

  for (const type of [vscode.FileType.Directory, vscode.FileType.File, vscode.FileType.SymbolicLink]) {
    test(`rejects an existing destination with file type ${type}`, async () => {
      const fixture = projectFixture({
        name: "demo",
        pickedParent: vscode.Uri.file("/projects"),
        destinationStat: { ...directory, type },
      });
      await fixture.run();

      assert.match(fixture.errors[0], /already exists/);
      assert.deepEqual(fixture.created, []);
      assert.deepEqual(fixture.opened, []);
    });
  }

  test("reports a failed destination check and skips creation", async () => {
    const fixture = projectFixture({
      name: "demo",
      pickedParent: vscode.Uri.file("/projects"),
      destinationStat: vscode.FileSystemError.NoPermissions("Cannot check destination"),
    });
    await fixture.run();

    assert.match(fixture.errors[0], /Cannot check destination/);
    assert.deepEqual(fixture.created, []);
    assert.deepEqual(fixture.opened, []);
  });

  test("reports a missing parent without creating it", async () => {
    const parent = vscode.Uri.file("/projects");
    const fixture = projectFixture({
      name: "demo",
      pickedParent: parent,
      parentStat: vscode.FileSystemError.FileNotFound("Parent folder is missing"),
    });
    await fixture.run();

    assert.match(fixture.errors[0], /Parent folder is missing/);
    assert.deepEqual(fixture.checked, [parent.toString()]);
    assert.deepEqual(fixture.created, []);
    assert.deepEqual(fixture.opened, []);
  });

  test("reports a failed folder creation and skips opening", async () => {
    const fixture = projectFixture({
      name: "demo",
      pickedParent: vscode.Uri.file("/projects"),
      createError: vscode.FileSystemError.Unavailable("Filesystem offline"),
    });
    await fixture.run();

    assert.match(fixture.errors[0], /Filesystem offline/);
    assert.deepEqual(fixture.created, []);
    assert.deepEqual(fixture.opened, []);
  });

  test("reports an open failure after the folder was created", async () => {
    const fixture = projectFixture({
      name: "demo",
      pickedParent: vscode.Uri.file("/projects"),
      openError: new Error("Could not open the folder"),
    });
    await fixture.run();

    assert.equal(fixture.created.length, 1);
    assert.match(fixture.errors[0], /Project created, but VS Code could not open it/);
  });
});

suite("Quick Action messages", () => {
  test("accepts the three supported actions", () => {
    for (const action of ["newProject", "openFolder", "cloneRepository"]) {
      assert.equal(isQuickActionMessage({ type: "quickAction", action }), true);
    }
  });

  test("rejects malformed and unsupported messages", () => {
    for (const message of [undefined, null, "newProject", {}, { action: "newProject" },
      { type: "quickAction", action: 0 }, { type: "quickAction", action: "git.clone" },
      { type: "other", action: "newProject" }]) {
      assert.equal(isQuickActionMessage(message), false);
    }
  });
});
