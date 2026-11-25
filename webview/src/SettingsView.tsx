import { isStartupBehavior } from "../../src/startupPolicy";
import type { ReactNode } from "react";
import { defaultSettings, kaomojiMaxLength, recentLimits, welcomeMaxLength } from "../../src/dashboardSettings";
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

function ColorControl({ label, value, swatches, change }: {
  label: string;
  value: string;
  swatches: readonly (readonly [string, string])[];
  change: (color: string) => void;
}) {
  return (
    <div className="settings-field" role="group" aria-label={label}>
      <label>{label}<input type="color" value={value} onChange={(event) => change(event.currentTarget.value)} /></label>
      <div className="settings-actions">
        {swatches.map(([name, color]) => (
          <button type="button" className="settings-swatch" key={color} aria-pressed={value.toLowerCase() === color}
            ref={(button) => { button?.style.setProperty("--swatch", color); }} onClick={() => change(color)}>
            {name}
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
  return (
    <div className="settings-range">
      <label>
        {label}
        <input type="range" min={min} max={max} value={value} aria-valuetext={`${value}${unit}`}
          onChange={(event) => change(event.currentTarget.valueAsNumber)} />
      </label>
      <output aria-hidden="true">{value}{unit}</output>
    </div>
  );
}

export function SettingsView({ settings, back, preview }: {
  settings: ReturnType<typeof useDashboardSettings>;
  back: () => void;
  preview: ReactNode;
}) {
  const { preview: current, saved, edit } = settings;

  return (
    <main className="dashboard settings-view" aria-labelledby="settings-title">
      <header className="dashboard-header">
        <h1 id="settings-title">Settings</h1>
        <button type="button" data-view-focus onClick={back}>Back to dashboard</button>
      </header>

      <section aria-labelledby="preview-title">
        <h2 id="preview-title" className="section-title">Preview</h2>
        {preview}
      </section>

      <form onSubmit={(event) => {
        event.preventDefault();
        if (settings.dirty) {
          settings.save();
        }
      }}>
        <fieldset disabled={settings.pending}>
          <legend>Appearance</legend>
          <ColorControl label="Background color" value={current.backgroundColor} swatches={backgroundSwatches}
            change={(value) => edit("backgroundColor", value)} />
          <ColorControl label="Accent color" value={current.accentColor} swatches={accentSwatches}
            change={(value) => edit("accentColor", value)} />
          <RangeControl label="Panel opacity" value={current.panelOpacity} unit="%" change={(value) => edit("panelOpacity", value)} />
          <label className="settings-check">
            <input type="checkbox" checked={current.artworkVisible} onChange={(event) => edit("artworkVisible", event.currentTarget.checked)} />
            Show background artwork
          </label>
          <RangeControl label="Artwork opacity" value={current.artworkOpacity} unit="%" change={(value) => edit("artworkOpacity", value)} />
        </fieldset>

        <fieldset disabled={settings.pending}>
          <legend>Dashboard</legend>
          <label>
            Welcome message
            <input type="text" maxLength={welcomeMaxLength} value={current.welcomeMessage}
              onChange={(event) => edit("welcomeMessage", event.currentTarget.value)} />
          </label>
          <label>
            Header kaomoji
            <input type="text" maxLength={kaomojiMaxLength} value={current.headerKaomoji}
              onChange={(event) => edit("headerKaomoji", event.currentTarget.value)} />
          </label>
          <label className="settings-check">
            <input type="checkbox" checked={current.decorativeSymbols}
              onChange={(event) => edit("decorativeSymbols", event.currentTarget.checked)} />
            Show decorative symbols
          </label>
          <RangeControl label="Visible recent projects" value={current.recentProjectsLimit}
            min={recentLimits.min} max={recentLimits.max} change={(value) => edit("recentProjectsLimit", value)} />
        </fieldset>

        <fieldset disabled={settings.pending}>
          <legend>Projects</legend>
          <p className="settings-directory">Current directory <strong>{saved.projectsDirectory || "Ask when creating a project"}</strong></p>
          <label>
            Projects directory
            <input type="text" value={current.projectsDirectory} aria-describedby="directory-help"
              onChange={(event) => edit("projectsDirectory", event.currentTarget.value)} />
          </label>
          <p id="directory-help">Use an absolute path on the active VS Code host.</p>
          <div className="settings-actions">
            <button type="button" disabled={!settings.ready} onClick={settings.browse}>Browse…</button>
            <button type="button" disabled={!current.projectsDirectory} onClick={() => edit("projectsDirectory", "")}>Clear</button>
          </div>
        </fieldset>

        <fieldset disabled={!settings.ready || settings.pending || !settings.welcome}>
          <legend>Startup</legend>
          <p>Replacing the Welcome page sets VS Code’s Startup Editor to None.</p>
          <label>
            Startup behavior
            <select value={current.startupBehavior} aria-describedby="startup-behavior-help" onChange={(event) => {
              const value = event.currentTarget.value;
              if (isStartupBehavior(value)) edit("startupBehavior", value);
            }}>
              <option value="emptyWindow">Empty windows only</option>
              <option value="always">Always</option>
              <option value="never">Never</option>
            </select>
          </label>
          <p id="startup-behavior-help">Empty windows only skips restored tabs. Always includes workspaces and preserves focus on open editors. Never opens Soft Start only on demand. Automatic opening requires VS Code’s Startup Editor to be None.</p>
          {settings.welcome === "changed" && <p>A VS Code preference is overriding the startup replacement.</p>}
          {settings.welcome === "otherHost" && <p>Open the original VS Code host to restore its saved startup preference.</p>}
          <div className="settings-actions">
            <button type="button" disabled={settings.welcome !== "available"} onClick={settings.enableWelcome}>Replace VS Code Welcome page</button>
            <button type="button" disabled={settings.welcome !== "active" && settings.welcome !== "changed"}
              onClick={settings.restoreWelcome}>Restore original VS Code startup page</button>
          </div>
        </fieldset>

        <div className="settings-actions">
          <button type="submit" disabled={!settings.ready || settings.pending || !settings.dirty}>Save changes</button>
          <button type="button" disabled={!settings.ready || settings.pending} onClick={settings.restore}>Restore Defaults</button>
        </div>
        {!settings.ready && (
          <div className="settings-actions">
            <p role="status">
              {settings.syncError ?? "Loading saved settings…"}
            </p>
            {settings.syncError && settings.retry && <button type="button" onClick={settings.retry}>Retry</button>}
          </div>
        )}
        {settings.feedback && (
          <p role={settings.feedback.error ? "alert" : "status"}>{settings.feedback.text}</p>
        )}
      </form>
    </main>
  );
}
