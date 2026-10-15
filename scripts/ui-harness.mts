// Development-only browser harness using the exact packaged webview files.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { webviewHtml } from '../src/webview';
import { DemoSession } from '../src/demo';
import { initialValues } from '../src/parameters';
const demo = new DemoSession();
let info = await demo.load(await readFile('examples/parameter-demo.rdl', 'utf8'));
let values = initialValues(info.parameters);
let hasPdf = false;
const state = () => ({ type: 'state', report: 'parameter-demo.rdl', environments: [{ id: 'dev', name: 'Development', detail: 'https://dev.example.test/reportserver' }, { id: 'demo', name: 'Demo (simulated)', detail: 'Local simulated preview' }], environmentId: 'demo', serverUrl: '', demo: true, parameters: info.parameters, values, errors: {}, error: '', warnings: info.warnings, busy: false, loaded: true, invalidated: false, hasPdf });
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  try {
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
server.listen(0, '127.0.0.1', () => console.log(`UI harness: http://127.0.0.1:${(server.address() as any).port}`));
