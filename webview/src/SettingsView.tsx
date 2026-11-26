import { useId, type ReactNode } from "react";
import { contributes } from "../../package.json";
import { isStartupBehavior, type StartupBehavior } from "../../src/startupPolicy";
import { defaultSettings, kaomojiMaxLength, recentLimits, welcomeMaxLength, type SettingKey } from "../../src/dashboardSettings";
import type { useDashboardSettings } from "./useDashboardSettings";

const backgroundSwatches = [
  ["Midnight", defaultSettings.backgroundColor],
  ["Ink blue", "#131b2a"],
  ["Plum", "#23172b"],
] as const;
const accentSwatches = [
  ["Lavender", defaultSettings.accentColor],
  ["Soft blue", "#a0d8f2"],
  ["Rose", "#edb5c9"],
] as const;

const sections = [
  ["appearance-settings", "Appearance"],
  ["dashboard-settings", "Dashboard"],
  ["projects-settings", "Projects"],
  ["startup-settings", "Startup"],
] as const;

const startupDescriptions: Record<StartupBehavior, string> = {
  always: "Opens in every window, beside any restored editors.",
  emptyWindow: "Opens in windows without a workspace, folder, or restored tabs.",
  never: "Opens only when you ask.",
};

const dashboardKeybinding = contributes.keybindings.find(({ command }) => command === "soft-start.openDashboard");
const dashboardShortcut = (navigator.platform.startsWith("Mac") ? dashboardKeybinding?.mac : dashboardKeybinding?.key)
  ?.split("+").map((key) => key[0].toUpperCase() + key.slice(1)).join(" + ");

function jumpTo(id: string) {
  const target = document.getElementById(id);
  target?.focus({ preventScroll: true });
  target?.scrollIntoView({ block: "start" });
}

