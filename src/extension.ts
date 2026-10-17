import * as vscode from 'vscode';
import { Connections, DEMO_PROFILE } from './connections';
import { Preview } from './preview';
import { SsrsSession } from './ssrs';
import { createTransport } from './transport';
import { analysisOf, registerLanguage } from './language';
import { DesignerProvider } from './designer';
import { prepareRdl } from './rdl';
import type { ParameterValues } from './types';

export function activate(context: vscode.ExtensionContext) {
  registerLanguage(context);
  const designers = new DesignerProvider(context);
  const serverDiagnostics = vscode.languages.createDiagnosticCollection('rdl-server');
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(DesignerProvider.viewType, designers, { supportsMultipleEditorsPerDocument: true }),
    serverDiagnostics,
    vscode.workspace.onDidChangeTextDocument(event => { if (event.contentChanges.length) serverDiagnostics.delete(event.document.uri); }),
    vscode.workspace.onDidSaveTextDocument(document => {
      if (current && current.uri.toString() === document.uri.toString() && vscode.workspace.getConfiguration('rdlPreview').get<boolean>('refreshOnSave')) void current.reload().catch(showError);
    })
  );
  const connections = new Connections(context);
  const remembered = new Map<string, ParameterValues>();
  let current: Preview | undefined;
  const showError = (error: unknown) => vscode.window.showErrorMessage(`RDL Preview: ${error instanceof Error ? error.message : String(error)}`);
  const guard = (fn: (...args: any[]) => Promise<unknown>) => (...args: any[]) => fn(...args).catch(showError);
  context.subscriptions.push(connections.onChange(change => { if (change === 'profiles') remembered.clear(); void current?.reconnect(); }));
  async function preview(uri?: vscode.Uri): Promise<void> {
    if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before previewing reports.');
    const target = rdlTarget(uri);
    if (!target || !/\.rdl$/i.test(target.path)) throw new Error('Open an .rdl file, then run Preview Report.');
    current?.dispose(); current = undefined;
    if (!connections.active() && !await connections.switch()) return;
    await Preview.open(context, target, connections, remembered, panel => { current = panel; });
  }
  const rdlTarget = (uri?: vscode.Uri): vscode.Uri | undefined => uri instanceof vscode.Uri ? uri : vscode.window.activeTextEditor?.document.uri ?? designers.active?.document.uri;
  async function openDesigner(uri?: vscode.Uri): Promise<void> {
    const target = rdlTarget(uri);
    if (!target || !/\.rdlc?$/i.test(target.path)) throw new Error('Open an .rdl file, then run Open Designer.');
    const fromText = vscode.window.activeTextEditor?.document.uri.toString() === target.toString();
    await vscode.commands.executeCommand('vscode.openWith', target, DesignerProvider.viewType, fromText ? vscode.ViewColumn.Beside : vscode.ViewColumn.Active);
  }
  async function openXml(uri?: vscode.Uri): Promise<void> {
    const target = uri instanceof vscode.Uri ? uri : designers.active?.document.uri;
    if (target) await vscode.window.showTextDocument(target, { viewColumn: vscode.ViewColumn.Beside });
  }
  async function validate(uri?: vscode.Uri): Promise<void> {
    if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before sending reports to a server.');
    const target = rdlTarget(uri);
    if (!target || !/\.rdl$/i.test(target.path)) throw new Error('Open an .rdl file, then run Validate on Server.');
    const profile = connections.active() || await connections.switch();
    if (!profile) return;
    if (profile.auth === 'demo') { await vscode.window.showInformationMessage('Demo mode has no report server. Choose a real connection to validate on the server.'); return; }
    const document = await vscode.workspace.openTextDocument(target);
    const session = new SsrsSession(profile, createTransport(profile, await connections.password(profile), context.extensionPath));
    serverDiagnostics.delete(target);
    try {
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Validating on ${profile.name}`, cancellable: true }, async (_progress, token) => {
        const sub = token.onCancellationRequested(() => session.dispose());
        try { await session.load(prepareRdl(document.getText(), profile)); } finally { sub.dispose(); }
      });
      void vscode.window.showInformationMessage(`${profile.name} accepted the report definition.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Point at the first quoted name SSRS mentions that the report declares, else the report element.
      const analysis = analysisOf(document);
      const named = [...message.matchAll(/[‘'"“]([A-Za-z_]\w*)[’'"”]/g)].map(m => analysis.declarations.find(d => d.name === m[1])).find(Boolean);
      const start = named?.start ?? analysis.root?.start ?? 0, end = named?.end ?? analysis.root?.openEnd ?? 0;
      const diagnostic = new vscode.Diagnostic(new vscode.Range(document.positionAt(start), document.positionAt(end)), message, vscode.DiagnosticSeverity.Error);
      diagnostic.source = `SSRS (${profile.name})`;
      serverDiagnostics.set(target, [diagnostic]);
      throw new Error(`${profile.name} rejected the report definition: ${message}`);
    } finally { session.dispose(); }
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
  for (const [command, handler] of Object.entries({ preview, manageProfiles: () => connections.manage(), switchProfile: () => connections.switch(), testConnection, demo, openDesigner, openXml, validate })) context.subscriptions.push(vscode.commands.registerCommand(`rdlPreview.${command}`, guard(handler)));
  context.subscriptions.push({ dispose: () => { current?.dispose(); remembered.clear(); } });
  if (context.extensionMode !== vscode.ExtensionMode.Test) return;
  return { designer: () => designers.active && { snapshot: () => designers.active!.snapshot(), send: (message: unknown) => designers.active!.receive(message) }, snapshot: () => current?.snapshot(), render: (values: ParameterValues) => current?.submit(values, true), selectEnvironment: (id: string) => current?.selectEnvironment(id), disposePreview: () => { current?.dispose(); current = undefined; } };
}
export function deactivate(): void {}
