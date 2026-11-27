import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { tmpdir } from "node:os";

export async function withWebviewBrowser({ chromium, media, hostScript }, run) {
  const contentTypes = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2" };
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    const path = url.pathname === "/" ? "/index.html" : url.pathname;
    if (path !== "/index.html" && !/^\/assets\/[\w-]+\.(?:js|css|svg|woff2)$/.test(path)) {
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
        "Content-Security-Policy": "default-src 'none'; script-src 'nonce-test-host'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'none'",
      });
      response.end(body);
    } catch {
      response.writeHead(404).end();
    }
  });

  const profile = await mkdtemp(join(tmpdir(), "soft-start-browser-"));
  let browser;
  let exited;
  let socket;
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    browser = spawn(chromium, [
      "--headless", "--no-first-run", "--no-default-browser-check", "--disable-background-networking",
      "--lang=en-US", "--remote-debugging-port=0", "--window-size=1200,900",
      `--user-data-dir=${profile}`, "about:blank",
    ], { stdio: ["ignore", "ignore", "pipe"] });
    exited = new Promise((resolve) => browser.once("close", resolve));
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
      assert.fail(`Timed out waiting for ${expression}${errors.length ? `\n${errors.join("\n")}` : ""}`);
    }
    await send("Runtime.enable");
    await send("Log.enable");
    await run({ send, evaluate, waitFor, errors, baseUrl: `http://127.0.0.1:${server.address().port}` });
  } finally {
    socket?.close();
    browser?.kill();
    server.closeAllConnections();
    server.close();
    await exited;
    await rm(profile, { recursive: true, force: true });
  }
}
