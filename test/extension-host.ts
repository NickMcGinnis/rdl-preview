import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { analyzeRdl } from '../src/rdl-analysis';
async function waitFor(condition: () => boolean, message: string): Promise<void> {
  const end = Date.now() + 15000;
  while (!condition() && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 100));
  assert.ok(condition(), message);
}
async function languageFeatures(extensionUri: vscode.Uri): Promise<void> {
  const example = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(extensionUri, 'examples', 'parameter-demo.rdl'));
  assert.equal(example.languageId, 'rdl', '.rdl files open as the RDL language');
  const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>('vscode.executeDocumentSymbolProvider', example.uri);
  assert.deepEqual(symbols.map(s => s.name), ['Parameters', 'Body']);
  assert.equal(symbols[0].children.length, 6);
  const text = '<Report xmlns="urn:rdl"><ReportParameters><ReportParameter Name="Year"><DataType>Integer</DataType></ReportParameter></ReportParameters><Body><ReportItems><Textbox Name="T"><Value>=Parameters!Year.Value &amp; Parameters!Nope.Value &amp; Parameters!</Value></Textbox></ReportItems></Body></Report>';
  const document = await vscode.workspace.openTextDocument({ language: 'rdl', content: text });
  await waitFor(() => vscode.languages.getDiagnostics(document.uri).length > 0, 'Diagnostics are published for RDL documents');
  assert.deepEqual(vscode.languages.getDiagnostics(document.uri).map(d => document.getText(d.range)), ['Nope']);
  const completions = await vscode.commands.executeCommand<vscode.CompletionList>('vscode.executeCompletionItemProvider', document.uri, document.positionAt(text.indexOf('</Value>')), '!');
  assert.ok(completions.items.some(i => i.label === 'Year'), 'Parameters! completes report parameter names');
  const definitions = await vscode.commands.executeCommand<vscode.Location[]>('vscode.executeDefinitionProvider', document.uri, document.positionAt(text.indexOf('Year.Value')));
  assert.equal(definitions.length, 1);
  assert.equal(document.getText(definitions[0].range), 'Year');
  const folds = await vscode.commands.executeCommand<vscode.FoldingRange[]>('vscode.executeFoldingRangeProvider', example.uri);
  assert.ok(folds.length > 0, 'Multi-line elements fold');
}
async function designerFeatures(api: any, extensionUri: vscode.Uri): Promise<void> {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'rdl-designer-'));
  try {
    const original = await readFile(path.join(extensionUri.fsPath, 'test', 'fixtures', 'sales.rdl'), 'utf8');
    const uri = vscode.Uri.file(path.join(folder, 'sales.rdl'));
    await writeFile(uri.fsPath, original);
    await vscode.commands.executeCommand('vscode.openWith', uri, 'rdlPreview.designer');
    await waitFor(() => !!api.designer()?.snapshot().ready, 'The designer webview loads and requests state');
    const designer = api.designer();
    assert.equal(designer.snapshot().details.title, 'Report');
    const document = vscode.workspace.textDocuments.find(d => d.uri.toString() === uri.toString())!;
    const year = 'Report/ReportParameters/ReportParameter[Year]';
    await designer.send({ type: 'select', path: year });
    assert.equal(designer.snapshot().details.title, 'Year');
    await designer.send({ type: 'set', path: year, key: 'prompt', value: 'Fiscal year', version: document.version });
    assert.equal(document.getText(), original.replace('<Prompt>Year</Prompt>', '<Prompt>Fiscal year</Prompt>'), 'Designer edits change only the target text');
    assert.ok(document.isDirty, 'Designer edits mark the document dirty');
    await designer.send({ type: 'set', path: year, key: 'prompt', value: 'Stale', version: document.version - 1 });
    assert.ok(!document.getText().includes('Stale'), 'Edits based on an older version are rejected');
    await designer.send({ type: 'action', path: 'Report/ReportParameters', id: 'addParameter', version: document.version });
    assert.equal(designer.snapshot().selected, 'Report/ReportParameters/ReportParameter[Parameter1]');
    assert.match(document.getText(), /<ParameterName>Parameter1<\/ParameterName>/);
    // Designer changes are ordinary document edits. (The test window has no focus, so the undo command can't run here.)
    await vscode.window.showTextDocument(document);
    await vscode.commands.executeCommand('workbench.action.files.revert');
    assert.equal(document.getText(), original, 'Reverting restores the file byte-for-byte');
    assert.ok(!document.isDirty);
    const offset = document.getText().indexOf('Parameters!Region') + 12;
    const rename = await vscode.commands.executeCommand<vscode.WorkspaceEdit>('vscode.executeDocumentRenameProvider', uri, document.positionAt(offset), 'Area');
    assert.equal(rename.get(uri).length, 4, 'F2 renames the declaration, two expressions and the layout cell');
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  } finally { await rm(folder, { recursive: true, force: true }); }
}
async function until<T>(probe: () => Promise<T>, accept: (value: T) => boolean, message: string): Promise<T> {
  const end = Date.now() + 15000;
  for (;;) {
    const value = await probe();
    if (accept(value)) return value;
    assert.ok(Date.now() < end, `${message}: ${JSON.stringify(value)}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}
// Drives the table controls in the real designer webview: what it shows, where focus is, and the XML.
async function designerTables(api: any, extensionUri: vscode.Uri): Promise<void> {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'rdl-tables-'));
  try {
    const uri = vscode.Uri.file(path.join(folder, 'sales.rdl'));
    await writeFile(uri.fsPath, await readFile(path.join(extensionUri.fsPath, 'test', 'fixtures', 'sales.rdl'), 'utf8'));
    await vscode.commands.executeCommand('vscode.openWith', uri, 'rdlPreview.designer');
    await waitFor(() => !!api.designer()?.snapshot().ready, 'The designer webview loads');
    const designer = api.designer();
    const document = vscode.workspace.textDocuments.find(d => d.uri.toString() === uri.toString())!;
    const xml = (key: string) => designer.snapshot().details.fields.find((f: any) => f.key === key)?.value;
    const cell = (key: string, row: number, column: number) => `[data-key="${key}"] tbody tr:nth-child(${row + 1}) td:nth-child(${column + 1}) input`;
    const remove = (key: string, row: number) => `[data-key="${key}"] tbody tr:nth-child(${row + 1}) button`;
    const add = (key: string) => `[data-key="${key}"] > button`;
    const probe = async (...steps: object[]) => { const result = await designer.probe(steps); assert.equal(result.error, '', 'Probe steps find their controls'); return result; };
    // The webview has rendered the state for the document's current version.
    const settled = () => until(() => probe(), view => view.version === document.version, 'The webview shows the current version');
    const type = (selector: string, text: string) => probe({ selector, type: text }, { selector, change: true });

    for (const key of ['availableValues', 'defaultValues']) {
      await designer.send({ type: 'action', path: 'Report/ReportParameters', id: 'addParameter', version: document.version });
      const parameter = designer.snapshot().selected;
      await designer.send({ type: 'set', path: parameter, key: key === 'availableValues' ? 'availableMode' : 'defaultMode', value: 'values', version: document.version });
      const blank = key === 'availableValues' ? ['', ''] : [''], buttonColumn = blank.length;
      const row = (value: string) => [value, ...blank.slice(1)];
      assert.deepEqual((await settled()).tables[key], [blank]);
      await type(cell(key, 0, 0), 'North');
      await settled();
      assert.deepEqual(xml(key), [row('North')]);

      // Add row shows the row at once, keeps it once the extension answers, and focuses its first cell.
      let version = document.version;
      let view = await probe({ selector: add(key), click: true });
      assert.deepEqual(view.tables[key], [row('North'), blank], 'Add row shows the new row immediately');
      view = await settled();
      assert.deepEqual(view.tables[key], [row('North'), blank], 'The new row stays after the update while focus is in the table');
      assert.deepEqual([view.focus.table, view.focus.row, view.focus.control], [key, 1, 0], 'Focus moves to the new row');
      assert.deepEqual(xml(key), [row('North'), blank]);
      assert.equal(document.version, version + 1, 'Adding a row is one edit');

      // Two adds faster than the extension can answer both accumulate.
      version = document.version;
      await probe({ selector: add(key), click: true }, { selector: add(key), click: true });
      view = await until(settled, v => v.tables[key].length === 4, 'Repeated adds accumulate');
      assert.deepEqual(xml(key), [row('North'), blank, blank, blank]);
      assert.equal(document.version, version + 2, 'Each add is its own edit');

      // Edits after adding keep every row.
      await type(cell(key, 3, 0), 'West');
      await type(cell(key, 1, 0), 'South');
      view = await settled();
      assert.deepEqual(xml(key), [row('North'), row('South'), blank, row('West')]);
      assert.deepEqual(view.tables[key], xml(key));

      // Remove shows at once; focus stays on the remove button that takes the removed row's place.
      version = document.version;
      view = await probe({ selector: remove(key, 2), click: true });
      assert.deepEqual(view.tables[key], [row('North'), row('South'), row('West')], 'Remove takes the row away immediately');
      view = await settled();
      assert.deepEqual(view.tables[key], [row('North'), row('South'), row('West')]);
      assert.deepEqual([view.focus.row, view.focus.control], [2, buttonColumn]);
      assert.deepEqual(xml(key), [row('North'), row('South'), row('West')]);
      assert.equal(document.version, version + 1, 'Removing a row is one edit');
      // Removing the last row moves focus to the row before it.
      view = await probe({ selector: remove(key, 2), click: true });
      assert.deepEqual([view.focus.table, view.focus.row, view.focus.control], [key, 1, buttonColumn], 'Focus moves to the previous row');
      view = await settled();
      assert.deepEqual(view.tables[key], [row('North'), row('South')]);
      assert.deepEqual(xml(key), [row('North'), row('South')]);

      // A change from elsewhere arrives while the user is typing in a cell: rows update, the typing stays.
      const column = blank.length - 1;
      await probe({ selector: cell(key, 0, column), type: 'Northern', caret: 3, mark: 'typing' });
      await designer.send({ type: 'set', path: parameter, key, value: [row('North'), row('South'), row('East')], version: document.version });
      view = await settled();
      assert.equal(view.tables[key].length, 3, 'Rows added elsewhere appear while a cell has focus');
      assert.deepEqual(view.focus, { ...view.focus, table: key, row: 0, control: column, value: 'Northern', caret: 3, mark: 'typing' }, 'The focused cell keeps its element, text and caret');
      await probe({ selector: cell(key, 0, column), change: true });
      await settled();
      const edited = key === 'availableValues' ? [['North', 'Northern'], row('South'), row('East')] : [['Northern'], row('South'), row('East')];
      assert.deepEqual(xml(key), edited, 'Committing the cell keeps the other rows');

      const analysis = analyzeRdl(document.getText());
      assert.deepEqual(analysis.issues.map(i => i.message), [], 'The report stays valid, including the RDL 2016 parameter layout');
      assert.equal(document.getText().match(/<CellDefinition>/g)?.length, analysis.declarations.filter(d => d.collection === 'Parameters').length, 'Every parameter keeps one layout cell');
    }

    // Query parameters use the same control.
    await designer.send({ type: 'select', path: 'Report/DataSets/DataSet[Sales]' });
    const initial = xml('queryParameters');
    assert.equal((await settled()).tables.queryParameters.length, initial.length);
    await probe({ selector: add('queryParameters'), click: true });
    await type(cell('queryParameters', initial.length, 0), '@Year');
    let view = await settled();
    assert.deepEqual(xml('queryParameters'), [...initial, ['@Year', '']]);
    assert.deepEqual(view.tables.queryParameters, xml('queryParameters'));
    await probe({ selector: remove('queryParameters', initial.length), click: true });
    view = await settled();
    assert.deepEqual([view.tables.queryParameters, xml('queryParameters')], [initial, initial]);
    // Removing every row leaves focus on Add row.
    for (let i = 0; i < initial.length; i++) { await probe({ selector: remove('queryParameters', 0), click: true }); await settled(); }
    view = await probe();
    assert.deepEqual([view.tables.queryParameters, view.focus.add, xml('queryParameters')], [[], true, []]);
    await vscode.window.showTextDocument(document);
    await vscode.commands.executeCommand('workbench.action.files.revert');
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  } finally { await rm(folder, { recursive: true, force: true }); }
}
export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension('NickMcGinnis.rdl-preview');
  assert.ok(extension, 'Extension is discoverable');
  assert.equal(vscode.extensions.getExtension('redhat.vscode-xml'), undefined, 'RDL features run here without Red Hat XML');
  const api = await extension.activate();
  assert.ok(api, 'Test API is exposed in test mode');
  await languageFeatures(extension.extensionUri);
  await designerFeatures(api, extension.extensionUri);
  await designerTables(api, extension.extensionUri);
  const commands = await vscode.commands.getCommands();
  for (const name of ['preview', 'manageProfiles', 'switchProfile', 'testConnection', 'demo', 'openDesigner', 'openXml', 'validate']) assert.ok(commands.includes(`rdlPreview.${name}`));
  await vscode.commands.executeCommand('rdlPreview.demo');
  await waitFor(() => api.snapshot()?.viewerReady, 'The packaged webview scripts load in VS Code');
  assert.equal(api.snapshot().demo, true); assert.equal(api.snapshot().parameterNames.length, 6);
  await api.render({ Department: ['Finance'], StartDate: ['2026-10-15'], MinimumAmount: ['12.5'], IncludeInactive: ['false'], Regions: ['North', 'South'], Notes: [null] });
  assert.ok(api.snapshot().pdfBytes > 500, 'Demo renders a PDF through the extension host');
  await waitFor(() => api.snapshot()?.pdfPages > 0 || api.snapshot()?.viewerError, 'PDF viewer responds').catch(error => { console.log('Viewer snapshot:', JSON.stringify(api.snapshot())); throw error; });
  assert.equal(api.snapshot().viewerError, '', 'PDF.js renders inside the VS Code CSP');
  assert.equal(api.snapshot().pdfPages, 1, 'PDF.js displays the rendered page');
  await api.render({ Department: ['Engineering'], StartDate: ['2026-10-16'], MinimumAmount: ['0'], IncludeInactive: ['true'], Regions: ['West'], Notes: ['Second render'] });
  await waitFor(() => api.snapshot()?.pdfPages > 0 || api.snapshot()?.viewerError, 'Second PDF preview responds');
  assert.equal(api.snapshot().viewerError, '', 'The worker can render another PDF in the same panel');
  assert.equal(api.snapshot().pdfPages, 1);
  await vscode.workspace.getConfiguration('rdlPreview').update('profiles', [{ id: 'dev', name: 'Dev', auth: 'windows', serverUrl: 'https://example.test/reportserver' }], vscode.ConfigurationTarget.Global);
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(api.snapshot().profile, 'Demo (simulated)', 'Editing another connection keeps the current execution');
  assert.ok(api.snapshot().pdfBytes > 500);
  await api.selectEnvironment('dev');
  assert.equal(api.snapshot().profile, 'Dev', 'The panel switches environment in place');
  assert.equal(api.snapshot().pdfBytes, 0, 'Switching discards the previous environment\'s output');
  await api.render({ Department: ['Engineering'] });
  assert.equal(api.snapshot().pdfBytes, 0, 'The previous execution cannot render after a switch');
  await api.selectEnvironment('demo');
  await waitFor(() => api.snapshot()?.parameterNames.length === 6, 'Switching back starts a new demo execution');
  assert.equal(api.snapshot().profile, 'Demo (simulated)');
  await api.render({ Department: ['Engineering'], StartDate: ['2026-10-16'], MinimumAmount: ['0'], IncludeInactive: ['true'], Regions: ['West'], Notes: [null] });
  assert.ok(api.snapshot().pdfBytes > 500, 'The new execution renders');
  await vscode.workspace.getConfiguration('rdlPreview').update('profiles', [], vscode.ConfigurationTarget.Global);
  api.disposePreview();
  console.log('Extension host: activation, RDL language features, designer edits, revert and rename, designer tables, registered commands, demo parameters, PDF output and in-panel environment switching passed.');
}
