import * as vscode from 'vscode';
import { analyzeRdl, completionsAt, definitionsAt, type Analysis, type OutlineItem, type OutlineKind } from './rdl-analysis';
import { declarationAt, renameEdits } from './rdl-rename';

// Also serve .rdl files a user has associated with the XML language.
export const RDL_SELECTOR: vscode.DocumentSelector = [{ language: 'rdl' }, { language: 'xml', pattern: '**/*.{rdl,rdlc}' }];
const KINDS: Record<OutlineKind, vscode.SymbolKind> = {
  group: vscode.SymbolKind.Namespace, dataSource: vscode.SymbolKind.Module, dataSet: vscode.SymbolKind.Class, field: vscode.SymbolKind.Field,
  parameter: vscode.SymbolKind.Variable, variable: vscode.SymbolKind.Variable, image: vscode.SymbolKind.File, section: vscode.SymbolKind.Package,
  textbox: vscode.SymbolKind.String, dataRegion: vscode.SymbolKind.Struct, rectangle: vscode.SymbolKind.Object, picture: vscode.SymbolKind.File,
  subreport: vscode.SymbolKind.Module, line: vscode.SymbolKind.Constant, reportItem: vscode.SymbolKind.Object
};

const cache = new WeakMap<vscode.TextDocument, { version: number; analysis: Analysis }>();
/** Analysis of the document's current version, shared by the language features and the designer. */
export function analysisOf(document: vscode.TextDocument): Analysis {
  const hit = cache.get(document);
  if (hit?.version === document.version) return hit.analysis;
  const analysis = analyzeRdl(document.getText());
  cache.set(document, { version: document.version, analysis });
  return analysis;
}

// Red Hat XML serves RDL through the xmlLanguageParticipants contribution but only activates for its own
// languages. Start it when an RDL document is open so it formats and validates without an .xml file open.
const RED_HAT_XML = 'redhat.vscode-xml';
function startXmlSupport(context: vscode.ExtensionContext): void {
  const start = () => {
    const xml = vscode.extensions.getExtension(RED_HAT_XML);
    if (!xml || xml.isActive || !vscode.workspace.textDocuments.some(d => d.languageId === 'rdl')) return;
    // Optional: RDL features don't depend on it, and it reports its own startup problems.
    xml.activate().then(undefined, () => undefined);
  };
  start();
  context.subscriptions.push(vscode.workspace.onDidOpenTextDocument(document => { if (document.languageId === 'rdl') start(); }), vscode.extensions.onDidChange(start));
}

export function registerLanguage(context: vscode.ExtensionContext): void {
  startXmlSupport(context);
  const range = (document: vscode.TextDocument, start: number, end: number) => new vscode.Range(document.positionAt(start), document.positionAt(end));
  const symbol = (document: vscode.TextDocument, item: OutlineItem): vscode.DocumentSymbol => {
    const result = new vscode.DocumentSymbol(item.name, item.detail, KINDS[item.kind], range(document, item.start, item.end), range(document, item.selectionStart, item.selectionEnd));
    result.children = item.children.map(child => symbol(document, child));
    return result;
  };

  const diagnostics = vscode.languages.createDiagnosticCollection('rdl');
  const timers = new Map<string, NodeJS.Timeout>();
  const refresh = (document: vscode.TextDocument) => {
    if (!vscode.languages.match(RDL_SELECTOR, document)) { diagnostics.delete(document.uri); return; }
    diagnostics.set(document.uri, analysisOf(document).issues.map(issue => {
      const result = new vscode.Diagnostic(range(document, issue.start, issue.end), issue.message, issue.severity === 'error' ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning);
      result.source = 'RDL';
      return result;
    }));
  };
  const cancel = (document: vscode.TextDocument) => { const key = document.uri.toString(); clearTimeout(timers.get(key)); timers.delete(key); };
  // Wait for a pause in typing; analysis validates the whole document.
  const schedule = (document: vscode.TextDocument) => { cancel(document); timers.set(document.uri.toString(), setTimeout(() => { timers.delete(document.uri.toString()); refresh(document); }, 300)); };
  for (const document of vscode.workspace.textDocuments) refresh(document);

  context.subscriptions.push(
    diagnostics,
    { dispose: () => { for (const timer of timers.values()) clearTimeout(timer); timers.clear(); } },
    vscode.workspace.onDidOpenTextDocument(refresh),
    vscode.workspace.onDidChangeTextDocument(event => { if (event.contentChanges.length) schedule(event.document); }),
    vscode.workspace.onDidCloseTextDocument(document => { cancel(document); diagnostics.delete(document.uri); }),
    vscode.languages.registerDocumentSymbolProvider(RDL_SELECTOR, { provideDocumentSymbols: document => analysisOf(document).outline.map(item => symbol(document, item)) }, { label: 'RDL' }),
    vscode.languages.registerDefinitionProvider(RDL_SELECTOR, {
      provideDefinition: (document, position) => definitionsAt(analysisOf(document), document.offsetAt(position)).map(d => new vscode.Location(document.uri, range(document, d.start, d.end)))
    }),
    vscode.languages.registerCompletionItemProvider(RDL_SELECTOR, {
      provideCompletionItems(document, position) {
        const result = completionsAt(analysisOf(document), document.lineAt(position).text.slice(0, position.character), document.offsetAt(position));
        if (!result) return undefined;
        const replace = new vscode.Range(position.translate(0, -result.partial.length), position);
        return result.items.map(c => {
          const item = new vscode.CompletionItem(c.name, vscode.CompletionItemKind.Field);
          item.detail = c.detail; item.range = replace; item.sortText = `${c.preferred ? 0 : 1}${c.name}`;
          return item;
        });
      }
    }, '!'),
    vscode.languages.registerRenameProvider(RDL_SELECTOR, {
      prepareRename(document, position) {
        const target = declarationAt(analysisOf(document), document.offsetAt(position));
        if (!target) throw new Error('Rename a parameter, field, dataset, data source, report item, group, variable or embedded image.');
        return { range: range(document, target.start, target.end), placeholder: target.declaration.name };
      },
      provideRenameEdits(document, position, newName) {
        const analysis = analysisOf(document), target = declarationAt(analysis, document.offsetAt(position));
        if (!target) return undefined;
        const { edits, skipped } = renameEdits(analysis, target.declaration, newName.trim());
        if (skipped) void vscode.window.showWarningMessage(`RDL: ${skipped} Fields!${target.declaration.name} reference${skipped === 1 ? '' : 's'} could belong to another dataset and ${skipped === 1 ? 'was' : 'were'} not renamed.`);
        const edit = new vscode.WorkspaceEdit();
        for (const e of edits) edit.replace(document.uri, range(document, e.start, e.end), e.text);
        return edit;
      }
    }),
    vscode.languages.registerFoldingRangeProvider(RDL_SELECTOR, {
      provideFoldingRanges(document) {
        const ranges: vscode.FoldingRange[] = [];
        const visit = (e: NonNullable<Analysis['root']>) => {
          const start = document.positionAt(e.start).line, end = document.positionAt(e.closeStart).line;
          // Keep the closing tag visible when it starts its own line.
          const last = end - (document.lineAt(end).firstNonWhitespaceCharacterIndex === document.positionAt(e.closeStart).character ? 1 : 0);
          if (last > start) ranges.push(new vscode.FoldingRange(start, last));
          if (end > start) for (const child of e.children) visit(child);
        };
        const root = analysisOf(document).root;
        if (root) visit(root);
        return ranges;
      }
    })
  );
}
