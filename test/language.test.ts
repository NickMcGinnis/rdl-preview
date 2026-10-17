import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { analyzeRdl, completionsAt, definitionsAt, type OutlineItem } from '../src/rdl-analysis';
import { parseElements, textOf } from '../src/rdl-model';

const report = (body: string, extra = '') => `<Report xmlns="urn:rdl" xmlns:rd="urn:rd">
<DataSources><DataSource Name="Main"><ConnectionProperties><DataProvider>SQL</DataProvider><ConnectString>Data Source=x</ConnectString></ConnectionProperties></DataSource></DataSources>
<DataSets><DataSet Name="Sales"><Query><DataSourceName>Main</DataSourceName><CommandText>SELECT 1</CommandText></Query><Fields><Field Name="Amount"><DataField>Amount</DataField><rd:TypeName>System.Decimal</rd:TypeName></Field><Field Name="Region"><DataField>Region</DataField></Field></Fields></DataSet>
<DataSet Name="Years"><Query><DataSourceName>Main</DataSourceName><CommandText>SELECT 1</CommandText></Query><Fields><Field Name="Year"><DataField>Year</DataField></Field></Fields></DataSet></DataSets>
<ReportParameters><ReportParameter Name="Year"><DataType>Integer</DataType><Prompt>Year</Prompt></ReportParameter></ReportParameters>${extra}
<ReportSections><ReportSection><Body><ReportItems>${body}</ReportItems></Body><Page><PageHeader><ReportItems><Textbox Name="Header"><Value>Header</Value></Textbox></ReportItems></PageHeader></Page></ReportSection></ReportSections>
</Report>`;
const tablix = (value: string) => `<Tablix Name="Grid"><DataSetName>Sales</DataSetName><TablixBody><TablixRows><TablixRow><TablixCells><TablixCell><CellContents><Textbox Name="Cell"><Paragraphs><Paragraph><TextRuns><TextRun><Value>${value}</Value></TextRun></TextRuns></Paragraph></Paragraphs></Textbox></CellContents></TablixCell></TablixCells></TablixRow></TablixRows></TablixBody></Tablix>`;
const messages = (xml: string) => analyzeRdl(xml).issues.map(i => `${i.severity}: ${xml.slice(i.start, i.end)}: ${i.message}`);
const names = (items: OutlineItem[]): unknown[] => items.map(i => i.children.length ? [i.name, names(i.children)] : i.name);

