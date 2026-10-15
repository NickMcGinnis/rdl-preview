import * as vscode from 'vscode';
import { Connections, DEMO_PROFILE } from './connections';
import { Preview } from './preview';
import { SsrsSession } from './ssrs';
import { createTransport } from './transport';
import type { ParameterValues } from './types';

export function activate(context: vscode.ExtensionContext) {
  const connections = new Connections(context);
  const remembered = new Map<string, ParameterValues>();
  let current: Preview | undefined;
  const showError = (error: unknown) => vscode.window.showErrorMessage(`RDL Preview: ${error instanceof Error ? error.message : String(error)}`);
  const guard = (fn: (...args: any[]) => Promise<unknown>) => (...args: any[]) => fn(...args).catch(showError);
  context.subscriptions.push(connections.onChange(() => { current?.invalidate(); remembered.clear(); }));
  async function preview(uri?: vscode.Uri): Promise<void> {
    if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before previewing reports.');
    const target = uri || vscode.window.activeTextEditor?.document.uri;
    if (!target || !/\.rdl$/i.test(target.path)) throw new Error('Open an .rdl file, then run Preview Report.');
    const profile = connections.active() || await connections.switch();
    if (!profile) return;
    current?.dispose(); current = undefined;
    await Preview.open(context, target, profile, connections, remembered, panel => { current = panel; });
  }
  async function demo(): Promise<void> {
    await connections.select(DEMO_PROFILE);
    const uri = vscode.Uri.joinPath(context.extensionUri, 'examples', 'parameter-demo.rdl');
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));
    await preview(uri);
  }
  async function testConnection(): Promise<void> {
    const profile = connections.active() || await connections.switch();
    if (!profile) return;
    if (profile.auth === 'demo') { await vscode.window.showInformationMessage('Demo mode is local and has no SSRS connection to test.'); return; }
    const password = await connections.password(profile);
    const session = new SsrsSession(profile, createTransport(profile, password, context.extensionPath));
    try {
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Testing ${profile.name}`, cancellable: true }, async (_progress, token) => {
        const sub = token.onCancellationRequested(() => session.dispose());
        try { await session.test(); } finally { sub.dispose(); }
      });
      await vscode.window.showInformationMessage(`Connected to ${profile.name}. The SSRS execution service responded. Preview a report to check execution permissions and data-source access.`);
    } finally { session.dispose(); }
  }
  for (const [command, handler] of Object.entries({ preview, manageProfiles: () => connections.manage(), switchProfile: () => connections.switch(), testConnection, demo })) context.subscriptions.push(vscode.commands.registerCommand(`rdlPreview.${command}`, guard(handler)));
  context.subscriptions.push({ dispose: () => { current?.dispose(); remembered.clear(); } });
  if (context.extensionMode !== vscode.ExtensionMode.Test) return;
  return { snapshot: () => current?.snapshot(), render: (values: ParameterValues) => current?.submit(values, true), disposePreview: () => { current?.dispose(); current = undefined; } };
}
export function deactivate(): void {}
