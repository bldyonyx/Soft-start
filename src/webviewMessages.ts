import { isQuickActionMessage, type QuickActionMessage } from "./quickActions";

export type RecentProjectKind = "folder" | "workspace";
export type RecentProjectItem = {
  id: string;
  name: string;
  path: string;
  kind: RecentProjectKind;
  lastOpened: number;
};

export type DashboardMessage =
  | QuickActionMessage
  | { type: "requestRecentProjects" | "viewAllRecentProjects" }
  | { type: "openRecentProject" | "removeRecentProject"; id: string };

export type RecentProjectsMessage = { type: "recentProjects"; projects: RecentProjectItem[] };

function isProjectId(value: unknown): value is string {
  return typeof value === "string" && value.length === 64 && /^[a-f0-9]+$/.test(value);
}

export function isDashboardMessage(value: unknown): value is DashboardMessage {
  if (isQuickActionMessage(value)) {
    return true;
  }
  if (typeof value !== "object" || value === null || !("type" in value)) {
    return false;
  }
  switch (value.type) {
    case "requestRecentProjects":
    case "viewAllRecentProjects":
      return true;
    case "openRecentProject":
    case "removeRecentProject":
      return "id" in value && isProjectId(value.id);
    default:
      return false;
  }
}

function isRecentProjectItem(value: unknown): value is RecentProjectItem {
  return typeof value === "object" && value !== null &&
    "id" in value && isProjectId(value.id) &&
    "name" in value && typeof value.name === "string" &&
    "path" in value && typeof value.path === "string" &&
    "kind" in value && (value.kind === "folder" || value.kind === "workspace") &&
    "lastOpened" in value && typeof value.lastOpened === "number" &&
    Number.isInteger(value.lastOpened) && value.lastOpened >= 0 && value.lastOpened <= 8.64e15;
}

export function isRecentProjectsMessage(value: unknown): value is RecentProjectsMessage {
  return typeof value === "object" && value !== null &&
    "type" in value && value.type === "recentProjects" &&
    "projects" in value && Array.isArray(value.projects) && value.projects.every(isRecentProjectItem);
}
