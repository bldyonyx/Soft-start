import { randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { watch } from "node:fs";

const eventName = /^\d{16}-[a-f0-9-]{36}\.json$/;

export class ProjectJournal {
  constructor(private readonly root: string) {}

  async initialize(legacy: unknown): Promise<unknown> {
    await mkdir(this.root, { recursive: true });
    const baseline = join(this.root, "legacy.json");
    try {
      return JSON.parse(await readFile(baseline, "utf8"));
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") {
        throw error;
      }
    }
    // Publish a fully written migration record exactly once, even with concurrent first windows.
    await this.publish("legacy.json", legacy, true);
    return JSON.parse(await readFile(baseline, "utf8"));
  }

  async events(): Promise<unknown[]> {
    const names = (await readdir(this.root)).filter((name) => eventName.test(name)).sort();
    const events: unknown[] = [];
    for (const name of names) {
      events.push(JSON.parse(await readFile(join(this.root, name), "utf8")));
    }
    return events;
  }

  async append(event: unknown): Promise<void> {
    const last = (await readdir(this.root)).filter((name) => eventName.test(name)).sort().at(-1);
    const sequence = last ? Number(last.slice(0, 16)) + 1 : 1;
    if (!Number.isSafeInteger(sequence)) {
      throw new Error("Soft Start project journal sequence is exhausted.");
    }
    await this.publish(`${String(sequence).padStart(16, "0")}-${randomUUID()}.json`, event, false);
  }

  watch(change: () => void, error: (error: Error) => void) {
    const watcher = watch(this.root, (_, name) => {
      if (!name || eventName.test(name)) {
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
