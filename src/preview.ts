import * as vscode from 'vscode';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { DemoSession } from './demo';
import { createTransport } from './transport';
import { SsrsSession } from './ssrs';
import { prepareRdl } from './rdl';
import { initialValues, invalidateDependents, validateValues } from './parameters';
import { webviewHtml } from './webview';
import { DEMO_PROFILE, type Connections } from './connections';
import type { ExecutionInfo, ParameterValues, Profile, ReportSession } from './types';

export interface PreviewSnapshot { report: string; profile: string; demo: boolean; parameterNames: string[]; pdfBytes: number; pdfPages: number; viewerReady: boolean; viewerError: string; invalidated: boolean }
export class Preview {
  private readonly panel: vscode.WebviewPanel;
  private profile?: Profile;
  private session?: ReportSession;
  // Incremented whenever the execution is replaced so stale replies are ignored.
  private generation = 0;
  private info?: ExecutionInfo;
  private values: ParameterValues = Object.create(null);
  private pdf?: Uint8Array;
  private loaded = false;
  private viewerReady = false;
  private pdfPages = 0;
  private viewerError = '';
  private busy = false;
  private disposed = false;
  private invalidated = false;
  private error = '';
  private fieldErrors: Record<string, string> = {};
  private readonly subscriptions: vscode.Disposable[] = [];
  private constructor(private context: vscode.ExtensionContext, readonly uri: vscode.Uri, private connections: Connections, private remembered: Map<string, ParameterValues>) {
    this.panel = vscode.window.createWebviewPanel('rdlPreview', `RDL: ${path.basename(uri.fsPath)}`, vscode.ViewColumn.Beside, {
      enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')]
    });
    this.panel.webview.html = this.html();
    const manage = (action: Promise<unknown>) => void action.catch(error => vscode.window.showErrorMessage(`RDL Preview: ${error instanceof Error ? error.message : String(error)}`));
    this.subscriptions.push(this.panel.onDidDispose(() => { this.disposed = true; this.session?.dispose(); for (const sub of this.subscriptions) sub.dispose(); }), this.panel.webview.onDidReceiveMessage(message => {
      if (message?.type === 'ready') { this.viewerReady = true; this.postState(); if (this.pdf) this.postPdf(); }
      else if (message?.type === 'pdfDisplayed' && Number.isInteger(message.pages) && message.pages > 0) { this.pdfPages = message.pages; this.viewerError = ''; }
      else if (message?.type === 'pdfError' && typeof message.error === 'string') { this.viewerError = message.error.slice(0, 1000); }
      else if (message?.type === 'render' || message?.type === 'refresh') {
        void this.submit(message.values, message.type === 'render').catch(error => this.fail(error));
      } else if (message?.type === 'savePdf') void this.savePdf();
      else if (message?.type === 'selectEnvironment' && typeof message.id === 'string') manage(this.selectEnvironment(message.id));
      else if (message?.type === 'addConnection') manage(this.connections.add());
      else if (message?.type === 'manageConnections') manage(this.connections.manage());
    }));
  }
  static async open(context: vscode.ExtensionContext, uri: vscode.Uri, connections: Connections, remembered: Map<string, ParameterValues>, onCreated?: (preview: Preview) => void): Promise<Preview> {
    const preview = new Preview(context, uri, connections, remembered);
    onCreated?.(preview);
    await preview.reconnect(); return preview;
  }
  private get key(): string { return `${this.profile?.id}:${this.uri.toString()}`; }
  snapshot(): PreviewSnapshot { return { report: path.basename(this.uri.fsPath), profile: this.profile?.name || '', demo: this.profile?.auth === 'demo', parameterNames: this.info?.parameters.map(p => p.name) || [], pdfBytes: this.pdf?.length || 0, pdfPages: this.pdfPages, viewerReady: this.viewerReady, viewerError: this.viewerError, invalidated: this.invalidated }; }
  dispose(): void { this.panel.dispose(); }
  async selectEnvironment(id: string): Promise<void> {
    const profile = [...this.connections.profiles(), DEMO_PROFILE].find(p => p.id === id);
    if (!profile) throw new Error('That connection no longer exists.');
    await this.connections.select(profile);
  }
  /** Follows the active connection, starting a new execution in this panel when it changes. */
  async reconnect(): Promise<void> {
    if (this.disposed) return;
    let profile: Profile | undefined;
    try { profile = this.connections.active(); } catch (error) { this.reset(undefined); this.fail(error); return; }
    // Unchanged connection: only the environment list may need refreshing.
    if (profile && this.profile && JSON.stringify(profile) === JSON.stringify(this.profile)) { this.postState(); return; }
    const generation = this.reset(profile);
    if (!profile) { this.error = 'The selected connection is no longer available. Choose an environment above.'; this.postState(); return; }
    this.busy = true; this.postState();
    try {
      const password = await this.connections.password(profile);
      if (generation !== this.generation || this.disposed) return;
      this.session = profile.auth === 'demo' ? new DemoSession() : new SsrsSession(profile, createTransport(profile, password, this.context.extensionPath));
    } catch (error) {
      if (generation === this.generation) { this.busy = false; this.fail(error); }
      return;
    }
    await this.initialize(generation, profile, this.session);
  }
  private reset(profile: Profile | undefined): number {
    this.session?.dispose(); this.session = undefined;
    this.profile = profile; this.info = undefined; this.values = Object.create(null); this.pdf = undefined; this.pdfPages = 0; this.viewerError = '';
    this.loaded = false; this.busy = false; this.invalidated = !profile; this.error = ''; this.fieldErrors = {};
    return ++this.generation;
  }
  private async initialize(generation: number, profile: Profile, session: ReportSession): Promise<void> {
    const current = () => generation === this.generation && !this.disposed;
    try {
      // Read the open document so unsaved edits are included.
      const document = await vscode.workspace.openTextDocument(this.uri);
      const rdl = prepareRdl(document.getText(), profile);
      let info = await session.load(rdl);
      if (!current()) return;
      if (info.credentialsRequired) {
        const credentials = [];
        for (const prompt of info.dataSourcePrompts) {
          if (!current()) return;
          const username = await vscode.window.showInputBox({ title: `Database credentials — ${profile.name}`, prompt: `${prompt.prompt || prompt.name}: username. Used only for this report execution.`, ignoreFocusOut: true });
          if (username === undefined) throw new Error('Database sign-in cancelled. Run Preview Report to try again.');
          const password = await vscode.window.showInputBox({ title: `Database credentials — ${prompt.name}`, prompt: 'Password. Used only for this report execution; not saved.', password: true, ignoreFocusOut: true });
          if (password === undefined) throw new Error('Database sign-in cancelled. Run Preview Report to try again.');
          credentials.push({ name: prompt.name, username, password });
        }
        if (!credentials.length) throw new Error('SSRS requires database credentials but returned no data-source prompts. Check shared data-source configuration.');
        info = await session.setCredentials(credentials);
      }
      let values = initialValues(info.parameters, this.remembered.get(this.key));
      // Apply remembered/default values to resolve any query-backed dependent choices.
      if (Object.keys(values).length) {
        info = await session.setParameters(values);
        values = initialValues(info.parameters, values);
      }
      if (!current()) return;
      this.info = info; this.values = values; this.loaded = true;
    } catch (error) { if (current()) this.fail(error); }
    finally { if (current()) { this.busy = false; this.postState(); } }
  }
  async submit(input: unknown, render: boolean): Promise<void> {
    if (this.busy || !this.loaded || this.invalidated || this.disposed || !this.info || !this.session) return;
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Parameter values must be an object.');
    const generation = this.generation, session = this.session;
    const current = () => generation === this.generation && !this.disposed;
    let values: ParameterValues = Object.create(null);
    for (const p of this.info.parameters) {
      const raw = (input as Record<string, unknown>)[p.name];
      if (raw === undefined) continue;
      if (!Array.isArray(raw) || raw.length > 10000 || raw.some(v => v !== null && (typeof v !== 'string' || v.length > 100000))) throw new Error(`Invalid values for ${p.name}.`);
      values[p.name] = raw as (string | null)[];
    }
    const changed = this.info.parameters.filter(p => JSON.stringify(values[p.name]) !== JSON.stringify(this.values[p.name]));
    // Only invalidate descendants of changed parent parameters, then get fresh defaults.
    for (const p of changed) if (this.info.parameters.some(v => v.dependencies.includes(p.name))) values = invalidateDependents(this.info.parameters, values, p.name);
    const localErrors = validateValues(this.info.parameters, values, !render || changed.some(p => this.info!.parameters.some(v => v.dependencies.includes(p.name))));
    this.values = values; this.fieldErrors = localErrors; this.error = '';
    if (Object.keys(localErrors).length) { this.postState(); return; }
    this.busy = true; this.postState();
    try {
      const info = await session.setParameters(values);
      if (!current()) return;
      this.info = info;
      this.values = initialValues(info.parameters, values);
      this.fieldErrors = render ? validateValues(info.parameters, this.values) : {};
      for (const p of info.parameters) {
        if (p.error) this.fieldErrors[p.name] = p.error;
        if (render && p.state !== 'HasValidValue' && !this.fieldErrors[p.name]) this.fieldErrors[p.name] = p.state === 'HasOutstandingDependencies' ? 'Set the upstream parameters and refresh choices.' : 'SSRS requires a valid value for this parameter.';
      }
      this.remembered.set(this.key, this.values);
      if (render && !Object.keys(this.fieldErrors).length) {
        const pdf = await session.render();
        if (!current()) return;
        this.pdf = pdf; this.pdfPages = 0; this.viewerError = ''; this.postPdf();
      }
    } catch (error) { if (current()) this.fail(error); }
    finally { if (current()) { this.busy = false; this.postState(); } }
  }
  private fail(error: unknown): void { this.error = error instanceof Error ? error.message : 'Preview failed. Run Preview Report to try again.'; this.postState(); }
  private postState(): void {
    if (this.disposed) return;
    let profiles: Profile[] = [];
    try { profiles = this.connections.profiles(); } catch { /* Manage Connections reports invalid settings. */ }
    const environments = [...profiles, DEMO_PROFILE].map(p => ({ id: p.id, name: p.name, detail: p.auth === 'demo' ? 'Local simulated preview' : p.serverUrl }));
    void this.panel.webview.postMessage({ type: 'state', report: path.basename(this.uri.fsPath), environments, environmentId: this.profile?.id || '', serverUrl: this.profile && this.profile.auth !== 'demo' ? this.profile.serverUrl : '', demo: this.profile?.auth === 'demo', parameters: this.info?.parameters || [], values: this.values, errors: this.fieldErrors, error: this.error, warnings: this.info?.warnings || [], busy: this.busy, loaded: this.loaded, invalidated: this.invalidated, hasPdf: !!this.pdf });
  }
  private postPdf(): void { if (this.pdf && !this.disposed) void this.panel.webview.postMessage({ type: 'pdf', base64: Buffer.from(this.pdf).toString('base64') }); }
  private async savePdf(): Promise<void> {
    if (!this.pdf) return;
    const prefix = path.basename(this.uri.fsPath, path.extname(this.uri.fsPath));
    const target = await vscode.window.showSaveDialog({ title: 'Save rendered preview', defaultUri: vscode.Uri.file(path.join(path.dirname(this.uri.fsPath), `${prefix}${this.profile?.auth === 'demo' ? '-demo' : ''}.pdf`)), filters: { PDF: ['pdf'] } });
    if (target) await vscode.workspace.fs.writeFile(target, this.pdf);
  }
  private html(): string {
    const view = this.panel.webview;
    const nonce = randomBytes(24).toString('base64');
    const resource = (name: string) => view.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', name)).toString();
    return webviewHtml(resource, view.cspSource, nonce);
  }
}
