import { welcomeStates, type WelcomeState } from "./startupPolicy";
import { isSettingsPatch, isSettingValue, settingKeys, type DashboardSettings, type SettingKey, type SettingsPatch } from "./dashboardSettings";
import { isQuickActionMessage, type QuickActionMessage } from "./quickActions";

export type ProjectKind = "folder" | "workspace";
export type ProjectItem = {
  id: string;
  name: string;
  path: string;
  hostLabel?: string;
  kind: ProjectKind;
  unresolved?: boolean;
  canRestoreName?: boolean;
};

export type RecentProjectItem = ProjectItem & { lastOpened: number };

export const settingsHostMeta = "soft-start-settings-host";
export const settingsHostVersion = "4";

export type SettingsMutation =
  | { type: "saveSettings"; changes: SettingsPatch; expected: SettingsPatch }
  | { type: "restoreSettings" }
  | { type: "browseProjectsDirectory" }
  | { type: "enableWelcomeReplacement" }
  | { type: "restoreWelcomeReplacement" };

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

export type ProjectRequest =
  | QuickActionMessage
  | { type: "viewAllRecentProjects" | "addPinnedProject" }
  | { type: "openRecentProject" | "removeRecentProject" | "pinRecentProject" |
      "openPinnedProject" | "renamePinnedProject" | "restorePinnedProjectName" |
      "locatePinnedProject" | "locateRecentProject"; id: string }
  | { type: "unpinProject"; id: string; section?: "recent" | "pins" }
  | { type: "reorderPinnedProjects"; ids: string[]; id?: string };

export type DashboardMessage = SettingsRequest | ProjectRequest | { type: "requestRecentProjects" };

export type ProjectLoadError = { type: "projectLoadError"; error: string; unsupportedStorage?: true };

export function isProjectLoadError(value: unknown): value is ProjectLoadError {
  return typeof value === "object" && value !== null &&
    "type" in value && value.type === "projectLoadError" && "error" in value && typeof value.error === "string" &&
    (!("unsupportedStorage" in value) || value.unsupportedStorage === true);
}

export type RecentProjectsMessage = { type: "recentProjects"; projects: RecentProjectItem[] };

export type PinnedProjectsMessage = { type: "pinnedProjects"; projects: ProjectItem[] };

export type ProjectActionTarget = { section: "pins" | "recent" | "quick"; id?: string };

export type ProjectChange = { kind: "pinned" | "reordered"; id: string };

export type ProjectActionMessage = {
  type: "projectAction";
  busy: boolean;
  error?: string;
  detail?: string;
  target?: ProjectActionTarget;
  change?: ProjectChange;
};

function isProjectActionTarget(value: unknown): value is ProjectActionTarget {
  return typeof value === "object" && value !== null && "section" in value &&
    (value.section === "pins" || value.section === "recent" || value.section === "quick") &&
    (!("id" in value) || value.id === undefined || isProjectId(value.id));
}

export function isProjectActionMessage(value: unknown): value is ProjectActionMessage {
  return typeof value === "object" && value !== null &&
    "type" in value && value.type === "projectAction" && "busy" in value && typeof value.busy === "boolean" &&
    (!("error" in value) || value.error === undefined || typeof value.error === "string") &&
    (!("detail" in value) || value.detail === undefined || typeof value.detail === "string") &&
    (!("target" in value) || value.target === undefined || isProjectActionTarget(value.target)) &&
    (!("change" in value) || value.change === undefined || (!value.busy && (!("error" in value) || !value.error) && isProjectChange(value.change)));
}

function isProjectChange(value: unknown): value is ProjectChange {
  return typeof value === "object" && value !== null && "kind" in value &&
    (value.kind === "pinned" || value.kind === "reordered") && "id" in value && isProjectId(value.id);
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
    case "restorePinnedProjectName":
    case "locatePinnedProject":
    case "locateRecentProject":
      return "id" in value && isProjectId(value.id);
    case "unpinProject":
      return "id" in value && isProjectId(value.id) &&
        (!("section" in value) || value.section === "pins" || value.section === "recent");
    case "reorderPinnedProjects":
      return "ids" in value && Array.isArray(value.ids) &&
        Array.from(value.ids).every(isProjectId) && new Set(value.ids).size === value.ids.length &&
        (!("id" in value) || (isProjectId(value.id) && value.ids.includes(value.id)));
    default:
      return false;
  }
}

function isProjectItem(value: unknown): value is ProjectItem {
  return typeof value === "object" && value !== null &&
    "id" in value && isProjectId(value.id) &&
    "name" in value && typeof value.name === "string" &&
    "path" in value && typeof value.path === "string" &&
    (!("canRestoreName" in value) || typeof value.canRestoreName === "boolean") &&
    (!("hostLabel" in value) || typeof value.hostLabel === "string") &&
    "kind" in value && (value.kind === "folder" || value.kind === "workspace") &&
    (!("unresolved" in value) || typeof value.unresolved === "boolean");
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
