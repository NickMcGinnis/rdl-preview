import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import { analyzeRdl } from '../src/rdl-analysis';
// Red Hat XML only activates for its own languages. Only an .rdl document is ever opened here.
async function waitFor<T>(probe: () => T | Promise<T>, message: string, timeout = 60000): Promise<T> {
  const end = Date.now() + timeout;
  for (;;) {
    const result = await probe();
    if (result) return result;
    assert.ok(Date.now() < end, message);
    await new Promise(resolve => setTimeout(resolve, 250));
  }
}
// Problems, not hints such as Red Hat XML's "no grammar" note.
const sources = (uri: vscode.Uri) => vscode.languages.getDiagnostics(uri).filter(d => d.severity <= vscode.DiagnosticSeverity.Warning).map(d => d.source);
export async function run(): Promise<void> {
  assert.equal(vscode.workspace.isTrusted, false, 'The window is in Restricted Mode');
  const xml = vscode.extensions.getExtension('redhat.vscode-xml');
  assert.ok(xml, 'Red Hat XML is installed and allowed in Restricted Mode');
  assert.ok(!xml.isActive, 'Nothing has started Red Hat XML yet');
  const [uri] = await vscode.workspace.findFiles('*.rdl');
  const document = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(document);
  assert.equal(document.languageId, 'rdl');
  await waitFor(() => xml.isActive, 'Opening an RDL document starts Red Hat XML');

  // Strip the indentation, then format through Red Hat XML.
  const flat = new vscode.WorkspaceEdit();
  flat.replace(uri, new vscode.Range(0, 0, document.lineCount, 0), document.getText().replace(/^[ \t]+/gm, ''));
  assert.ok(await vscode.workspace.applyEdit(flat));
  const edits = await waitFor(async () => {
    const result = await vscode.commands.executeCommand<vscode.TextEdit[] | undefined>('vscode.executeFormatDocumentProvider', uri, { tabSize: 2, insertSpaces: true });
    return result?.length ? result : undefined;
  }, 'Red Hat XML formats RDL documents');
  const format = new vscode.WorkspaceEdit();
  format.set(uri, edits!);
  assert.ok(await vscode.workspace.applyEdit(format));
  assert.match(document.getText(), /\n {2}<ReportParameters>/, 'Formatting restores indentation');
  const formatted = analyzeRdl(document.getText());
  assert.ok(formatted.wellFormed, 'Formatting keeps the report well-formed');
  assert.deepEqual(formatted.issues, [], 'Formatting keeps the report valid RDL');
  assert.equal(document.languageId, 'rdl', 'Formatting keeps the RDL language');

  // A deliberate malformed closing tag is reported by both RDL and Red Hat XML.
  const end = document.getText().lastIndexOf('</Report>');
  const broken = new vscode.WorkspaceEdit();
  broken.replace(uri, new vscode.Range(document.positionAt(end), document.positionAt(end + '</Report>'.length)), '</BrokenReport>');
  assert.ok(await vscode.workspace.applyEdit(broken));
  await waitFor(() => sources(uri).includes('xml') && sources(uri).includes('RDL'), 'Red Hat XML and RDL both report the malformed tag');
  assert.equal(document.languageId, 'rdl');
  assert.ok(!vscode.workspace.textDocuments.some(d => d.languageId === 'xml'), 'No XML document was opened');
  const fixed = new vscode.WorkspaceEdit();
  fixed.replace(uri, new vscode.Range(document.positionAt(end), document.positionAt(end + '</BrokenReport>'.length)), '</Report>');
  assert.ok(await vscode.workspace.applyEdit(fixed));
  await waitFor(() => !sources(uri).length, 'Fixing the tag clears both problems').catch(error => { console.log('Diagnostics:', JSON.stringify(vscode.languages.getDiagnostics(uri))); throw error; });
  await vscode.commands.executeCommand('workbench.action.files.revert');
  console.log('Extension host with Red Hat XML in Restricted Mode: an .rdl file alone starts XML, which formats and validates it as RDL.');
}