test('a valid report has no issues and a structured outline', () => {
  const xml = report(tablix('=Sum(Fields!Amount.Value) &amp; Parameters!Year.Value'));
  assert.deepEqual(messages(xml), []);
  assert.deepEqual(names(analyzeRdl(xml).outline), [
    ['Data Sources', ['Main']], ['Datasets', [['Sales', ['Amount', 'Region']], ['Years', ['Year']]]], ['Parameters', ['Year']],
    ['Page Header', ['Header']], ['Body', [['Grid', ['Cell']]]]
  ]);
  const grid = analyzeRdl(xml).outline[4].children[0];
  assert.equal(grid.kind, 'dataRegion'); assert.equal(grid.detail, 'Tablix · Sales');
  assert.equal(xml.slice(grid.selectionStart, grid.selectionEnd), 'Grid');
});
test('the bundled example report analyzes cleanly', async () => {
  const analysis = analyzeRdl(await readFile('examples/parameter-demo.rdl', 'utf8'));
  assert.deepEqual(analysis.issues, []);
  assert.equal(analysis.references.filter(r => r.collection === 'Parameters').length, 6);
});
test('unknown references are errors with a hint when only the case differs', () => {
  assert.deepEqual(messages(report(tablix('=Parameters!year.Value &amp; Fields!Missing.Value &amp; ReportItems!Nope.Value &amp; DataSets("Ghost").CommandText &amp; Variables!V.Value'))), [
    'error: year: Report parameter "year" is not defined. Did you mean "Year"? Names are case-sensitive.',
    'error: Missing: Field "Missing" is not defined in any dataset.',
    'error: Nope: Report item "Nope" is not defined.',
    'error: Ghost: Dataset "Ghost" is not defined.',
    'error: V: Variable "V" is not defined.'
  ]);
});
test('string literals, comments and plain text are not scanned for references', () => {
  const xml = report(tablix(`="Parameters!Nope and ""Fields!Nope""" &amp; Fields!Amount.Value ' Parameters!Nope`) + '<Textbox Name="Plain"><Value>Parameters!Nope</Value></Textbox>');
  assert.deepEqual(messages(xml), []);
});
test('bracketed, Item and collection-case variants of references resolve', () => {
  const xml = report(tablix('=parameters!Year.Value + Parameters.Item("Year").Value + FIELDS![Amount].Value + ReportItems("Grid").Value'));
  assert.deepEqual(messages(xml), []);
  assert.equal(analyzeRdl(xml).references.filter(r => !['DataSets', 'DataSources'].includes(r.collection)).length, 4);
});
test('element references and dataset-scoped value fields are checked', () => {
  const xml = report('<Textbox Name="T"><ToggleItem>Gone</ToggleItem></Textbox>')
    .replace('<DataSourceName>Main</DataSourceName><CommandText>SELECT 1</CommandText></Query><Fields><Field Name="Year">', '<DataSourceName>Mian</DataSourceName><CommandText>SELECT 1</CommandText></Query><Fields><Field Name="Year">')
    .replace('<Prompt>Year</Prompt>', '<Prompt>Year</Prompt><ValidValues><DataSetReference><DataSetName>Years</DataSetName><ValueField>Year</ValueField><LabelField>Amount</LabelField></DataSetReference></ValidValues>');
  assert.deepEqual(messages(xml), [
    'error: Mian: Data source "Mian" is not defined.',
    'error: Amount: Field "Amount" is not defined in dataset "Years".',
    'error: Gone: Report item "Gone" is not defined.'
  ]);
});
test('duplicate names are reported per collection, and fields per dataset', () => {
  const xml = report('<Textbox Name="Header"><Value>x</Value></Textbox>')
    .replace('<Field Name="Region">', '<Field Name="Amount">')
    .replace('<Field Name="Year">', '<Field Name="Amount">');
  assert.deepEqual(messages(xml), [
    'error: Amount: Field name "Amount" is already used in dataset "Sales". Names must be unique.',
    'error: Header: Report item name "Header" is already used. Names must be unique.'
  ]);
});
test('parameter layout cells must name parameters, and parameters need a cell', () => {
  const layout = (name: string) => `<ReportParametersLayout><GridLayoutDefinition><NumberOfColumns>1</NumberOfColumns><NumberOfRows>1</NumberOfRows><CellDefinitions><CellDefinition><ColumnIndex>0</ColumnIndex><RowIndex>0</RowIndex><ParameterName>${name}</ParameterName></CellDefinition></CellDefinitions></GridLayoutDefinition></ReportParametersLayout>`;
  assert.deepEqual(messages(report('', layout('Year'))), []);
  assert.deepEqual(messages(report('', layout('Yr'))), [
    'error: Yr: Report parameter "Yr" is not defined.',
    'warning: Year: Report parameter "Year" has no cell in ReportParametersLayout. SSRS expects one cell definition per parameter.'
  ]);
});
test('designer metadata and foreign default namespaces are ignored', () => {
  const xml = report('', '<rd:DesignerState><QueryDefinition xmlns="urn:query"><DataSetName>Ghost</DataSetName></QueryDefinition></rd:DesignerState><Other xmlns="urn:x"><ReportParameter Name="Year"/></Other>');
  assert.deepEqual(messages(xml), []);
});
test('namespace-prefixed reports are analyzed', () => {
  const xml = '<r:Report xmlns:r="urn:rdl"><r:ReportParameters><r:ReportParameter Name="A"><r:DataType>String</r:DataType></r:ReportParameter></r:ReportParameters><r:Body><r:ReportItems><r:Textbox Name="T"><r:Value>=Parameters!B.Value</r:Value></r:Textbox></r:ReportItems></r:Body></r:Report>';
  assert.deepEqual(messages(xml), ['error: B: Report parameter "B" is not defined.']);
  assert.deepEqual(names(analyzeRdl(xml).outline), [['Parameters', ['A']], ['Body', ['T']]]);
});
test('malformed XML reports only the parse error but still produces an outline', () => {
  const xml = report('<Textbox Name="Open"><Value>=Parameters!Nope.Value</Value>');
  const analysis = analyzeRdl(xml);
  assert.equal(analysis.issues.length, 1);
  assert.match(analysis.issues[0].message, /^Invalid XML: /);
  assert.ok(names(analysis.outline).some(n => Array.isArray(n) && n[0] === 'Parameters'));
  assert.equal(analyzeRdl('<Root/>').issues[0].message, 'The root element is <Root>, not <Report>, so this is not an RDL report.');
});
test('reference ranges map through entities and CDATA back to the source', () => {
  const xml = report(tablix('="a&amp;b" &amp; <![CDATA[Fields!Region.Value]]> &amp; Parameters!Year.Value'));
  const analysis = analyzeRdl(xml);
  assert.deepEqual(analysis.references.filter(r => ['Fields', 'Parameters'].includes(r.collection)).map(r => xml.slice(r.start, r.end)), ['Region', 'Year']);
  const [e] = parseElements('<a>x&#x41;&lt;<!-- c -->y</a>');
  assert.equal(textOf('<a>x&#x41;&lt;<!-- c -->y</a>', e).text, 'xA<y');
});
test('go to definition resolves expression and element references', () => {
  const xml = report(tablix('=Fields!Region.Value'));
  const analysis = analyzeRdl(xml);
  const [region] = definitionsAt(analysis, xml.indexOf('Fields!Region') + 8);
  assert.equal(region.dataSet, 'Sales'); assert.equal(xml.slice(region.start, region.end), 'Region');
  const [dataSet] = definitionsAt(analysis, xml.indexOf('<DataSetName>Sales') + 14);
  assert.equal(dataSet.collection, 'DataSets');
  assert.deepEqual(definitionsAt(analysis, 0), []);
});
test('completion lists collection members and prefers the enclosing data region dataset', () => {
  const xml = report(tablix('=Fields!'));
  const analysis = analyzeRdl(xml);
  const fields = completionsAt(analysis, '=Sum(Fields!Am', xml.indexOf('=Fields!'))!;
  assert.equal(fields.partial, 'Am');
  assert.deepEqual(fields.items.map(i => [i.name, i.preferred]), [['Amount', true], ['Region', true], ['Year', false]]);
  assert.deepEqual(completionsAt(analysis, '=Parameters!', 0)!.items.map(i => i.name), ['Year']);
  assert.ok(completionsAt(analysis, '=Globals!', 0)!.items.some(i => i.name === 'PageNumber'));
  assert.equal(completionsAt(analysis, '=Foo!', 0), undefined);
});
