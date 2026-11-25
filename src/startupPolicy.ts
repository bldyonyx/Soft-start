export const startupBehaviors = ["emptyWindow", "always", "never"] as const;
export type StartupBehavior = (typeof startupBehaviors)[number];

export function isStartupBehavior(value: unknown): value is StartupBehavior {
  return startupBehaviors.some((behavior) => behavior === value);
}

export const welcomeStates = ["available", "active", "changed", "otherHost"] as const;
export type WelcomeState = (typeof welcomeStates)[number];

export function shouldOpenAtStartup(
  behavior: unknown,
  nativeStartupEditor: unknown,
  window: { hasWorkspaceFile: boolean; folderCount: number; hasTabs: boolean },
): boolean {
  if (nativeStartupEditor !== "none") {
    return false;
  }
  return behavior === "always" || (
    behavior === "emptyWindow" && !window.hasWorkspaceFile && window.folderCount === 0 && !window.hasTabs
  );
}
