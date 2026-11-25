# Soft Start

Soft Start is a VS Code extension with a React dashboard. Open it from the Command Palette with **Soft Start: Open Dashboard**.

## Quick Actions implementation plan

1. Replace the disabled **New file** tile with **New project** and a folder-plus icon. Enable all three tiles through a shared, typed message contract and validate incoming messages in the extension host.
2. Prompt for a single folder name with `showInputBox()` and validate it before using it as a path segment. Resolve `softStart.projectsDirectory` as an absolute path on the active extension host, or offer the native VS Code folder picker when the setting is empty.
3. Confirm the parent is a directory and check that the destination is free. Create the empty folder with `workspace.fs.createDirectory()` and open it with `vscode.openFolder`. Handle cancellation without side effects and report filesystem and open failures in VS Code. Use VS Code URIs and run on the workspace extension host for WSL and remote sessions.
4. Delegate **Open folder** and **Clone repository** to VS Code. Keep the existing dashboard artwork, transparency, decorative details, responsive layout, CSP, and packaging.
5. Test project creation, validation, cancellation, existing paths, filesystem failures, and message validation. Run the extension and webview builds, linters, and tests.

Set `softStart.projectsDirectory` in VS Code Settings to an existing absolute folder on the active host. In a WSL or other remote window, use the Remote settings for that host. Leave it empty to pick a parent folder each time.

## Build and package

From a clean checkout, install the extension and dashboard dependencies from the repository root:

```sh
npm ci
npm --prefix webview ci
```

Run `npm run vscode:prepublish` to build the dashboard into `media/` and compile the extension into `out/`.
Run `npx @vscode/vsce package --no-dependencies` to create a local VSIX. VSCE runs the same build automatically and includes the generated dashboard assets. The extension has no runtime npm dependencies.

For local development, run `npm run build:webview` before launching the extension with F5. Run it again after changing the dashboard. The F5 task watches the extension's TypeScript, and `npm --prefix webview run dev` starts the standalone dashboard dev server.
