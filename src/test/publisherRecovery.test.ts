import * as assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as vscode from "vscode";
import { projectHostIdentity } from "../projectHost";
import { ProjectJournal } from "../projectJournal";
import { identifyProject, projectId, serializeUri } from "../projects";
import { ProjectStore, projectStoreAt } from "../projectStore";

const host = projectHostIdentity("wsl", "test-machine", "Ubuntu");
const otherHost = projectHostIdentity("wsl", "test-machine", "Debian");
const empty = { get: <T>(_key: string) => undefined as T | undefined };

function project(name: string) {
  return { uri: vscode.Uri.file(`/recovery-test/${name}`), name, kind: "folder" as const };
}

suite("Publisher-ID pin recovery", () => {
  let root: string;
  let history: ProjectJournal;
  let historicalScope: string;
  let currentScope: string;

  function current() {
    return projectStoreAt(currentScope, host, empty);
  }

  function historical() {
    return new ProjectStore(history, host, empty);
  }

  setup(async () => {
    root = await mkdtemp(join(tmpdir(), "soft-start-publisher-"));
    historicalScope = join(root, "undefined_publisher.soft-start", "projects-v2", host.key);
    currentScope = join(root, "bldyonyx.soft-start");
    history = new ProjectJournal(historicalScope);
  });

  teardown(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("replays active publisher-less pins with their metadata and order, leaving history untouched", async () => {
    const legacy = historical();
    await legacy.pin(project("first"), 101);
    await legacy.pin(project("second"), 102);
    await legacy.pin(project("removed"), 103);
    await legacy.record(project("second"), 104);
    const [first, second, removed] = (await legacy.read()).pins;
    await legacy.rename(second, "Custom title");
    await legacy.reorder([second.id, first.id, removed.id]);
    await legacy.unpin(removed.id);
    const oldFiles = await Promise.all((await readdir(historicalScope)).sort().map(async (name) =>
      [name, await readFile(join(historicalScope, name), "utf8")]));
    const { store } = current();
    assert.deepEqual(await store.read(), { pins: (await legacy.read()).pins, recent: [] });
    assert.deepEqual(await Promise.all((await readdir(historicalScope)).sort().map(async (name) =>
      [name, await readFile(join(historicalScope, name), "utf8")])), oldFiles);
  });

  test("keeps existing pin order, deduplicates, and respects removals using either identity", async () => {
    const { journal } = current();
    const original = new ProjectStore(journal, host, empty);
    await original.pin(project("keep"), 1);
    await original.pin(project("duplicate"), 2);
    await original.unpin(identifyProject(project("removed"), host).id);
    await original.unpin(projectId(project("legacy-removed").uri));

    const legacy = historical();
    for (const name of ["duplicate", "removed", "legacy-removed", "imported"]) {
      await legacy.pin(project(name), 8);
    }

    const { store } = current();
    assert.deepEqual((await store.read()).pins.map(({ name, pinnedAt }) => [name, pinnedAt]),
      [["keep", 1], ["duplicate", 2], ["imported", 8]]);
  });

  test("recognizes the verified counterpart of an unresolved historical URI", async () => {
    const previous = project("unresolved");
    await history.initialize({ version: 2, recent: null, pins: [{
      ...previous, id: projectId(previous.uri), uri: serializeUri(previous.uri), pinnedAt: 1,
    }] });
    const { journal } = current();
    const installed = new ProjectStore(journal, host, empty);
    await installed.unpin(identifyProject(previous, host).id);
    assert.deepEqual((await current().store.read()).pins, []);
  });

  test("recovers once across recreated stores and never restores a subsequently removed pin", async () => {
    await historical().pin(project("once"), 1);
    const { store, journal } = current();
    const [pin] = (await store.read()).pins;
    await store.unpin(pin.id);
    await historical().pin(project("later"), 2);
    assert.deepEqual((await current().store.read()).pins, []);
    assert.equal((await journal.events()).filter((event) =>
      (event as { type: string }).type === "recoverPublisherPins").length, 1);
  });

  test("concurrent host windows recover the same pins once in the effective list", async () => {
    await historical().pin(project("first"), 1);
    await historical().pin(project("second"), 2);
    const a = current().store;
    const b = current().store;
    const snapshots = await Promise.all([a.read(), b.read()]);
    for (const snapshot of snapshots) {
      assert.deepEqual(snapshot.pins.map(({ name }) => name), ["first", "second"]);
    }
    const { journal } = current();
    assert.equal((await journal.events()).length, 1);
    await a.unpin(snapshots[0].pins[0].id);
    assert.deepEqual((await b.read()).pins.map(({ name }) => name), ["second"]);
  });

  test("a failed publication keeps current pins available and can be retried", async () => {
    await historical().pin(project("recovered"), 1);
    const { journal } = current();
    await new ProjectStore(journal, host, empty).pin(project("current"), 2);
    let fail = true;
    const flaky = {
      initialize: (legacy: unknown) => journal.initialize(legacy),
      events: () => journal.events(),
      append: (event: unknown) => journal.append(event),
      publishPublisherRecovery: async (event: unknown) => {
        if (fail) {
          fail = false;
          throw new Error("Interrupted publication");
        }
        await journal.publishPublisherRecovery(event);
      },
    };
    const store = new ProjectStore(flaky, host, empty, history);
    assert.deepEqual((await store.read()).pins.map(({ name }) => name), ["current"]);
    assert.equal((await journal.events()).length, 1);
    assert.deepEqual((await store.read()).pins.map(({ name }) => name), ["current", "recovered"]);
  });

  test("missing history stays untouched and malformed history never records completion", async () => {
    const { journal } = current();
    const { store } = current();
    assert.deepEqual(await store.read(), { pins: [], recent: [] });
    assert.deepEqual(await journal.events(), []);
    await assert.rejects(readdir(historicalScope), { code: "ENOENT" });

    await mkdir(historicalScope, { recursive: true });
    const baseline = join(historicalScope, "legacy.json");
    const malformed = '{"version":2,"pins":[{}],"recent":null}';
    await writeFile(baseline, malformed);
    assert.deepEqual((await store.read()).pins, []);
    assert.deepEqual(await journal.events(), []);
    assert.equal(await readFile(baseline, "utf8"), malformed);

    await writeFile(baseline, '{"version":2,"pins":null,"recent":null}');
    await history.append({ type: "unsupported" });
    assert.deepEqual((await store.read()).pins, []);
    assert.deepEqual(await journal.events(), []);
  });

  test("recovery stays within the current profile, verified host, and permanent extension ID", async () => {
    await historical().pin(project("same host"), 1);
    await historical().pin(identifyProject(project("foreign origin"), otherHost), 2);
    const elsewhere = join(root, "different-profile", "bldyonyx.soft-start");
    for (const store of [
      projectStoreAt(elsewhere, host, empty).store,
      projectStoreAt(currentScope, otherHost, empty).store,
      projectStoreAt(currentScope, undefined, empty).store,
      projectStoreAt(join(root, "other.soft-start"), host, empty).store,
    ]) {
      assert.deepEqual((await store.read()).pins, []);
    }
    assert.deepEqual((await current().store.read()).pins.map(({ name }) => name), ["same host"]);
  });
});
