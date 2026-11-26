import { randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { watch } from "node:fs";

const recoveryName = "publisher-recovery.json";
const eventName = /^\d{16}-[a-f0-9-]{36}\.json$/;

export class ProjectJournal {
  constructor(private readonly root: string) {}

  async initialize(legacy: unknown): Promise<unknown> {
    await mkdir(this.root, { recursive: true });
    const baseline = await this.readBaseline();
    if (baseline !== undefined) {
      return baseline;
    }
    // Publish a fully written migration record exactly once, even with concurrent first windows.
    await this.publish("legacy.json", legacy, true);
    return JSON.parse(await readFile(join(this.root, "legacy.json"), "utf8"));
  }

  async readBaseline(): Promise<unknown> {
    return this.readOptional("legacy.json");
  }

  private async readOptional(name: string): Promise<unknown> {
    try {
      return JSON.parse(await readFile(join(this.root, name), "utf8"));
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") {
        throw error;
      }
    }
  }

  async events(): Promise<unknown[]> {
    // Read the recovery checkpoint first so its preceding events are present in
    // the subsequent directory listing, even if another host just published it.
    const recovery = await this.readOptional(recoveryName);
    const names = await this.eventNames();
    const events: unknown[] = [];
    for (const name of names) {
      events.push(JSON.parse(await readFile(join(this.root, name), "utf8")));
    }
    if (recovery !== undefined) {
      if (!recovery || typeof recovery !== "object" || !("afterSequence" in recovery) ||
          typeof recovery.afterSequence !== "number" || !Number.isSafeInteger(recovery.afterSequence) ||
          recovery.afterSequence < 0 || !("event" in recovery)) {
        throw new Error("Soft Start found an invalid publisher recovery record.");
      }
      const afterSequence = recovery.afterSequence;
      const next = names.findIndex((name) => Number(name.slice(0, 16)) > afterSequence);
      events.splice(next === -1 ? events.length : next, 0, recovery.event);
    }
    return events;
  }

  async publishPublisherRecovery(event: unknown): Promise<void> {
    const last = (await this.eventNames()).at(-1);
    const afterSequence = last ? Number(last.slice(0, 16)) : 0;
    // A fixed filename lets competing windows publish once atomically. Older
    // builds can still replay the ordinary journal without parsing this record.
    await this.publish(recoveryName, { afterSequence, event }, true);
  }

  private async eventNames(): Promise<string[]> {
    return (await readdir(this.root)).filter((name) => eventName.test(name)).sort();
  }

  async append(event: unknown): Promise<void> {
    const last = (await this.eventNames()).at(-1);
    const sequence = last ? Number(last.slice(0, 16)) + 1 : 1;
    if (!Number.isSafeInteger(sequence)) {
      throw new Error("Soft Start project journal sequence is exhausted.");
    }
    await this.publish(`${String(sequence).padStart(16, "0")}-${randomUUID()}.json`, event, false);
  }

  watch(change: () => void, error: (error: Error) => void) {
    const watcher = watch(this.root, (_, name) => {
      if (!name || eventName.test(name) || name === recoveryName) {
        change();
      }
    });
    watcher.on("error", error);
    return watcher;
  }

  private async publish(name: string, value: unknown, once: boolean): Promise<void> {
    const temporary = join(this.root, `.${randomUUID()}.tmp`);
    try {
      const file = await open(temporary, "wx", 0o600);
      try {
        await file.writeFile(JSON.stringify(value), "utf8");
        await file.sync();
      } finally {
        await file.close();
      }
      const target = join(this.root, name);
      try {
        await link(temporary, target);
      } catch (error) {
        if (!once || !(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") {
          throw error;
        }
      }
    } finally {
      await unlink(temporary).catch(() => {});
    }
  }
}
