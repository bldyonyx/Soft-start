# Soft Start

Soft Start is a VS Code extension with a React dashboard. Open it from the Command Palette with **Soft Start: Open Dashboard**.

## Quick Actions implementation plan

1. Replace the disabled **New file** tile with **New project** and a folder-plus icon. Enable all three tiles through a shared, typed message contract and validate incoming messages in the extension host.
2. Prompt for a single folder name with `showInputBox()` and validate it before using it as a path segment. Resolve `softStart.projectsDirectory` as an absolute path on the active extension host, or offer the native VS Code folder picker when the setting is empty.
3. Confirm the parent is a directory and check that the destination is free. Create the empty folder with `workspace.fs.createDirectory()` and open it with `vscode.openFolder`. Handle cancellation without side effects and report filesystem and open failures in VS Code. Use VS Code URIs and run on the workspace extension host for WSL and remote sessions.
4. Delegate **Open folder** and **Clone repository** to VS Code. Keep the existing dashboard artwork, transparency, decorative details, responsive layout, CSP, and packaging.
5. Test project creation, validation, cancellation, existing paths, filesystem failures, and message validation. Run the extension and webview builds, linters, and tests.

Set `softStart.projectsDirectory` in VS Code Settings to an existing absolute folder on the active host. In a WSL or other remote window, use the Remote settings for that host. Leave it empty to pick a parent folder each time.

## Project storage across windows

Recent and pinned projects are shared by windows using the same Soft Start storage directory and host identity. Native paths are bound to the originating host. Soft Start preserves an explicit authority when VS Code provides one. Profiles, local installs, WSL distributions, and SSH hosts with separate stores do not synchronize their project histories. WSL uses the reported distro name and machine ID, and SSH uses the remote machine ID where available. If the host cannot be verified, Soft Start requires an explicitly addressed project.

On first use, each store saves a versioned snapshot of the old project lists in `projects-v2/<host>/legacy.json` under VS Code's extension storage directory. The old VS Code state stays intact. Legacy entries with an unknown host remain visible and can be renamed or removed. To reopen one, locate it in the correct VS Code window and pin the verified project again. Keep the legacy state and journal files if the migration reports an error.

Project updates are published as individual files using the native filesystem. VS Code windows sharing that filesystem and directory converge on the same operation order. The store requires atomic hard-link support and keeps its operation history for recovery. Independent stores do not provide cross-host transactions. Native New Project uses exclusive directory creation. A provider that exposes only VS Code's directory API can report pre-existing items during preflight, but cannot guarantee exclusive creation during a race. Soft Start never writes to an existing project's contents.

## Dashboard settings

Open the gear in the dashboard header. Appearance and dashboard edits update the preview as you work. **Save changes** writes the edited preferences, and **Restore Defaults** resets appearance and dashboard preferences after confirmation. Recent and pinned projects and the projects directory are kept.

Appearance and dashboard preferences are application-scoped Soft Start user settings. The Projects section uses the machine-scoped `softStart.projectsDirectory` setting. In a WSL or other remote window, VS Code writes this setting to the remote host's user settings. Browse selects a folder for the draft. Save applies it to New Project, and saving an empty value returns New Project to prompting for a folder. Settings changes made in VS Code also update an open dashboard.

## Use Soft Start at startup

The first time Soft Start activates, it offers **Set as startup page** or **Not now**. Either choice dismisses onboarding for this profile. You can set up the replacement later under **Settings → Startup** in Soft Start. Confirming replacement saves the original VS Code Startup Editor user preference, sets `workbench.startupEditor` to `none`, and selects **Empty windows only**. The new behavior applies on the next startup.

- **Empty windows only** opens Soft Start in a window without a folder, workspace file, or restored editor tab.
- **Always** also opens it in folder and multi-root workspaces, requesting that VS Code preserve focus when tabs are already open.
- **Never** turns off automatic opening. **Soft Start: Open Dashboard** is available in every mode.

Soft Start uses VS Code's configured startup editor and opens its own dashboard after startup. If another workspace or user preference sets the effective Startup Editor to something other than `none`, Soft Start skips automatic opening. It leaves restored editors, including a manually opened or restored Welcome tab, in VS Code's control. Closing the dashboard keeps it closed for the current extension-host session.

The Startup Editor is changed via VS Code's **Global** user configuration target, including in WSL. This can affect other windows that inherit the same user preference. VS Code resolves whether a Remote user setting or the local user setting supplies the preference; Soft Start leaves workspace and workspace-folder settings alone. Restore from the same VS Code profile and local or remote host where you enabled replacement.

**Restore original VS Code startup page** disables automatic opening and restores the saved user value. A previously inherited value is restored by removing the override. If the native user preference changed independently, choose **Keep current setting** or explicitly confirm restoration. **Restore Defaults** in Soft Start leaves startup preferences and the restore record in place.

Before uninstalling, use **Restore original VS Code startup page**. After uninstalling, open VS Code Settings and search for **Workbench: Startup Editor**. In the applicable User or Remote settings tab, reset the setting if it was inherited, or select your previous value. Choose **Welcome Page** to show the standard Welcome editor.

## Build and package

From a clean checkout, install the extension and dashboard dependencies from the repository root:

```sh
npm ci
npm --prefix webview ci
```

Run `npm run vscode:prepublish` to build the dashboard into `media/` and compile the extension into `out/`.
Run `npx @vscode/vsce package --no-dependencies` to create a local VSIX. VSCE runs the same build automatically and includes the generated dashboard assets. The extension has no runtime npm dependencies.

For local development, F5 builds the extension and dashboard together before opening the Extension Development Host. Stop and restart the debug session after changing the host or its webview protocol so the new dashboard connects to the matching host build. The foreground build is also the default VS Code build task. Use `npm run watch` separately for TypeScript watch mode and `npm --prefix webview run dev` for the standalone dashboard preview.
