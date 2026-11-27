# Develop Soft Start

Soft Start has a TypeScript extension host and a React webview. Use Node.js 24 and npm. From the checkout root, install dependencies for both parts.

```sh
npm ci
npm --prefix webview ci
```

1. Open the checkout in VS Code and press **F5** using **Run Extension**. The launch task compiles the host and builds the webview.
2. In the Extension Development Host, run **Soft Start: Open Dashboard** from the Command Palette.
3. Debug extension host code under `src/` and dashboard code under `webview/src/`. Restart the development host after changing host code or the webview message protocol.

Run `npm run vscode:prepublish` to build both parts without opening a development window. `npm run watch` recompiles the host only. See the [webview guide](webview/README.md) for the standalone preview.

`npm test` compiles and lints the extension host, then runs the VS Code extension suite. Use a disposable profile for manual checks involving startup preferences or project history. See the [README’s compatibility section](README.md) for storage constraints and [local packaging](README.md#build-a-local-vsix) for the VSIX workflow.
