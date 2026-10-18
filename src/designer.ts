import * as vscode from 'vscode';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { analysisOf } from './language';
import { applyAction, applyField, describe, designerTree, nodeAt, readOnlyReason, wireframe, type Change, type Details, type ImageInput, type TreeNode } from './rdl-designer';
import { designerHtml } from './webview';

export interface DesignerSnapshot { ready: boolean; selected: string; details?: Details; readOnly: string; version: number }
const IMAGE_TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.bmp': 'image/bmp' };
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/** Tree-and-properties editor over the RDL text. The TextDocument stays the source of truth. */
export class DesignerProvider implements vscode.CustomTextEditorProvider {
  static readonly viewType = 'rdlPreview.designer';
  active?: Designer;
  constructor(private readonly context: vscode.ExtensionContext) {}
  resolveCustomTextEditor(document: vscode.TextDocument, panel: vscode.WebviewPanel): void {
    const designer = new Designer(this.context, document, panel);
    this.active = designer;
    panel.onDidChangeViewState(() => { if (panel.active) this.active = designer; });
    panel.onDidDispose(() => { if (this.active === designer) this.active = undefined; });
  }
}

export class Designer {
  private selected = 'Report';
  private tree: TreeNode[] = [];
  private ready = false;
  private refreshTimer?: NodeJS.Timeout;
  private syncTimer?: NodeJS.Timeout;
  private editing: Promise<unknown> = Promise.resolve();
  private readonly probes = new Map<number, (result: unknown) => void>();
  private probeId = 0;
  private readonly subscriptions: vscode.Disposable[] = [];
  constructor(private readonly context: vscode.ExtensionContext, readonly document: vscode.TextDocument, private readonly panel: vscode.WebviewPanel) {
    const media = vscode.Uri.joinPath(context.extensionUri, 'media');
    panel.webview.options = { enableScripts: true, localResourceRoots: [media] };
    const resource = (name: string) => panel.webview.asWebviewUri(vscode.Uri.joinPath(media, name)).toString();
    panel.webview.html = designerHtml(resource, panel.webview.cspSource, randomBytes(24).toString('base64'), context.extensionMode === vscode.ExtensionMode.Test);
    this.subscriptions.push(
      panel.webview.onDidReceiveMessage(message => void this.receive(message)),
      vscode.workspace.onDidChangeTextDocument(event => {
        if (event.document !== document || !event.contentChanges.length) return;
        // Typing in the text editor: refresh once the user pauses.
        clearTimeout(this.refreshTimer);
        this.refreshTimer = setTimeout(() => this.post(), 200);
      }),
      vscode.window.onDidChangeTextEditorSelection(event => {
        if (event.textEditor.document !== document || !panel.visible || (event.kind !== vscode.TextEditorSelectionChangeKind.Mouse && event.kind !== vscode.TextEditorSelectionChangeKind.Keyboard)) return;
        clearTimeout(this.syncTimer);
        this.syncTimer = setTimeout(() => this.followText(document.offsetAt(event.selections[0].active)), 150);
      }),
      panel.onDidDispose(() => { clearTimeout(this.refreshTimer); clearTimeout(this.syncTimer); for (const sub of this.subscriptions) sub.dispose(); })
    );
  }
  snapshot(): DesignerSnapshot {
    const analysis = analysisOf(this.document);
    return { ready: this.ready, selected: this.selected, details: describe(analysis, this.selected), readOnly: readOnlyReason(analysis) ?? '', version: this.document.version };
  }
  private post(): void {
    clearTimeout(this.refreshTimer);
    const analysis = analysisOf(this.document);
    this.tree = designerTree(analysis);
    if (!describe(analysis, this.selected)) this.selected = this.tree[0]?.path ?? 'Report';
    const errors = analysis.issues.filter(i => i.severity === 'error').length;
    void this.panel.webview.postMessage({
      type: 'state', version: this.document.version, file: path.basename(this.document.uri.path), readOnly: readOnlyReason(analysis) ?? '', problems: errors,
      tree: this.tree, selected: this.selected, details: describe(analysis, this.selected), wireframe: wireframe(analysis, this.selected)
    });
  }
  private followText(offset: number): void {
    const node = nodeAt(designerTree(analysisOf(this.document)), offset);
    if (node && node.path !== this.selected) { this.selected = node.path; this.post(); }
  }
  /** Shows the selected node in any visible text editor for the same document. */
  private reveal(): void {
    const find = (nodes: TreeNode[]): TreeNode | undefined => { for (const n of nodes) { if (n.path === this.selected) return n; const hit = find(n.children); if (hit) return hit; } return undefined; };
    const node = find(this.tree);
    if (!node || node.start < 0) return;
    const range = new vscode.Range(this.document.positionAt(node.selectionStart), this.document.positionAt(node.selectionEnd));
    for (const editor of vscode.window.visibleTextEditors) {
      if (editor.document !== this.document) continue;
      editor.selection = new vscode.Selection(range.start, range.start);
      editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    }
  }
  /** Test only: runs steps against the webview's controls and returns what it shows. */
  probe(steps: unknown[]): Promise<any> {
    const id = ++this.probeId;
    return new Promise(resolve => { this.probes.set(id, resolve); void this.panel.webview.postMessage({ type: 'probe', id, steps }); });
  }
  /** Handles a webview message. Exposed for the extension-host test. */
  async receive(message: any): Promise<void> {
    const text = (value: unknown, max = 2000) => typeof value === 'string' && value.length <= max ? value : undefined;
    try {
      switch (message?.type) {
        case 'ready': this.ready = true; this.post(); return;
        case 'probe': this.probes.get(message.id)?.(message.result); this.probes.delete(message.id); return;
        case 'select': { const path = text(message.path); if (path) { this.selected = path; this.post(); this.reveal(); } return; }
        case 'openXml': await vscode.window.showTextDocument(this.document, { viewColumn: vscode.ViewColumn.Beside }); return;
        case 'preview': await vscode.commands.executeCommand('rdlPreview.preview', this.document.uri); return;
        case 'openProblems': await vscode.commands.executeCommand('workbench.actions.view.problems'); return;
        case 'set': {
          const path = text(message.path), key = text(message.key, 100);
          if (!path || !key) return;
          // A table edit made before the previous one came back is based on that edit, not on this version.
          const unchanged = () => message.base !== undefined && JSON.stringify(describe(analysisOf(this.document), path)?.fields.find(f => f.key === key)?.value) === JSON.stringify(message.base);
          await this.serially(async () => {
            if (!this.current(message.version, unchanged)) { void this.panel.webview.postMessage({ type: 'fieldError', key, message: 'The report changed while you were editing. Check the value and try again.' }); return; }
            try { await this.apply(applyField(analysisOf(this.document), path, key, message.value)); }
            catch (error) { void this.panel.webview.postMessage({ type: 'fieldError', key, message: error instanceof Error ? error.message : String(error) }); }
          });
          return;
        }
        case 'action': {
          const path = text(message.path), id = text(message.id, 100);
          if (!path || !id || !this.current(message.version)) return;
          const input = await this.actionInput(path, id);
          if (input === null) return;
          await this.serially(() => this.apply(applyAction(analysisOf(this.document), path, id, input)));
          return;
        }
      }
    } catch (error) {
      void vscode.window.showErrorMessage(`RDL Designer: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  private current(version: unknown, unchanged?: () => boolean): boolean {
    if (readOnlyReason(analysisOf(this.document))) return false;
    if (version === this.document.version || unchanged?.()) return true;
    this.post();
    return false;
  }
  /** Collects what an action needs from the user. Null cancels the action. */
  private async actionInput(nodePath: string, id: string): Promise<unknown> {
    if (id === 'addFields') {
      const value = await vscode.window.showInputBox({ title: 'Add fields', prompt: 'Column names the query returns, separated by commas. Existing columns are skipped.', placeHolder: 'CustomerId, CustomerName, Total', ignoreFocusOut: true });
      return value?.trim() ? value : null;
    }
    if (id === 'addImage') {
      const [file] = await vscode.window.showOpenDialog({ title: 'Embed an image in the report', canSelectMany: false, filters: { Images: Object.keys(IMAGE_TYPES).map(e => e.slice(1)) } }) || [];
      if (!file) return null;
      const extension = path.extname(file.path).toLowerCase();
      if (!IMAGE_TYPES[extension]) throw new Error('Choose a PNG, JPEG, GIF or BMP image.');
      if ((await vscode.workspace.fs.stat(file)).size > MAX_IMAGE_BYTES) throw new Error('Images larger than 10 MB make reports slow to load. Choose a smaller image.');
      const data = await vscode.workspace.fs.readFile(file);
      return { name: path.basename(file.path, extension), mimeType: IMAGE_TYPES[extension], data: Buffer.from(data).toString('base64') } satisfies ImageInput;
    }
    if (id === 'delete') {
      const details = describe(analysisOf(this.document), nodePath);
      if (!details) return null;
      const detail = details.usage ? `${details.usage} expression${details.usage === 1 ? '' : 's'} or setting${details.usage === 1 ? '' : 's'} still refer${details.usage === 1 ? 's' : ''} to it and will show errors until updated.` : 'You can undo this with Edit → Undo.';
      const kind = details.subtitle.split(' · ')[0];
      const question = kind === details.title ? `Delete the ${kind.toLowerCase()}?` : `Delete ${kind.toLowerCase()} "${details.title}"?`;
      const choice = await vscode.window.showWarningMessage(question, { modal: true, detail }, 'Delete');
      return choice === 'Delete' ? undefined : null;
    }
    return undefined;
  }
  /** Applies edits one at a time, so each is computed from the text the one before produced. */
  private serially(task: () => Promise<void>): Promise<void> {
    const run = this.editing.then(task);
    this.editing = run.catch(() => undefined);
    return run;
  }
  private async apply(change: Change): Promise<void> {
    if (change.edits.length) {
      const edit = new vscode.WorkspaceEdit();
      for (const e of change.edits) edit.replace(this.document.uri, new vscode.Range(this.document.positionAt(e.start), this.document.positionAt(e.end)), e.text);
      if (!await vscode.workspace.applyEdit(edit)) throw new Error('VS Code could not apply the change. The file may be read-only.');
    }
    this.selected = change.select;
    this.post(); this.reveal();
    if (change.message) void vscode.window.showInformationMessage(`RDL Designer: ${change.message}`);
  }
}
