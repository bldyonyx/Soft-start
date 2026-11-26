import * as vscode from "vscode";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { createProject } from "./newProject";
import { workspaceProjectStore } from "./projectStore";
import { cloneProject, ProjectActions } from "./projectActions";
import { assertProjectOrigin, currentProject, openProject, presentProject, projectId } from "./projects";
import { addPinnedProject, promptPinnedProjectName, selectProjectLocation } from "./pinnedProjects";
import { DashboardPanel } from "./dashboardPanel";
import { Startup, startupScope } from "./startup";
import { onSettingsChanged } from "./settingsConfiguration";
import { SettingsWebview } from "./settingsWebview";
import { isDashboardMessage, settingsHostMeta, settingsHostVersion, type ProjectActionMessage, type ProjectActionTarget, type PinnedProjectsMessage, type RecentProjectsMessage } from "./webviewMessages";

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
    <meta http-equiv="Content-Security-Policy" content="${csp}">
    <meta name="${settingsHostMeta}" content="${settingsHostVersion}">`,
  );

  return html;
}

function reportSettingsDeliveryError(error: unknown) {
  console.error("Soft Start could not send dashboard settings to the webview.", error);
}

export function activate(context: vscode.ExtensionContext) {
  const startup = new Startup(context.globalState, startupScope(context));
  const settings = new SettingsWebview(undefined, undefined, undefined, startup);
  const dashboards = new Set<vscode.Webview>();
  let pendingStorage: ReturnType<typeof workspaceProjectStore> | undefined;
  let observedId: string | undefined;
  let recording = Promise.resolve();
  let refreshing = Promise.resolve();

  function projectStorage() {
    return pendingStorage ??= workspaceProjectStore(context).catch((error: unknown) => {
      pendingStorage = undefined;
      throw error;
    });
  }

  function sendProjectAction(message: ProjectActionMessage) {
    for (const webview of dashboards) {
      void Promise.resolve(webview.postMessage(message)).catch((error: unknown) => {
        console.error("Soft Start could not send project action status.", error);
      });
    }
  }

  const actions = new ProjectActions(sendProjectAction);
  function refreshProjects() {
    if (!dashboards.size) {
      return Promise.resolve();
    }
    refreshing = refreshing.then(async () => {
      const { store } = await projectStorage();
      const { recent, pins } = await store.read();
      const history: RecentProjectsMessage = { type: "recentProjects",
        projects: recent.map((entry) => ({ ...presentProject(entry), lastOpened: entry.lastOpened })) };
      const pinned: PinnedProjectsMessage = { type: "pinnedProjects",
        projects: pins.map((entry) => presentProject({ ...entry, name: entry.displayName ?? entry.name })) };
      for (const webview of dashboards) {
        await webview.postMessage(history);
        await webview.postMessage(pinned);
      }
    }).catch((error: unknown) => {
      const detail = error instanceof Error ? error.message : String(error);
      sendProjectAction(actions.status(`Could not refresh projects. ${detail}`, { section: "pins" }));
    });
    return refreshing;
  }

  function trackProject() {
    const project = currentProject(vscode.workspace);
    const id = project && projectId(project.uri);
    if (id === observedId) {
      return;
    }
    observedId = id;
    if (project) {
      recording = recording.then(async () => {
        const { store } = await projectStorage();
        await store.record(project);
        await refreshProjects();
      }).catch((error: unknown) => {
        if (observedId === id) {
          observedId = undefined;
        }
        console.error("Soft Start could not record the current project.", error);
      });
    }
  }

  function publishSettings() {
    for (const webview of dashboards) {
      void settings.publish(webview).catch(reportSettingsDeliveryError);
    }
  }

  const dashboard = new DashboardPanel<vscode.WebviewPanel>((preserveFocus) => {
    const panel = vscode.window.createWebviewPanel(
      "softStart",
      "Soft Start",
      { viewColumn: vscode.ViewColumn.One, preserveFocus },
      {
        enableScripts: true,
        localResourceRoots: [
          vscode.Uri.joinPath(context.extensionUri, "media"),
        ],
      },
    );
    const { webview } = panel;
    dashboards.add(webview);
    let disposed = false;
    let watcher: ReturnType<Awaited<ReturnType<typeof workspaceProjectStore>>["journal"]["watch"]> | undefined;
    let watchTimer: ReturnType<typeof setTimeout> | undefined;

    async function watchProjects() {
      if (watcher || disposed) {
        return;
      }
      const { journal, store } = await projectStorage();
      await store.read();
      if (!watcher && !disposed) {
        watcher = journal.watch(() => {
          clearTimeout(watchTimer);
          watchTimer = setTimeout(() => void refreshProjects(), 75);
        }, (error) => {
          watcher?.close();
          watcher = undefined;
          console.error("Soft Start could not watch project changes.", error);
        });
      }
    }

    const listener = webview.onDidReceiveMessage(async (message: unknown) => {
      if (!isDashboardMessage(message)) {
        return;
      }
      if (message.type === "requestSettings" || message.type === "saveSettings" ||
          message.type === "restoreSettings" || message.type === "browseProjectsDirectory" ||
          message.type === "enableWelcomeReplacement" || message.type === "restoreWelcomeReplacement") {
        await settings.handle(message, webview).catch(reportSettingsDeliveryError);
        return;
      }
      if (message.type === "requestRecentProjects") {
        await webview.postMessage(actions.status());
        trackProject();
        await recording;
        await watchProjects().catch((error: unknown) => console.error("Soft Start could not watch projects.", error));
        await refreshProjects();
        return;
      }
      const target: ProjectActionTarget = {
        section: message.type === "quickAction" ? "quick" :
          message.type.endsWith("RecentProject") || message.type === "viewAllRecentProjects" ? "recent" : "pins",
        id: "id" in message ? message.id : undefined,
      };
      await actions.run(async (focus) => {
        if (message.type === "quickAction") {
          switch (message.action) {
            case "newProject":
              await createProject();
              break;
            case "openFolder":
              await vscode.commands.executeCommand("workbench.action.files.openFolder");
              break;
            case "cloneRepository":
              await cloneProject();
              break;
          }
          return;
        }

        await recording;
        const { store } = await projectStorage();
        try {
          switch (message.type) {
            case "removeRecentProject":
              await store.forget(message.id);
              return;
            case "addPinnedProject":
              await addPinnedProject(store);
              return;
            case "locatePinnedProject":
            case "locateRecentProject": {
              const list = message.type === "locatePinnedProject" ? "pins" : "recent";
              const original = (await store.read())[list].find(({ id }) => id === message.id);
              if (original?.origin.kind !== "unknown") {
                throw new Error("This project has changed. Refresh the dashboard and try again.");
              }
              const selection = await selectProjectLocation(original.kind, undefined, true);
              if (selection) {
                await store.locate(list, original.id, selection);
              }
              return;
            }
            case "pinRecentProject": {
              const project = (await store.read()).recent.find(({ id }) => id === message.id);
              if (!project) {
                throw new Error("This project is no longer in Soft Start’s recent history.");
              }
              await store.pin(project);
              return;
            }
            case "unpinProject":
              await store.unpin(message.id);
              return;
            case "reorderPinnedProjects":
              await store.reorder(message.ids);
              return;
            case "renamePinnedProject": {
              const project = (await store.read()).pins.find(({ id }) => id === message.id);
              if (!project) {
                throw new Error("This project is no longer pinned.");
              }
              const name = await promptPinnedProjectName(project);
              if (name !== undefined) {
                await store.rename(project, name);
              }
              return;
            }
          }

          const fromPins = message.type === "openPinnedProject";
          let id: string | undefined;
          if (message.type === "viewAllRecentProjects") {
            const items = (await store.read()).recent.map(presentProject).map((item) => ({
              id: item.id,
              label: item.name,
              description: item.path,
              detail: item.unresolved ? "Use Locate project on the dashboard to confirm this location." : undefined,
            }));
            id = (await vscode.window.showQuickPick(items, {
              title: "Recent projects",
              placeHolder: "Select a project to open",
              matchOnDescription: true,
            }))?.id;
          } else if (message.type === "openRecentProject" || fromPins) {
            id = message.id;
          }
          if (id) {
            focus({ ...target, id });
            const latest = await store.read();
            const project = (fromPins ? latest.pins : latest.recent).find((entry) => entry.id === id);
            if (!project) {
              throw new Error(fromPins ? "This project is no longer pinned." : "This project is no longer in Soft Start’s recent history.");
            }
            assertProjectOrigin(project, store.host);
            await openProject(project);
            // The destination host records the workspace after VS Code opens it.
          }
        } finally {
          await refreshProjects();
        }
      }, target);
    });
    panel.onDidDispose(() => {
      disposed = true;
      settings.dispose(webview);
      clearTimeout(watchTimer);
      watcher?.close();
      dashboard.closed(panel);
      dashboards.delete(webview);
      listener.dispose();
    });
    try {
      webview.html = getWebviewHtml(webview, context.extensionUri);
      return panel;
    } catch (error) {
      panel.dispose();
      throw error;
    }
  });

  trackProject();
  context.subscriptions.push(
    onSettingsChanged(publishSettings),
    vscode.workspace.onDidChangeWorkspaceFolders(trackProject),
    vscode.window.onDidChangeWindowState((state) => {
      if (state.focused) {
        trackProject();
        void recording.then(() => refreshProjects());
      }
    }),
    vscode.commands.registerCommand("soft-start.openDashboard", () => dashboard.open()),
  );



  if (context.extensionMode !== vscode.ExtensionMode.Test) {
    // Startup activation happens once per host. Closing a panel or changing settings never triggers opening.
    try {
      const hasTabs = vscode.window.tabGroups.all.some(({ tabs }) => tabs.length > 0);
      dashboard.openAtStartup(() => startup.shouldOpen({
        hasWorkspaceFile: Boolean(vscode.workspace.workspaceFile),
        folderCount: vscode.workspace.workspaceFolders?.length ?? 0,
        hasTabs,
      }), hasTabs);
    } catch (error) {
      console.error("Soft Start could not open the startup dashboard.", error);
    }
    void startup.onboard().then(publishSettings).catch((error: unknown) => {
      console.error("Soft Start could not set up the startup page.", error);
      const detail = error instanceof Error ? error.message : String(error);
      void vscode.window.showWarningMessage(`Soft Start could not set up the startup page. ${detail}`);
    });
  }
}

export function deactivate() {}
