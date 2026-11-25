import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import * as vscode from "vscode";
import type { ProjectOrigin } from "./projects";

type Host = Extract<ProjectOrigin, { kind: "host" }>;

export function projectHostIdentity(remote: string | undefined, machine: string, distro?: string): Host {
  return {
    kind: "host",
    key: createHash("sha256").update(JSON.stringify([remote ?? null, machine, distro ?? null])).digest("hex"),
    label: remote === "wsl" ? `WSL${distro ? ` (${distro})` : ""}` : remote === "ssh-remote" ? "Remote SSH" : remote ?? "Local",
  };
}

export async function currentProjectHost(): Promise<Host | undefined> {
  const remote = vscode.env.remoteName;
  if (!remote) {
    return projectHostIdentity(undefined, vscode.env.machineId);
  }
  const distro = remote === "wsl" ? process.env.WSL_DISTRO_NAME : undefined;
  if (remote === "wsl" && !distro) {
    return;
  }
  // env.machineId belongs to the client. Native files belong to the workspace host.
  for (const path of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) {
    const machine = await readFile(path, "utf8").catch(() => "");
    if (/^(?!0{32})[a-f0-9]{32}$/i.test(machine.trim())) {
      return projectHostIdentity(remote, machine.trim().toLowerCase(), distro);
    }
  }
}
