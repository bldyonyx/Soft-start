# Soft Start webview

This React and TypeScript app renders the dashboard and its Settings view. The extension host loads the Vite production build inside a VS Code editor tab.

Run these commands from the extension root.

| Command | Use |
| --- | --- |
| `npm --prefix webview ci` | Install the webview dependencies from its lockfile. |
| `npm --prefix webview run dev` | Preview the interface in a browser with Vite. The standalone preview has no VS Code host for project actions, saved history, or Settings writes. |
| `npm run build:webview` | Type-check and build the dashboard into `media/`. |
| `npm --prefix webview run lint` | Run the webview’s Oxlint checks. |

Use the [extension development guide](../vsc-extension-quickstart.md) to test native behavior. For browser regression checks, build the webview first and run `node webview/test/settings.browser.mjs /path/to/chromium` from the extension root. The harness uses an isolated browser profile and a fixture host. See the [promotional capture guide](test/README.md) for screenshot commands.
