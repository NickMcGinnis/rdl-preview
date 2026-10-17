import { resolve, type Analysis, type OutlineItem } from './rdl-analysis';
import { Draft, type Build, type TextEdit } from './rdl-edit';
import { attribute, pathOf, prefixOf, type XmlElement } from './rdl-model';
import { renameEdits } from './rdl-rename';

// Designer view model and edits. Pure: no vscode dependency, and every change is a set of text edits.
export interface TreeNode { path: string; name: string; kind: string; detail: string; children: TreeNode[]; start: number; end: number; selectionStart: number; selectionEnd: number; virtual?: boolean }
export type FieldType = 'text' | 'code' | 'multiline' | 'select' | 'checkbox' | 'size' | 'number' | 'table' | 'image' | 'info';
export interface Option { value: string; label: string }
export interface Column { label: string; code?: boolean; placeholder?: string }
export type Value = string | string[][];
export interface FieldSpec { key: string; label: string; type: FieldType; value: Value; section: string; options?: Option[]; columns?: Column[]; hint?: string; placeholder?: string; readOnly?: boolean }
export interface ActionSpec { id: string; label: string; danger?: boolean; disabled?: boolean; input?: 'fieldNames' | 'image' }
export interface Details { path: string; kind: string; title: string; subtitle: string; fields: FieldSpec[]; actions: ActionSpec[]; usage: number }
export interface WireItem { path: string; name: string; kind: string; x: number; y: number; width: number; height: number; depth: number }
export interface Wireframe { title: string; path: string; width: number; height: number; items: WireItem[] }
export interface Change { edits: TextEdit[]; select: string; message?: string }
export interface ImageInput { name: string; mimeType: string; data: string }

const DATA_REGIONS = new Set(['Tablix', 'Chart', 'GaugePanel', 'Map', 'CustomReportItem']);
const AREAS = new Set(['Body', 'PageHeader', 'PageFooter']);
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/bmp', 'image/x-png'];
const PROVIDERS = ['SQL', 'SQLAZURE', 'OLEDB', 'OLEDB-MD', 'ODBC', 'ORACLE', 'TERADATA', 'XML', 'SHAREPOINTLIST'];
const SIZE = /^(\d+(\.\d*)?|\.\d+) ?(in|cm|mm|pt|pc)$/;
const UNITS: Record<string, number> = { in: 1, cm: 1 / 2.54, mm: 1 / 25.4, pt: 1 / 72, pc: 1 / 6 };
export const inches = (size: string | undefined): number | undefined => {
  const m = /^\s*(\d*\.?\d+)\s*(in|cm|mm|pt|pc)\s*$/i.exec(size || '');
  return m ? Number(m[1]) * UNITS[m[2].toLowerCase()] : undefined;
};

const ADD_PARAMETER: ActionSpec = { id: 'addParameter', label: 'Add parameter' };
const ADD_DATA_SOURCE: ActionSpec = { id: 'addDataSource', label: 'Add data source' };
const ADD_SHARED_DATA_SOURCE: ActionSpec = { id: 'addSharedDataSource', label: 'Add shared data source' };
const ADD_DATA_SET: ActionSpec = { id: 'addDataSet', label: 'Add dataset' };
const ADD_IMAGE: ActionSpec = { id: 'addImage', label: 'Add image…', input: 'image' };
const DELETE: ActionSpec = { id: 'delete', label: 'Delete', danger: true };
const CONTAINERS: Record<string, { label: string; empty: string; actions: ActionSpec[] }> = {
  DataSources: { label: 'Data Sources', empty: 'No data sources yet.', actions: [ADD_DATA_SOURCE, ADD_SHARED_DATA_SOURCE] },
  DataSets: { label: 'Datasets', empty: 'No datasets yet.', actions: [ADD_DATA_SET] },
  ReportParameters: { label: 'Parameters', empty: 'No parameters yet.', actions: [ADD_PARAMETER] },
  Variables: { label: 'Variables', empty: 'No variables.', actions: [] },
  EmbeddedImages: { label: 'Embedded Images', empty: 'No embedded images yet.', actions: [ADD_IMAGE] }
};
const KIND_LABELS: Record<string, string> = { ReportParameter: 'Parameter', DataSource: 'Data source', DataSet: 'Dataset', Field: 'Field', EmbeddedImage: 'Embedded image', Variable: 'Variable', ReportSection: 'Section', Body: 'Body', PageHeader: 'Page header', PageFooter: 'Page footer', Textbox: 'Text box', Tablix: 'Table, matrix or list', Rectangle: 'Rectangle', Image: 'Image', Subreport: 'Subreport', Line: 'Line', Chart: 'Chart', GaugePanel: 'Gauge', Map: 'Map', CustomReportItem: 'Custom report item' };

export function schemaVersion(root: XmlElement): string | undefined {
  const prefix = prefixOf(root);
  const namespace = new RegExp(`(?:^|\\s)xmlns${prefix ? ':' + prefix : ''}\\s*=\\s*(["'])([^"']*)\\1`).exec(root.attrs)?.[2] || '';
  return /reporting\/(\d{4}\/\d{2})\/reportdefinition/i.exec(namespace)?.[1];
}
/** Why the designer can't edit this document, if it can't. */
export function readOnlyReason(a: Analysis): string | undefined {
  if (!a.root || a.root.name !== 'Report') return 'This file is not an RDL report.';
  if (!a.wellFormed) return 'The XML has errors. Fix them in the text editor to continue editing here.';
  const version = schemaVersion(a.root);
  if (version && Number(version.slice(0, 4)) < 2008) return `RDL ${version} reports are read-only in the designer. Upgrade the report in Report Builder or Visual Studio to edit it here.`;
  return undefined;
}

// Reading helpers.
interface Ctx { d: Draft; e: XmlElement; a: Analysis }
const isItem = (e: XmlElement): boolean => (e.parent?.name === 'ReportItems' || e.parent?.name === 'CellContents') && !!attribute(e, 'Name');
const nameOf = (e: XmlElement): string => attribute(e, 'Name')?.value ?? '';
const names = (a: Analysis, collection: string, dataSet?: string): string[] => a.declarations.filter(d => d.collection === collection && (dataSet === undefined || d.dataSet === dataSet)).map(d => d.name);
const options = (values: string[]): Option[] => values.map(value => ({ value, label: value }));
const unique = (taken: string[], base: string): string => { const set = new Set(taken); for (let i = 1; ; i++) if (!set.has(`${base}${i}`)) return `${base}${i}`; };
const sections = (d: Draft): XmlElement[] => { const list = d.children(d.child(d.root, 'ReportSections'), 'ReportSection'); return list.length ? list : [d.root!]; };
const childPath = (parent: string, tag: string, name: string): string => `${parent}/${tag}[${encodeURIComponent(name)}]`;
const sizeError = (value: string): string | undefined => SIZE.test(value) ? undefined : 'Enter a size such as 1in, 2.5cm, 10mm or 12pt.';