function ColorControl({ label, value, draft, invalid, swatches, change }: {
  label: string;
  value: string;
  draft: string;
  invalid: boolean;
  swatches: readonly (readonly [string, string])[];
  change: (color: string) => void;
}) {
  const id = useId();
  return (
    <div className="settings-field settings-color" role="group" aria-labelledby={id}>
      <span className="settings-label" id={id}>{label}</span>
      <div className="settings-color-entry">
        <input type="color" value={value} aria-label={`Pick ${label.toLowerCase()}`}
          onChange={(event) => change(event.currentTarget.value)} />
        <input type="text" className="settings-hex" value={draft} maxLength={7} placeholder="#RRGGBB"
          aria-label={`${label} hex value`} aria-invalid={invalid || undefined} aria-describedby={invalid ? `${id}-error` : undefined}
          autoComplete="off" spellCheck={false} onChange={(event) => change(event.currentTarget.value.toLowerCase())} />
      </div>
      {invalid && <p className="settings-field-error" id={`${id}-error`}>Enter a hex color such as #c5b3e5.</p>}
      <div className="settings-actions">
        {swatches.map(([name, color]) => (
          <button type="button" className="settings-swatch" key={color} aria-pressed={!invalid && value.toLowerCase() === color}
            ref={(button) => { button?.style.setProperty("--swatch", color); }} onClick={() => change(color)}>
            <span className="settings-swatch-dot" aria-hidden="true" />
            {name}
            <span className="settings-swatch-check" aria-hidden="true">✓</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function RangeControl({ label, value, min = 0, max = 100, unit = "", change }: {
  label: string;
  value: number;
  min?: number;
  max?: number;
  unit?: string;
  change: (value: number) => void;
}) {
  const id = useId();
  return (
    <div className="settings-range">
      <label htmlFor={id} className="settings-label">{label}</label>
      <span className="settings-range-value" aria-hidden="true">{value}{unit}</span>
      <input id={id} type="range" min={min} max={max} value={value} aria-valuetext={unit ? `${value} percent` : undefined}
        onChange={(event) => change(event.currentTarget.valueAsNumber)} />
    </div>
  );
}

const settingLabels: Record<SettingKey, string> = {
  backgroundColor: "Background color", accentColor: "Accent color", panelOpacity: "Panel opacity",
  artworkVisible: "Background artwork visibility", artworkOpacity: "Artwork opacity", welcomeMessage: "Welcome message",
  headerKaomoji: "Header kaomoji", decorativeSymbols: "Decorative symbols", recentProjectsLimit: "Visible recent projects",
  startupBehavior: "Startup behavior", showStatusBarItem: "Show Soft Start in the status bar", projectsDirectory: "Projects directory",
};

export function SettingsView({ settings, back, preview }: {
  settings: ReturnType<typeof useDashboardSettings>;
  back: () => void;
  preview: ReactNode;
}) {
  const { preview: current, saved, edit, colorDraft, invalidColors, canSave } = settings;
  const feedback = settings.feedback;
  const error = Boolean(settings.syncError || settings.unknown || feedback?.outcome === "rejected" || feedback?.outcome === "partial");
  const status = settings.pending ? "Waiting for the settings action to finish…"
    : settings.rechecking ? "Checking saved settings…"
    : settings.syncError ?? (settings.unknown ? "The action’s outcome is unknown. Check saved settings before trying again."
      : settings.hostBusy ? "Another settings action is running."
      : feedback?.detail ?? (!settings.ready ? "Loading saved settings…" : settings.dirty ? "" : "Saved settings loaded."));
  const saveState = settings.pendingAction === "saveSettings" ? "Saving changes…"
    : settings.pendingAction === "restoreSettings" ? "Restoring defaults…"
    : settings.pending ? "Working…" : settings.rechecking ? "Checking settings…"
    : settings.unknown ? "Save status unknown" : !canSave ? "Review color values"
    : settings.dirty ? "Unsaved changes" : settings.ready ? "Up to date" : "Preview only";
  const rejected = Object.entries(feedback?.writes?.rejected ?? {}) as [SettingKey, string][];
  const directoryError = current.projectsDirectory === feedback?.rejectedDirectory ? feedback?.writes?.rejected.projectsDirectory : undefined;
  const needsReview = error || settings.hostBusy;
  const saveDisabled = !settings.ready || settings.pending || settings.rechecking || !settings.dirty || !canSave;

  return (
    <main className="dashboard settings-view" aria-labelledby="settings-title">
      <header className="dashboard-header settings-header">
        <h1 id="settings-title">Settings</h1>
        <button type="button" className="settings-back" data-view-focus onClick={back}>Back to dashboard</button>
      </header>

      <div className="settings-savebar">
        <div>
          <p className="settings-save-state" data-dirty={settings.dirty || undefined}>{saveState}</p>
          {needsReview && <button type="button" className="settings-text-button" onClick={() => jumpTo("settings-feedback")}>Review feedback</button>}
        </div>
        <button type="submit" form="settings-form" className="settings-save" disabled={saveDisabled}>Save changes</button>
      </div>
      <div className="settings-status" id="settings-feedback" tabIndex={-1}>
        <div role={error ? "alert" : "status"}>
          {status && <p>{status}</p>}
          {!settings.pending && rejected.length > 0 && (
            <ul>
              {rejected.map(([key, detail]) => <li key={key}>{settingLabels[key]} — {detail}</li>)}
            </ul>
          )}
        </div>
        {settings.retry && !settings.rechecking && (settings.syncError || settings.unknown || settings.hostBusy) && (
          <button type="button" onClick={settings.retry}>
            {settings.unknown || settings.hostBusy ? "Check saved settings" : "Retry"}
          </button>
        )}
      </div>

      <section className="settings-preview" aria-labelledby="preview-title">
        <h2 id="preview-title" className="section-title">Live preview</h2>
        {preview}
      </section>

      <nav aria-label="Settings sections" className="settings-nav">
        {sections.map(([id, label]) => (
          <a key={id} href={`#${id}`} onClick={(event) => { event.preventDefault(); jumpTo(id); }}>{label}</a>
        ))}
      </nav>

      <form id="settings-form" onSubmit={(event) => {
        event.preventDefault();
        if (!saveDisabled) settings.save();
      }}>
        <fieldset disabled={settings.pending}>
          <legend id="appearance-settings" tabIndex={-1}>Appearance</legend>
          <ColorControl label="Background color" value={current.backgroundColor} draft={colorDraft.backgroundColor}
            invalid={invalidColors.backgroundColor} swatches={backgroundSwatches} change={(value) => edit("backgroundColor", value)} />
          <ColorControl label="Accent color" value={current.accentColor} draft={colorDraft.accentColor}
            invalid={invalidColors.accentColor} swatches={accentSwatches} change={(value) => edit("accentColor", value)} />
          <RangeControl label="Panel opacity" value={current.panelOpacity} unit="%" change={(value) => edit("panelOpacity", value)} />
          <label className="settings-check">
            <input type="checkbox" checked={current.artworkVisible} onChange={(event) => edit("artworkVisible", event.currentTarget.checked)} />
            <span>Show background artwork</span>
          </label>
          <RangeControl label="Artwork opacity" value={current.artworkOpacity} unit="%" change={(value) => edit("artworkOpacity", value)} />
        </fieldset>

        <fieldset disabled={settings.pending}>
          <legend id="dashboard-settings" tabIndex={-1}>Dashboard</legend>
          <label>
            <span className="settings-label">Welcome message</span>
            <input type="text" maxLength={welcomeMaxLength} value={current.welcomeMessage}
              onChange={(event) => edit("welcomeMessage", event.currentTarget.value)} />
          </label>
          <label>
            <span className="settings-label">Header kaomoji</span>
            <input type="text" maxLength={kaomojiMaxLength} value={current.headerKaomoji}
              onChange={(event) => edit("headerKaomoji", event.currentTarget.value)} />
          </label>
          <label className="settings-check">
            <input type="checkbox" checked={current.decorativeSymbols}
              onChange={(event) => edit("decorativeSymbols", event.currentTarget.checked)} />
            <span>Show decorative symbols</span>
          </label>
          <RangeControl label="Visible recent projects" value={current.recentProjectsLimit}
            min={recentLimits.min} max={recentLimits.max} change={(value) => edit("recentProjectsLimit", value)} />
        </fieldset>

        <fieldset disabled={settings.pending}>
          <legend id="projects-settings" tabIndex={-1}>Projects</legend>
          <div className="settings-field">
            <label htmlFor="projects-directory" className="settings-label">Projects directory</label>
            <div className="settings-directory-entry">
              <input id="projects-directory" type="text" value={current.projectsDirectory}
                aria-describedby={directoryError ? "directory-help directory-error" : "directory-help"} aria-invalid={Boolean(directoryError) || undefined}
                placeholder="Ask when creating a project" spellCheck={false}
                onChange={(event) => edit("projectsDirectory", event.currentTarget.value)} />
              <div className="settings-actions">
                <button type="button" disabled={!settings.ready} onClick={settings.browse}>Browse…</button>
                <button type="button" disabled={!current.projectsDirectory} onClick={() => edit("projectsDirectory", "")}>Clear</button>
              </div>
            </div>
            <p id="directory-help" className="settings-help">Use an absolute path on the active VS Code host. Leave blank to choose each time.</p>
            {directoryError && <p id="directory-error" className="settings-field-error">{directoryError}</p>}
            {saved.projectsDirectory !== current.projectsDirectory && (
              <p className="settings-directory settings-help">Saved directory <strong>{saved.projectsDirectory || "Ask when creating a project"}</strong></p>
            )}
          </div>
        </fieldset>

        <fieldset disabled={!settings.ready || settings.pending || !settings.welcome}>
          <legend id="startup-settings" tabIndex={-1}>Startup</legend>
          <div className="settings-field">
            <label htmlFor="startup-behavior" className="settings-label">Startup behavior</label>
            <select id="startup-behavior" value={current.startupBehavior} aria-describedby="startup-behavior-help native-startup-help" onChange={(event) => {
              const value = event.currentTarget.value;
              if (isStartupBehavior(value)) edit("startupBehavior", value);
            }}>
              <option value="always">Always</option>
              <option value="emptyWindow">Empty windows only</option>
              <option value="never">Never</option>
            </select>
            <p id="startup-behavior-help" className="settings-help">{startupDescriptions[current.startupBehavior]}</p>
          </div>
          <div className="settings-field">
            <p id="native-startup-help" className="settings-help">
              Automatic opening requires VS Code’s Startup Editor to be <strong>None</strong>. Replacing the Welcome page sets this for you.
            </p>
            {settings.welcome === "changed" && <p>A VS Code preference is overriding the startup replacement.</p>}
            {settings.welcomeGuidance && <p id="welcome-restore-guidance">{settings.welcomeGuidance}</p>}
            {settings.welcome === "otherHost" && <p>Open the original VS Code host to restore its saved startup preference.</p>}
            <div className="settings-actions">
              <button type="button" disabled={settings.welcome !== "available" && settings.welcome !== "changed"} onClick={settings.enableWelcome}>Replace VS Code Welcome page</button>
              <button type="button" disabled={settings.welcome !== "active" && settings.welcome !== "changed"}
                aria-describedby={settings.welcomeGuidance ? "welcome-restore-guidance" : undefined}
                onClick={settings.restoreWelcome}>
                {settings.welcomeGuidance ? "Disable Soft Start automatic startup" : "Restore original VS Code startup page"}
              </button>
            </div>
          </div>
          <label className="settings-check">
            <input type="checkbox" checked={current.showStatusBarItem}
              onChange={(event) => edit("showStatusBarItem", event.currentTarget.checked)} />
            <span>Show Soft Start in the status bar</span>
          </label>
          <div className="settings-shortcut">
            {dashboardShortcut && <p><span className="settings-label">Default dashboard shortcut</span> <kbd>{dashboardShortcut}</kbd></p>}
            <p className="settings-help">Search for <strong>Soft Start</strong> in VS Code’s Keyboard Shortcuts to customize it.</p>
          </div>
        </fieldset>

        <div className="settings-reset">
          <p id="restore-scope" className="settings-help">Resets Appearance and Dashboard settings. Keeps startup preferences, the status bar setting, the projects directory, pins, and recent projects.</p>
          <button type="button" disabled={!settings.ready || settings.pending || settings.rechecking}
            aria-describedby="restore-scope" onClick={settings.restore}>Restore Defaults</button>
        </div>
      </form>
    </main>
  );
}
