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
      decorativeSymbols: true, recentProjectsLimit: 4, projectsDirectory: '', startupBehavior: 'never', showStatusBarItem: false
    };
    let saved = {...defaults, panelOpacity: 80};
    let welcome = 'available';
    let revision = 0;
    let lastResult;
    window.requests = [];
    window.reply = false;
    window.failRead = false;
    window.saveMode = '';
    window.held = undefined;
    const originalTimeout = window.setTimeout;
    window.setTimeout = (fn, ms, ...args) => originalTimeout(fn, ms === 8000 ? 600 : ms, ...args);
    const snapshot = () => ({revision:++revision, busy:false, settings:{...saved}, welcome});
    const emitResult = (result) => window.postMessage({type:'settingsResult',...snapshot(),...result}, '*');
    const complete = (request, detail, fields = {}) => {
      lastResult = {requestId:request.requestId,outcome:'success',detail,...fields};
      if (saveMode === 'lost' && request.type === 'saveSettings') return;
      if (saveMode === 'held' && request.type === 'saveSettings') {
        held = {type:'settingsResult',...snapshot(),...lastResult};
        return;
      }
      emitResult(lastResult);
    };
    window.externalEdit = changes => {
      saved = {...saved,...changes};
      window.postMessage({type:'settings',...snapshot()}, '*');
    };
    window.acquireVsCodeApi = () => ({ postMessage(request) {
      requests.push(request);
      if (request.type === 'requestSettings' && reply) {
        if (failRead) {
          window.postMessage({type:'settingsLoadError', revision:++revision, error:'Configuration unavailable'}, '*');
        } else if (request.recover && lastResult?.requestId === request.recover) {
          emitResult(lastResult);
        } else {
          window.postMessage({type:'settings', ...snapshot(), recover:request.recover}, '*');
        }
      } else if (request.type === 'saveSettings') {
        if (saveMode === 'unknown') return;
        if (saveMode === 'reject') {
          complete(request, 'Nothing was saved.', {outcome:'rejected',
            writes:{applied:[], rejected:{projectsDirectory:'Use an absolute path'}}});
          return;
        }
        if (saveMode === 'partial') {
          saved = {...saved, backgroundColor:request.changes.backgroundColor};
          complete(request, '1 saved, 1 not saved.', {outcome:'partial',
            writes:{applied:['backgroundColor'],rejected:{welcomeMessage:'Changed in VS Code'}}});
          return;
        }
        saved = {...saved, ...request.changes};
        complete(request, 'Settings saved.', {writes:{applied:Object.keys(request.changes),rejected:{}}});
      } else if (request.type === 'browseProjectsDirectory') {
        complete(request, undefined, {directory:'/home/test/projects'});
      } else if (request.type === 'enableWelcomeReplacement') {
        welcome = 'active';
        saved = {...saved, startupBehavior:'emptyWindow'};
        complete(request, 'Soft Start is set as the startup page.');
      } else if (request.type === 'restoreWelcomeReplacement') {
        welcome = 'available';
        saved = {...saved, startupBehavior:'never'};
        complete(request, 'Original VS Code startup preference restored.');
      } else if (request.type === 'restoreSettings') {
        saved = {...defaults,projectsDirectory:saved.projectsDirectory,startupBehavior:saved.startupBehavior,showStatusBarItem:saved.showStatusBarItem};
        complete(request, 'Defaults restored.', {writes:{applied:Object.keys(defaults)
          .filter(key => !['projectsDirectory','startupBehavior','showStatusBarItem'].includes(key)),rejected:{}}});
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
      const hostMarker = url.searchParams.has("legacy") ? "" : '<meta name="soft-start-settings-host" content="4">';
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
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = targets.find(({ type, url }) => type === "page" && url === "about:blank");
  assert.ok(page, "Chromium did not expose the test tab");
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
  await waitFor("requests.some(({type}) => type === 'requestRecentProjects')");
  assert.equal(await evaluate("document.querySelectorAll('.project-loading-row').length"), 2);
  assert.equal(await evaluate("document.querySelector('.project-empty')"), null);
  await evaluate("window.postMessage({type:'projectLoadError', error:'Project storage unavailable'}, '*')");
  await waitFor("document.querySelector('[role=alert]')?.textContent === 'Project storage unavailable'");
  await click(".project-load-error button");
  assert.equal(await evaluate("requests.filter(({type}) => type === 'requestRecentProjects').length"), 2);
  assert.equal(await evaluate("document.querySelectorAll('.project-loading-row').length"), 2);
  await evaluate("window.postMessage({type:'recentProjects', projects:[]}, '*')");
  await waitFor("document.querySelectorAll('.project-loading-row').length === 2");
  await evaluate("window.postMessage({type:'pinnedProjects', projects:[]}, '*')");
  await waitFor("document.querySelectorAll('.project-empty-hint').length === 2");

  await evaluate(`(() => {
    const add = document.querySelector('.recent-view-all');
    add.click();
    add.click();
  })()`);
  assert.equal(await evaluate("requests.filter(({type}) => type === 'addPinnedProject').length"), 1);
  await evaluate("window.postMessage({type:'projectAction', busy:true, detail:'Adding pinned project…', target:{section:'pins'}}, '*')");
  await waitFor("document.querySelector('[role=status]').textContent === 'Adding pinned project…'");
  await evaluate("window.postMessage({type:'projectAction', busy:false, target:{section:'pins'}}, '*')");
  await waitFor("document.querySelector('[role=status]').textContent === ''");

  await evaluate(`window.pins = [
    {id:'a'.repeat(64), name:'Renamed project', path:'/projects/first', kind:'folder', canRestoreName:true},
    {id:'b'.repeat(64), name:'Second project', path:'/projects/second', kind:'folder'}
  ]; window.postMessage({type:'pinnedProjects', projects:pins}, '*')`);
  await waitFor("document.querySelectorAll('.pinned-row').length === 2");
  await send("Emulation.setDeviceMetricsOverride", { width: 280, height: 420, deviceScaleFactor: 1, mobile: false });
  await click(".pinned-row .recent-menu-trigger");
  const openMenu = ".recent-menu-items:popover-open";
  assert.equal(await evaluate(`(() => {
    const menu = document.querySelector('${openMenu}');
    const r = menu.getBoundingClientRect();
    return menu.contains(document.activeElement) && r.left >= 0 && r.top >= 0 &&
      r.right <= document.documentElement.clientWidth && r.bottom <= innerHeight;
  })()`), true);
  await send("Input.dispatchKeyEvent", {type:"keyDown", key:"ArrowDown", code:"ArrowDown"});
  assert.equal(await evaluate("document.activeElement.textContent"), "Rename");
  await send("Input.dispatchKeyEvent", {type:"keyDown", key:"Escape", code:"Escape"});
  await waitFor("document.activeElement.classList.contains('recent-menu-trigger')");
  assert.equal(await evaluate(`document.querySelector('${openMenu}')`), null);
  await click(".pinned-row .recent-menu-trigger");
  await send("Input.dispatchMouseEvent", {type:"mousePressed", x:4, y:4, button:"left", clickCount:1});
  await send("Input.dispatchMouseEvent", {type:"mouseReleased", x:4, y:4, button:"left", clickCount:1});
  await waitFor("document.activeElement.classList.contains('recent-menu-trigger')");
  assert.equal(await evaluate(`document.querySelector('${openMenu}')`), null);
  await send("Emulation.clearDeviceMetricsOverride");

  await click(".pinned-row .recent-menu-trigger");
  await evaluate(`[...document.querySelectorAll('${openMenu} button')]
    .find(button => button.textContent === 'Restore original name').click()`);
  assert.equal(await evaluate("requests.at(-1).type"), "restorePinnedProjectName");
  await evaluate(`window.postMessage({type:'projectAction',busy:false,error:'Could not rename project',
    target:{section:'pins',id:pins[0].id}}, '*')`);
  await waitFor("document.querySelector('.pinned-row [role=alert]')?.textContent === 'Could not rename project'");
  await click(".pinned-row .recent-menu-trigger");
  await evaluate(`[...document.querySelectorAll('${openMenu} button')]
    .find(button => button.textContent === 'Move down').click()`);
  assert.deepEqual(await evaluate("requests.at(-1)"), {
    type: "reorderPinnedProjects", ids: ["b".repeat(64), "a".repeat(64)], id: "a".repeat(64),
  });
  await evaluate(`window.postMessage({type:'projectAction',busy:true,detail:'Moving pinned project…',
    target:{section:'pins',id:pins[0].id}}, '*')`);
  await waitFor("document.querySelector('.pinned-row').getAttribute('aria-busy') === 'true'");
  await evaluate(`window.postMessage({type:'pinnedProjects',projects:[pins[1],pins[0]]}, '*');
    window.postMessage({type:'projectAction',busy:false,detail:'Renamed project moved to position 2 of 2.',
      target:{section:'pins',id:pins[0].id}}, '*')`);
  await waitFor("document.querySelector('[role=status]').textContent.includes('position 2 of 2')");
  assert.equal(await evaluate("document.activeElement.getAttribute('aria-label')"), "Actions for Renamed project");
  await evaluate(`window.dragData = new DataTransfer();
    document.querySelector('.pinned-drag-handle').dispatchEvent(new DragEvent('dragstart', {
      bubbles:true, dataTransfer:dragData
    }));`);
  await waitFor("document.querySelector('.pinned-row[data-dragging]')");
  await evaluate(`document.querySelector('.pinned-row + .pinned-row').dispatchEvent(new DragEvent('dragover', {
    bubbles:true, cancelable:true, dataTransfer:dragData
  }))`);
  await waitFor("document.querySelector('.pinned-row + .pinned-row').dataset.drop === 'after'");
  await evaluate(`document.querySelector('.pinned-row + .pinned-row').dispatchEvent(new DragEvent('drop', {
    bubbles:true, cancelable:true, dataTransfer:dragData
  }))`);
  assert.deepEqual(await evaluate("requests.at(-1)"), {
    type: "reorderPinnedProjects", ids: ["a".repeat(64), "b".repeat(64)], id: "b".repeat(64),
  });
  await waitFor("!document.querySelector('.pinned-row[data-drop], .pinned-row[data-dragging]')");
  await evaluate(`window.postMessage({type:'projectAction',busy:false}, '*')`);

  await evaluate("window.postMessage({type:'projectAction',busy:true}, '*')");
  await waitFor("document.querySelector('.project-actions').getAttribute('aria-disabled') === 'true'");
  await click(".utility-tile");
  assert.equal(await evaluate("requests.some(({type}) => type === 'quickAction')"), false);
  await evaluate("window.postMessage({type:'projectAction',busy:false,error:'Git Clone is unavailable.'}, '*')");
  await waitFor("document.querySelector('[role=alert]')?.textContent === 'Git Clone is unavailable.'");
  await click(".utility-tile");
  assert.equal(await evaluate("requests.some(({type}) => type === 'quickAction')"), true);
  await evaluate("window.postMessage({type:'projectAction',busy:false}, '*')");
  await evaluate(`window.postMessage({type:'pinnedProjects',projects:[
    {id:'a'.repeat(64), name:'Legacy project', path:'/projects/legacy', kind:'folder', unresolved:true}
  ]}, '*')`);
  await waitFor("document.querySelector('.pinned-row .recent-open')?.disabled === true");
  await click(".pinned-row .recent-menu-trigger");
  assert.equal(await evaluate("document.querySelector('.pinned-row .recent-menu-items button').textContent"), "Locate project");
  await click(".pinned-row .recent-menu-items button");
  assert.equal(await evaluate("requests.some(({type,id}) => type === 'locatePinnedProject' && id === 'a'.repeat(64))"), true);
  await evaluate(`window.postMessage({type:'projectAction',busy:false,error:'This location is already pinned.',
    target:{section:'pins',id:'a'.repeat(64)}}, '*')`);
  await waitFor("document.querySelector('.pinned-row [role=alert]')?.textContent === 'This location is already pinned.'");
  await evaluate(`window.postMessage({type:'pinnedProjects',projects:[]}, '*');
    window.postMessage({type:'projectAction',busy:false}, '*')`);
  await click(".settings-gear");
  await waitFor("document.querySelector('.settings-view')");
  assert.equal(await evaluate("document.querySelector('fieldset').disabled"), false, "preview must work before a host reply");
  assert.equal(await evaluate("getComputedStyle(document.querySelector('.settings-preview-artwork')).pointerEvents"), "none");

  for (const width of [280, 320, 480, 640, 800, 1024, 1440]) {
    await send("Emulation.setDeviceMetricsOverride", { width, height: 800, deviceScaleFactor: 1, mobile: false });
    const dimensions = await evaluate(`(() => {
      const root = document.documentElement;
      const controls = [...document.querySelectorAll('.settings-view :is(input, select, button, a)')];
      return {
        width: innerWidth, overflow: root.scrollWidth - root.clientWidth,
        clipped: controls.filter((control) => {
          const rect = control.getBoundingClientRect();
          return rect.left < 0 || rect.right > root.clientWidth || rect.width < 16 ||
            (control.matches('button, a') && control.scrollWidth > control.clientWidth);
        }).map((control) => control.textContent || control.outerHTML),
        unlabeled: controls.filter((control) => control.matches('input, select') &&
          !control.labels?.length && !control.getAttribute('aria-label')).length,
      };
    })()`);
    assert.deepEqual(dimensions, { width, overflow: 0, clipped: [], unlabeled: 0 });
    for (const section of ["appearance", "dashboard", "projects", "startup"]) {
      await click(`.settings-nav a[href="#${section}-settings"]`);
      assert.equal(await evaluate("document.activeElement.id"), `${section}-settings`);
      assert.equal(await evaluate(`(() => {
        const heading = document.activeElement.getBoundingClientRect();
        const toolbar = document.querySelector('.settings-savebar').getBoundingClientRect();
        const save = document.querySelector('.settings-save').getBoundingClientRect();
        return heading.top >= toolbar.bottom && save.top >= 0 && save.bottom <= innerHeight;
      })()`), true, `section ${section} at ${width}px`);
    }
    console.log(`Settings at ${width}px passed`);
  }
  await send("Emulation.clearDeviceMetricsOverride");
  await click('.settings-nav a[href="#appearance-settings"]');
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
  assert.equal(await evaluate("document.activeElement.type"), "color");
  assert.equal(await evaluate("getComputedStyle(document.activeElement).outlineStyle"), "solid");

  const hexInput = ".settings-color .settings-hex";
  await input(hexInput, "#ab");
  await waitFor(`document.querySelector('${hexInput}').getAttribute('aria-invalid') === 'true'`);
  assert.match(await evaluate("document.querySelector('.settings-save-state').textContent"), /Review color/);
  assert.equal(await evaluate("token('--background')"), "#080709");
  await click("[data-view-focus]");
  await click(".settings-gear");
  assert.equal(await evaluate(`document.querySelector('${hexInput}').value`), "#ab");
  await input(hexInput, "#343045");
  await waitFor("token('--background') === '#343045'");
  assert.equal(await evaluate(`document.querySelector('${hexInput}').hasAttribute('aria-invalid')`), false);
  assert.equal(await evaluate("document.querySelector('.settings-save-state').textContent"), "Unsaved changes");

  await click("fieldset:first-of-type .settings-field:nth-child(2) .settings-swatch:nth-child(2)");
  await waitFor("token('--background') === '#131b2a'");
  assert.equal(await evaluate("document.querySelector('.settings-color .settings-swatch[aria-pressed=true]').textContent.trim()"), "Ink blue✓");
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
  await click(".settings-status button");
  await waitFor("document.querySelector('.settings-status [role=alert]')?.textContent.includes('Configuration unavailable')");
  assert.equal(await evaluate("document.querySelector('button[type=submit]').disabled"), true);
  await evaluate("failRead = false");
  await click(".settings-status button");
  await waitFor("!document.querySelector('button[type=submit]').disabled");
  assert.equal(await evaluate("token('--background')"), "#343045", "sync must preserve the draft");
  await input(hexInput, "#343");
  await waitFor(`document.querySelector('${hexInput}').getAttribute('aria-invalid') === 'true'`);
  assert.equal(await evaluate("document.querySelector('.settings-save').disabled"), true);
  assert.equal(await evaluate("requests.some(({type}) => type === 'saveSettings')"), false);
  await input(hexInput, "#343045");
  await waitFor("!document.querySelector('.settings-save').disabled");


  await click("fieldset:nth-of-type(3) .settings-actions button:first-child");
  await waitFor("document.querySelector('#projects-directory').value === '/home/test/projects'");
  await click("fieldset:nth-of-type(3) .settings-actions button:last-child");
  await input("fieldset:nth-of-type(3) input", "/home/test/edited");
  await click("button[type=submit]");
  await waitFor("document.querySelector('[role=status]')?.textContent === 'Settings saved.'");
  await click("[data-view-focus]");
  await waitFor("!document.querySelector('.settings-view')");
  assert.equal(await evaluate("document.activeElement.className"), "settings-gear");
  assert.equal(await evaluate("token('--background')"), "#343045");
  await click(".settings-gear");
  await click(".settings-reset button");
  await waitFor("document.querySelector('[role=status]')?.textContent === 'Defaults restored.'");
  assert.equal(await evaluate("token('--background')"), "#080709");
  assert.equal(await evaluate("document.querySelector('#projects-directory').value"), "/home/test/edited");
  const startupSelect = "fieldset:nth-of-type(4) select";
  const replaceWelcome = "fieldset:nth-of-type(4) .settings-actions button:first-child";
  const restoreWelcome = "fieldset:nth-of-type(4) .settings-actions button:last-child";
  assert.equal(await evaluate(`document.querySelector('${startupSelect}').value`), "never");
  await evaluate(`(() => {
    const select = document.querySelector('${startupSelect}');
    select.value = 'always';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await input("fieldset:nth-of-type(3) input", "/home/test/unsaved");
  await click(".settings-reset button");
  await waitFor("document.querySelector('.settings-status p')?.textContent === 'Defaults restored.'");
  assert.equal(await evaluate(`document.querySelector('${startupSelect}').value`), "always");
  assert.equal(await evaluate("document.querySelector('fieldset:nth-of-type(3) input').value"), "/home/test/unsaved");
  assert.match(await evaluate("document.querySelector('.settings-directory').textContent"), /\/home\/test\/edited/);
  await input("fieldset:nth-of-type(3) input", "/home/test/edited");
  await click(replaceWelcome);
  await waitFor(`document.querySelector('${startupSelect}').value === 'emptyWindow'`);
  const statusBarToggle = "fieldset:nth-of-type(4) input[type=checkbox]";
  assert.equal(await evaluate(`document.querySelector('${statusBarToggle}').checked`), false);
  await click(statusBarToggle);
  await evaluate(`(() => {
    const select = document.querySelector('${startupSelect}');
    select.value = 'always';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await click("button[type=submit]");
  await waitFor("document.querySelector('[role=status]')?.textContent === 'Settings saved.'");
  assert.ok(await evaluate("requests.some(request => request.changes?.startupBehavior === 'always')"));
  assert.ok(await evaluate("requests.some(request => request.changes?.showStatusBarItem === true && request.expected.showStatusBarItem === false)"));
  await click(".settings-reset button");
  await waitFor("document.querySelector('[role=status]')?.textContent === 'Defaults restored.'");
  assert.equal(await evaluate(`document.querySelector('${startupSelect}').value`), "always");
  assert.equal(await evaluate(`document.querySelector('${statusBarToggle}').checked`), true);
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

  const welcomeInput = "fieldset:nth-of-type(2) input[type=text]";
  const directoryInput = "fieldset:nth-of-type(3) input";
  const saveButton = "button[type=submit]";
  const recoveryButton = ".settings-status button";
  const status = "document.querySelector('.settings-status p')?.textContent";
  // A rejected save keeps the invalid field and unrelated valid edits.
  await evaluate("saveMode = 'reject'");
  await input(welcomeInput, "Keep this greeting");
  await input(directoryInput, "../invalid");
  await click(saveButton);
  await waitFor(`${status} === 'Nothing was saved.'`);
  assert.equal(await evaluate(`document.querySelector('${welcomeInput}').value`), "Keep this greeting");
  assert.equal(await evaluate(`document.querySelector('${directoryInput}').value`), "../invalid");
  assert.match(await evaluate("document.querySelector('.settings-status li').textContent"), /Projects directory/);
  assert.equal(await evaluate("document.querySelector('#projects-directory').getAttribute('aria-invalid')"), "true");
  assert.equal(await evaluate("document.querySelector('#directory-error').textContent"), "Use an absolute path");

  await input(directoryInput, "/home/test/edited");
  await input(backgroundInput, "#131b2a");
  await evaluate("saveMode = 'partial'");
  await click(saveButton);
  await waitFor(`${status} === '1 saved, 1 not saved.'`);
  assert.equal(await evaluate(`document.querySelector('${welcomeInput}').value`), "Keep this greeting");
  await evaluate("saveMode = 'lost'");
  const beforeRecovery = await evaluate("requests.filter(({type}) => type === 'saveSettings').length");
  await click(saveButton);
  await waitFor(`${status}?.includes('outcome is unknown')`);
  await input(welcomeInput, "Newer draft after timeout");
  await click(recoveryButton);
  await waitFor(`${status} === 'Settings saved.'`);
  assert.equal(await evaluate("requests.filter(({type}) => type === 'saveSettings').length"), beforeRecovery + 1);
  assert.equal(await evaluate(`document.querySelector('${welcomeInput}').value`), "Newer draft after timeout");
  assert.deepEqual(await evaluate("Object.keys(requests.filter(({type}) => type === 'saveSettings').at(-1).changes).sort()"),
    ["artworkOpacity", "welcomeMessage"]);

  // A newer native snapshot must win over an older, correlated mutation reply.
  await evaluate("saveMode = 'held'");
  await click(saveButton);
  await waitFor("Boolean(held)");
  await evaluate("externalEdit({ welcomeMessage:'External change' }); window.postMessage(held, '*')");
  await waitFor(`${status} === 'Settings saved.'`);
  assert.equal(await evaluate(`document.querySelector('${welcomeInput}').value`), "Newer draft after timeout");
  await click("[data-view-focus]");
  await waitFor("document.querySelector('main h1')?.textContent.includes('External change')");
  await click(".settings-gear");

  // Recover when the host no longer knows the result.
  await evaluate("saveMode = 'unknown'");
  await click(saveButton);
  await waitFor(`${status}?.includes('outcome is unknown')`);
  await click(recoveryButton);
  await waitFor(`${status}?.includes('earlier action could not be confirmed')`);
  assert.equal(await evaluate(`document.querySelector('${saveButton}').disabled`), false);
  assert.equal(await evaluate(`document.querySelector('${welcomeInput}').value`), "Newer draft after timeout");

  await click(saveButton);
  await waitFor("document.querySelector('fieldset').disabled");
  await send("Page.navigate", { url: `http://127.0.0.1:${server.address().port}/?legacy=1` });
  await waitFor("document.querySelector('.settings-gear')");
  await click(".settings-gear");
  await waitFor("document.querySelector('.settings-status [role=alert]')?.textContent.includes('different settings versions')");
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