// Properties. Each knows how to read its value and how to write a new one into the draft.
interface Prop {
  key: string; label: string; type: FieldType; section: string;
  get(c: Ctx): Value;
  set?(c: Ctx, value: any): void | { select?: string; message?: string };
  options?(c: Ctx): Option[];
  hint?(c: Ctx): string | undefined;
  when?(c: Ctx): boolean;
  placeholder?: string; columns?: Column[];
}
interface LeafOptions { base?(c: Ctx): XmlElement | undefined; options?: Option[] | ((c: Ctx) => Option[]); required?: boolean; removeWhen?: string[]; fallback?: string; validate?(value: string): string | undefined; when?(c: Ctx): boolean; hint?(c: Ctx): string | undefined; placeholder?: string }
/** A property stored as the text of a descendant element. Empty or default values remove the element. */
function leaf(key: string, label: string, type: FieldType, section: string, path: string[], o: LeafOptions = {}): Prop {
  const base = (c: Ctx) => o.base ? o.base(c) : c.e;
  return {
    key, label, type, section, when: o.when, hint: o.hint, placeholder: o.placeholder,
    options: o.options && (typeof o.options === 'function' ? o.options : () => o.options as Option[]),
    get: c => c.d.value(base(c), ...path) ?? o.fallback ?? '',
    set(c, raw: string) {
      const target = base(c);
      if (!target) throw new Error(`${label} can't be set on this item.`);
      const value = type === 'code' || type === 'multiline' ? raw : raw.trim();
      const error = value || o.required ? o.validate?.(value) : undefined;
      if (error) throw new Error(error);
      const remove = !o.required && (value === '' || o.removeWhen?.includes(value));
      c.d.apply(c.d.setLeaf(target, path, remove ? undefined : value));
    }
  };
}
const checkbox = (key: string, label: string, section: string, path: string[], o: LeafOptions = {}) => leaf(key, label, 'checkbox', section, path, { removeWhen: ['false'], ...o });
const size = (key: string, label: string, section: string, path: string[], o: LeafOptions = {}) => leaf(key, label, 'size', section, path, { validate: sizeError, placeholder: 'e.g. 1in', ...o });
const info = (key: string, label: string, section: string, get: (c: Ctx) => string, when?: (c: Ctx) => boolean): Prop => ({ key, label, type: 'info', section, get, when });

