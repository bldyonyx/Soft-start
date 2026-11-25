import { welcomeStates, type WelcomeState } from "./startupPolicy";
import { isSettingsPatch, isSettingValue, settingKeys, type DashboardSettings, type SettingKey, type SettingsPatch } from "./dashboardSettings";
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
export const settingsHostVersion = "3";

export type SettingsMutation =
  | { type: "saveSettings"; changes: SettingsPatch; expected: SettingsPatch }
  | { type: "restoreSettings" }
  | { type: "browseProjectsDirectory" }
  | { type: "enableWelcomeReplacement" | "restoreWelcomeReplacement" };

export type SettingsRequest =
  | { type: "requestSettings"; recover?: string }
  | (SettingsMutation & { requestId: string });

export type SettingsWriteReport = {
  applied: SettingKey[];
  rejected: Partial<Record<SettingKey, string>>;
};

export type SettingsOutcome = {
  requestId: string;
  outcome: "success" | "partial" | "rejected" | "cancelled";
  writes?: SettingsWriteReport;
  detail?: string;
  directory?: string;
};

type SettingsSnapshot = {
  revision: number;
  settings: DashboardSettings;
  busy: boolean;
  welcome?: WelcomeState;
  welcomeGuidance?: string;
};

export type SettingsMessage =
  | ({ type: "settings"; recover?: string } & SettingsSnapshot)
  | ({ type: "settingsResult" } & SettingsSnapshot & SettingsOutcome)
  | { type: "settingsLoadError"; revision: number; error: string };

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

export type ProjectActionMessage = { type: "projectAction"; busy: boolean; error?: string };

export function isProjectActionMessage(value: unknown): value is ProjectActionMessage {
  return typeof value === "object" && value !== null &&
    "type" in value && value.type === "projectAction" && "busy" in value && typeof value.busy === "boolean" &&
    (!("error" in value) || value.error === undefined || typeof value.error === "string");
}

function isProjectId(value: unknown): value is string {
  return typeof value === "string" && value.length === 64 && /^[a-f0-9]+$/.test(value);
}

function isRequestId(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9-]{1,80}$/.test(value);
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
      return !("recover" in value) || value.recover === undefined || isRequestId(value.recover);
    case "restoreSettings":
    case "browseProjectsDirectory":
    case "enableWelcomeReplacement":
    case "restoreWelcomeReplacement":
      return "requestId" in value && isRequestId(value.requestId);
    case "saveSettings":
      if (!("requestId" in value) || !isRequestId(value.requestId) ||
          !("changes" in value) || !isSettingsPatch(value.changes) ||
          !("expected" in value) || !isSettingsPatch(value.expected)) {
        return false;
      }
      const { changes, expected } = value;
      return Object.keys(changes).length === Object.keys(expected).length &&
        Object.keys(changes).every((key) => Object.hasOwn(expected, key));
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


function isWriteReport(value: unknown): value is SettingsWriteReport {
  return typeof value === "object" && value !== null &&
    "applied" in value && Array.isArray(value.applied) && Array.from(value.applied).every(isSettingKey) &&
    "rejected" in value && typeof value.rejected === "object" && value.rejected !== null &&
    !Array.isArray(value.rejected) &&
    Object.entries(value.rejected).every(([key, error]) => isSettingKey(key) && typeof error === "string");
}

function isSettingKey(value: unknown): value is SettingKey {
  return settingKeys.some((key) => key === value);
}

export function isSettingsMessage(value: unknown): value is SettingsMessage {
  if (typeof value !== "object" || value === null || !("type" in value) ||
      !("revision" in value) || typeof value.revision !== "number" ||
      !Number.isSafeInteger(value.revision) || value.revision < 1) {
    return false;
  }
  if (value.type === "settingsLoadError") {
    return "error" in value && typeof value.error === "string";
  }
  if ((value.type !== "settings" && value.type !== "settingsResult") ||
      !("settings" in value) || typeof value.settings !== "object" || value.settings === null ||
      !("busy" in value) || typeof value.busy !== "boolean") {
    return false;
  }
  const settings = value.settings as Record<string, unknown>;
  if (!settingKeys.every((key) => Object.hasOwn(settings, key) && isSettingValue(key, settings[key])) ||
      ("welcome" in value && value.welcome !== undefined && !welcomeStates.some((state) => state === value.welcome)) ||
      ("welcomeGuidance" in value && value.welcomeGuidance !== undefined && typeof value.welcomeGuidance !== "string")) {
    return false;
  }
  if (value.type === "settings") {
    return !("recover" in value) || value.recover === undefined || isRequestId(value.recover);
  }
  return "requestId" in value && isRequestId(value.requestId) &&
    "outcome" in value && (value.outcome === "success" || value.outcome === "partial" ||
      value.outcome === "rejected" || value.outcome === "cancelled") &&
    (!("writes" in value) || value.writes === undefined || isWriteReport(value.writes)) &&
    (!("detail" in value) || value.detail === undefined || typeof value.detail === "string") &&
    (!("directory" in value) || value.directory === undefined || isSettingValue("projectsDirectory", value.directory));
}
