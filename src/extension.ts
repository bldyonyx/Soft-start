import * as vscode from "vscode";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { createProject } from "./newProject";
import { isQuickActionMessage } from "./quickActions";

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
  let actionInProgress = false;
  const disposable = vscode.commands.registerCommand(
    "soft-start.openDashboard",
    () => {
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

      panel.webview.html = getWebviewHtml(panel.webview, context.extensionUri);

      const listener = panel.webview.onDidReceiveMessage(async (message: unknown) => {
        if (actionInProgress || !isQuickActionMessage(message)) {
          return;
        }
        actionInProgress = true;
        try {
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
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          void vscode.window.showErrorMessage(`Quick action failed. ${detail}`);
        } finally {
          actionInProgress = false;
        }
      });
      panel.onDidDispose(() => listener.dispose());
    },
  );

  context.subscriptions.push(disposable);
}

export function deactivate() {}
