// Run after compiling: node scripts/test-publisher-restart.mjs /path/to/VSCode-linux-x64/code
// Optional arguments are disposable copies of the old and current host journals (the directories containing legacy.json).
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runTests } from "@vscode/test-electron";

const [executable, historical, current] = process.argv.slice(2);
if (!executable || Boolean(historical) !== Boolean(current)) {
  throw new Error("Provide the VS Code executable and either both disposable journal directories or neither.");
}

// Launch Electron as a workbench even when invoked from a VS Code terminal.
delete process.env.ELECTRON_RUN_AS_NODE;

const root = await mkdtemp(join(tmpdir(), "soft-start-restart-"));
const repo = fileURLToPath(new URL("../", import.meta.url));
const extension = join(root, "extension");
const tests = join(root, "test.cjs");

try {
  await mkdir(extension);
  await cp(join(repo, "out"), join(extension, "out"), { recursive: true });
  await writeFile(join(extension, "package.json"), JSON.stringify({
    publisher: "bldyonyx", name: "soft-start", version: "0.0.1", engines: { vscode: "^1.146.0" },
    activationEvents: ["onStartupFinished"], main: "./probe.cjs",
  }));
  await writeFile(join(extension, "probe.cjs"), "exports.activate = (context) => context;\n");

  await writeFile(tests, `
    const assert = require("node:assert/strict");
    const { cp, mkdir, readFile, writeFile } = require("node:fs/promises");
    const { dirname, join } = require("node:path");
    const vscode = require("vscode");
    const { projectHostIdentity } = require("./extension/out/projectHost.js");
    const { ProjectJournal } = require("./extension/out/projectJournal.js");
    const { ProjectStore, projectStoreAt } = require("./extension/out/projectStore.js");
    const empty = { get: () => undefined };

    exports.run = async () => {
      const context = await vscode.extensions.getExtension("bldyonyx.soft-start").activate();
      // The local desktop host supplies vscode-userdata. Only the disposable
      // harness uses the native path directly to exercise WSL journal scope.
      const storage = context.globalStorageUri.fsPath;
      assert.ok(storage.startsWith(join(__dirname, "profile") + require("node:path").sep));
      const old = process.env.SOFT_START_OLD_JOURNAL;
      const current = process.env.SOFT_START_CURRENT_JOURNAL;
      const host = old ? { kind: "host", key: require("node:path").basename(old), label: "Fixture" }
        : projectHostIdentity("wsl", "disposable-machine", "Ubuntu");
      assert.match(host.key, /^[a-f0-9]{64}$/);
      const historical = join(dirname(storage), "undefined_publisher.soft-start", "projects-v2", host.key);
      const { store } = projectStoreAt(storage, host, empty);
      const marker = join(__dirname, "expected.json");

      if (process.env.SOFT_START_RESTART_STAGE === "first") {
        await mkdir(dirname(historical), { recursive: true });
        if (old) {
          assert.equal(require("node:path").basename(current), host.key);
          const destination = join(storage, "projects-v2", host.key);
          await mkdir(dirname(destination), { recursive: true });
          await cp(old, historical, { recursive: true });
          await cp(current, destination, { recursive: true });
        } else {
          const journal = new ProjectJournal(historical);
          const prior = new ProjectStore(journal, host, empty);
          await prior.pin({ uri: vscode.Uri.file(join(__dirname, "example")), kind: "folder", name: "Example" }, 1);
        }
        const before = await new ProjectStore(new ProjectJournal(join(storage, "projects-v2", host.key)), host, empty).read();
        const snapshot = await store.read();
        assert.ok(snapshot.pins.length > before.pins.length, "Expected recovered pins");
        assert.deepEqual(snapshot.recent, before.recent);
        console.log("Recovered pins:", snapshot.pins.map(({ name }) => name).join(", "));
        await store.unpin(snapshot.pins.at(-1).id);
        await writeFile(marker, JSON.stringify({ pid: process.pid, storage, expected: await store.read() }));
      } else {
        const { pid, storage: prior, expected } = JSON.parse(await readFile(marker, "utf8"));
        assert.notEqual(process.pid, pid);
        assert.equal(storage, prior);
        assert.deepEqual(await store.read(), expected);
        console.log("Recovery and subsequent unpin persisted across extension-host restart.");
      }
    };
  `);

  for (const stage of ["first", "second"]) {
    const workspace = join(root, stage);
    await mkdir(workspace);
    await runTests({
      vscodeExecutablePath: resolve(executable),
      extensionDevelopmentPath: extension,
      extensionTestsPath: tests,
      launchArgs: [
        "--ozone-platform=headless", "--disable-gpu", `--user-data-dir=${join(root, "profile")}`,
        `--extensions-dir=${join(root, "extensions")}`, workspace,
      ],
      extensionTestsEnv: {
        SOFT_START_RESTART_STAGE: stage,
        SOFT_START_OLD_JOURNAL: historical ? resolve(historical) : "",
        SOFT_START_CURRENT_JOURNAL: current ? resolve(current) : "",
      },
    });
  }
} finally {
  await rm(root, { recursive: true, force: true });
}
