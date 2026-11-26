import * as vscode from "vscode";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { createProject } from "./newProject";
import { UnsupportedProjectStorageError, workspaceProjectStore } from "./projectStore";
import { cloneProject, pendingProjectAction, ProjectActions } from "./projectActions";
import { assertProjectOrigin, currentProject, identifyProject, openProject, presentProject, projectId } from "./projects";
import { addPinnedProject, promptPinnedProjectName, selectProjectLocation } from "./pinnedProjects";
import { DashboardPanel } from "./dashboardPanel";
import { Startup, startupScope } from "./startup";
import { onSettingsChanged, SettingsConfiguration } from "./settingsConfiguration";
import { SettingsWebview } from "./settingsWebview";
import { isDashboardMessage, settingsHostMeta, settingsHostVersion, type ProjectActionMessage, type ProjectActionTarget, type ProjectLoadError, type PinnedProjectsMessage, type RecentProjectsMessage } from "./webviewMessages";

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
  const configuration = new SettingsConfiguration();
  const settings = new SettingsWebview(configuration, undefined, undefined, startup);
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

  function sendProjectFeedback(message: ProjectActionMessage | ProjectLoadError) {
    for (const webview of dashboards) {
      void Promise.resolve().then(() => webview.postMessage(message)).catch((error: unknown) => {
        console.error("Soft Start could not send project feedback.", error);
      });
    }
  }

  const actions = new ProjectActions(sendProjectFeedback);
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
        projects: pins.map((entry) => ({
          ...presentProject({ ...entry, name: entry.displayName ?? entry.name }),
          canRestoreName: Boolean(entry.displayName),
        })) };
      for (const webview of dashboards) {
        await webview.postMessage(history);
        await webview.postMessage(pinned);
      }
    }).catch((error: unknown) => {
      if (error instanceof UnsupportedProjectStorageError) {
        sendProjectFeedback({ type: "projectLoadError", error: error.message, unsupportedStorage: true });
        return;
      }
      const detail = error instanceof Error ? error.message : String(error);
      sendProjectFeedback({ type: "projectLoadError", error: `Could not load projects. ${detail}` });
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
      {
        // Opening in the active group would select the webview even with preserveFocus.
        viewColumn: preserveFocus ? vscode.ViewColumn.Beside : vscode.ViewColumn.One,
        preserveFocus,
      },
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
          message.type === "unpinProject" ? message.section ?? "pins" :
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
              return "Project removed from Recent Projects.";
            case "addPinnedProject": {
              const added = await addPinnedProject(store);
              if (added) {
                return { detail: "Project is in Pinned Projects.",
                  change: { kind: "pinned", id: identifyProject(added, store.host).id } };
              }
              return;
            }
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
                return "Project location confirmed.";
              }
              return;
            }
            case "pinRecentProject": {
              const project = (await store.read()).recent.find(({ id }) => id === message.id);
              if (!project) {
                throw new Error("This project is no longer in Soft Start’s recent history.");
              }
              await store.pin(project);
              return { detail: "Project is pinned.", change: { kind: "pinned", id: project.id } };
            }
            case "unpinProject":
              await store.unpin(message.id);
              return "Project unpinned.";
            case "reorderPinnedProjects": {
              await store.reorder(message.ids);
              if (!message.id) {
                return "Pinned projects reordered.";
              }
              const { pins } = await store.read();
              const position = pins.findIndex(({ id }) => id === message.id);
              if (position === -1) {
                throw new Error("This pin was removed in another window.");
              }
              const project = pins[position];
              return { detail: `${project.displayName ?? project.name} moved to position ${position + 1} of ${pins.length}.`,
                change: { kind: "reordered", id: project.id } };
            }
            case "restorePinnedProjectName":
            case "renamePinnedProject": {
              const project = (await store.read()).pins.find(({ id }) => id === message.id);
              if (!project) {
                throw new Error("This project is no longer pinned.");
              }
              const name = message.type === "restorePinnedProjectName" ? "" : await promptPinnedProjectName(project);
              const trimmed = name?.trim();
              if (trimmed === undefined || trimmed === (project.displayName ?? project.name)) {
                return;
              }
              await store.rename(project, trimmed);
              const expected = trimmed && trimmed !== project.name ? trimmed : undefined;
              const updated = (await store.read()).pins.find(({ id }) => id === project.id);
              if (updated?.pinnedAt !== project.pinnedAt || updated.displayName !== expected) {
                throw new Error("The pin changed in another window. Review the current name and try again.");
              }
              return !expected
                ? "Original project name restored." : "Pinned project renamed.";
            }
          }

          const fromPins = message.type === "openPinnedProject";
          let id: string | undefined;
          if (message.type === "viewAllRecentProjects") {
            const items = (await store.read()).recent.map(presentProject).map((item) => ({
              id: item.id,
              label: item.name,
              description: item.hostLabel ? `${item.hostLabel} · ${item.path}` : item.path,
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
            focus({ ...target, id }, "Opening project…");
            const latest = await store.read();
            const project = (fromPins ? latest.pins : latest.recent).find((entry) => entry.id === id);
            if (!project) {
              throw new Error(fromPins ? "This project is no longer pinned." : "This project is no longer in Soft Start’s recent history.");
            }
            assertProjectOrigin(project, store.host);
            await openProject(project);
            // The destination host records the workspace after VS Code opens it.
            return "Open request accepted by VS Code.";
          }
        } finally {
          await refreshProjects();
        }
      }, target, pendingProjectAction(message));
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
  const openDashboard = "soft-start.openDashboard";
  const statusBar = vscode.window.createStatusBarItem("softStart.dashboard", vscode.StatusBarAlignment.Right);
  statusBar.name = "Soft Start";
  statusBar.text = "Soft Start";
  statusBar.tooltip = "Open Soft Start dashboard";
  statusBar.accessibilityInformation = { label: "Open Soft Start dashboard", role: "button" };
  statusBar.command = openDashboard;
  function updateStatusBar() {
    if (configuration.read().showStatusBarItem) {
      statusBar.show();
    } else {
      statusBar.hide();
    }
  }
  context.subscriptions.push(
    statusBar,
    onSettingsChanged(() => {
      updateStatusBar();
      publishSettings();
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(trackProject),
    vscode.window.onDidChangeWindowState((state) => {
      if (state.focused) {
        trackProject();
        void recording.then(() => refreshProjects());
      }
    }),
    vscode.commands.registerCommand(openDashboard, () => dashboard.open()),
  );
  updateStatusBar();

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
