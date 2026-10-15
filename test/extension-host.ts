import * as vscode from 'vscode';
import assert from 'node:assert/strict';
async function waitFor(condition: () => boolean, message: string): Promise<void> {
  const end = Date.now() + 15000;
  while (!condition() && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 100));
  assert.ok(condition(), message);
}
export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension('NickMcGinnis.rdl-preview');
  assert.ok(extension, 'Extension is discoverable');
  const api = await extension.activate();
  assert.ok(api, 'Test API is exposed in test mode');
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
  assert.equal(api.snapshot().invalidated, true, 'A connection change invalidates the existing execution');
  const before = api.snapshot().pdfBytes;
  await api.render({ Department: ['Engineering'] });
  assert.equal(api.snapshot().pdfBytes, before, 'An invalidated execution cannot render');
  api.disposePreview();
  console.log('Extension host: activation, registered commands, demo parameters, PDF output and connection invalidation passed.');
}
