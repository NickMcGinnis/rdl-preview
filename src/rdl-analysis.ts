import { XMLValidator } from 'fast-xml-parser';
import { attribute, childText, defaultNamespace, parseElements, prefixOf, textOf, type XmlElement } from './rdl-model';

export type Collection = 'Parameters' | 'Fields' | 'ReportItems' | 'DataSets' | 'DataSources' | 'Variables' | 'Groups' | 'EmbeddedImages';
export interface Declaration { collection: Collection; name: string; detail: string; element: XmlElement; start: number; end: number; dataSet?: string }
export interface Reference { collection: Collection; name: string; start: number; end: number; dataSet?: string }
export interface Issue { start: number; end: number; message: string; severity: 'error' | 'warning' }
export type OutlineKind = 'group' | 'dataSource' | 'dataSet' | 'field' | 'parameter' | 'variable' | 'image' | 'section' | 'textbox' | 'dataRegion' | 'rectangle' | 'picture' | 'subreport' | 'line' | 'reportItem';
export interface OutlineItem { name: string; detail: string; kind: OutlineKind; element: XmlElement; start: number; end: number; selectionStart: number; selectionEnd: number; children: OutlineItem[] }
/** A string literal naming the scope of an aggregate or lookup, e.g. "Sales" in Sum(Fields!Amount.Value, "Sales"). */
export interface ScopeReference { name: string; start: number; end: number }
export interface Analysis { xml: string; root?: XmlElement; wellFormed: boolean; declarations: Declaration[]; references: Reference[]; scopes: ScopeReference[]; issues: Issue[]; outline: OutlineItem[] }

