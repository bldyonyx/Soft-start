import * as vscode from "vscode";
import { readFileSync } from "node:fs";

export function activate(context: vscode.ExtensionContext) {
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

      const htmlPath = vscode.Uri.joinPath(
        context.extensionUri,
        "media",
        "index.html",
      );

      let html = readFileSync(htmlPath.fsPath, "utf8");

      // Convert Vite's relative asset paths into VS Code webview URIs.
      html = html.replace(
        /(src|href)="\.\/([^"]+)"/g,
        (_match, attribute: string, assetPath: string) => {
          const resourceUri = vscode.Uri.joinPath(
            context.extensionUri,
            "media",
            assetPath,
          );

          return `${attribute}="${panel.webview.asWebviewUri(resourceUri)}"`;
        },
      );

      panel.webview.html = html;
    },
  );

  context.subscriptions.push(disposable);
}

export function deactivate() {}