const nameProp: Prop = {
  key: 'name', label: 'Name', type: 'text', section: 'General',
  get: c => nameOf(c.e),
  set(c, value: string) {
    const target = c.a.declarations.find(d => d.element === c.e);
    if (!target) throw new Error('This item can\'t be renamed here.');
    const path = pathOf(c.e), tag = path.slice(path.lastIndexOf('/') + 1).replace(/\[.*$/, '');
    const { edits, skipped } = renameEdits(c.a, target, value.trim());
    c.d.apply(edits);
    return { select: childPath(path.slice(0, path.lastIndexOf('/')), tag, value.trim()), message: skipped ? `${skipped} reference${skipped === 1 ? '' : 's'} to "${target.name}" could belong to another dataset and ${skipped === 1 ? 'was' : 'were'} left unchanged.` : undefined };
  }
};

// Tables of repeated child elements, such as available values or query parameters. Rows map to
// existing elements by position, so untouched rows and unknown children stay as they are.
interface Cell { child?: string; attr?: string; self?: boolean; optional?: boolean }
function readRows(d: Draft, container: XmlElement | undefined, row: string, cells: Cell[]): string[][] {
  return d.children(container, row).map(r => cells.map(cell => cell.attr ? attribute(r, cell.attr)?.value ?? '' : cell.self ? d.text(r) : d.value(r, cell.child!) ?? ''));
}
function writeRows(d: Draft, container: XmlElement | undefined, rowTag: string, cells: Cell[], rows: string[][], create: (rows: Build[]) => TextEdit[]): void {
  const build = (row: string[]): Build => {
    const self = cells.findIndex(c => c.self);
    if (self >= 0) return { tag: rowTag, text: row[self] };
    const attrs: Record<string, string> = {}, children: Build[] = [];
    cells.forEach((cell, i) => { if (cell.attr) attrs[cell.attr] = row[i]; else if (row[i] !== '' || !cell.optional) children.push({ tag: cell.child!, text: row[i] }); });
    return { tag: rowTag, attrs, children };
  };
  const existing = d.children(container, rowTag);
  if (!rows.length) { if (container) d.apply(d.remove(container)); return; }
  const edits: TextEdit[] = [];
  rows.slice(0, existing.length).forEach((row, i) => cells.forEach((cell, j) => {
    const target = existing[i];
    if (cell.attr) { if ((attribute(target, cell.attr)?.value ?? '') !== row[j]) edits.push(...d.setAttribute(target, cell.attr, row[j])); }
    else if (cell.self) edits.push(...d.setText(target, row[j]));
    else edits.push(...d.setLeaf(target, [cell.child!], row[j] === '' && cell.optional ? undefined : row[j]));
  }));
  if (rows.length > existing.length) {
    const extra = rows.slice(existing.length).map(build);
    edits.push(...(container && existing.length ? d.insert(container, extra, { after: existing.at(-1) }) : create(extra)));
  }
  for (const row of existing.slice(rows.length)) edits.push(...d.remove(row));
  d.apply(edits);
}
function table(key: string, label: string, section: string, columns: Column[], cells: Cell[], rowTag: string, container: (c: Ctx) => XmlElement | undefined, create: (c: Ctx, rows: Build[]) => TextEdit[], when?: (c: Ctx) => boolean): Prop {
  return {
    key, label, type: 'table', section, columns, when,
    get: c => readRows(c.d, container(c), rowTag, cells),
    set: (c, rows: string[][]) => writeRows(c.d, container(c), rowTag, cells, rows, built => create(c, built))
  };
}

// A choice between alternative child structures, such as no/static/query-based available values.
function modeProp(key: string, label: string, section: string, wrapper: string, choices: Option[], current: (c: Ctx) => string, builds: Record<string, (c: Ctx) => Build>): Prop {
  return {
    key, label, type: 'select', section, get: current, options: () => choices,
    set(c, mode: string) {
      if (mode === current(c)) return;
      const existing = c.d.child(c.e, wrapper);
      if (mode === 'none') { if (existing) c.d.apply(c.d.remove(existing)); return; }
      const build = builds[mode]?.(c);
      if (!build) throw new Error('Unknown choice.');
      c.d.apply(existing ? c.d.replace(existing, build) : c.d.insert(c.e, [build]));
    }
  };
}
const firstDataSetWithField = (a: Analysis): [string, string] => {
  const field = a.declarations.find(d => d.collection === 'Fields');
  if (!field) throw new Error('Add a dataset with at least one field first.');
  return [field.dataSet!, field.name];
};
function parameterValuesProps(prefix: 'available' | 'default'): Prop[] {
  const wrapper = prefix === 'available' ? 'ValidValues' : 'DefaultValue';
  const section = prefix === 'available' ? 'Available values' : 'Default values';
  const mode = (c: Ctx) => c.d.at(c.e, wrapper, 'DataSetReference') ? 'query' : c.d.at(c.e, wrapper, prefix === 'available' ? 'ParameterValues' : 'Values') ? 'values' : 'none';
  const dataSet = (c: Ctx) => c.d.value(c.e, wrapper, 'DataSetReference', 'DataSetName') ?? '';
  const fields = (c: Ctx) => options(names(c.a, 'Fields', dataSet(c)));
  const reference = (c: Ctx): Build => { const [ds, field] = firstDataSetWithField(c.a); return { tag: wrapper, children: [{ tag: 'DataSetReference', children: [{ tag: 'DataSetName', text: ds }, { tag: 'ValueField', text: field }] }] }; };
  const isQuery = (c: Ctx) => mode(c) === 'query';
  const props: Prop[] = [
    modeProp(`${prefix}Mode`, prefix === 'available' ? 'Available values' : 'Default value', section, wrapper,
      [{ value: 'none', label: prefix === 'available' ? 'Any value' : 'No default' }, { value: 'values', label: 'Specify values' }, { value: 'query', label: 'Get values from a query' }], mode,
      prefix === 'available'
        ? { values: () => ({ tag: wrapper, children: [{ tag: 'ParameterValues', children: [{ tag: 'ParameterValue', children: [{ tag: 'Value', text: '' }] }] }] }), query: reference }
        : { values: () => ({ tag: wrapper, children: [{ tag: 'Values', children: [{ tag: 'Value', text: '' }] }] }), query: reference }),
    prefix === 'available'
      ? table('availableValues', 'Values', section, [{ label: 'Value', code: true }, { label: 'Label', placeholder: 'Same as value' }], [{ child: 'Value' }, { child: 'Label', optional: true }], 'ParameterValue', c => c.d.at(c.e, 'ValidValues', 'ParameterValues'), () => [], c => mode(c) === 'values')
      : table('defaultValues', 'Values', section, [{ label: 'Value', code: true, placeholder: 'Value or =expression' }], [{ self: true }], 'Value', c => c.d.at(c.e, 'DefaultValue', 'Values'), () => [], c => mode(c) === 'values'),
    {
      key: `${prefix}DataSet`, label: 'Dataset', type: 'select', section, when: isQuery, get: dataSet, options: c => options(names(c.a, 'DataSets')),
      set(c, value: string) {
        // Keep the value and label fields valid for the newly chosen dataset.
        const reference = c.d.at(c.e, wrapper, 'DataSetReference')!, fieldsOf = names(c.a, 'Fields', value);
        const edits = c.d.setLeaf(reference, ['DataSetName'], value);
        if (!fieldsOf.includes(c.d.value(reference, 'ValueField') ?? '')) edits.push(...c.d.setLeaf(reference, ['ValueField'], fieldsOf[0] ?? ''));
        const label = c.d.value(reference, 'LabelField');
        if (label !== undefined && !fieldsOf.includes(label)) edits.push(...c.d.setLeaf(reference, ['LabelField'], undefined));
        c.d.apply(edits);
      }
    },
    leaf(`${prefix}ValueField`, 'Value field', 'select', section, [wrapper, 'DataSetReference', 'ValueField'], { required: true, when: isQuery, options: fields })
  ];
  if (prefix === 'available') props.push(leaf('availableLabelField', 'Label field', 'select', section, ['ValidValues', 'DataSetReference', 'LabelField'], { when: isQuery, options: c => [{ value: '', label: 'Same as value' }, ...fields(c)] }));
  return props;
}

function parameterProps(): Prop[] {
  return [
    nameProp,
    leaf('dataType', 'Data type', 'select', 'General', ['DataType'], { required: true, options: options(['String', 'Integer', 'Float', 'Boolean', 'DateTime']) }),
    leaf('prompt', 'Prompt', 'text', 'General', ['Prompt'], { required: true }),
    checkbox('hidden', 'Hidden', 'General', ['Hidden']),
    checkbox('multiValue', 'Allow multiple values', 'General', ['MultiValue']),
    checkbox('nullable', 'Allow null value', 'General', ['Nullable']),
    checkbox('allowBlank', 'Allow blank value', 'General', ['AllowBlank'], { hint: c => c.d.value(c.e, 'DataType') === 'String' ? undefined : 'Only applies to String parameters.' }),
    ...parameterValuesProps('available'),
    ...parameterValuesProps('default')
  ];
}

function dataSourceProps(): Prop[] {
  const shared = (c: Ctx) => !!c.d.child(c.e, 'DataSourceReference');
  const embedded = (c: Ctx) => !shared(c);
  const connection = (): Build => ({ tag: 'ConnectionProperties', children: [{ tag: 'DataProvider', text: 'SQL' }, { tag: 'ConnectString', text: '' }] });
  return [
    nameProp,
    {
      key: 'sourceType', label: 'Connection', type: 'select', section: 'General', get: c => shared(c) ? 'shared' : 'embedded',
      options: () => [{ value: 'embedded', label: 'Embedded connection' }, { value: 'shared', label: 'Shared data source' }],
      set(c, value: string) {
        const reference = c.d.child(c.e, 'DataSourceReference'), properties = c.d.child(c.e, 'ConnectionProperties');
        if (value === 'shared' && !reference) c.d.apply(properties ? c.d.replace(properties, { tag: 'DataSourceReference', text: '' }) : c.d.insert(c.e, [{ tag: 'DataSourceReference', text: '' }]));
        else if (value === 'embedded' && !properties) c.d.apply(reference ? c.d.replace(reference, connection()) : c.d.insert(c.e, [connection()]));
      }
    },
    leaf('reference', 'Shared data source', 'text', 'General', ['DataSourceReference'], { required: true, when: shared, placeholder: '/Data Sources/Name or a relative path' }),
    leaf('provider', 'Data provider', 'select', 'Connection', ['ConnectionProperties', 'DataProvider'], { required: true, when: embedded, options: options(PROVIDERS) }),
    leaf('connectString', 'Connection string', 'code', 'Connection', ['ConnectionProperties', 'ConnectString'], {
      required: true, when: embedded, placeholder: 'Data Source=server;Initial Catalog=database',
      hint: c => /(password|pwd)\s*=/i.test(c.d.value(c.e, 'ConnectionProperties', 'ConnectString') ?? '') ? 'This connection string seems to contain a password. Prefer integrated security or credentials stored on the report server.' : undefined
    }),
    checkbox('integratedSecurity', 'Use Windows integrated security', 'Connection', ['ConnectionProperties', 'IntegratedSecurity'], { when: embedded })
  ];
}

function dataSetProps(): Prop[] {
  const shared = (c: Ctx) => !!c.d.child(c.e, 'SharedDataSet');
  const local = (c: Ctx) => !shared(c);
  const query = (c: Ctx) => c.d.child(c.e, 'SharedDataSet') ?? c.d.child(c.e, 'Query');
  return [
    nameProp,
    leaf('sharedReference', 'Shared dataset', 'text', 'Query', ['SharedDataSet', 'SharedDataSetReference'], { required: true, when: shared }),
    leaf('dataSource', 'Data source', 'select', 'Query', ['Query', 'DataSourceName'], { required: true, when: local, options: c => options(names(c.a, 'DataSources')) }),
    leaf('commandType', 'Command type', 'select', 'Query', ['Query', 'CommandType'], { when: local, fallback: 'Text', removeWhen: ['Text'], options: [{ value: 'Text', label: 'Text' }, { value: 'StoredProcedure', label: 'Stored procedure' }, { value: 'TableDirect', label: 'Table direct' }] }),
    leaf('commandText', 'Query', 'code', 'Query', ['Query', 'CommandText'], { required: true, when: local, placeholder: 'SELECT … or =expression' }),
    leaf('timeout', 'Timeout (seconds)', 'number', 'Query', ['Query', 'Timeout'], { when: local, validate: v => /^\d+$/.test(v) ? undefined : 'Enter a whole number of seconds.' }),
    table('queryParameters', 'Query parameters', 'Query', [{ label: 'Name', placeholder: '@Name' }, { label: 'Value', code: true, placeholder: '=Parameters!Name.Value' }], [{ attr: 'Name' }, { child: 'Value' }], 'QueryParameter',
      c => c.d.child(query(c), 'QueryParameters'), (c, rows) => { const base = query(c); if (!base) throw new Error('This dataset has no query.'); return c.d.insert(base, [{ tag: 'QueryParameters', children: rows }]); }),
    info('fieldCount', 'Fields', 'Fields', c => { const n = names(c.a, 'Fields', nameOf(c.e)).length; return `${n} field${n === 1 ? '' : 's'}. Select a field in the outline to edit it. The designer can't run the query, so list the columns it returns with Add fields.`; })
  ];
}

function fieldProps(): Prop[] {
  const calculated = (c: Ctx) => !c.d.child(c.e, 'DataField') && !!c.d.child(c.e, 'Value');
  return [
    nameProp,
    {
      key: 'source', label: 'Source', type: 'select', section: 'General', get: c => calculated(c) ? 'calculated' : 'database',
      options: () => [{ value: 'database', label: 'Query field' }, { value: 'calculated', label: 'Calculated field' }],
      set(c, value: string) {
        const field = c.d.child(c.e, 'DataField'), expression = c.d.child(c.e, 'Value');
        if (value === 'calculated' && !expression) c.d.apply(field ? c.d.replace(field, { tag: 'Value', text: '=' }) : c.d.insert(c.e, [{ tag: 'Value', text: '=' }]));
        else if (value === 'database' && !field) c.d.apply(expression ? c.d.replace(expression, { tag: 'DataField', text: nameOf(c.e) }) : c.d.insert(c.e, [{ tag: 'DataField', text: nameOf(c.e) }]));
      }
    },
    leaf('dataField', 'Query column', 'text', 'General', ['DataField'], { required: true, when: c => !calculated(c) }),
    leaf('value', 'Expression', 'code', 'General', ['Value'], { required: true, when: calculated, placeholder: '=Fields!Price.Value * Fields!Quantity.Value' })
  ];
}

function itemProps(c: Ctx): Prop[] {
  const e = c.e, props: Prop[] = [nameProp];
  const paragraphs = (c: Ctx) => c.d.children(c.d.child(c.e, 'Paragraphs'), 'Paragraph');
  const runs = (c: Ctx) => paragraphs(c).flatMap(p => c.d.children(c.d.child(p, 'TextRuns'), 'TextRun'));
  // Font settings apply to every text run (or paragraph) so mixed formatting can be made uniform.
  const styled = (key: string, label: string, type: FieldType, style: string, targets: (c: Ctx) => XmlElement[], o: { options?: string[]; fallback?: string; removeWhen?: string[]; validate?(v: string): string | undefined; placeholder?: string } = {}): Prop => ({
    key, label, type, section: 'Font', placeholder: o.placeholder, options: o.options && (() => options(o.options!)),
    when: c => targets(c).length > 0,
    get: c => c.d.value(targets(c)[0], 'Style', style) ?? o.fallback ?? '',
    hint: c => new Set(targets(c).map(t => c.d.value(t, 'Style', style) ?? o.fallback ?? '')).size > 1 ? 'The text runs use different values. A new value applies to all of them.' : undefined,
    set(c, raw: string) {
      const value = raw.trim(), error = value && !value.startsWith('=') ? o.validate?.(value) : undefined;
      if (error) throw new Error(error);
      const remove = value === '' || o.removeWhen?.includes(value);
      c.d.apply(targets(c).flatMap(t => c.d.setLeaf(t, ['Style', style], remove ? undefined : value)));
    }
  });
  if (e.name === 'Textbox') props.push(
    leaf('value', 'Value', 'code', 'Text', ['Paragraphs', 'Paragraph', 'TextRuns', 'TextRun', 'Value'], { required: true, when: c => runs(c).length <= 1, placeholder: 'Text or =expression' }),
    info('runs', 'Value', 'Text', c => `This text box has ${runs(c).length} text runs. Edit their values in the text editor.`, c => runs(c).length > 1),
    checkbox('canGrow', 'Can grow', 'Text', ['CanGrow']),
    checkbox('canShrink', 'Can shrink', 'Text', ['CanShrink']),
    styled('fontFamily', 'Font', 'text', 'FontFamily', runs, { placeholder: 'Arial' }),
    styled('fontSize', 'Size', 'text', 'FontSize', runs, { placeholder: '10pt', validate: sizeError }),
    styled('fontWeight', 'Weight', 'select', 'FontWeight', runs, { options: ['Normal', 'Thin', 'ExtraLight', 'Light', 'Medium', 'SemiBold', 'Bold', 'ExtraBold', 'Heavy'], fallback: 'Normal', removeWhen: ['Normal'] }),
    styled('fontStyle', 'Style', 'select', 'FontStyle', runs, { options: ['Normal', 'Italic'], fallback: 'Normal', removeWhen: ['Normal'] }),
    styled('color', 'Color', 'text', 'Color', runs, { placeholder: 'Black, #333333 or =expression' }),
    styled('format', 'Format', 'text', 'Format', runs, { placeholder: 'e.g. N2, C, d' }),
    styled('textAlign', 'Alignment', 'select', 'TextAlign', paragraphs, { options: ['General', 'Left', 'Center', 'Right'], fallback: 'General', removeWhen: ['General'] }),
    leaf('verticalAlign', 'Vertical alignment', 'select', 'Font', ['Style', 'VerticalAlign'], { options: options(['Top', 'Middle', 'Bottom']), fallback: 'Top', removeWhen: ['Top'] })
  );
  if (e.name === 'Image') {
    const source = (c: Ctx) => c.d.value(c.e, 'Source') ?? '';
    props.push(
      leaf('source', 'Source', 'select', 'Image', ['Source'], { required: true, options: [{ value: 'External', label: 'External (URL or path)' }, { value: 'Embedded', label: 'Embedded in the report' }, { value: 'Database', label: 'Database field' }] }),
      leaf('embeddedImage', 'Image', 'select', 'Image', ['Value'], { required: true, when: c => source(c) === 'Embedded', options: c => options(names(c.a, 'EmbeddedImages')) }),
      leaf('imageValue', 'Value', 'code', 'Image', ['Value'], { required: true, when: c => source(c) !== 'Embedded', placeholder: 'URL, path or =Fields!Photo.Value' }),
      leaf('mimeType', 'MIME type', 'text', 'Image', ['MIMEType'], { when: c => source(c) === 'Database', placeholder: 'image/png' }),
      leaf('sizing', 'Sizing', 'select', 'Image', ['Sizing'], { fallback: 'AutoSize', removeWhen: ['AutoSize'], options: [{ value: 'AutoSize', label: 'Auto size' }, { value: 'Fit', label: 'Fit' }, { value: 'FitProportional', label: 'Fit proportionally' }, { value: 'Clip', label: 'Clip' }] })
    );
  }
  if (e.name === 'Subreport') props.push(leaf('reportName', 'Report', 'text', 'General', ['ReportName'], { required: true, placeholder: 'Name or path of the deployed report' }));
  if (DATA_REGIONS.has(e.name) && (e.name === 'Tablix' || c.d.child(e, 'DataSetName'))) props.push(leaf('dataSetName', 'Dataset', 'select', 'Data', ['DataSetName'], { required: true, options: c => options(names(c.a, 'DataSets')) }));
  if (e.name === 'Tablix') props.push(leaf('noRowsMessage', 'No rows message', 'text', 'Data', ['NoRowsMessage']));
  if (e.name === 'Tablix' || e.name === 'Rectangle') props.push(leaf('pageBreak', 'Page break', 'select', 'General', ['PageBreak', 'BreakLocation'], { fallback: 'None', removeWhen: ['None'], options: [{ value: 'None', label: 'None' }, { value: 'Start', label: 'Before' }, { value: 'End', label: 'After' }, { value: 'StartAndEnd', label: 'Before and after' }, { value: 'Between', label: 'Between each instance' }] }));
  if (e.parent?.name === 'ReportItems') props.push(
    size('top', 'Top', 'Position', ['Top'], { placeholder: '0in' }), size('left', 'Left', 'Position', ['Left'], { placeholder: '0in' }),
    size('width', 'Width', 'Position', ['Width']), size('height', 'Height', 'Position', ['Height'])
  );
  props.push(leaf('hidden', 'Hidden', 'code', 'Visibility', ['Visibility', 'Hidden'], { removeWhen: ['false', 'False'], placeholder: 'false, true or =expression' }));
  if (e.name !== 'Line') props.push(
    leaf('toolTip', 'Tooltip', 'text', 'Visibility', ['ToolTip']),
    leaf('backgroundColor', 'Background color', 'text', 'Visibility', ['Style', 'BackgroundColor'], { placeholder: 'White, #F5F5F5 or =expression' })
  );
  return props;
}

function pageProps(base: (c: Ctx) => XmlElement): Prop[] {
  const page = (key: string, label: string, name: string, placeholder: string) => size(key, label, 'Page', ['Page', name], { base, placeholder });
  return [
    size('width', 'Report width', 'Page', ['Width'], { base, required: true }),
    page('pageWidth', 'Page width', 'PageWidth', '8.5in'), page('pageHeight', 'Page height', 'PageHeight', '11in'),
    page('leftMargin', 'Left margin', 'LeftMargin', '0in'), page('rightMargin', 'Right margin', 'RightMargin', '0in'),
    page('topMargin', 'Top margin', 'TopMargin', '0in'), page('bottomMargin', 'Bottom margin', 'BottomMargin', '0in')
  ];
}

function propsFor(c: Ctx): Prop[] {
  const { e, a } = c;
  if (e === a.root) return [
    leaf('description', 'Description', 'multiline', 'General', ['Description']),
    leaf('author', 'Author', 'text', 'General', ['Author']),
    leaf('language', 'Language', 'text', 'General', ['Language'], { placeholder: 'en-US or =User!Language' }),
    leaf('autoRefresh', 'Auto refresh (seconds)', 'number', 'General', ['AutoRefresh'], { validate: v => /^\d+$/.test(v) ? undefined : 'Enter a whole number of seconds.' }),
    ...(sections(c.d).length === 1 ? pageProps(c => sections(c.d)[0]) : [])
  ];
  switch (e.name) {
    case 'ReportSection': return pageProps(c => c.e);
    case 'Body': return [size('height', 'Height', 'Size', ['Height'], { required: true })];
    case 'PageHeader': case 'PageFooter': return [size('height', 'Height', 'Size', ['Height'], { required: true }), checkbox('printOnFirstPage', 'Print on first page', 'Size', ['PrintOnFirstPage']), checkbox('printOnLastPage', 'Print on last page', 'Size', ['PrintOnLastPage'])];
    case 'ReportParameter': return parameterProps();
    case 'DataSource': return dataSourceProps();
    case 'DataSet': return dataSetProps();
    case 'Field': return fieldProps();
    case 'Variable': return [nameProp, leaf('value', 'Value', 'code', 'General', ['Value'], { required: true })];
    case 'EmbeddedImage': return [nameProp, info('mimeType', 'Type', 'General', c => c.d.value(c.e, 'MIMEType') ?? ''), {
      key: 'preview', label: 'Preview', type: 'image', section: 'General',
      get: c => { const data = c.d.value(c.e, 'ImageData') ?? '', mime = c.d.value(c.e, 'MIMEType') ?? ''; return IMAGE_TYPES.includes(mime) && data.length < 4_000_000 ? `data:${mime};base64,${data.replace(/\s+/g, '')}` : ''; }
    }];
  }
  return isItem(e) ? itemProps(c) : [];
}

function actionsFor(c: Ctx): ActionSpec[] {
  const { d, e, a } = c, root = a.root!;
  const pageAdds = (base: XmlElement): ActionSpec[] => [
    ...(d.at(base, 'Page', 'PageHeader') ? [] : [{ id: 'addPageHeader', label: 'Add page header' }]),
    ...(d.at(base, 'Page', 'PageFooter') ? [] : [{ id: 'addPageFooter', label: 'Add page footer' }])
  ];
  if (e === root) return [ADD_PARAMETER, ADD_DATA_SOURCE, ADD_DATA_SET, ...(sections(d).length === 1 ? pageAdds(sections(d)[0]) : [])];
  if (e.parent === root && CONTAINERS[e.name]) return CONTAINERS[e.name].actions;
  switch (e.name) {
    case 'ReportSection': return pageAdds(e);
    case 'ReportParameter': {
      const siblings = d.children(e.parent, 'ReportParameter'), i = siblings.indexOf(e);
      return [{ id: 'moveUp', label: 'Move up', disabled: i <= 0 }, { id: 'moveDown', label: 'Move down', disabled: i >= siblings.length - 1 }, DELETE];
    }
    case 'DataSet': return [{ id: 'addField', label: 'Add field' }, { id: 'addFields', label: 'Add fields…', input: 'fieldNames' }, DELETE];
    case 'DataSource': case 'Field': case 'EmbeddedImage': case 'Variable': return [DELETE];
    case 'Body': return [{ id: 'addTextbox', label: 'Add text box' }];
    case 'PageHeader': case 'PageFooter': return [{ id: 'addTextbox', label: 'Add text box' }, DELETE];
  }
  if (!isItem(e)) return [];
  return [...(e.name === 'Rectangle' ? [{ id: 'addTextbox', label: 'Add text box' }] : []), ...(e.parent?.name === 'ReportItems' ? [DELETE] : [])];
}

function usage(a: Analysis, e: XmlElement): number {
  const declaration = a.declarations.find(d => d.element === e);
  if (!declaration) return 0;
  return a.references.filter(r => resolve(a, r).includes(declaration)).length + (['DataSets', 'Groups', 'ReportItems'].includes(declaration.collection) ? a.scopes.filter(s => s.name === declaration.name).length : 0);
}

export function designerTree(a: Analysis): TreeNode[] {
  const root = a.root;
  if (!root || root.name !== 'Report') return [];
  const rootPath = pathOf(root);
  const node = (item: OutlineItem): TreeNode => ({ path: pathOf(item.element), name: item.name, kind: item.kind, detail: item.detail, start: item.start, end: item.end, selectionStart: item.selectionStart, selectionEnd: item.selectionEnd, children: item.children.map(node) });
  const groups = new Map(a.outline.filter(i => i.kind === 'group').map(i => [i.element.name, node(i)]));
  const virtual = (name: string): TreeNode => ({ path: `${rootPath}/${name}`, name: CONTAINERS[name].label, kind: 'group', detail: '', start: -1, end: -1, selectionStart: -1, selectionEnd: -1, children: [], virtual: true });
  const children = [
    ...['DataSources', 'DataSets', 'ReportParameters', 'Variables', 'EmbeddedImages'].flatMap(name => groups.get(name) ?? (name === 'Variables' ? [] : [virtual(name)])),
    ...a.outline.filter(i => i.kind !== 'group').map(node)
  ];
  return [{ path: rootPath, name: 'Report', kind: 'report', detail: schemaVersion(root) ? `RDL ${schemaVersion(root)}` : '', start: root.start, end: root.end, selectionStart: root.start, selectionEnd: root.openEnd, children }];
}
/** The deepest tree node whose element contains the offset. */
export function nodeAt(nodes: TreeNode[], offset: number): TreeNode | undefined {
  for (const n of nodes) if (n.start <= offset && offset < n.end) return nodeAt(n.children, offset) ?? n;
  return undefined;
}

/** A top-level list that doesn't exist yet, shown so items can be added to it. */
const virtualContainer = (root: XmlElement, path: string) => { const name = path.slice(path.lastIndexOf('/') + 1); return path === `${pathOf(root)}/${name}` ? CONTAINERS[name] : undefined; };
export function describe(a: Analysis, path: string): Details | undefined {
  const root = a.root;
  if (!root) return undefined;
  const d = new Draft(a.xml, root), e = d.find(path);
  if (!e) {
    const container = virtualContainer(root, path);
    return container && { path, kind: 'group', title: container.label, subtitle: container.empty, fields: [], actions: container.actions, usage: 0 };
  }
  const c: Ctx = { d, e, a };
  const fields = propsFor(c).filter(p => !p.when || p.when(c)).map((p): FieldSpec => {
    const value = p.get(c);
    // Expressions can't be shown as a checkbox or list choice.
    const expression = typeof value === 'string' && value.startsWith('=') && (p.type === 'checkbox' || p.type === 'select');
    let choices = p.options?.(c);
    if (choices && typeof value === 'string' && value && !choices.some(o => o.value === value)) choices = [...choices, { value, label: value }];
    return { key: p.key, label: p.label, type: expression ? 'code' : p.type, value, section: p.section, options: expression ? undefined : choices, columns: p.columns, hint: p.hint?.(c), placeholder: p.placeholder, readOnly: !p.set };
  });
  const count = usage(a, e);
  const kind = e === root ? 'Report' : CONTAINERS[e.name] && e.parent === root ? 'Group' : KIND_LABELS[e.name] || e.name;
  const title = e === root ? 'Report' : CONTAINERS[e.name] && e.parent === root ? CONTAINERS[e.name].label : nameOf(e) || KIND_LABELS[e.name] || e.name;
  const subtitle = e === root ? (schemaVersion(root) ? `RDL ${schemaVersion(root)}` : 'RDL report') : [kind, count ? `${count} reference${count === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · ');
  const fallback: FieldSpec = { key: 'none', label: 'Properties', type: 'info', value: 'Edit this item in the text editor.', section: 'General', readOnly: true };
  return { path, kind: e === root ? 'report' : e.name, title, subtitle, fields: fields.length ? fields : [fallback], actions: actionsFor(c), usage: count };
}

export function applyField(a: Analysis, path: string, key: string, value: unknown): Change {
  const d = new Draft(a.xml, a.root), e = d.get(path), c: Ctx = { d, e, a };
  const prop = propsFor(c).find(p => p.key === key && (!p.when || p.when(c)));
  if (!prop?.set) throw new Error('This property can\'t be edited here.');
  const valid = prop.type === 'table'
    ? Array.isArray(value) && value.length <= 1000 && value.every(row => Array.isArray(row) && row.length === prop.columns!.length && row.every(cell => typeof cell === 'string' && cell.length <= 100_000))
    : typeof value === 'string' && value.length <= 1_000_000;
  if (!valid) throw new Error('The value has an unexpected shape.');
  const result = prop.set(c, value) || {};
  return { edits: d.edits(), select: result.select ?? path, message: result.message };
}

/** Builds for new report objects. */
const textbox = (name: string): Build => ({ tag: 'Textbox', attrs: { Name: name }, children: [
  { tag: 'CanGrow', text: 'true' }, { tag: 'KeepTogether', text: 'true' },
  { tag: 'Paragraphs', children: [{ tag: 'Paragraph', children: [{ tag: 'TextRuns', children: [{ tag: 'TextRun', children: [{ tag: 'Value', text: '' }, { tag: 'Style' }] }] }, { tag: 'Style' }] }] },
  { tag: 'Top', text: '0in' }, { tag: 'Left', text: '0in' }, { tag: 'Height', text: '0.25in' }, { tag: 'Width', text: '1in' }, { tag: 'Style' }
] });
function fieldName(column: string, taken: string[]): string {
  let base = column.replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  if (!/^[A-Za-z]/.test(base)) base = `Field_${base}`;
  if (!taken.includes(base)) return base;
  return unique(taken, `${base}_`);
}

export function applyAction(a: Analysis, path: string, id: string, input?: unknown): Change {
  const d = new Draft(a.xml, a.root), root = d.root!, rootPath = pathOf(root);
  const done = (select: string, message?: string): Change => ({ edits: d.edits(), select, message });
  const addToList = (list: string, build: Build): Change => {
    const container = d.child(root, list);
    d.apply(container ? d.insert(container, [build]) : d.insert(root, [{ tag: list, children: [build] }]));
    return done(childPath(`${rootPath}/${list}`, build.tag, build.attrs!.Name));
  };
  switch (id) {
    case 'addParameter': {
      const name = unique(names(a, 'Parameters'), 'Parameter');
      const build: Build = { tag: 'ReportParameter', attrs: { Name: name }, children: [{ tag: 'DataType', text: 'String' }, { tag: 'Prompt', text: name }] };
      const list = d.child(root, 'ReportParameters');
      d.apply([...(list ? d.insert(list, [build]) : d.insert(root, [{ tag: 'ReportParameters', children: [build] }])), ...layoutCell(d, name)]);
      return done(childPath(`${rootPath}/ReportParameters`, 'ReportParameter', name));
    }
    case 'addDataSource': return addToList('DataSources', { tag: 'DataSource', attrs: { Name: unique(names(a, 'DataSources'), 'DataSource') }, children: [{ tag: 'ConnectionProperties', children: [{ tag: 'DataProvider', text: 'SQL' }, { tag: 'ConnectString', text: '' }] }] });
    case 'addSharedDataSource': return addToList('DataSources', { tag: 'DataSource', attrs: { Name: unique(names(a, 'DataSources'), 'DataSource') }, children: [{ tag: 'DataSourceReference', text: '' }] });
    case 'addDataSet': return addToList('DataSets', { tag: 'DataSet', attrs: { Name: unique(names(a, 'DataSets'), 'DataSet') }, children: [{ tag: 'Query', children: [{ tag: 'DataSourceName', text: names(a, 'DataSources')[0] ?? '' }, { tag: 'CommandText', text: '' }] }] });
    case 'addImage': {
      const image = input as ImageInput;
      if (!image || typeof image.name !== 'string' || typeof image.data !== 'string' || !IMAGE_TYPES.includes(image.mimeType) || !/^[A-Za-z0-9+/=]*$/.test(image.data)) throw new Error('Choose a PNG, JPEG, GIF or BMP image.');
      const taken = names(a, 'EmbeddedImages');
      return addToList('EmbeddedImages', { tag: 'EmbeddedImage', attrs: { Name: fieldName(image.name, taken) }, children: [{ tag: 'MIMEType', text: image.mimeType }, { tag: 'ImageData', text: image.data }] });
    }
    case 'addField': case 'addFields': {
      const dataSet = d.get(path), dataSetName = nameOf(dataSet), taken = names(a, 'Fields', dataSetName);
      const existing = new Set(d.children(d.child(dataSet, 'Fields'), 'Field').map(f => d.value(f, 'DataField')));
      if (id === 'addFields' && (typeof input !== 'string' || input.length > 100_000)) throw new Error('Enter column names separated by commas.');
      const columns = id === 'addField' ? [unique(taken, 'Field')] : [...new Set((input as string).split(/[,;\t\r\n]+/).map(s => s.trim()).filter(s => s && !existing.has(s)))];
      if (!columns.length) return done(path, 'Those columns already have fields.');
      const builds = columns.map(column => { const name = fieldName(column, taken); taken.push(name); return { tag: 'Field', attrs: { Name: name }, children: [{ tag: 'DataField', text: column }] }; });
      const fields = d.child(dataSet, 'Fields');
      d.apply(fields ? d.insert(fields, builds) : d.insert(dataSet, [{ tag: 'Fields', children: builds }]));
      return builds.length === 1 ? done(childPath(`${path}/Fields`, 'Field', builds[0].attrs.Name)) : done(path, `Added ${builds.length} fields.`);
    }
    case 'addTextbox': {
      const area = d.get(path), name = unique(names(a, 'ReportItems'), 'Textbox'), list = d.child(area, 'ReportItems');
      d.apply(list ? d.insert(list, [textbox(name)]) : d.insert(area, [{ tag: 'ReportItems', children: [textbox(name)] }]));
      return done(childPath(`${path}/ReportItems`, 'Textbox', name));
    }
    case 'addPageHeader': case 'addPageFooter': {
      const base = path === rootPath && sections(d).length === 1 ? sections(d)[0] : d.get(path), tag = id === 'addPageHeader' ? 'PageHeader' : 'PageFooter';
      const build: Build = { tag, children: [{ tag: 'Height', text: '0.5in' }, { tag: 'PrintOnFirstPage', text: 'true' }, { tag: 'PrintOnLastPage', text: 'true' }] };
      const page = d.child(base, 'Page');
      d.apply(page ? d.insert(page, [build]) : d.insert(base, [{ tag: 'Page', children: [build] }]));
      return done(`${pathOf(base)}/Page/${tag}`);
    }
    case 'moveUp': case 'moveDown': {
      const e = d.get(path), siblings = d.children(e.parent, 'ReportParameter'), i = siblings.indexOf(e), other = siblings[id === 'moveUp' ? i - 1 : i + 1];
      if (e.name !== 'ReportParameter' || !other) return done(path);
      const source = (x: XmlElement) => d.xml.slice(x.start, x.end);
      const edits: TextEdit[] = [{ start: e.start, end: e.end, text: source(other) }, { start: other.start, end: other.end, text: source(e) }];
      // Keep the prompt area in the new order by swapping the two parameters' layout cells.
      const cellName = (name: string) => cells(d).map(cell => d.child(cell, 'ParameterName')).find(p => p && d.text(p).trim() === name);
      const mine = cellName(nameOf(e)), theirs = cellName(nameOf(other));
      if (mine && theirs) edits.push(...d.setText(mine, nameOf(other)), ...d.setText(theirs, nameOf(e)));
      d.apply(edits);
      return done(path);
    }
    case 'delete': {
      const e = d.get(path);
      if (!actionsFor({ d, e, a }).some(x => x.id === 'delete')) throw new Error('This item can\'t be deleted here.');
      const ancestors: string[] = [];
      for (let x = e.parent; x; x = x.parent) ancestors.push(pathOf(x));
      const edits = d.remove(e);
      if (e.name === 'ReportParameter') {
        const layout = d.child(root, 'ReportParametersLayout');
        const cell = cells(d).find(cell => d.value(cell, 'ParameterName')?.trim() === nameOf(e));
        if (layout && d.children(d.child(root, 'ReportParameters'), 'ReportParameter').length === 1) edits.push(...d.remove(layout));
        else if (cell) edits.push(...d.remove(cell));
      }
      d.apply(edits);
      return done(ancestors.find(p => d.find(p) || virtualContainer(root, p)) ?? rootPath);
    }
  }
  throw new Error('Unknown action.');
}
const cells = (d: Draft): XmlElement[] => d.children(d.at(d.root, 'ReportParametersLayout', 'GridLayoutDefinition', 'CellDefinitions'), 'CellDefinition');
/** Edits giving a new parameter the first free cell of an RDL 2016 parameter layout, growing the grid if it's full. */
function layoutCell(d: Draft, name: string): TextEdit[] {
  const grid = d.at(d.root, 'ReportParametersLayout', 'GridLayoutDefinition');
  if (!grid) return [];
  const columns = Math.max(1, Number(d.value(grid, 'NumberOfColumns')) || 1), rows = Math.max(0, Number(d.value(grid, 'NumberOfRows')) || 0);
  const used = new Set(cells(d).map(cell => `${Number(d.value(cell, 'RowIndex') || 0)},${Number(d.value(cell, 'ColumnIndex') || 0)}`));
  let row = rows, column = 0;
  search: for (let r = 0; r < rows; r++) for (let col = 0; col < columns; col++) if (!used.has(`${r},${col}`)) { row = r; column = col; break search; }
  const cell: Build = { tag: 'CellDefinition', children: [{ tag: 'ColumnIndex', text: String(column) }, { tag: 'RowIndex', text: String(row) }, { tag: 'ParameterName', text: name }] };
  const list = d.child(grid, 'CellDefinitions');
  return [...(list ? d.insert(list, [cell]) : d.insert(grid, [{ tag: 'CellDefinitions', children: [cell] }])), ...(row >= rows ? d.setLeaf(grid, ['NumberOfRows'], String(row + 1)) : [])];
}

/** A scaled outline of the body, header or footer containing the selection. */
export function wireframe(a: Analysis, path: string): Wireframe | undefined {
  const root = a.root;
  if (!root || root.name !== 'Report') return undefined;
  const d = new Draft(a.xml, root), selected = d.find(path);
  let area: XmlElement | undefined;
  for (let x = selected; x && !area; x = x.parent) if (AREAS.has(x.name) && prefixOf(x) === prefixOf(root)) area = x;
  // Only for the report, a section, or something on the page.
  if (!area && selected && selected !== root && selected.name !== 'ReportSection') return undefined;
  area ??= d.child(selected?.name === 'ReportSection' ? selected : sections(d)[0], 'Body');
  if (!area) return undefined;
  const section = area.name === 'Body' ? area.parent : area.parent?.parent;
  const items: WireItem[] = [];
  const walk = (list: XmlElement | undefined, x0: number, y0: number, depth: number) => {
    for (const item of list?.children.filter(c => prefixOf(c) === prefixOf(root) && attribute(c, 'Name')) || []) {
      const round = (n: number) => Math.round(n * 1e4) / 1e4;
      const x = round(x0 + (inches(d.value(item, 'Left')) ?? 0)), y = round(y0 + (inches(d.value(item, 'Top')) ?? 0));
      items.push({ path: pathOf(item), name: nameOf(item), kind: item.name, x, y, width: inches(d.value(item, 'Width')) ?? 0, height: inches(d.value(item, 'Height')) ?? 0, depth });
      if (item.name === 'Rectangle') walk(d.child(item, 'ReportItems'), x, y, depth + 1);
    }
  };
  walk(d.child(area, 'ReportItems'), 0, 0, 0);
  const width = items.reduce((max, i) => Math.max(max, i.x + i.width), inches(d.value(section, 'Width')) ?? 0);
  const height = items.reduce((max, i) => Math.max(max, i.y + i.height), inches(d.value(area, 'Height')) ?? 0);
  return { title: KIND_LABELS[area.name], path: pathOf(area), width, height, items };
}
