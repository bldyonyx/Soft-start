import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { withWebviewBrowser } from "./webview-browser.mjs";

const [chromium, output, ...options] = process.argv.slice(2);
assert.ok(chromium && output && options.every(option => ["--wide", "--new-only"].includes(option)),
  "Usage: node webview/test/promo-screenshots.mjs <chromium executable> <output directory> [--wide] [--new-only]");

const extensionRoot = fileURLToPath(new URL("../../", import.meta.url));
const manifest = JSON.parse(await readFile(join(extensionRoot, "package.json"), "utf8"));
const settings = Object.fromEntries(Object.entries(manifest.contributes.configuration.properties)
  .map(([key, { default: value }]) => [key.slice("softStart.".length), value]));

function project(name, slug) {
  const path = `/home/avery/Projects/${slug}`;
  return { id: createHash("sha256").update(path).digest("hex"), name, path, kind: "folder" };
}

const pins = [
  project("Dear Pages", "dear-pages"),
  project("Design Inspector", "design-inspector"),
  project("Kiflo", "kiflo"),
];
const recent = [
  [project("Soft Start", "soft-start"), 18, "18 min. ago"],
  [project("Taskly", "taskly"), 200, "3 hr. ago"],
  [project("Font Pairing Lab", "font-pairing-lab"), 1560, "1 day ago"],
  [project("Velvet Fangs", "velvet-fangs"), 7380, "5 days ago"],
];
const primary = { width: 1200, height: 800 };
const responsive = { width: 680, height: 1100 };
const wide = { width: 1440, height: 900 };
const hostScript = `
  const now = Date.now();
  let saved = ${JSON.stringify(settings)};
  let revision = 0;
  const snapshot = () => ({ settings: saved, revision: ++revision, busy: false, welcome: "available" });
  const send = message => window.postMessage(message, location.origin);
  window.acquireVsCodeApi = () => ({
    postMessage({ type, requestId, changes, expected }) {
      if (type === "requestSettings") {
        send({ type: "settings", ...snapshot() });
      } else if (type === "saveSettings") {
        const keys = Object.keys(changes);
        const accepted = keys.every(key =>
          ["backgroundColor", "accentColor"].includes(key) && /^#[0-9a-f]{6}$/.test(changes[key]) &&
          expected[key] === saved[key]);
        if (accepted) saved = { ...saved, ...changes };
        send({ type: "settingsResult", ...snapshot(), requestId,
          outcome: accepted ? "success" : "rejected",
          detail: accepted ? "Settings saved." : "The screenshot host only saves color changes.",
          writes: { applied: accepted ? keys : [], rejected: {} } });
      } else if (type === "requestRecentProjects") {
        send({ type: "pinnedProjects", projects: ${JSON.stringify(pins)} });
        send({ type: "recentProjects", projects: ${JSON.stringify(recent.map(([item, minutes]) => ({ ...item, minutes })))}
          .map(({ minutes, ...item }) => ({ ...item, lastOpened: now - minutes * 60_000 })) });
      }
    },
  });
`;

