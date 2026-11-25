import { welcomeStates, type WelcomeState } from "./startupPolicy";
import { isSettingsPatch, isSettingValue, settingKeys, type DashboardSettings, type SettingsPatch } from "./dashboardSettings";
import { isQuickActionMessage, type QuickActionMessage } from "./quickActions";

export type ProjectKind = "folder" | "workspace";
export type ProjectItem = {
  id: string;
  name: string;
  path: string;
  kind: ProjectKind;
};

export type RecentProjectItem = ProjectItem & { lastOpened: number };

export const settingsHostMeta = "soft-start-settings-host";
export const settingsHostVersion = "2";

export type SettingsRequest =
  | { type: "requestSettings" }
  | { type: "saveSettings"; changes: SettingsPatch }
  | { type: "restoreSettings" }
  | { type: "browseProjectsDirectory" }
  | { type: "enableWelcomeReplacement" | "restoreWelcomeReplacement" };

export type SettingsMessage =
  | { type: "settings"; settings: DashboardSettings; welcome?: WelcomeState }
  | { type: "settingsResult"; settings: DashboardSettings; welcome?: WelcomeState; error?: string; directory?: string; status?: string }
  | { type: "settingsLoadError"; error: string };

export type DashboardMessage =
  | SettingsRequest
  | QuickActionMessage
  | { type: "requestRecentProjects" | "viewAllRecentProjects" }
  | { type: "addPinnedProject" }
  | { type: "openRecentProject" | "removeRecentProject" | "pinRecentProject" |
      "openPinnedProject" | "renamePinnedProject" | "unpinProject"; id: string }
  | { type: "reorderPinnedProjects"; ids: string[] };

export type RecentProjectsMessage = { type: "recentProjects"; projects: RecentProjectItem[] };

export type PinnedProjectsMessage = { type: "pinnedProjects"; projects: ProjectItem[] };

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
    case "requestSettings":
    case "restoreSettings":
    case "browseProjectsDirectory":
    case "enableWelcomeReplacement":
    case "restoreWelcomeReplacement":
      return true;
    case "saveSettings":
      return "changes" in value && isSettingsPatch(value.changes);
    case "requestRecentProjects":
    case "viewAllRecentProjects":
    case "addPinnedProject":
      return true;
    case "openRecentProject":
    case "removeRecentProject":
    case "pinRecentProject":
    case "openPinnedProject":
    case "renamePinnedProject":
    case "unpinProject":
      return "id" in value && isProjectId(value.id);
    case "reorderPinnedProjects":
      return "ids" in value && Array.isArray(value.ids) &&
        Array.from(value.ids).every(isProjectId) && new Set(value.ids).size === value.ids.length;
    default:
      return false;
  }
}

function isProjectItem(value: unknown): value is ProjectItem {
  return typeof value === "object" && value !== null &&
    "id" in value && isProjectId(value.id) &&
    "name" in value && typeof value.name === "string" &&
    "path" in value && typeof value.path === "string" &&
    "kind" in value && (value.kind === "folder" || value.kind === "workspace");
}

export function isProjectTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 8.64e15;
}

function isRecentProjectItem(value: unknown): value is RecentProjectItem {
  return isProjectItem(value) && "lastOpened" in value && isProjectTimestamp(value.lastOpened);
}

export function isRecentProjectsMessage(value: unknown): value is RecentProjectsMessage {
  return typeof value === "object" && value !== null &&
    "type" in value && value.type === "recentProjects" &&
    "projects" in value && Array.isArray(value.projects) && value.projects.every(isRecentProjectItem);
}


export function isPinnedProjectsMessage(value: unknown): value is PinnedProjectsMessage {
  return typeof value === "object" && value !== null &&
    "type" in value && value.type === "pinnedProjects" &&
    "projects" in value && Array.isArray(value.projects) && value.projects.every(isProjectItem);
}


export function isSettingsMessage(value: unknown): value is SettingsMessage {
  if (typeof value !== "object" || value === null || !("type" in value)) {
    return false;
  }
  if (value.type === "settingsLoadError") {
    return "error" in value && typeof value.error === "string";
  }
  if ((value.type !== "settings" && value.type !== "settingsResult") ||
      !("settings" in value) || typeof value.settings !== "object" || value.settings === null) {
    return false;
  }
  const settings = value.settings as Record<string, unknown>;
  return settingKeys.every((key) => Object.hasOwn(settings, key) && isSettingValue(key, settings[key])) &&
    (!("welcome" in value) || value.welcome === undefined || welcomeStates.some((state) => state === value.welcome)) &&
    (!("error" in value) || value.error === undefined || typeof value.error === "string") &&
    (!("directory" in value) || value.directory === undefined || isSettingValue("projectsDirectory", value.directory)) &&
    (!("status" in value) || value.status === undefined || typeof value.status === "string");
}
