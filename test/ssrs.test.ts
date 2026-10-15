import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { SsrsSession, NS } from '../src/ssrs';
import { createTransport, type Transport } from '../src/transport';
import { demoPdf } from '../src/demo';
import { parseXml, escapeXml } from '../src/xml';
import type { Profile } from '../src/types';

function loopbackTransport(): Transport {
  return { dispose() {}, post: (url, action, body) => new Promise((resolve, reject) => {
    const req = http.request(url, { method: 'POST', headers: { SOAPAction: `"${action}"`, 'Content-Type': 'text/xml', 'Content-Length': Buffer.byteLength(body) } }, res => {
      const chunks: Buffer[] = []; res.on('data', b => chunks.push(b)); res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }));
    }); req.on('error', reject); req.end(body);
  }) };
}

const info = `<ExecutionID>fixture-session</ExecutionID><Parameters><ReportParameter><Name>Department</Name><Type>String</Type><Nullable>false</Nullable><AllowBlank>false</AllowBlank><MultiValue>false</MultiValue><Prompt>Department</Prompt><PromptUser>true</PromptUser><ValidValues><ValidValue><Label>Research &amp; Development</Label><Value>R&amp;D</Value></ValidValue></ValidValues><State>HasValidValue</State></ReportParameter><ReportParameter><Name>Regions</Name><Type>String</Type><MultiValue>true</MultiValue><PromptUser>true</PromptUser><Dependencies><string>Department</string></Dependencies><State>HasValidValue</State></ReportParameter></Parameters>`;
const wrap = (method: string, body: string) => `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Header><ExecutionHeader xmlns="${NS}"><ExecutionID>fixture-session</ExecutionID></ExecutionHeader></soap:Header><soap:Body><${method}Response xmlns="${NS}">${body}</${method}Response></soap:Body></soap:Envelope>`;