const LABELS: Record<Collection, string> = { Parameters: 'Report parameter', Fields: 'Field', ReportItems: 'Report item', DataSets: 'Dataset', DataSources: 'Data source', Variables: 'Variable', Groups: 'Group', EmbeddedImages: 'Embedded image' };
const COLLECTIONS: Record<string, Collection> = { parameters: 'Parameters', fields: 'Fields', reportitems: 'ReportItems', datasets: 'DataSets', datasources: 'DataSources', variables: 'Variables' };
export const GLOBALS = ['ExecutionTime', 'OverallPageNumber', 'OverallTotalPages', 'PageName', 'PageNumber', 'RenderFormat', 'ReportFolder', 'ReportName', 'ReportServerUrl', 'TotalPages'];
export const USER = ['Language', 'UserID'];
const DATA_REGIONS = new Set(['Tablix', 'Chart', 'GaugePanel', 'Map', 'CustomReportItem']);
const ITEM_KINDS: Record<string, OutlineKind> = { Textbox: 'textbox', Rectangle: 'rectangle', Image: 'picture', Subreport: 'subreport', Line: 'line' };
// Element values that name another declaration rather than holding an expression.
const ELEMENT_REFERENCES: Record<string, Collection> = { DataSetName: 'DataSets', DataSourceName: 'DataSources', ToggleItem: 'ReportItems', ParameterName: 'Parameters' };
// VB string literals and comments are matched first so references inside them are ignored.
// Functions whose string-literal arguments name a dataset, group or data region.
const SCOPE_FUNCTIONS = new Set(['aggregate', 'avg', 'count', 'countdistinct', 'countrows', 'first', 'inscope', 'last', 'level', 'lookup', 'lookupset', 'max', 'min', 'multilookup', 'previous', 'rownumber', 'runningvalue', 'stdev', 'stdevp', 'sum', 'union', 'var', 'varp']);
export const SCOPE_COLLECTIONS: Collection[] = ['DataSets', 'Groups', 'ReportItems'];
const TOKEN = /"(?:[^"]|"")*"?|'[^\r\n]*|[A-Za-z_]\w*|\S/g;
function scopeStrings(value: string): { name: string; index: number }[] {
  const tokens = [...value.matchAll(TOKEN)].filter(t => !t[0].startsWith("'"));
  const stack: string[] = [], result: { name: string; index: number }[] = [];
  tokens.forEach((t, i) => {
    const token = t[0], previous = tokens[i - 1]?.[0] ?? '', next = tokens[i + 1]?.[0] ?? '';
    if (token === '(') stack.push(/^[A-Za-z_]/.test(previous) ? previous.toLowerCase() : '');
    else if (token === ')') stack.pop();
    else if (/^"[^"]+"$/.test(token) && SCOPE_FUNCTIONS.has(stack.at(-1) ?? '') && (previous === '(' || previous === ',') && (next === ')' || next === ',')) result.push({ name: token.slice(1, -1), index: t.index! + 1 });
  });
  return result;
}
const EXPRESSION = /(?<![\w.])(Parameters|Fields|ReportItems|DataSets|DataSources|Variables)\s*(?:\.\s*Item\s*)?\(\s*"([^"]*)"\s*\)|"(?:[^"]|"")*"?|'[^\r\n]*|(?<![\w.])(Parameters|Fields|ReportItems|DataSets|DataSources|Variables)\s*!\s*(?:([A-Za-z_]\w*)|\[([^\]\r\n]*)\])/gi;

function offsetAt(xml: string, line: number, col: number): number {
  let offset = 0;
  for (let i = 1; i < line; i++) { const next = xml.indexOf('\n', offset); if (next < 0) break; offset = next + 1; }
  return Math.min(xml.length, offset + Math.max(0, col - 1));
}

export function analyzeRdl(xml: string): Analysis {
  const elements = parseElements(xml), root = elements[0];
  const valid = XMLValidator.validate(xml);
  const analysis: Analysis = { xml, root, wellFormed: valid === true, declarations: [], references: [], scopes: [], issues: [], outline: [] };
  if (valid !== true) {
    const start = offsetAt(xml, valid.err.line, valid.err.col);
    analysis.issues.push({ start, end: Math.min(xml.length, start + 1), message: `Invalid XML: ${valid.err.msg}`, severity: 'error' });
  }
  if (!root || root.name !== 'Report') {
    if (root && valid === true) analysis.issues.push({ start: root.start, end: root.openEnd, message: `The root element is <${root.tag}>, not <Report>, so this is not an RDL report.`, severity: 'warning' });
    return analysis;
  }
  // Only the report's own namespace; skips rd:* designer metadata and embedded query-designer XML.
  const rdl: XmlElement[] = [];
  const prefix = prefixOf(root), namespace = defaultNamespace(root);
  const walk = (e: XmlElement) => {
    if (e !== root && (prefixOf(e) !== prefix || (!prefix && defaultNamespace(e) !== undefined && defaultNamespace(e) !== namespace))) return;
    rdl.push(e);
    for (const c of e.children) walk(c);
  };
  walk(root);
  const text = (e: XmlElement, name: string) => childText(xml, e, name) || '';
  const declare = (collection: Collection, e: XmlElement, detail = '', dataSet?: string) => {
    const name = attribute(e, 'Name');
    if (name) analysis.declarations.push({ collection, name: name.value, detail, element: e, start: name.start, end: name.end, dataSet });
  };
  const isItem = (e: XmlElement) => (e.parent?.name === 'ReportItems' || e.parent?.name === 'CellContents') && !!attribute(e, 'Name');
  for (const e of rdl) {
    const parent = e.parent?.name;
    if (e.name === 'ReportParameter' && parent === 'ReportParameters') declare('Parameters', e, text(e, 'DataType'));
    else if (e.name === 'DataSource' && parent === 'DataSources') declare('DataSources', e, e.children.some(c => c.name === 'DataSourceReference') ? `shared: ${text(e, 'DataSourceReference')}` : childText(xml, e.children.find(c => c.name === 'ConnectionProperties') || e, 'DataProvider') || '');
    else if (e.name === 'DataSet' && parent === 'DataSets') declare('DataSets', e, e.children.some(c => c.name === 'SharedDataSet') ? 'shared' : childText(xml, e.children.find(c => c.name === 'Query') || e, 'DataSourceName') || '');
    else if (e.name === 'Field' && parent === 'Fields' && e.parent?.parent?.name === 'DataSet') declare('Fields', e, text(e, 'DataField') || (e.children.some(c => c.name === 'Value') ? 'calculated' : ''), attribute(e.parent.parent, 'Name')?.value);
    else if (e.name === 'Variable' && parent === 'Variables') declare('Variables', e);
    else if (e.name === 'Group') declare('Groups', e);
    else if (e.name === 'EmbeddedImage' && parent === 'EmbeddedImages') declare('EmbeddedImages', e, text(e, 'MIMEType'));
    else if (isItem(e)) declare('ReportItems', e, DATA_REGIONS.has(e.name) && text(e, 'DataSetName') ? `${e.name} · ${text(e, 'DataSetName')}` : e.name);
  }
  // References from expressions and from elements that name a declaration.
  for (const e of rdl) {
    if (e.children.length || e.selfClosing || e.name === 'Code') continue;
    const raw = xml.slice(e.openEnd, e.closeStart);
    if (/^\s*=/.test(raw)) {
      const { text: value, offsets } = textOf(xml, e);
      for (const m of value.matchAll(EXPRESSION)) {
        const collection = COLLECTIONS[(m[1] || m[3] || '').toLowerCase()];
        if (!collection) continue;
        const name = m[2] ?? m[4] ?? m[5], at = m.index! + m[0].lastIndexOf(name);
        analysis.references.push({ collection, name, start: offsets[at], end: offsets[at + name.length] });
      }
      for (const s of scopeStrings(value)) analysis.scopes.push({ name: s.name, start: offsets[s.index], end: offsets[s.index + s.name.length] });
      continue;
    }
    let collection: Collection | undefined = e.name === 'ParameterName' && e.parent?.name !== 'CellDefinition' ? undefined : ELEMENT_REFERENCES[e.name];
    let dataSet: string | undefined;
    if ((e.name === 'ValueField' || e.name === 'LabelField') && e.parent?.name === 'DataSetReference') { collection = 'Fields'; dataSet = childText(xml, e.parent, 'DataSetName'); }
    if (!collection) continue;
    const { text: value, offsets } = textOf(xml, e);
    const name = value.trim();
    if (!name) continue;
    const at = value.indexOf(name);
    analysis.references.push({ collection, name, start: offsets[at], end: offsets[at + name.length], dataSet });
  }
  analysis.outline = outline(xml, root, rdl, analysis.declarations);
  if (valid !== true) return analysis;
  // Duplicate names. Fields only need to be unique within their dataset.
  const seen = new Map<string, Declaration>();
  for (const d of analysis.declarations) {
    if (d.collection === 'Variables') continue;
    const key = `${d.collection}\0${d.collection === 'Fields' ? d.dataSet : ''}\0${d.name}`;
    const first = seen.get(key);
    if (!first) { seen.set(key, d); continue; }
    analysis.issues.push({ start: d.start, end: d.end, severity: 'error', message: `${LABELS[d.collection]} name "${d.name}" is already used${d.collection === 'Fields' ? ` in dataset "${d.dataSet}"` : ''}. Names must be unique.` });
  }
  for (const r of analysis.references) {
    if (r.collection === 'Fields' && r.dataSet !== undefined && !analysis.declarations.some(d => d.collection === 'DataSets' && d.name === r.dataSet)) continue;
    if (resolve(analysis, r).length) continue;
    const candidates = analysis.declarations.filter(d => d.collection === r.collection && (r.dataSet === undefined || d.dataSet === r.dataSet));
    const similar = candidates.find(d => d.name.toLowerCase() === r.name.toLowerCase());
    const where = r.collection === 'Fields' ? r.dataSet !== undefined ? ` in dataset "${r.dataSet}"` : ' in any dataset' : '';
    analysis.issues.push({ start: r.start, end: r.end, severity: 'error', message: `${LABELS[r.collection]} "${r.name}" is not defined${where}.${similar ? ` Did you mean "${similar.name}"? Names are case-sensitive.` : ''}` });
  }
  for (const s of analysis.scopes) {
    if (!analysis.declarations.some(d => SCOPE_COLLECTIONS.includes(d.collection) && d.name === s.name)) analysis.issues.push({ start: s.start, end: s.end, severity: 'warning', message: `Scope "${s.name}" is not a dataset, group or data region in this report.` });
  }
  checkParameterLayout(xml, rdl, analysis);
  return analysis;
}

// RDL 2016 requires exactly one layout cell per parameter, at a unique position inside the grid.
function checkParameterLayout(xml: string, rdl: XmlElement[], analysis: Analysis): void {
  const layout = rdl.find(e => e.name === 'ReportParametersLayout');
  const grid = layout?.children.find(c => c.name === 'GridLayoutDefinition');
  if (!layout || !grid) return;
  const rows = Number(childText(xml, grid, 'NumberOfRows')), columns = Number(childText(xml, grid, 'NumberOfColumns'));
  const cells = grid.children.find(c => c.name === 'CellDefinitions')?.children.filter(c => c.name === 'CellDefinition') || [];
  const names = new Set<string>(), positions = new Set<string>();
  const issue = (e: XmlElement, message: string) => analysis.issues.push({ start: e.start, end: e.openEnd, severity: 'error', message });
  for (const cell of cells) {
    const name = childText(xml, cell, 'ParameterName'), row = Number(childText(xml, cell, 'RowIndex') || 0), column = Number(childText(xml, cell, 'ColumnIndex') || 0);
    if (name && names.has(name)) issue(cell, `Report parameter "${name}" has more than one cell in ReportParametersLayout.`);
    if (name) names.add(name);
    if (positions.has(`${row},${column}`)) issue(cell, `More than one parameter cell uses row ${row}, column ${column}.`);
    positions.add(`${row},${column}`);
    if (Number.isInteger(rows) && (row < 0 || row >= rows)) issue(cell, `Row ${row} is outside the parameter grid, which has ${rows} row${rows === 1 ? '' : 's'}.`);
    if (Number.isInteger(columns) && (column < 0 || column >= columns)) issue(cell, `Column ${column} is outside the parameter grid, which has ${columns} column${columns === 1 ? '' : 's'}.`);
  }
  for (const d of analysis.declarations) if (d.collection === 'Parameters' && !names.has(d.name)) analysis.issues.push({ start: d.start, end: d.end, severity: 'error', message: `Report parameter "${d.name}" has no cell in ReportParametersLayout. Every parameter needs exactly one cell.` });
}

/** Declarations a reference points to. Fields without a dataset match any dataset. */
export function resolve(analysis: Analysis, r: Reference): Declaration[] {
  return analysis.declarations.filter(d => d.collection === r.collection && d.name === r.name && (r.dataSet === undefined || d.dataSet === r.dataSet));
}
export function definitionsAt(analysis: Analysis, offset: number): Declaration[] {
  const r = analysis.references.find(r => r.start <= offset && offset <= r.end);
  if (r) return resolve(analysis, r);
  const scope = analysis.scopes.find(s => s.start <= offset && offset <= s.end);
  return scope ? analysis.declarations.filter(d => SCOPE_COLLECTIONS.includes(d.collection) && d.name === scope.name) : [];
}

export interface Completion { name: string; detail: string; preferred: boolean }
/** Names for a `Collection!partial` expression ending at the cursor. */
export function completionsAt(analysis: Analysis, linePrefix: string, offset: number): { partial: string; items: Completion[] } | undefined {
  const m = /(?<![\w.])(Parameters|Fields|ReportItems|DataSets|DataSources|Variables|Globals|User)\s*!\s*(\w*)$/i.exec(linePrefix);
  if (!m) return undefined;
  const key = m[1].toLowerCase(), partial = m[2];
  if (key === 'globals' || key === 'user') return { partial, items: (key === 'globals' ? GLOBALS : USER).map(name => ({ name, detail: key === 'globals' ? 'Built-in global' : 'User', preferred: false })) };
  const collection = COLLECTIONS[key];
  const scope = collection === 'Fields' ? scopeDataSet(analysis, offset) : undefined;
  const items = new Map<string, Completion>();
  for (const d of analysis.declarations) {
    if (d.collection !== collection) continue;
    const preferred = scope !== undefined && d.dataSet === scope;
    const existing = items.get(d.name);
    if (existing && (existing.preferred || !preferred)) continue;
    items.set(d.name, { name: d.name, detail: d.dataSet ? `${d.dataSet}${d.detail ? ` · ${d.detail}` : ''}` : d.detail, preferred });
  }
  return { partial, items: [...items.values()] };
}
/** Dataset of the innermost data region (or other element with a DataSetName) containing the offset. */
export function scopeDataSet(analysis: Analysis, offset: number): string | undefined {
  let e = analysis.root;
  while (e) {
    const child = e.children.find(c => c.start <= offset && offset <= c.end);
    if (!child) break;
    e = child;
  }
  for (; e; e = e.parent) {
    const name = childText(analysis.xml, e, 'DataSetName');
    if (name) return name;
  }
  return undefined;
}

function outline(xml: string, root: XmlElement, rdl: XmlElement[], declarations: Declaration[]): OutlineItem[] {
  const byElement = new Map(declarations.map(d => [d.element, d]));
  const item = (e: XmlElement, kind: OutlineKind, children: OutlineItem[] = [], name?: string, detail?: string): OutlineItem => {
    const d = byElement.get(e);
    return { name: name || d?.name || e.name, detail: detail ?? d?.detail ?? '', kind, element: e, start: e.start, end: e.end, selectionStart: d?.start ?? e.start, selectionEnd: d?.end ?? e.openEnd, children };
  };
  const inRdl = new Set(rdl);
  const child = (e: XmlElement | undefined, name: string) => e?.children.find(c => c.name === name && inRdl.has(c));
  const group = (container: string, member: string, kind: OutlineKind, label: string, children?: (e: XmlElement) => OutlineItem[]): OutlineItem[] => {
    const e = child(root, container);
    const members = e?.children.filter(c => c.name === member && inRdl.has(c)) || [];
    return e && members.length ? [item(e, 'group', members.map(m => item(m, kind, children?.(m))), label, `${members.length}`)] : [];
  };
  const reportItems = (e: XmlElement): OutlineItem[] => e.children.filter(c => inRdl.has(c)).flatMap(c => byElement.get(c)?.collection === 'ReportItems'
    ? [item(c, ITEM_KINDS[c.name] || (DATA_REGIONS.has(c.name) ? 'dataRegion' : 'reportItem'), reportItems(c))]
    : reportItems(c));
  const sectionParts = (section: XmlElement): OutlineItem[] => {
    const page = child(section, 'Page') || section;
    return [[child(page, 'PageHeader'), 'Page Header'], [child(section, 'Body'), 'Body'], [child(page, 'PageFooter'), 'Page Footer']].flatMap(([e, label]) => e ? [item(e as XmlElement, 'section', reportItems(e as XmlElement), label as string, '')] : []);
  };
  const sections = child(root, 'ReportSections')?.children.filter(c => c.name === 'ReportSection' && inRdl.has(c)) || [];
  return [
    ...group('DataSources', 'DataSource', 'dataSource', 'Data Sources'),
    ...group('DataSets', 'DataSet', 'dataSet', 'Datasets', ds => child(ds, 'Fields')?.children.filter(f => byElement.has(f)).map(f => item(f, 'field')) || []),
    ...group('ReportParameters', 'ReportParameter', 'parameter', 'Parameters'),
    ...group('Variables', 'Variable', 'variable', 'Variables'),
    ...group('EmbeddedImages', 'EmbeddedImage', 'image', 'Embedded Images'),
    ...(sections.length > 1 ? sections.map((s, i) => item(s, 'section', sectionParts(s), `Section ${i + 1}`, '')) : sectionParts(sections[0] || root))
  ];
}
