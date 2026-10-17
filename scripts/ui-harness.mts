// Development-only browser harness using the exact packaged webview files.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { designerHtml, webviewHtml } from '../src/webview';
import { analyzeRdl } from '../src/rdl-analysis';
import { applyAction, applyField, describe, designerTree, readOnlyReason, wireframe } from '../src/rdl-designer';
import { DemoSession } from '../src/demo';
import { initialValues } from '../src/parameters';
const demo = new DemoSession();
let info = await demo.load(await readFile('examples/parameter-demo.rdl', 'utf8'));
let values = initialValues(info.parameters);
let hasPdf = false;
const state = () => ({ type: 'state', report: 'parameter-demo.rdl', environments: [{ id: 'dev', name: 'Development', detail: 'https://dev.example.test/reportserver' }, { id: 'demo', name: 'Demo (simulated)', detail: 'Local simulated preview' }], environmentId: 'demo', serverUrl: '', demo: true, parameters: info.parameters, values, errors: {}, error: '', warnings: info.warnings, busy: false, loaded: true, invalidated: false, hasPdf });
// Designer: the real view model over an in-memory copy of the synthetic fixture.
let rdl = await readFile('test/fixtures/sales.rdl', 'utf8'), version = 1, selected = 'Report';
const designerState = () => {
  const analysis = analyzeRdl(rdl);
  if (!describe(analysis, selected)) selected = 'Report';
  const state = { type: 'state', version, file: 'sales.rdl', readOnly: readOnlyReason(analysis) ?? '', problems: analysis.issues.filter(i => i.severity === 'error').length, tree: designerTree(analysis), selected, details: describe(analysis, selected), wireframe: wireframe(analysis, selected) };
  return [state];
};
const designerMessage = (message: any) => {
  const run = (change: { edits: { start: number; end: number; text: string }[]; select: string }) => {
    rdl = [...change.edits].sort((a, b) => b.start - a.start).reduce((text, e) => text.slice(0, e.start) + e.text + text.slice(e.end), rdl);
    if (change.edits.length) version++;
    selected = change.select;
  };
  try {
    if (message.type === 'select') selected = message.path;
    if (message.type === 'set') run(applyField(analyzeRdl(rdl), message.path, message.key, message.value));
    if (message.type === 'action') run(applyAction(analyzeRdl(rdl), message.path, message.id, message.id === 'addFields' ? 'CustomerId, CustomerName' : undefined));
  } catch (error) { return [{ type: 'fieldError', key: message.key, message: (error as Error).message }]; }
  return designerState();
};
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  try {
    if (url.pathname === '/designer-api') {
      let raw = ''; for await (const chunk of req) raw += chunk;
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(designerMessage(JSON.parse(raw)))); return;
    }
    if (url.pathname === '/designer') {
      const nonce = 'rdl-browser-harness';
      const harness = `window.acquireVsCodeApi=()=>({getState:()=>undefined,setState:()=>{},postMessage:async message=>{const response=await fetch('/designer-api',{method:'POST',body:JSON.stringify(message)});for(const data of await response.json())window.dispatchEvent(new MessageEvent('message',{data}));}});`;
      res.setHeader('Content-Type', 'text/html'); res.end(designerHtml(name => '/media/' + name, "'self'", nonce).replace("font-src 'self';", "font-src 'self'; connect-src 'self';").replace('<script nonce=', `<script nonce="${nonce}">${harness}</script><script nonce=`)); return;
    }
    if (url.pathname === '/api') {
      let raw = ''; for await (const chunk of req) raw += chunk;
      const message = JSON.parse(raw);
      const messages: any[] = [];
      if (message.type === 'render' || message.type === 'refresh') {
        values = message.values; info = await demo.setParameters(values);
        if (message.type === 'render') { const pdf = await demo.render(); hasPdf = true; messages.push({ type: 'pdf', base64: Buffer.from(pdf).toString('base64') }); }
      }
      messages.push(state()); res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(messages)); return;
    }
    if (url.pathname === '/harness.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(`window.acquireVsCodeApi=()=>({postMessage:async message=>{const response=await fetch('/api',{method:'POST',body:JSON.stringify(message)});for(const data of await response.json())window.dispatchEvent(new MessageEvent('message',{data}));}});`); return; }
    if (url.pathname === '/') {
      const nonce = 'rdl-browser-harness';
      const html = webviewHtml(name => '/media/' + name, "'self'", nonce).replace('<script nonce=', `<script nonce="${nonce}" src="/harness.js"></script><script nonce=`);
      res.setHeader('Content-Type', 'text/html'); res.end(html); return;
    }
    const file = path.resolve('.' + url.pathname);
    if (!file.startsWith(path.resolve('media') + path.sep)) { res.writeHead(404); res.end(); return; }
    const types: Record<string, string> = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm' };
    res.setHeader('Content-Type', types[path.extname(file)] || 'application/octet-stream'); res.end(await readFile(file));
  } catch (error) { res.writeHead(500); res.end(String(error)); }
});
server.listen(Number(process.env.PORT) || 0, '127.0.0.1', () => { const port = (server.address() as any).port; console.log(`UI harness: http://127.0.0.1:${port} (preview), http://127.0.0.1:${port}/designer (designer)`); });
