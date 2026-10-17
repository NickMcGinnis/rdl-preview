import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { analyzeRdl } from '../src/rdl-analysis';
import { Draft, type TextEdit } from '../src/rdl-edit';
import { applyAction, applyField, describe, designerTree, nodeAt, readOnlyReason, wireframe, type TreeNode } from '../src/rdl-designer';
import { declarationAt } from '../src/rdl-rename';

// Git may check fixtures out with CRLF on Windows. Tests use LF text; CRLF is covered explicitly below.
const sales = readFileSync('test/fixtures/sales.rdl', 'utf8').replace(/\r\n/g, '\n');
const demo = readFileSync('examples/parameter-demo.rdl', 'utf8').replace(/\r\n/g, '\n');
const apply = (xml: string, edits: TextEdit[]) => [...edits].sort((a, b) => b.start - a.start).reduce((text, e) => text.slice(0, e.start) + e.text + text.slice(e.end), xml);
const field = (xml: string, path: string, key: string, value: unknown) => { const change = applyField(analyzeRdl(xml), path, key, value); return { xml: apply(xml, change.edits), change }; };
const action = (xml: string, path: string, id: string, input?: unknown) => { const change = applyAction(analyzeRdl(xml), path, id, input); return { xml: apply(xml, change.edits), change }; };
const issues = (xml: string) => analyzeRdl(xml).issues.map(i => i.message);
const read = (xml: string, path: string, key: string) => describe(analyzeRdl(xml), path)!.fields.find(f => f.key === key)?.value;
const R = 'Report', PARAMS = `${R}/ReportParameters`, REGION = `${PARAMS}/ReportParameter[Region]`, YEAR = `${PARAMS}/ReportParameter[Year]`;
const SALES = `${R}/DataSets/DataSet[Sales]`, BODY = `${R}/ReportSections/ReportSection/Body`, TITLE = `${BODY}/ReportItems/Textbox[Title]`;
const names = (nodes: TreeNode[]): unknown[] => nodes.map(n => n.children.length ? [n.name, names(n.children)] : n.name);

test('draft inserts children with the surrounding indentation, line endings and prefix', () => {
  const pretty = new Draft('<Report>\r\n  <A>\r\n    <B>1</B>\r\n  </A>\r\n  <Empty></Empty>\r\n  <Self />\r\n</Report>');
  pretty.apply(pretty.insert(pretty.find('Report/A')!, [{ tag: 'C', text: 'x < y' }]));
  pretty.apply(pretty.insert(pretty.find('Report/Empty')!, [{ tag: 'D', children: [{ tag: 'E', text: '1' }] }]));
  pretty.apply(pretty.insert(pretty.find('Report/Self')!, [{ tag: 'F' }]));
  assert.equal(pretty.xml, '<Report>\r\n  <A>\r\n    <B>1</B>\r\n    <C>x &lt; y</C>\r\n  </A>\r\n  <Empty>\r\n    <D>\r\n      <E>1</E>\r\n    </D>\r\n  </Empty>\r\n  <Self>\r\n    <F />\r\n  </Self>\r\n</Report>');
  const inline = new Draft('<r:Report xmlns:r="urn:rdl"><r:ReportParameter Name="A"><r:DataType>String</r:DataType><r:Prompt>A</r:Prompt></r:ReportParameter></r:Report>');
  inline.apply(inline.insert(inline.find('Report/ReportParameter[A]')!, [{ tag: 'Nullable', text: 'true' }]));
  assert.equal(inline.xml, '<r:Report xmlns:r="urn:rdl"><r:ReportParameter Name="A"><r:DataType>String</r:DataType><r:Nullable>true</r:Nullable><r:Prompt>A</r:Prompt></r:ReportParameter></r:Report>', 'Inline documents stay inline; new children follow Report Builder order');
});
test('draft removes whole lines and empty lists, and escapes text and attributes', () => {
  const d = new Draft('<Report>\n  <Fields>\n    <Field Name="A" />\n  </Fields>\n  <Keep />\n</Report>');
  d.apply(d.remove(d.find('Report/Fields/Field[A]')!));
  assert.equal(d.xml, '<Report>\n  <Keep />\n</Report>');
  const e = new Draft('<Report><Value xmlns:xsi="urn:xsi" xsi:nil="true" /><T Name="a">old</T></Report>');
  e.apply([...e.setText(e.find('Report/Value')!, 'a & b'), ...e.setAttribute(e.find('Report/T[a]')!, 'Name', 'say "hi"')]);
  assert.equal(e.xml, '<Report><Value xmlns:xsi="urn:xsi">a &amp; b</Value><T Name="say &quot;hi&quot;">old</T></Report>');
  assert.equal(e.edits().length, 2, 'A single batch keeps its separate edits');
});

