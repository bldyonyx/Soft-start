export const defaultSettings = {
  backgroundColor: "#080709",
  accentColor: "#c5b3e5",
  panelOpacity: 85,
  artworkVisible: true,
  artworkOpacity: 14,
  welcomeMessage: "Ready when you are",
  headerKaomoji: "૮ ᴗ͈ ˕ ✙╿ྀི꒱",
  decorativeSymbols: true,
  recentProjectsLimit: 4,
  projectsDirectory: "",
};

export type DashboardSettings = typeof defaultSettings;
export type SettingKey = keyof DashboardSettings;
export type SettingsPatch = Partial<DashboardSettings>;

export const welcomeMaxLength = 160;
export const kaomojiMaxLength = 80;
export const recentLimits = { min: 1, max: 10 };

export const settingKeys = Object.keys(defaultSettings) as SettingKey[];
export const customizationKeys = settingKeys.filter((key) => key !== "projectsDirectory");

function integerIn(value: unknown, min: number, max: number) {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

export function isSettingValue<K extends SettingKey>(key: K, value: unknown): value is DashboardSettings[K] {
  switch (key) {
    case "backgroundColor":
    case "accentColor":
      return typeof value === "string" && /^#[\da-f]{6}$/i.test(value);
    case "panelOpacity":
    case "artworkOpacity":
      return integerIn(value, 0, 100);
    case "recentProjectsLimit":
      return integerIn(value, recentLimits.min, recentLimits.max);
    case "artworkVisible":
    case "decorativeSymbols":
      return typeof value === "boolean";
    case "welcomeMessage":
    case "headerKaomoji":
      return typeof value === "string" && !/[\r\n\0]/u.test(value) &&
        value.length <= (key === "welcomeMessage" ? welcomeMaxLength : kaomojiMaxLength);
    case "projectsDirectory":
      return typeof value === "string" && !/[\r\n\0]/u.test(value);
    default:
      return false;
  }
}

export function isSettingsPatch(value: unknown): value is SettingsPatch {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const entries = Object.entries(value);
  return entries.length > 0 && entries.every(([key, item]) =>
    Object.hasOwn(defaultSettings, key) && isSettingValue(key as SettingKey, item));
}

export function visibleRecentProjects<T>(projects: readonly T[], limit: number) {
  return projects.slice(0, integerIn(limit, recentLimits.min, recentLimits.max) ? limit : defaultSettings.recentProjectsLimit);
}
