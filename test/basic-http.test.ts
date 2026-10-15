import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { validateProfile } from '../src/profiles';
import { createTransport } from '../src/transport';
import { SsrsSession, NS } from '../src/ssrs';
import { parseXml } from '../src/xml';
import { demoPdf } from '../src/demo';
import type { Profile } from '../src/types';

const profile: Profile = { id: 'legacy', name: 'Legacy development', serverUrl: 'http://127.0.0.1:1/reportserver', auth: 'basic', username: 'FIXTURE\\report-user', allowHttp: true };

test('Basic authentication over HTTP is accepted only with the saved connection opt-in', () => {
  assert.equal(validateProfile(profile).allowHttp, true);
  for (const allowHttp of [undefined, false, 'true']) {
    assert.throws(() => validateProfile({ ...profile, allowHttp }), /explicitly allow HTTP/);
  }
  assert.doesNotThrow(() => validateProfile({ ...profile, serverUrl: 'https://example.test/reportserver', allowHttp: false }));
});

test('Basic HTTP transport refuses to send credentials until this connection permits HTTP', async () => {
  const transport = createTransport({ ...profile, allowHttp: false }, 'synthetic-password', process.cwd());
  try { await assert.rejects(transport.post(profile.serverUrl, `${NS}/ListRenderingExtensions`, '<request/>'), /explicitly allow HTTP/); }
  finally { transport.dispose(); }
});

test('opted-in Basic HTTP connection completes parameterized SOAP preview without following redirects', async (t) => {
  const methods: string[] = [];
  let redirectedRequests = 0;
  const password = 'synthetic-fixture-password';
  const server = http.createServer(async (request, response) => {
    try {
      if (request.url === '/redirect-target') { redirectedRequests++; response.end('unexpected'); return; }
      assert.equal(request.headers.authorization, `Basic ${Buffer.from(`${profile.username}:${password}`).toString('base64')}`);
      let body = ''; for await (const chunk of request) body += chunk;
      const method = String(request.headers.soapaction).replace(/"/g, '').split('/').pop()!;
      methods.push(method);
      const requestXml = parseXml(body).Envelope;
      let result: string;
      const metadata = '<ExecutionID>basic-http-session</ExecutionID><Parameters><ReportParameter><Name>Department</Name><Type>String</Type><Nullable>false</Nullable><PromptUser>true</PromptUser><State>HasValidValue</State></ReportParameter></Parameters>';
      if (method === 'ListRenderingExtensions') result = '<Extensions><Extension><Name>PDF</Name></Extension></Extensions>';
      else if (method === 'LoadReportDefinition') {
        assert.equal(Buffer.from(requestXml.Body.LoadReportDefinition.Definition, 'base64').toString(), '<Report/>');
        result = `<executionInfo>${metadata}</executionInfo>`;
      } else {
        assert.equal(requestXml.Header.ExecutionHeader.ExecutionID, 'basic-http-session');
        if (method === 'SetExecutionParameters') {
          assert.equal(requestXml.Body.SetExecutionParameters.Parameters.ParameterValue.Value, 'Research & Development');
          result = `<executionInfo>${metadata}</executionInfo>`;
        } else {
          assert.equal(method, 'Render');
          result = `<Result>${Buffer.from(demoPdf(['Basic HTTP protocol fixture'])).toString('base64')}</Result>`;
        }
      }
      response.setHeader('Content-Type', 'text/xml; charset=utf-8');
      response.end(`<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><${method}Response xmlns="${NS}">${result}</${method}Response></soap:Body></soap:Envelope>`);
    } catch (error) { response.writeHead(500); response.end(String(error)); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { if (server.listening) { server.closeAllConnections(); server.close(); } });
  const liveProfile = validateProfile({ ...profile, serverUrl: `http://127.0.0.1:${(server.address() as any).port}/reportserver` });
  const transport = createTransport(liveProfile, password, process.cwd());
  const session = new SsrsSession(liveProfile, transport);
  try {
    await session.test(); await session.load('<Report/>'); await session.setParameters({ Department: ['Research & Development'] });
    const pdf = Buffer.from(await session.render()); assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
    assert.deepEqual(methods, ['ListRenderingExtensions', 'LoadReportDefinition', 'SetExecutionParameters', 'Render']);
    server.removeAllListeners('request');
    server.on('request', (request, response) => {
      if (request.url === '/redirect-target') redirectedRequests++;
      response.writeHead(302, { Location: '/redirect-target' }); response.end();
    });
    await assert.rejects(session.test(), /redirected/);
    assert.equal(redirectedRequests, 0);
  } finally { session.dispose(); server.close(); await once(server, 'close'); }
});