test('the tree mirrors the outline, offers empty lists, and maps offsets to nodes', () => {
  const tree = designerTree(analyzeRdl(sales));
  assert.deepEqual(names(tree), [['Report', [
    ['Data Sources', ['Warehouse']], ['Datasets', [['Sales', ['Region', 'Amount']], ['Regions', ['Region']]]], ['Parameters', ['Region', 'Year']], ['Embedded Images', ['Logo']],
    'Page Header', ['Body', ['Title', ['SalesTable', ['AmountCell']], ['Box', ['Note']]]]
  ]]]);
  assert.deepEqual(designerTree(analyzeRdl(demo))[0].children.filter(n => n.virtual).map(n => n.path), ['Report/DataSources', 'Report/DataSets', 'Report/EmbeddedImages']);
  assert.equal(nodeAt(tree, sales.indexOf('="Sales for "'))?.path, TITLE);
  assert.equal(nodeAt(tree, sales.indexOf('=Parameters!Region'))?.path, SALES);
});
test('designer edits only the targeted text', () => {
  const { xml } = field(sales, YEAR, 'prompt', 'Fiscal year');
  assert.equal(xml, sales.replace('<Prompt>Year</Prompt>', '<Prompt>Fiscal year</Prompt>'));
  assert.equal(field(xml, YEAR, 'prompt', 'Fiscal year').change.edits.length, 0, 'Setting the same value is a no-op');
  assert.equal(field(sales, YEAR, 'nullable', 'true').xml, sales.replace('<DataType>Integer</DataType>\n', '<DataType>Integer</DataType>\n      <Nullable>true</Nullable>\n'));
  assert.equal(field(field(sales, YEAR, 'nullable', 'true').xml, YEAR, 'nullable', 'false').xml, sales, 'Clearing a checkbox removes the element again');
});
test('designer edits keep CRLF line endings', () => {
  const crlf = sales.replace(/\n/g, '\r\n');
  let xml = action(crlf, PARAMS, 'addParameter').xml;
  xml = field(xml, TITLE, 'fontWeight', 'Bold').xml;
  xml = action(xml, SALES, 'addFields', 'A, B').xml;
  xml = action(xml, YEAR, 'delete').xml;
  assert.doesNotMatch(xml, /[^\r]\n/, 'Every line still ends with CRLF');
  assert.deepEqual(issues(xml), []);
});
test('parameter details reflect query and static values', () => {
  const details = describe(analyzeRdl(sales), REGION)!;
  assert.equal(details.subtitle, 'Parameter · 3 references');
  const values = Object.fromEntries(details.fields.map(f => [f.key, f.value]));
  assert.equal(values.availableMode, 'query'); assert.equal(values.availableDataSet, 'Regions'); assert.equal(values.availableValueField, 'Region');
  assert.equal(values.defaultMode, 'none');
  assert.deepEqual(read(sales, YEAR, 'defaultValues'), [['2026']]);
  assert.deepEqual(details.actions.map(a => [a.id, !!a.disabled]), [['moveUp', true], ['moveDown', false], ['delete', false]]);
});
test('renaming updates expressions, layout cells and scope strings but not unrelated names', () => {
  const renamed = field(sales, REGION, 'name', 'Area');
  assert.equal(renamed.change.select, `${PARAMS}/ReportParameter[Area]`);
  assert.match(renamed.xml, /="Sales for " &amp; Parameters!Area\.Value/);
  assert.match(renamed.xml, /<Value>=Parameters!Area\.Value<\/Value>/);
  assert.match(renamed.xml, /<ParameterName>Area<\/ParameterName>/);
  assert.equal(renamed.xml.match(/<DataField>Region<\/DataField>/g)?.length, 2, 'Fields with the same name are untouched');
  assert.deepEqual(issues(renamed.xml), []);
  const dataset = field(sales, SALES, 'name', 'Orders').xml;
  assert.match(dataset, /<DataSetName>Orders<\/DataSetName>/); assert.match(dataset, /Sum\(Fields!Amount\.Value, "Orders"\)/);
  assert.deepEqual(issues(dataset), []);
  const regionField = field(sales, `${R}/DataSets/DataSet[Regions]/Fields/Field[Region]`, 'name', 'Name').xml;
  assert.match(regionField, /<ValueField>Name<\/ValueField>/);
  assert.match(regionField, /<Field Name="Region">\n {10}<DataField>Region<\/DataField>\n {10}<rd:TypeName>/, 'The Sales field of the same name is untouched');
  assert.throws(() => field(sales, REGION, 'name', 'Year'), /already exists/);
  assert.throws(() => field(sales, REGION, 'name', '1st'), /must start with a letter/);
  const analysis = analyzeRdl(sales);
  assert.equal(declarationAt(analysis, sales.indexOf('Parameters!Region') + 12)?.declaration.collection, 'Parameters');
});
test('adding, moving and deleting parameters keeps the 2016 parameter layout valid', () => {
  const added = action(sales, PARAMS, 'addParameter');
  assert.equal(added.change.select, `${PARAMS}/ReportParameter[Parameter1]`);
  assert.match(added.xml, /<NumberOfRows>2<\/NumberOfRows>/);
  assert.match(added.xml, /<CellDefinition>\n {10}<ColumnIndex>0<\/ColumnIndex>\n {10}<RowIndex>1<\/RowIndex>\n {10}<ParameterName>Parameter1<\/ParameterName>/);
  assert.deepEqual(issues(added.xml), []);
  const moved = action(sales, REGION, 'moveDown').xml;
  assert.ok(moved.indexOf('ReportParameter Name="Year"') < moved.indexOf('ReportParameter Name="Region"'));
  assert.ok(moved.indexOf('<ParameterName>Year</ParameterName>') < moved.indexOf('<ParameterName>Region</ParameterName>'), 'Cells swap so the prompt order follows');
  assert.deepEqual(issues(moved), []);
  const deleted = action(sales, YEAR, 'delete');
  assert.equal(deleted.change.select, PARAMS);
  assert.doesNotMatch(deleted.xml, /Year/); assert.deepEqual(issues(deleted.xml), []);
  const none = action(deleted.xml, REGION, 'delete');
  assert.doesNotMatch(none.xml, /ReportParameters|ReportParametersLayout/);
  assert.equal(none.change.select, PARAMS, 'The empty list stays selectable');
  assert.ok(describe(analyzeRdl(none.xml), PARAMS)!.actions.some(a => a.id === 'addParameter'));
  assert.deepEqual(issues(none.xml).filter(m => !m.includes('Region')), [], 'Only the now-dangling expression references remain');
});
test('available and default values switch between none, static values and queries', () => {
  let xml = field(sales, REGION, 'availableMode', 'values').xml;
  xml = field(xml, REGION, 'availableValues', [['N', 'North'], ['S', '']]).xml;
  assert.match(xml, /<ParameterValue>\n {12}<Value>N<\/Value>\n {12}<Label>North<\/Label>\n {10}<\/ParameterValue>\n {10}<ParameterValue>\n {12}<Value>S<\/Value>\n {10}<\/ParameterValue>/);
  assert.deepEqual(read(xml, REGION, 'availableValues'), [['N', 'North'], ['S', '']]);
  xml = field(xml, REGION, 'availableValues', [['N', '']]).xml;
  assert.deepEqual(read(xml, REGION, 'availableValues'), [['N', '']]);
  xml = field(xml, REGION, 'availableMode', 'none').xml;
  assert.doesNotMatch(xml, /ValidValues/);
  const defaults = field(sales, YEAR, 'defaultValues', []).xml;
  assert.doesNotMatch(defaults, /DefaultValue/);
  const query = field(sales, YEAR, 'defaultMode', 'query').xml;
  assert.match(query, /<DefaultValue>\n {8}<DataSetReference>\n {10}<DataSetName>Sales<\/DataSetName>\n {10}<ValueField>Region<\/ValueField>/);
  const switched = field(field(sales, REGION, 'availableLabelField', 'Region').xml, REGION, 'availableDataSet', 'Sales').xml;
  assert.match(switched, /<DataSetName>Sales<\/DataSetName>\n {10}<ValueField>Region<\/ValueField>\n {10}<LabelField>Region<\/LabelField>/);
  assert.deepEqual(issues(switched), []);
});
test('data sources, datasets and fields', () => {
  const DS = `${R}/DataSources/DataSource[Warehouse]`;
  const shared = field(sales, DS, 'sourceType', 'shared').xml;
  assert.match(shared, /<DataSource Name="Warehouse">\n {6}<DataSourceReference \/>\n {6}<rd:SecurityType>/);
  assert.match(field(shared, DS, 'sourceType', 'embedded').xml, /<ConnectionProperties>\n {8}<DataProvider>SQL<\/DataProvider>\n {8}<ConnectString \/>/);
  assert.match(String(describe(analyzeRdl(field(sales, DS, 'connectString', 'Server=x;Password=secret').xml), DS)!.fields.find(f => f.key === 'connectString')!.hint), /password/);
  let xml = field(sales, SALES, 'queryParameters', [['@Region', '=Parameters!Region.Value'], ['@Year', '=Parameters!Year.Value']]).xml;
  assert.match(xml, /<QueryParameter Name="@Year">\n {12}<Value>=Parameters!Year\.Value<\/Value>/);
  xml = field(xml, SALES, 'commandType', 'StoredProcedure').xml;
  assert.match(xml, /<CommandType>StoredProcedure<\/CommandType>/);
  assert.doesNotMatch(field(xml, SALES, 'commandType', 'Text').xml, /CommandType/);
  const fields = action(sales, SALES, 'addFields', 'Customer Name, Amount\n2026 Total');
  assert.equal(fields.change.message, 'Added 2 fields.');
  assert.match(fields.xml, /<Field Name="Customer_Name">\n {10}<DataField>Customer Name<\/DataField>/);
  assert.match(fields.xml, /<Field Name="Field_2026_Total">/);
  const calculated = field(sales, `${SALES}/Fields/Field[Amount]`, 'source', 'calculated').xml;
  assert.match(calculated, /<Field Name="Amount">\n {10}<Value>=<\/Value>\n {10}<rd:TypeName>/);
  assert.deepEqual(issues(action(sales, `${R}/DataSets`, 'addDataSet').xml), []);
});
test('report items: text, fonts, positions and validation', () => {
  let xml = field(sales, TITLE, 'fontWeight', 'Bold').xml;
  assert.match(xml, /<Style>\n {22}<FontSize>14pt<\/FontSize>\n {22}<FontWeight>Bold<\/FontWeight>\n {20}<\/Style>/);
  assert.equal(field(xml, TITLE, 'fontWeight', 'Normal').xml, sales);
  xml = field(sales, TITLE, 'textAlign', 'Center').xml;
  assert.match(xml, /<Style>\n {18}<TextAlign>Center<\/TextAlign>\n {16}<\/Style>/, 'Self-closing paragraph styles expand');
  assert.throws(() => field(sales, TITLE, 'top', 'abc'), /Enter a size/);
  assert.throws(() => field(sales, TITLE, 'fontSize', 'big'), /Enter a size/);
  assert.match(field(sales, TITLE, 'value', 'Plain & simple').xml, /<Value>Plain &amp; simple<\/Value>/);
  assert.doesNotMatch(field(sales, TITLE, 'canGrow', 'false').xml, /<Textbox Name="Title">\n {12}<CanGrow>/);
  const cell = `${BODY}/ReportItems/Tablix[SalesTable]/TablixBody/TablixRows/TablixRow/TablixCells/TablixCell/CellContents/Textbox[AmountCell]`;
  const cellDetails = describe(analyzeRdl(sales), cell)!;
  assert.ok(!cellDetails.fields.some(f => f.key === 'top'), 'Cells have no position');
  assert.ok(!cellDetails.actions.some(a => a.id === 'delete'), 'Cells must keep their content');
  assert.equal(read(sales, `${BODY}/ReportItems/Tablix[SalesTable]`, 'dataSetName'), 'Sales');
  const added = action(sales, BODY, 'addTextbox');
  assert.equal(added.change.select, `${BODY}/ReportItems/Textbox[Textbox1]`);
  assert.deepEqual(issues(added.xml), []);
  assert.match(action(sales, R, 'addPageFooter').xml, /<\/PageHeader>\n {8}<PageFooter>\n {10}<Height>0\.5in<\/Height>/);
});
test('expressions in checkbox or choice properties are shown as expressions', () => {
  const xml = sales.replace('<CanGrow>true</CanGrow>', '<CanGrow>=Parameters!Year.Value &gt; 2000</CanGrow>');
  const canGrow = describe(analyzeRdl(xml), TITLE)!.fields.find(f => f.key === 'canGrow')!;
  assert.equal(canGrow.type, 'code'); assert.equal(canGrow.value, '=Parameters!Year.Value > 2000');
});
test('wireframe positions nested items in inches', () => {
  const frame = wireframe(analyzeRdl(sales), TITLE)!;
  assert.equal(frame.title, 'Body'); assert.equal(frame.width, 6.5); assert.equal(frame.height, 2);
  const note = frame.items.find(i => i.name === 'Note')!;
  assert.deepEqual([note.x, note.y, note.depth], [1.1, 1.1, 1]);
  assert.equal(wireframe(analyzeRdl(sales), `${R}/ReportSections/ReportSection/Page/PageHeader`)!.title, 'Page header');
});
test('inline documents, read-only states and older schemas', () => {
  const added = action(demo, R, 'addParameter');
  assert.match(added.xml, /<ReportParameter Name="Notes">[\s\S]*?<\/ReportParameter>\n {4}<ReportParameter Name="Parameter1"><DataType>String<\/DataType><Prompt>Parameter1<\/Prompt><\/ReportParameter>/);
  assert.deepEqual(issues(added.xml), []);
  assert.equal(readOnlyReason(analyzeRdl(sales)), undefined);
  assert.match(readOnlyReason(analyzeRdl('<Report><A></Report>'))!, /XML has errors/);
  assert.match(readOnlyReason(analyzeRdl('<Report xmlns="http://schemas.microsoft.com/sqlserver/reporting/2005/01/reportdefinition"/>'))!, /2005\/01 reports are read-only/);
  assert.match(readOnlyReason(analyzeRdl('<Root/>'))!, /not an RDL report/);
});
test('embedded images are previewed and added from validated input', () => {
  const preview = read(sales, `${R}/EmbeddedImages/EmbeddedImage[Logo]`, 'preview');
  assert.match(String(preview), /^data:image\/png;base64,iVBOR/);
  const added = action(sales, `${R}/EmbeddedImages`, 'addImage', { name: 'company logo.png', mimeType: 'image/png', data: 'AAAA' });
  assert.equal(added.change.select, `${R}/EmbeddedImages/EmbeddedImage[company_logo_png]`);
  assert.throws(() => action(sales, `${R}/EmbeddedImages`, 'addImage', { name: 'x.svg', mimeType: 'image/svg+xml', data: 'AAAA' }), /PNG, JPEG, GIF or BMP/);
});
