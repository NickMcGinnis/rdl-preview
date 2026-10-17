import * as vscode from 'vscode';
import assert from 'node:assert/strict';
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
export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension('NickMcGinnis.rdl-preview');
  assert.ok(extension, 'Extension is discoverable');
  const api = await extension.activate();
  assert.ok(api, 'Test API is exposed in test mode');
  await languageFeatures(extension.extensionUri);
  const commands = await vscode.commands.getCommands();
  for (const name of ['preview', 'manageProfiles', 'switchProfile', 'testConnection', 'demo']) assert.ok(commands.includes(`rdlPreview.${name}`));
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
  console.log('Extension host: activation, RDL language features, registered commands, demo parameters, PDF output and in-panel environment switching passed.');
}
