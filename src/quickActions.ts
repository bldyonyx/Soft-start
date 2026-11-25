const actions = ["newProject", "openFolder", "cloneRepository"] as const;

export type QuickActionMessage = {
  type: "quickAction";
  action: (typeof actions)[number];
};

export function isQuickActionMessage(value: unknown): value is QuickActionMessage {
  return typeof value === "object" && value !== null &&
    "type" in value && value.type === "quickAction" &&
    "action" in value && actions.some((action) => action === value.action);
}
