import * as vscode from "vscode";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { createProject } from "./newProject";
import { presentProject as presentRecentProject, RecentProjects } from "./recentProjects";
import { currentProject, openProject, presentProject, projectId } from "./projects";
import { PinnedProjects, promptPinnedProjectName, selectPinnedProject } from "./pinnedProjects";
import { isDashboardMessage, type PinnedProjectsMessage, type RecentProjectsMessage } from "./webviewMessages";

function getNonce(): string {
  return randomBytes(16).toString("base64");
}

function getWebviewHtml(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
): string {
  const mediaUri = vscode.Uri.joinPath(extensionUri, "media");
  const htmlUri = vscode.Uri.joinPath(mediaUri, "index.html");

  const nonce = getNonce();
  let html = readFileSync(htmlUri.fsPath, "utf8");

  // Convert local resource paths into VS Code webview URIs.
  html = html.replace(
    /(src|href)="(?!https?:|data:|#)(\.?\/?[^"]+)"/g,
    (_match, attribute: string, assetPath: string) => {
      const cleanPath = assetPath.replace(/^\.\//, "").replace(/^\//, "");
      const resourceUri = vscode.Uri.joinPath(mediaUri, cleanPath);

      return `${attribute}="${webview.asWebviewUri(resourceUri)}"`;
    },
  );

  // Vite generates an external module script.
  html = html.replace(/<script\b/g, `<script nonce="${nonce}"`);

  const csp = [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    `style-src ${webview.cspSource}`,
    `img-src ${webview.cspSource} data:`,
    `font-src ${webview.cspSource}`,
    "connect-src 'none'",
  ].join("; ");

  html = html.replace(
    "<head>",
    `<head>
    <meta http-equiv="Content-Security-Policy" content="${csp}">`,
  );

  return html;
}

export function activate(context: vscode.ExtensionContext) {
  const history = new RecentProjects(context.globalState);
  const pins = new PinnedProjects(context.globalState);
  const dashboards = new Set<vscode.Webview>();
  let actionInProgress = false;
  let observedId: string | undefined;
  let recording = Promise.resolve();

  function sendHistory(targets: Iterable<vscode.Webview>) {
    const message: RecentProjectsMessage = {
      type: "recentProjects",
      projects: history.list().map(presentRecentProject),
    };
    for (const webview of targets) {
      void webview.postMessage(message);
    }
  }

  function sendPins(targets: Iterable<vscode.Webview>) {
    const message: PinnedProjectsMessage = {
      type: "pinnedProjects",
      projects: pins.list().map((entry) => presentProject({ ...entry, name: entry.displayName ?? entry.name })),
    };
    for (const webview of targets) {
      void webview.postMessage(message);
    }
  }

  function trackProject() {
    const project = currentProject(vscode.workspace);
    const id = project && projectId(project.uri);
    if (id === observedId) {
      return;
    }
    observedId = id;
    if (project) {
      recording = history.record(project).then(() => sendHistory(dashboards)).catch((error: unknown) => {
        if (observedId === id) {
          observedId = undefined;
        }
        console.error("Soft Start could not record the current project.", error);
      });
    }
  }

  trackProject();
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(trackProject),
    vscode.window.onDidChangeWindowState((state) => {
      if (state.focused) {
        trackProject();
        if (dashboards.size) {
          void recording.then(() => {
            sendHistory(dashboards);
            sendPins(dashboards);
          });
        }
      }
    }),
    vscode.commands.registerCommand("soft-start.openDashboard", () => {
      const panel = vscode.window.createWebviewPanel(
        "softStart",
        "Soft Start",
        vscode.ViewColumn.One,
        {
          enableScripts: true,
          localResourceRoots: [
            vscode.Uri.joinPath(context.extensionUri, "media"),
          ],
        },
      );
      const { webview } = panel;
      dashboards.add(webview);

      const listener = webview.onDidReceiveMessage(async (message: unknown) => {
        if (!isDashboardMessage(message)) {
          return;
        }
        if (message.type === "requestRecentProjects") {
          trackProject();
          await recording;
          if (dashboards.has(webview)) {
            sendHistory([webview]);
            sendPins([webview]);
          }
          return;
        }
        if (actionInProgress) {
          return;
        }
        actionInProgress = true;
        try {
          await recording;
          if (message.type === "quickAction") {
            switch (message.action) {
              case "newProject":
                await createProject();
                break;
              case "openFolder":
                await vscode.commands.executeCommand("workbench.action.files.openFolder");
                break;
              case "cloneRepository":
                await vscode.commands.executeCommand("git.clone");
                break;
            }
            return;
          }

          if (message.type === "removeRecentProject") {
            await history.remove(message.id);
            sendHistory(dashboards);
            return;
          }

          switch (message.type) {
            case "addPinnedProject": {
              const project = await selectPinnedProject();
              if (project) {
                await pins.pin(project);
                sendPins(dashboards);
              }
              return;
            }
            case "pinRecentProject": {
              const project = history.list().find(({ id }) => id === message.id);
              if (!project) {
                throw new Error("This project is no longer in Soft Start’s recent history.");
              }
              await pins.pin({ ...project, uri: vscode.Uri.from(project.uri) });
              sendPins(dashboards);
              return;
            }
            case "unpinProject":
              await pins.unpin(message.id);
              sendPins(dashboards);
              return;
            case "reorderPinnedProjects":
              await pins.reorder(message.ids);
              sendPins(dashboards);
              return;
            case "renamePinnedProject": {
              const project = pins.list().find(({ id }) => id === message.id);
              if (!project) {
                throw new Error("This project is no longer pinned.");
              }
              const name = await promptPinnedProjectName(project);
              if (name !== undefined) {
                await pins.rename(project.id, name);
                sendPins(dashboards);
              }
              return;
            }
          }

          let id: string | undefined;
          if (message.type === "viewAllRecentProjects") {
            const items = history.list().map(presentRecentProject).map((item) => ({
              id: item.id,
              label: item.name,
              description: item.path,
            }));
            const selected = await vscode.window.showQuickPick(items, {
              title: "Recent projects",
              placeHolder: "Select a project to open",
              matchOnDescription: true,
            });
            id = selected?.id;
          } else if (message.type === "openRecentProject" || message.type === "openPinnedProject") {
            id = message.id;
          }
          if (id) {
            const fromPins = message.type === "openPinnedProject";
            const project = (fromPins ? pins.list() : history.list()).find((entry) => entry.id === id);
            if (!project) {
              void vscode.window.showWarningMessage(fromPins ? "This project is no longer pinned." :
                "This project is no longer in Soft Start’s recent history.");
              sendPins(dashboards);
              sendHistory(dashboards);
              return;
            }
            await openProject(project);
            // The destination normally records on activation. Update here too if
            // VS Code keeps this host alive, such as when it focuses an existing window.
            await history.record({ ...project, uri: vscode.Uri.from(project.uri) });
            sendHistory(dashboards);
          }
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          void vscode.window.showErrorMessage(`Soft Start: ${detail}`);
          sendHistory(dashboards);
          sendPins(dashboards);
        } finally {
          actionInProgress = false;
        }
      });
      panel.onDidDispose(() => {
        dashboards.delete(webview);
        listener.dispose();
      });
      webview.html = getWebviewHtml(webview, context.extensionUri);
    }),
  );
}

export function deactivate() {}
