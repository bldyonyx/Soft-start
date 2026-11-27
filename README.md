# Soft Start

> A little space to begin.\
> Your cozy VS Code dashboard.

Keep the projects you return to close, pick up where you left off, or start with a clean folder. Midnight Bunny keeps you company in a dashboard that opens right in a VS Code editor tab.

<!-- Promotional banner: place the approved final Soft Start banner here at full width once publication rights and its public image URL are confirmed. -->

---

## ✦ Dashboard preview

Midnight and Lavender are the starting palette. In a wide editor, your pinned and recent projects sit side by side. Below 720 CSS pixels, the lists stack in one column. At 520 CSS pixels or less, the dashboard hides the background artwork.

<!-- Dashboard screenshot: place the approved primary dashboard image here at full width after publication clearance. -->
<!-- Supporting screenshots: place the responsive dashboard and a selected Settings or VS Code workbench capture below the primary image after selection and publication clearance. Give each image descriptive alt text. -->

---

## ✦ Features

### Keep your projects close

- **Pinned projects.** Use **Add project** to bookmark a folder or saved workspace without opening it, or pin a project from its recent row. Open a pin to return to it. Use its menu to rename it, restore its original name, move it up or down, or unpin it. You can also drag pins into order.
- **Recent projects.** Soft Start records up to 50 folders and saved workspaces opened while the extension is active. Empty windows, untitled workspaces, and the terminal’s working directory are outside that history. The dashboard shows four entries by default. Set the visible count from 1 to 10, or use **View all recent projects** when more entries are available. A row’s menu can remove it from the visible history.
- **Find an unresolved project.** Open a VS Code window connected to the project’s original location and choose **Locate project** from the row’s menu. Select the folder or saved workspace to confirm its location.

Soft Start keeps its own history. To bring a project over from **File → Open Recent**, reopen it in a window where Soft Start is active and project storage is available.

### Start something new

| Quick action | What it does |
| --- | --- |
| **New project** | Creates an empty folder and asks VS Code to open it. Set an existing absolute **Projects directory** on the active host, or leave it blank to choose a parent each time. The new folder remains on disk if creation succeeds but VS Code cannot open it. |
| **Open folder** | Opens VS Code’s folder picker. |
| **Clone repository** | Opens the clone workflow from VS Code’s built-in Git extension, which must be enabled and available in that environment. |

---

## ✦ Make it yours

Open the gear in the dashboard header. In **Appearance**, mix backgrounds and accents independently.

| Backgrounds | Accents |
| --- | --- |
| Midnight · Ink blue · Plum | Lavender · Soft blue · Rose |

Use the color pickers or enter custom hex values. Soft Start adjusts the displayed accent for contrast when needed. Set the panel opacity, show or hide the background artwork, and adjust its opacity. Under **Dashboard**, edit the welcome message, change the header kaomoji, toggle decorative symbols, and set how many recent projects appear.

**Live Preview** shows appearance and welcome details as you edit. Choose **Save changes** to apply your edits. **Browse…** fills in the Projects directory as a draft until you save it. To set it in VS Code for a remote window, use that host’s Remote settings. If only some changes save, Soft Start reports which ones applied and keeps the rest for review. If a save reply is missing, **Check saved settings** reads the current values without repeating the save.

