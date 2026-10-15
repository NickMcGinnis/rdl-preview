import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { prepareRdl } from '../src/rdl';
import { validateProfile } from '../src/profiles';
import { initialValues, invalidateDependents, validateValues } from '../src/parameters';
import { parameterXml, decodeInfo } from '../src/ssrs';
import { curlConfig } from '../src/transport';
import { parseXml } from '../src/xml';
import { DemoSession } from '../src/demo';
import type { Profile, ReportParameter } from '../src/types';
const profile: Profile = { id: 'dev', name: 'Development', auth: 'windows', serverUrl: 'https://example.test/reportserver', catalogFolder: '/Reports/Finance' };
const p = (patch: Partial<ReportParameter> = {}): ReportParameter => ({ name: 'A', prompt: 'A', type: 'String', nullable: false, allowBlank: false, multiValue: false, promptUser: true, defaults: [], dependencies: [], state: 'HasValidValue', ...patch });

test('unmodified RDL round trips byte-for-byte, including unsupported designer metadata', () => {
  const rdl = '<?xml version="1.0"?><Report xmlns="urn:rdl" xmlns:x="urn:custom"><!-- keep me --><x:Anything a="&amp;">  arbitrary <![CDATA[ < > ]]></x:Anything></Report>';
  assert.equal(prepareRdl(rdl, profile), rdl);
});
test('resolves relative data-source, dataset and subreport references without changing unrelated XML', () => {
  const rdl = '<Report><DataSources><DataSource Name="Main"><DataSourceReference>../../Data Sources/Main</DataSourceReference></DataSource></DataSources><DataSets><DataSet Name="Items"><SharedDataSet><SharedDataSetReference>Items</SharedDataSetReference></SharedDataSet></DataSet></DataSets><Subreport Name="Child"><ReportName>../Child</ReportName></Subreport><Custom>Keep  two spaces</Custom></Report>';
  const result = prepareRdl(rdl, profile);
  assert.match(result, /<DataSourceReference>\/Data Sources\/Main<\/DataSourceReference>/);
  assert.match(result, /<SharedDataSetReference>\/Reports\/Finance\/Items<\/SharedDataSetReference>/);
  assert.match(result, /<ReportName>\/Reports\/Child<\/ReportName>/);
  assert.ok(result.endsWith('<Custom>Keep  two spaces</Custom></Report>'));
});
test('preview overrides support namespaced RDL, embedded sources and shared sources', () => {
  const input = '<r:Report xmlns:r="urn:rdl"><r:DataSources><r:DataSource Name="Main"><r:ConnectionProperties><r:DataProvider>SQL</r:DataProvider><r:ConnectString>Server=old</r:ConnectString><r:IntegratedSecurity>true</r:IntegratedSecurity></r:ConnectionProperties><r:Keep>yes</r:Keep></r:DataSource></r:DataSources></r:Report>';
  const embedded = prepareRdl(input, { ...profile, dataSources: { Main: { connectionString: 'Server=dev;Database=Demo' } } });
  assert.match(embedded, /Server=dev;Database=Demo/); assert.match(embedded, /<r:IntegratedSecurity>true<\/r:IntegratedSecurity>/);
  const shared = prepareRdl(input, { ...profile, dataSources: { Main: { reference: '/Shared/Dev & QA' } } });
  assert.match(shared, /<r:DataSourceReference>\/Shared\/Dev &amp; QA<\/r:DataSourceReference><r:Keep>yes/);
  assert.match(input, /Server=old/);
  assert.throws(() => prepareRdl(input, { ...profile, dataSources: { Missing: { reference: '/Shared/Missing' } } }), /does not match/);
});
test('rejects malformed XML and external entity declarations before processing', () => {
  assert.throws(() => prepareRdl('<Report><Oops></Report>', profile), /Invalid XML/);
  assert.throws(() => prepareRdl('<!DOCTYPE Report [<!ENTITY x SYSTEM "file:///etc/passwd">]><Report>&x;</Report>', profile), /DTD/);
});
test('profiles require explicit HTTP opt-in and avoid embedded credentials', () => {
  assert.equal(validateProfile(profile).timeoutSeconds, 120);
  assert.throws(() => validateProfile({ ...profile, serverUrl: 'http://example.test/reportserver' }), /HTTPS/);
  assert.doesNotThrow(() => validateProfile({ ...profile, serverUrl: 'http://example.test/reportserver', allowHttp: true }));
  assert.doesNotThrow(() => validateProfile({ ...profile, auth: 'basic', username: 'demo', serverUrl: 'http://example.test/reportserver', allowHttp: true }));
  assert.throws(() => validateProfile({ ...profile, serverUrl: 'https://user:password@example.test/reportserver' }), /without credentials/);
  assert.throws(() => validateProfile({ ...profile, serverUrl: 'https://example.test/reports' }), /portal/);
  assert.throws(() => validateProfile({ ...profile, dataSources: { Main: { connectionString: 'Server=dev;PWD=secret' } } }), /credentials/);
  assert.throws(() => validateProfile({ ...profile, dataSources: { Main: { reference: '/DS', connectionString: 'Server=dev' } } }), /either/);
});
test('null, blank, integers, dates, booleans and multi-value choices retain distinct semantics', () => {
  assert.deepEqual({ ...validateValues([p({ nullable: true })], { A: [null] }) }, {});
  assert.ok(validateValues([p()], { A: [null] }).A);
  assert.deepEqual({ ...validateValues([p({ allowBlank: true })], { A: [''] }) }, {});
  assert.ok(validateValues([p()], { A: [''] }).A);
  assert.ok(validateValues([p({ type: 'Integer' })], { A: ['2147483648'] }).A);
  assert.ok(validateValues([p({ type: 'Float' })], { A: ['NaN'] }).A);
  assert.ok(validateValues([p({ type: 'Boolean' })], { A: ['yes'] }).A);
  assert.ok(validateValues([p({ type: 'DateTime' })], { A: ['not a date'] }).A);
  const choices = p({ multiValue: true, validValues: [{ label: 'One', value: '1' }, { label: 'Two', value: '2' }] });
  assert.deepEqual({ ...validateValues([choices], { A: ['1', '2'] }) }, {});
  assert.ok(validateValues([choices], { A: ['3'] }).A);
});
test('dependent parameters are invalidated transitively and remembered choices are filtered', () => {
  const params = [p(), p({ name: 'B', dependencies: ['A'] }), p({ name: 'C', dependencies: ['B'] }), p({ name: 'D' })];
  assert.deepEqual(invalidateDependents(params, { A: ['new'], B: ['old'], C: ['old'], D: ['keep'] }, 'A'), { A: ['new'], D: ['keep'] });
  const value = initialValues([p({ validValues: [{ label: 'new', value: 'new' }] })], { A: ['old'] });
  assert.equal(value.A, undefined);
});
test('SOAP encodes repeated multi-value entries, escaped strings, blank and xsi:nil', () => {
  const result = parameterXml({ A: ['<&', '', null], B: ['1'] });
  assert.match(result, /&lt;&amp;/); assert.match(result, /<Value><\/Value>/); assert.match(result, /xsi:nil="true"/);
  assert.equal((result.match(/<Name>A<\/Name>/g) || []).length, 3);
});
test('execution metadata preserves nil defaults, dependencies, unavailable and empty choices', () => {
  const info = decodeInfo({ ExecutionID: 'id', Parameters: { ReportParameter: { Name: 'A', Type: 'String', Nullable: 'true', PromptUser: 'false', DefaultValues: { string: { '@_nil': 'true' } }, Dependencies: { string: 'Parent' }, ValidValues: '' } } });
  assert.equal(info.id, 'id'); assert.deepEqual(info.parameters[0].defaults, [null]); assert.deepEqual(info.parameters[0].dependencies, ['Parent']); assert.deepEqual(info.parameters[0].validValues, []); assert.equal(info.parameters[0].promptUser, false);
});
test('curl credentials and XML are config-escaped and do not become process arguments', () => {
  const config = curlConfig('https://example.test', 'action', '<xml>\n"\\</xml>', { ...profile, auth: 'ntlm', username: 'DOMAIN\\user' }, 'pw"\nurl = "https://evil.test');
  assert.equal(config.split('\n').filter(l => l.startsWith('url =')).length, 1);
  assert.match(config, /user = "DOMAIN\\\\user:pw\\"\\nurl/);
  assert.ok(!config.includes('insecure'));
});
test('demo parses a parameterized fixture and produces a clearly labeled valid PDF', async () => {
  const demo = new DemoSession();
  const info = await demo.load(await readFile('examples/parameter-demo.rdl', 'utf8'));
  assert.equal(info.parameters.length, 6);
  assert.match(info.warnings[0], /simulated/);
  await demo.setParameters(initialValues(info.parameters));
  const pdf = Buffer.from(await demo.render());
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-'); assert.match(pdf.toString(), /DEMO - simulated/);
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const loading = getDocument({ data: new Uint8Array(pdf), useSystemFonts: true });
  const document = await loading.promise;
  assert.equal(document.numPages, 1); const text = await (await document.getPage(1)).getTextContent();
  assert.ok(text.items.some((item: any) => item.str?.includes('Department: Engineering'))); await loading.destroy();
});