test('real HTTP SOAP loop: temporary definition, credentials, parameters, session reuse and PDF', async () => {
  const calls: string[] = [];
  const server = http.createServer(async (request, response) => {
    try {
      let body = ''; for await (const chunk of request) body += chunk;
      assert.equal(request.url, '/reportserver/ReportExecution2005.asmx');
      const method = String(request.headers.soapaction).replace(/"/g, '').split('/').pop()!;
      calls.push(method);
      const xml = parseXml(body).Envelope;
      if (method !== 'LoadReportDefinition' && method !== 'ListRenderingExtensions') assert.equal(xml.Header.ExecutionHeader.ExecutionID, 'fixture-session');
      let result = '';
      if (method === 'ListRenderingExtensions') result = '<Extensions><Extension><Name>PDF</Name></Extension></Extensions>';
      else if (method === 'LoadReportDefinition') {
        assert.equal(Buffer.from(xml.Body.LoadReportDefinition.Definition, 'base64').toString(), '<Report />');
        result = `<executionInfo>${info}<CredentialsRequired>true</CredentialsRequired><DataSourcePrompts><DataSourcePrompt><Name>Main</Name><Prompt>Database</Prompt></DataSourcePrompt></DataSourcePrompts></executionInfo>`;
      } else if (method === 'SetExecutionCredentials') {
        assert.equal(xml.Body.SetExecutionCredentials.Credentials.DataSourceCredentials.Password, '<db-secret>');
        result = `<executionInfo>${info}<CredentialsRequired>false</CredentialsRequired></executionInfo>`;
      } else if (method === 'SetExecutionParameters') {
        const parameters = xml.Body.SetExecutionParameters.Parameters.ParameterValue;
        assert.equal(parameters[0].Value, 'R&D'); assert.equal(parameters.filter((p: any) => p.Name === 'Regions').length, 2);
        assert.equal(xml.Body.SetExecutionParameters.ParameterLanguage, 'en-US'); result = `<executionInfo>${info}</executionInfo>`;
      } else if (method === 'Render') {
        assert.equal(xml.Body.Render.Format, 'PDF'); result = `<Result>${Buffer.from(demoPdf(['HTTP fixture'])).toString('base64')}</Result><MimeType>application/pdf</MimeType>`;
      }
      response.writeHead(200, { 'Content-Type': 'text/xml' }); response.end(wrap(method, result));
    } catch (error) { response.writeHead(500); response.end(String(error)); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const profile: Profile = { id: 'fixture', name: 'Fixture', auth: 'windows', serverUrl: `http://127.0.0.1:${(server.address() as any).port}/reportserver` };
  const session = new SsrsSession(profile, loopbackTransport());
  try {
    await session.test(); const loaded = await session.load('<Report />');
    assert.equal(loaded.credentialsRequired, true); assert.equal(loaded.dataSourcePrompts[0].name, 'Main');
    assert.deepEqual(loaded.parameters[1].dependencies, ['Department']);
    await session.setCredentials([{ name: 'Main', username: 'user', password: '<db-secret>' }]);
    await session.setParameters({ Department: ['R&D'], Regions: ['North', 'South'] });
    const pdf = await session.render(); assert.equal(Buffer.from(pdf).subarray(0, 5).toString(), '%PDF-');
    assert.deepEqual(calls, ['ListRenderingExtensions', 'LoadReportDefinition', 'SetExecutionCredentials', 'SetExecutionParameters', 'Render']);
  } finally { session.dispose(); server.close(); await once(server, 'close'); }
});
test('SOAP faults expose useful nested server errors, not an opaque HTTP 500', async () => {
  const fault = `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><soap:Fault><faultcode>soap:Server</faultcode><faultstring>Report failed</faultstring><detail><Error><Code>rsProcessingAborted</Code><Message>${escapeXml('Data source "Main" was not found.')}</Message></Error></detail></soap:Fault></soap:Body></soap:Envelope>`;
  const session = new SsrsSession({ id: 'dev', name: 'Dev', auth: 'windows', serverUrl: 'https://example.test/reportserver' }, { post: async () => ({ status: 500, body: fault }), dispose() {} });
  await assert.rejects(session.load('<Report />'), /Data source "Main" was not found/);
});
test('redirects and sign-in pages are rejected without following them', async () => {
  for (const status of [302, 401, 403, 404]) {
    const session = new SsrsSession({ id: 'dev', name: 'Dev', auth: 'windows', serverUrl: 'https://example.test/reportserver' }, { post: async () => ({ status, body: '<html>Sign in</html>' }), dispose() {} });
    await assert.rejects(session.test(), status === 302 ? /redirected/ : status === 401 ? /401/ : status === 403 ? /403/ : /404/);
  }
});

test('platform HTTP adapter transports SOAP using stdin and preserves HTTP error bodies', async () => {
  let received = '';
  const authTrace: number[] = [];
  // Synthetic NTLM type-2 challenge: exercise the system's real handshake,
  // without asserting cryptographic identity or requiring a domain/server.
  const target = Buffer.from('FIXTURE', 'utf16le');
  const challenge = Buffer.alloc(48 + target.length + 4);
  challenge.write('NTLMSSP\0'); challenge.writeUInt32LE(2, 8);
  challenge.writeUInt16LE(target.length, 12); challenge.writeUInt16LE(target.length, 14); challenge.writeUInt32LE(48, 16);
  challenge.writeUInt32LE(0x00888205, 20); Buffer.from('12345678').copy(challenge, 24);
  challenge.writeUInt16LE(4, 40); challenge.writeUInt16LE(4, 42); challenge.writeUInt32LE(48 + target.length, 44); target.copy(challenge, 48);
  const server = http.createServer(async (request, response) => {
    const authorization = String(request.headers.authorization || '');
    const token = Buffer.from(authorization.replace(/^NTLM /i, ''), 'base64');
    const type = token.length >= 12 ? token.readUInt32LE(8) : 0;
    authTrace.push(type);
    if (type !== 3) {
      for await (const _chunk of request) {}
      response.writeHead(401, { 'WWW-Authenticate': type === 1 ? `NTLM ${challenge.toString('base64')}` : 'NTLM', 'Content-Length': '0', Connection: 'keep-alive' }); response.end(); return;
    }
    for await (const chunk of request) received += chunk;
    response.writeHead(500, { 'Content-Type': 'text/xml; charset=utf-8' }); response.end('<fixture>é &amp; unicode</fixture>');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const url = `http://127.0.0.1:${(server.address() as any).port}/reportserver/ReportExecution2005.asmx`;
  const transport = createTransport({ id: 'local', name: 'Local transport fixture', auth: 'ntlm', username: 'DOMAIN\\fixture', serverUrl: url, allowHttp: true, timeoutSeconds: 60 }, 'synthetic-not-a-real-password', process.cwd());
  try {
    const result = await transport.post(url, `${NS}/LoadReportDefinition`, '<report>é &amp; example</report>');
    assert.equal(result.status, 500); assert.match(result.body, /é &amp; unicode/); assert.equal(received, '<report>é &amp; example</report>');
  } catch (error) {
    throw new Error(`${(error as Error).message} (synthetic fixture authentication message types: ${authTrace.join(', ') || 'no requests received'})`);
  } finally { transport.dispose(); server.close(); await once(server, 'close'); }
});
