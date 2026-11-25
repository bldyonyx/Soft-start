import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const [chromium, media = fileURLToPath(new URL("../../media", import.meta.url))] = process.argv.slice(2);
assert.ok(chromium, "Usage: node webview/test/settings.browser.mjs <chromium executable> [build directory]");

const hostScript = `
    const defaults = {
      backgroundColor: '#080709', accentColor: '#c5b3e5', panelOpacity: 85, artworkVisible: true,
      artworkOpacity: 14, welcomeMessage: 'Ready when you are', headerKaomoji: '૮ ᴗ͈ ˕ ✙╿ྀི꒱',
      decorativeSymbols: true, recentProjectsLimit: 4, projectsDirectory: '', startupBehavior: 'never'
    };
    let saved = {...defaults, panelOpacity: 80};
    let welcome = 'available';
    window.requests = [];
    window.reply = false;
    window.failRead = false;
    window.acquireVsCodeApi = () => ({ postMessage(request) {
      requests.push(request);
      if (request.type === 'requestSettings' && reply) {
        window.postMessage(failRead ? {type:'settingsLoadError', error:'Configuration unavailable'} :
          {type:'settings', settings:saved, welcome}, '*');
      } else if (request.type === 'saveSettings') {
        saved = {...saved, ...request.changes};
        window.postMessage({type:'settingsResult',settings:saved,welcome,status:'Settings saved.'}, '*');
      } else if (request.type === 'browseProjectsDirectory') {
        window.postMessage({type:'settingsResult',settings:saved,welcome,directory:'/home/test/projects'}, '*');
      } else if (request.type === 'enableWelcomeReplacement') {
        welcome = 'active';
        saved = {...saved, startupBehavior:'emptyWindow'};
        window.postMessage({type:'settingsResult',settings:saved,welcome,status:'Soft Start is set as the startup page.'}, '*');
      } else if (request.type === 'restoreWelcomeReplacement') {
        welcome = 'available';
        saved = {...saved, startupBehavior:'never'};
        window.postMessage({type:'settingsResult',settings:saved,welcome,status:'Original VS Code startup preference restored.'}, '*');
      } else if (request.type === 'restoreSettings') {
        saved = {...defaults,projectsDirectory:saved.projectsDirectory,startupBehavior:saved.startupBehavior};
        window.postMessage({type:'settingsResult',settings:saved,welcome,status:'Defaults restored.'}, '*');
      }
    } });
    window.token = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  
`;

const contentTypes = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };
const server = createServer(async (request, response) => {
  const url = new URL(request.url, "http://127.0.0.1");
  const path = url.pathname === "/" ? "/index.html" : url.pathname;
  if (path !== "/index.html" && !/^\/assets\/[\w-]+\.(?:js|css|svg)$/.test(path)) {
    response.writeHead(404).end();
    return;
  }
  try {
    let body = await readFile(join(media, path));
    if (path === "/index.html") {
      const hostMarker = url.searchParams.has("legacy") ? "" : '<meta name="soft-start-settings-host" content="2">';
      body = body.toString().replace("<head>", `<head>${hostMarker}<script nonce="test-host">${hostScript}</script>`)
        .replace(/<script type=/g, '<script nonce="test-host" type=');
    }
    response.writeHead(200, {
      "Content-Type": contentTypes[extname(path)],
      "Content-Security-Policy": "default-src 'none'; script-src 'nonce-test-host'; style-src 'self'; img-src 'self' data:; connect-src 'none'",
    });
    response.end(body);
  } catch {
    response.writeHead(404).end();
  }
});
server.listen(0, "127.0.0.1");
await once(server, "listening");

const browser = spawn(chromium, ["--remote-debugging-port=0", "--window-size=1200,900", "about:blank"],
  { stdio: ["ignore", "ignore", "pipe"] });