**Restore Defaults** asks for confirmation, then resets Appearance and Dashboard preferences. It keeps your Projects directory, Startup preferences, status bar setting, pinned projects, and recent history. To undo Welcome page replacement, use [the separate startup restoration controls](#restore-your-startup-page).

### Open Soft Start at startup

In **Settings → Startup**, choose **Never** (the default), **Empty windows only**, or **Always**. Empty windows have no folder, workspace file, or restored tabs. **Always** also opens Soft Start in project windows, beside restored editors so they keep focus. Automatic opening requires the effective **Workbench: Startup Editor** to be **None**.

On first activation, choose **Set as startup page** or **Not now**. You can also opt in later with **Replace VS Code Welcome page**. After confirmation, Soft Start records the previous user preference, sets `workbench.startupEditor` to `none`, and chooses **Empty windows only** for the next startup. The user-level change can affect other windows that inherit it. Workspace settings and policies can still override it. To keep the dashboard tab handy without changing startup, right-click the tab and choose **Pin**.

### Restore your startup page

- **Local VS Code.** In the profile where you opted in, choose **Restore original VS Code startup page** under **Startup** and confirm. This turns off Soft Start’s automatic opening and restores the previous User value, or removes the override if the value was inherited. If you changed the native preference since opting in, you can keep the current setting or explicitly restore the previous one.
- **WSL or another remote host.** In the original profile and host, choose **Disable Soft Start automatic startup**. Soft Start switches to **Never** and retains the backup and restoration guidance. VS Code can report a merged user preference in a remote window, so check **Workbench: Startup Editor** in both the User and Remote Settings tabs. Restore or reset only the layer you can verify, and keep any newer preference you want to retain.

---

## ✦ Getting started

1. [Build a local VSIX](#build-a-local-vsix) from the checkout, or use a locally supplied build.
2. In the VS Code window where you want to use Soft Start, run **Extensions: Install from VSIX...** and select the file. Reload if VS Code asks. For WSL, open the target WSL window first so you can install on that host.
3. Open the Command Palette and run **Soft Start: Open Dashboard**.

You can also install and check the current local build from a terminal with the VS Code CLI. In WSL, run these commands from the checkout in the integrated terminal of the target WSL window. Use **Developer: Show Running Extensions** to check where Soft Start is running.

```sh
code --install-extension ./soft-start-0.0.1.vsix
code --list-extensions --show-versions
```

Look for `bldyonyx.soft-start@0.0.1`. To replace a local build with a newer package that has the same version, rebuild it and run `code --install-extension ./soft-start-0.0.1.vsix --force`.

Before uninstalling, [restore your startup page](#restore-your-startup-page) if you opted in, and back up the extension’s storage if you want to keep pins and recents. Use the Extensions view or run `code --uninstall-extension bldyonyx.soft-start` in the same environment. If you already uninstalled, find **Workbench: Startup Editor** in the applicable User or Remote Settings tab. Reset an inherited value or select the previous one. Choose **Welcome Page** if you want VS Code’s standard Welcome editor.

## ✦ Keyboard shortcuts

| Action | Windows and Linux binding | macOS binding |
| --- | --- | --- |
| **Soft Start: Open Dashboard** | `Ctrl+Alt+Shift+D` | `Cmd+Option+Shift+D` |

Search for **Soft Start: Open Dashboard** in VS Code’s Keyboard Shortcuts to change the binding. In the dashboard’s **Settings → Startup**, enable **Show Soft Start in the status bar** and save if you prefer a button. It works even with automatic startup off.

The dashboard supports keyboard navigation, visible focus, and menu-based pin reordering. It respects the system reduced-motion preference.

---

## ✦ Compatibility and known limitations

- **VS Code version.** The manifest declares VS Code 1.146.0 as the minimum. Local VSIX installation and dashboard display were exercised on Linux desktop VS Code 1.148.0 in an isolated headless profile. Windows, macOS, and end-to-end WSL and other remote sessions have yet to be verified for this release.
- **Project history needs native storage.** Pins and recents require a `file:` extension storage URI on the active host and a filesystem that supports atomic hard links. The tested Linux desktop host supplied `vscode-userdata:`, so Soft Start could neither load nor save pins or recents there. In that case it leaves stored data untouched and skips migration and recovery. Quick Actions and dashboard Settings remain available subject to the host’s capabilities.
- **History is scoped to the store and host.** Windows using the same store and host identity share history. Separate profiles, WSL distributions, SSH hosts, and other independent stores keep their own lists. Open a host-bound project from its original environment. Explicitly addressed locations retain their authority.
- **Keep recovery files.** On a supported store, the legacy project lists are snapshotted in `projects-v2/<host>/legacy.json` within VS Code’s extension storage. Keep the old state and journal files if migration reports an error. Builds using `bldyonyx.soft-start` can recover eligible pins from the matching host journal of older `undefined_publisher.soft-start` builds. Recent history from that publisher-less journal stays there.

---

## ✦ Privacy and local data

Soft Start stores project names, location URIs, host information, and timestamps in the extension’s local storage on the host. Preferences use VS Code’s settings, and the extension records a startup backup only when you opt into Welcome page replacement. Removing a project from a list does not delete the project or erase earlier records from the journal or migration backups.

Soft Start has no extension telemetry or direct dashboard network requests. **Clone repository** uses VS Code’s Git workflow, which can contact a remote repository and use Git credentials.

---

## ✦ Development

Made with `TypeScript` · `React` · `Vite` · `VS Code Extension API`

Use Node.js 24 and npm. From the repository root, install the dependencies for both the extension and the webview.

```sh
npm ci
npm --prefix webview ci
```

Use **F5** to build both parts and launch an Extension Development Host. That window uses the checkout in place of an installed copy with the same ID. Other windows keep using their installed extension. For isolated testing, use a disposable profile because the checkout and VSIX can share extension storage when the profile and host match.

Run `npm run watch` for host TypeScript watch mode or `npm --prefix webview run dev` for the standalone interface preview. The standalone preview has no extension host for native actions or saved data. Restart the development host after changing the host code or message protocol.

### Build a local VSIX

```sh
npx @vscode/vsce package --no-dependencies --allow-missing-repository --skip-license
```

VSCE runs `npm run vscode:prepublish` automatically. It builds the webview into `media/` and compiles the host into `out/`. This command is for local packaging while release rights are pending. The resulting file is `soft-start-0.0.1.vsix` at the current manifest version.

---

## ✦ License and credits

Soft Start’s Signature typography uses **PF Pixelscript Pro Regular** by Parachute and **Mali** by the Mali Project Authors. Mali and the bundled decorative font subsets have SIL Open Font License notices in `webview/public/font-licenses/`.

The extension source license has not been established. Public redistribution and embedding rights for PF Pixelscript Pro are pending, as are public-use rights for Midnight Bunny, the decorative artwork, and the promotional images. The banner and screenshots remain private while those questions are resolved.

<p align="center">
  A quiet hello from Midnight Bunny ♡
</p>
