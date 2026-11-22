# Soft Start

Soft Start is a VS Code extension with a React dashboard. Open it from the Command Palette with **Soft Start: Open Dashboard**.

## Build and package

From a clean checkout, install the extension and dashboard dependencies from the repository root:

```sh
npm ci
npm --prefix webview ci
```

Run `npm run vscode:prepublish` to build the dashboard into `media/` and compile the extension into `out/`.
Run `npx @vscode/vsce package --no-dependencies` to create a local VSIX. VSCE runs the same build automatically and includes the generated dashboard assets. The extension has no runtime npm dependencies.

For local development, run `npm run build:webview` before launching the extension with F5. Run it again after changing the dashboard. The F5 task watches the extension's TypeScript, and `npm --prefix webview run dev` starts the standalone dashboard dev server.