const temporary = await mkdtemp(join(tmpdir(), "soft-start-promo-"));
try {
  const media = join(temporary, "media");
  // Use the production Vite configuration and emit the build into this run's temporary directory.
  await promisify(execFile)(process.execPath, [
    "node_modules/vite/bin/vite.js", "build", "--outDir", media,
  ], { cwd: join(extensionRoot, "webview") }).catch((error) => {
    throw new Error(`Production webview build failed: ${error.stderr || error.message}`);
  });

  const outputDirectory = resolve(output);
  await mkdir(outputDirectory, { recursive: true });
  await withWebviewBrowser({ chromium, media, hostScript }, async ({ send, evaluate, waitFor, errors, baseUrl }) => {
    const captures = [];
    const dashboardReady = `
      !document.querySelector('.dashboard[hidden]') &&
      document.querySelectorAll('.pinned-row').length === ${pins.length} &&
      document.querySelectorAll('.recent-project-row:not(.pinned-row)').length === ${recent.length} &&
      document.querySelector('.dashboard-watermark')?.naturalWidth > 0`;
    const settle = () => evaluate(`(async () => {
      const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
      await frame();
      await document.fonts.ready;
      await Promise.allSettled(document.getAnimations().map(animation => animation.finished));
      await frame();
      await frame();
    })()`);
    const click = selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);

    let navigation = 0;
    async function openDashboard({ width, height }) {
      await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 2, mobile: false });
      const url = `${baseUrl}/?capture=${++navigation}`;
      await send("Page.navigate", { url });
      await waitFor(`location.href === ${JSON.stringify(url)} && (${dashboardReady})`);
    }

    async function openSettings() {
      await click(".settings-gear");
      await waitFor(`document.querySelector('#settings-save-state')?.textContent === 'Up to date' &&
        document.querySelector('.settings-preview-artwork')?.naturalWidth > 0`);
    }

    async function capture(name) {
      const { data } = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
      captures.push([join(outputDirectory, `soft-start-${name}@2x.png`), Buffer.from(data, "base64")]);
    }

    async function captureDashboard(name) {
      await waitFor(dashboardReady);
      await settle();
      const detail = await evaluate(`(() => {
        const root = document.documentElement;
        const artwork = document.querySelector('.dashboard-watermark');
        const texts = selector => Array.from(document.querySelectorAll(selector), node => node.textContent.trim());
        return {
          pins: texts('.pinned-row .recent-name'),
          recent: texts('.recent-project-row:not(.pinned-row) .recent-name'),
          times: texts('.recent-project-row:not(.pinned-row) time'),
          fonts: [...document.fonts].filter(face => face.status === 'loaded').map(face => face.family),
          decorations: texts('.dashboard .accent'),
          artworkVisible: getComputedStyle(artwork).display !== 'none' && Number(getComputedStyle(artwork).opacity) > 0,
          fits: root.scrollWidth === innerWidth && root.scrollHeight === innerHeight,
        };
      })()`);
      assert.deepEqual(detail.pins, pins.map(({ name }) => name));
      assert.deepEqual(detail.recent, recent.map(([{ name }]) => name));
      assert.deepEqual(detail.times, recent.map(([, , label]) => label));
      for (const font of ["PF Pixelscript Pro", "Mali", "Soft Start Decor"]) {
        assert.ok(detail.fonts.some(family => family.replaceAll('"', '') === font), `${font} did not load`);
      }
      for (const symbol of ["𓏲ּ𝄢", settings.headerKaomoji, "‹𝟹", "・・・・・", "ഒ", "⸝⸝", "ʚ⠀ິɞ"]) {
        assert.ok(detail.decorations.includes(symbol), `Missing decoration: ${symbol}`);
      }
      assert.ok(detail.artworkVisible, "Dashboard artwork is hidden");
      assert.ok(detail.fits, `Dashboard needs scrolling for ${name}`);
      await capture(name);
    }

    async function captureSettings(name, first, last = first) {
      await settle();
      const bounds = await evaluate(`(() => {
        const first = document.querySelector(${JSON.stringify(first)}).getBoundingClientRect();
        const last = document.querySelector(${JSON.stringify(last)}).getBoundingClientRect();
        const bar = document.querySelector('.settings-savebar').getBoundingClientRect();
        return { top: first.top, bottom: last.bottom, barBottom: bar.bottom, height: innerHeight };
      })()`);
      assert.ok(bounds.top >= bounds.barBottom && bounds.bottom <= bounds.height,
        `Viewport clips ${name}: ${JSON.stringify(bounds)}`);
      await capture(`${name}-1200x800`);
    }

    await send("Emulation.setLocaleOverride", { locale: "en-US" });
    const dashboardSizes = options.includes("--new-only") ? [] : [primary, responsive];
    if (options.includes("--wide")) dashboardSizes.push(wide);
    for (const size of dashboardSizes) {
      await openDashboard(size);
      await captureDashboard(`${size.width}x${size.height}`);
    }

    await openDashboard(primary);
    await openSettings();
    const fieldset = id => `fieldset:has(#${id}-settings)`;
    await settle();
    await evaluate(`window.scrollBy({
      top: Math.max(0, document.querySelector(${JSON.stringify(fieldset("appearance"))}).getBoundingClientRect().bottom - innerHeight + 20),
      behavior: "instant",
    })`);
    await captureSettings("settings-appearance", ".settings-preview", fieldset("appearance"));
    await click('.settings-nav a[href="#dashboard-settings"]');
    await captureSettings("settings-dashboard", fieldset("dashboard"));
    await click('.settings-nav a[href="#projects-settings"]');
    await captureSettings("settings-projects-startup", fieldset("projects"), fieldset("startup"));

    const swatches = await evaluate(`Array.from(document.querySelectorAll('.settings-swatch'), (button, index) => ({
      index,
      name: button.firstElementChild.nextSibling.textContent.trim(),
      selected: button.getAttribute('aria-pressed') === 'true',
      color: button.style.getPropertyValue('--swatch'),
    }))`);
    assert.equal(swatches.filter(({ selected }) => selected).length, 2);
    for (const { index, name, selected, color } of swatches) {
      // The approved default dashboard already shows the selected background and accent.
      if (selected) continue;
      await openDashboard(primary);
      await openSettings();
      const token = await evaluate(`(() => {
        const swatch = document.querySelectorAll('.settings-swatch')[${index}];
        const group = swatch.closest('.settings-color');
        return group.querySelector('input[type=color]').getAttribute('aria-label') === 'Pick background color'
          ? '--background' : '--lavender';
      })()`);
      const tokenValue = `getComputedStyle(document.documentElement).getPropertyValue(${JSON.stringify(token)}).trim()`;
      const original = await evaluate(tokenValue);
      await evaluate(`document.querySelectorAll('.settings-swatch')[${index}].click()`);
      await waitFor(`document.querySelectorAll('.settings-swatch')[${index}].getAttribute('aria-pressed') === 'true' &&
        !document.querySelector('.settings-save').disabled`);
      await click(".settings-save");
      await waitFor(`document.querySelector('#settings-save-state')?.textContent === 'Up to date' &&
        document.querySelector('.settings-status [role=status]')?.textContent === 'Settings saved.'`);
      await click(".settings-back");
      await waitFor(`${tokenValue} !== ${JSON.stringify(original)}`);
      if (token === "--background") assert.equal(await evaluate(tokenValue), color);
      const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
      await captureDashboard(`preset-${slug}-1200x800`);
    }
    assert.deepEqual(errors, []);
    for (const [path, png] of captures) {
      await writeFile(path, png);
      console.log(path);
    }
  });
} finally {
  await rm(temporary, { recursive: true, force: true });
}