let socket;
try {
  const port = await new Promise((resolve, reject) => {
    const lines = createInterface({ input: browser.stderr });
    lines.on("line", (line) => {
      const match = line.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/);
      if (match) resolve(match[1]);
    });
    browser.once("error", reject);
    browser.once("exit", (code) => reject(new Error(`Chromium exited with code ${code}`)));
  });
  const [page] = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await once(socket, "open");
  const pending = new Map();
  const errors = [];
  let nextId = 0;
  socket.addEventListener("message", ({ data }) => {
    const message = JSON.parse(data);
    if (message.id) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    } else if (message.method === "Runtime.exceptionThrown") {
      errors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
    } else if (message.method === "Log.entryAdded" && ["security", "javascript"].includes(message.params.entry.source)) {
      errors.push(message.params.entry.text);
    } else if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error") {
      errors.push(message.params.args.map(({ value, description }) => value ?? description).join(" "));
    }
  });
  async function send(method, params = {}) {
    const id = ++nextId;
    const response = new Promise((resolve) => pending.set(id, resolve));
    socket.send(JSON.stringify({ id, method, params }));
    const result = await response;
    assert.equal(result.error, undefined, JSON.stringify(result.error));
    return result.result;
  }
  async function evaluate(expression) {
    const { result, exceptionDetails } = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    assert.equal(exceptionDetails, undefined, result.description);
    return result.value;
  }
  async function waitFor(expression) {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await evaluate(`Boolean(${expression})`)) return;
      await delay(50);
    }
    assert.fail(`Timed out waiting for ${expression}`);
  }
  async function click(selector) {
    const point = await evaluate(`(() => {
      const node = document.querySelector(${JSON.stringify(selector)});
      node.scrollIntoView({block: 'center'});
      const {x,y,width,height} = node.getBoundingClientRect();
      return {x:x+width/2,y:y+height/2};
    })()`);
    await send("Input.dispatchMouseEvent", { type: "mousePressed", ...point, button: "left", clickCount: 1 });
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", ...point, button: "left", clickCount: 1 });
  }
  async function input(selector, value) {
    // Native color chooser UI is outside the page. Commit its value as Chromium does.
    await evaluate(`(() => {
      const node = document.querySelector(${JSON.stringify(selector)});
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(node, ${JSON.stringify(value)});
      node.dispatchEvent(new Event('input', { bubbles: true }));
      node.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
  }

  async function artworkPixels(selector) {
    const target = `document.querySelector(${JSON.stringify(selector)})`;
    await waitFor(`${target}?.naturalWidth > 0`);
    const clip = await evaluate(`(() => {
      const image = ${target};
      if (getComputedStyle(image).position !== 'fixed') image.scrollIntoView({block: 'center'});
      const {left, top, width, height} = image.getBoundingClientRect();
      const sampleWidth = Math.min(Math.floor(width), 260);
      const sampleHeight = Math.min(Math.floor(height), 220);
      return {
        x: Math.floor(left + scrollX + (width - sampleWidth) / 2),
        y: Math.floor(top + scrollY + (height - sampleHeight) / 2),
        width: sampleWidth, height: sampleHeight, scale: 1
      };
    })()`);
    const capture = () => send("Page.captureScreenshot", { clip, captureBeyondViewport: true });
    const visible = await capture();
    await evaluate(`${target}.style.setProperty('opacity', '0')`);
    const hidden = await capture();
    await evaluate(`${target}.style.removeProperty('opacity')`);
    return evaluate(`(async () => {
      async function pixels(png) {
        const image = new Image();
        image.src = 'data:image/png;base64,' + png;
        await image.decode();
        const canvas = document.createElement('canvas');
        canvas.width = image.width;
        canvas.height = image.height;
        const context = canvas.getContext('2d');
        context.drawImage(image, 0, 0);
        return context.getImageData(0, 0, image.width, image.height).data;
      }
      const [withArt, withoutArt] = await Promise.all([
        pixels(${JSON.stringify(visible.data)}), pixels(${JSON.stringify(hidden.data)})
      ]);
      let lighter = 0, darker = 0;
      for (let i = 0; i < withArt.length; i += 4) {
        const delta = (withArt[i] - withoutArt[i] + withArt[i+1] - withoutArt[i+1] + withArt[i+2] - withoutArt[i+2]) / 3;
        lighter = Math.max(lighter, delta);
        darker = Math.max(darker, -delta);
      }
      return { lighter, darker };
    })()`);
  }

  await send("Runtime.enable");
  await send("Log.enable");
  await send("Page.navigate", { url: `http://127.0.0.1:${server.address().port}/` });
  await waitFor("document.querySelector('.settings-gear')");
  await click(".settings-gear");
  await waitFor("document.querySelector('.settings-view')");
  assert.equal(await evaluate("document.querySelector('fieldset').disabled"), false, "preview must work before a host reply");
  assert.equal(await evaluate("getComputedStyle(document.querySelector('.settings-preview-artwork')).pointerEvents"), "none");

  await click("fieldset:first-of-type .settings-field:nth-child(2) .settings-swatch:nth-child(2)");
  await waitFor("token('--background') === '#131b2a'");
  await click("fieldset:first-of-type .settings-field:nth-child(3) .settings-swatch:nth-child(2)");
  await waitFor("token('--lavender') === 'rgb(160 216 242)'");

  await input("input[type=color]", "#343045");
  await waitFor("token('--background') === '#343045'");
  await input(".settings-field:nth-child(3) input[type=color]", "#ffdddd");
  await waitFor("token('--lavender') === 'rgb(255 221 221)'");
  await click("fieldset:first-of-type input[type=range]");
  await waitFor("token('--panel-opacity') !== '85%'");
  await click("fieldset:first-of-type .settings-range:last-child input");
  await waitFor("token('--artwork-opacity') !== '0.14'");
  await click("fieldset:first-of-type input[type=checkbox]");
  await waitFor("getComputedStyle(document.querySelector('.settings-preview-artwork')).opacity === '0'");
  await click("fieldset:first-of-type input[type=checkbox]");
  await waitFor("token('--artwork-opacity') !== '0'");

  await input("fieldset:nth-of-type(2) input[type=text]", "Hello from the preview");
  await waitFor("document.querySelector('.settings-view .window-content h3').textContent.includes('Hello from the preview')");
  await input("fieldset:nth-of-type(2) label:nth-of-type(2) input", "(•‿•)");
  await waitFor("document.querySelector('.settings-preview-kaomoji').textContent.includes('(•‿•)')");
  await click("fieldset:nth-of-type(2) input[type=checkbox]");
  await waitFor("!document.querySelector('.settings-preview-kaomoji')");
  await click("fieldset:nth-of-type(2) input[type=range]");
  assert.notEqual(await evaluate("document.querySelector('fieldset:nth-of-type(2) input[type=range]').value"), "4");
  assert.equal(await evaluate("requests.some(({type}) => type === 'saveSettings')"), false);
  assert.equal(await evaluate("document.querySelector('button[type=submit]').disabled"), true);

  // Withhold enough replies to also exercise the visible error and explicit retry.
  await waitFor("[...document.querySelectorAll('button')].some(button => button.textContent === 'Retry')");
  assert.equal(await evaluate("requests.filter(({type}) => type === 'requestSettings').length"), 3);
  await evaluate("reply = true; failRead = true");
  await click(".settings-view form > div:last-of-type button");
  await waitFor("document.querySelector('[role=status]')?.textContent.includes('Configuration unavailable')");
  assert.equal(await evaluate("document.querySelector('button[type=submit]').disabled"), true);
  await evaluate("failRead = false");
  await click(".settings-view form > div:last-of-type button");
  await waitFor("!document.querySelector('button[type=submit]').disabled");
  assert.equal(await evaluate("token('--background')"), "#343045", "sync must preserve the draft");

  await click("fieldset:nth-of-type(3) .settings-actions button:first-child");
  await waitFor("document.querySelector('#directory-help').previousElementSibling.querySelector('input').value === '/home/test/projects'");
  await click("fieldset:nth-of-type(3) .settings-actions button:last-child");
  await input("fieldset:nth-of-type(3) input", "/home/test/edited");
  await click("button[type=submit]");
  await waitFor("document.querySelector('[role=status]')?.textContent === 'Settings saved.'");
  await click("[data-view-focus]");
  await waitFor("!document.querySelector('.settings-view')");
  assert.equal(await evaluate("document.activeElement.className"), "settings-gear");
  assert.equal(await evaluate("token('--background')"), "#343045");
  await click(".settings-gear");
  await click(".settings-view form > .settings-actions button:last-child");
  await waitFor("document.querySelector('[role=status]')?.textContent === 'Defaults restored.'");
  assert.equal(await evaluate("token('--background')"), "#080709");
  assert.match(await evaluate("document.querySelector('.settings-directory').textContent"), /\/home\/test\/edited/);
  const startupSelect = "fieldset:nth-of-type(4) select";
  const replaceWelcome = "fieldset:nth-of-type(4) .settings-actions button:first-child";
  const restoreWelcome = "fieldset:nth-of-type(4) .settings-actions button:last-child";
  assert.equal(await evaluate(`document.querySelector('${startupSelect}').value`), "never");
  await click(replaceWelcome);
  await waitFor(`document.querySelector('${startupSelect}').value === 'emptyWindow'`);
  await evaluate(`(() => {
    const select = document.querySelector('${startupSelect}');
    select.value = 'always';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await click("button[type=submit]");
  await waitFor("document.querySelector('[role=status]')?.textContent === 'Settings saved.'");
  assert.ok(await evaluate("requests.some(request => request.changes?.startupBehavior === 'always')"));
  await click(".settings-view form > .settings-actions button:last-child");
  await waitFor("document.querySelector('[role=status]')?.textContent === 'Defaults restored.'");
  assert.equal(await evaluate(`document.querySelector('${startupSelect}').value`), "always");
  await click(restoreWelcome);
  await waitFor(`document.querySelector('${startupSelect}').value === 'never'`);

  const previewArt = ".settings-preview-artwork";
  const dashboardArt = ".dashboard-watermark";
  const backgroundInput = ".settings-field input[type=color]";
  const artworkOpacityInput = "fieldset:first-of-type .settings-range:last-child input";
  const artworkToggle = "fieldset:first-of-type input[type=checkbox]";
  const backgrounds = [
    ["Midnight", "#080709", 1],
    ["Ink Blue", "#131b2a", 2],
    ["Plum", "#23172b", 3],
    ["Custom light", "#eeedea"],
    ["Custom dark", "#625960"],
  ];
  for (const [name, color, swatch] of backgrounds) {
    if (swatch) {
      await click(`.settings-field:nth-child(2) .settings-swatch:nth-child(${swatch})`);
    } else {
      await input(backgroundInput, color);
    }
    await waitFor(`token('--background') === '${color}'`);
    const direction = name === "Custom light" ? "darker" : "lighter";
    assert.equal(await evaluate(`getComputedStyle(document.querySelector('${previewArt}')).opacity`), "0.14");
    const previewContrast = await artworkPixels(previewArt);
    assert.ok(previewContrast[direction] >= 7, `${name} preview artwork pixels: ${JSON.stringify(previewContrast)}`);

    if (name === "Midnight") {
      await click("[data-view-focus]");
      assert.equal(await evaluate(`getComputedStyle(document.querySelector('${dashboardArt}')).filter`), "none");
    } else {
      await click("button[type=submit]");
      await waitFor("document.querySelector('[role=status]')?.textContent === 'Settings saved.'");
      await click("[data-view-focus]");
    }
    assert.equal(await evaluate(`token('--background')`), color);
    const dashboardContrast = await artworkPixels(dashboardArt);
    assert.ok(dashboardContrast[direction] >= 16, `${name} dashboard artwork pixels: ${JSON.stringify(dashboardContrast)}`);
    await click(".settings-gear");
  }

  const normal = await artworkPixels(previewArt);
  await input(artworkOpacityInput, "50");
  await waitFor("token('--artwork-opacity') === '0.5'");
  assert.ok((await artworkPixels(previewArt)).lighter > normal.lighter, "higher opacity paints a stronger preview");
  await click(artworkToggle);
  await waitFor("token('--artwork-opacity') === '0'");
  assert.deepEqual(await artworkPixels(previewArt), { lighter: 0, darker: 0 });

  await send("Emulation.setDeviceMetricsOverride", { width: 500, height: 850, deviceScaleFactor: 1, mobile: false });
  await click("[data-view-focus]");
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('${dashboardArt}')).display`), "none");
  await click(".settings-gear");
  await click(artworkToggle);
  await waitFor("token('--artwork-opacity') === '0.5'");
  assert.ok((await artworkPixels(previewArt)).lighter >= 8, "preview artwork stays visible in a narrow window");
  await send("Emulation.clearDeviceMetricsOverride");

  await send("Page.navigate", { url: `http://127.0.0.1:${server.address().port}/?legacy=1` });
  await waitFor("document.querySelector('.settings-gear')");
  await click(".settings-gear");
  await waitFor("document.querySelector('[role=status]')?.textContent.includes('older Soft Start build')");
  assert.equal(await evaluate("requests.some(({type}) => type === 'requestSettings')"), false);
  assert.equal(await evaluate("document.querySelector('button[type=submit]').disabled"), true);
  assert.deepEqual(errors, []);
  console.log("Settings browser interactions passed.");
} finally {
  socket?.close();
  browser.kill();
  server.closeAllConnections();
  server.close();
}
