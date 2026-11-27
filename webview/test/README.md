# Soft Start promotional screenshots

Run from the extension root with an existing Chromium or Chrome executable and the webview dependencies already present in `webview/node_modules`.

```sh
node webview/test/promo-screenshots.mjs /path/to/chromium /tmp/soft-start-promo
```

The command generates the primary and responsive dashboard PNGs, three settings PNGs, and four alternate color PNGs. Add `--wide` for the optional wide dashboard. Add `--new-only` to refresh only the settings and color PNGs while preserving the approved dashboard captures in the output directory. Each capture replaces its matching filename.

| Webview size in CSS pixels | PNG at 2× | Use |
| --- | --- | --- |
| 1200 × 800 | 2400 × 1600 | Primary dashboard, settings, and color presets |
| 680 × 1100 | 1360 × 2200 | Responsive dashboard with stacked project lists and visible artwork |
| 1440 × 900 | 2880 × 1800 | Optional wide dashboard |

The primary dashboard shows the default Midnight background and Lavender accent. Each alternate dashboard applies one built-in swatch through the actual Appearance controls and saves it to the isolated fixture. Ink blue and Plum use the default accent. Soft blue and Rose use the default background.

The command builds the production webview into a temporary directory and serves it on loopback using the browser test harness. The harness supplies the extension manifest defaults and the same fictional projects for every capture. Color saves are held in memory for the current page. The approved fonts, decorative symbols, and artwork come from the production bundle. Headless Chromium uses a fresh temporary profile. The build and profile are removed when the run ends.

The PNGs show the webview content. VS Code tabs, sidebars, and window chrome are outside the frame. Settings are scrolled to frame each requested section, with Live Preview visible in the Appearance shot. Native dialogs, startup changes, and project commands require a VS Code host. Platform glyphs and rasterization can vary across browser and OS versions. The production layout stacks project lists below 720 CSS px and hides background artwork at 520 CSS px and below.

The harness lives under `webview/test/`, outside the root `.vscodeignore` packaging allowlist. It never starts VS Code or accesses its profile, project folders, settings, or history. Chromium needs its normal headless runtime and the harness needs permission to bind a local loopback port.
