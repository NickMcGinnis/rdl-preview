import { parseElements, prefixOf, resolvePath, textOf, type XmlElement } from './rdl-model';

export interface TextEdit { start: number; end: number; text: string }
/** An element to insert. Tags without a prefix get the parent's namespace prefix. */
export interface Build { tag: string; attrs?: Record<string, string>; text?: string; children?: Build[] }

export const escapeText = (value: string): string => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
export const escapeAttribute = (value: string): string => escapeText(value).replace(/"/g, '&quot;');

// The order Report Builder writes children in. RDL content models are unordered choices,
// so this only decides where a new element looks natural.
const ORDER: Record<string, string[]> = {
  Report: ['Description', 'Author', 'AutoRefresh', 'DataSources', 'DataSets', 'ReportSections', 'Body', 'Width', 'Page', 'ReportParameters', 'ReportParametersLayout', 'Code', 'EmbeddedImages', 'Language', 'ConsumeContainerWhitespace'],
  ReportSection: ['Body', 'Width', 'Page'],
  Page: ['PageHeader', 'PageFooter', 'PageHeight', 'PageWidth', 'InteractiveHeight', 'InteractiveWidth', 'LeftMargin', 'RightMargin', 'TopMargin', 'BottomMargin', 'Columns', 'ColumnSpacing', 'Style'],
  Body: ['ReportItems', 'Height', 'Style'],
  PageHeader: ['Height', 'PrintOnFirstPage', 'PrintOnLastPage', 'ReportItems', 'Style'],
  PageFooter: ['Height', 'PrintOnFirstPage', 'PrintOnLastPage', 'ReportItems', 'Style'],
  ReportParameter: ['DataType', 'Nullable', 'DefaultValue', 'AllowBlank', 'Prompt', 'ValidValues', 'Hidden', 'MultiValue', 'UsedInQuery'],
  DataSetReference: ['DataSetName', 'ValueField', 'LabelField'],
  ParameterValue: ['Value', 'Label'],
  DataSource: ['DataSourceReference', 'ConnectionProperties'],
  ConnectionProperties: ['DataProvider', 'ConnectString', 'IntegratedSecurity', 'Prompt'],
  DataSet: ['Query', 'SharedDataSet', 'Fields', 'Filters'],
  Query: ['DataSourceName', 'QueryParameters', 'CommandType', 'CommandText', 'Timeout'],
  SharedDataSet: ['SharedDataSetReference', 'QueryParameters'],
  Field: ['DataField', 'Value'],
  Textbox: ['CanGrow', 'CanShrink', 'KeepTogether', 'Paragraphs', 'Top', 'Left', 'Height', 'Width', 'ZIndex', 'Visibility', 'ToolTip', 'DataElementOutput', 'Style'],
  Rectangle: ['ReportItems', 'PageBreak', 'KeepTogether', 'Top', 'Left', 'Height', 'Width', 'ZIndex', 'Visibility', 'ToolTip', 'Style'],
  Tablix: ['TablixCorner', 'TablixBody', 'TablixColumnHierarchy', 'TablixRowHierarchy', 'NoRowsMessage', 'PageBreak', 'DataSetName', 'Top', 'Left', 'Height', 'Width', 'ZIndex', 'Visibility', 'ToolTip', 'Style'],
  Image: ['Source', 'Value', 'MIMEType', 'Sizing', 'Top', 'Left', 'Height', 'Width', 'ZIndex', 'Visibility', 'ToolTip', 'Style'],
  Subreport: ['ReportName', 'Parameters', 'Top', 'Left', 'Height', 'Width', 'ZIndex', 'Visibility', 'ToolTip', 'Style'],
  Line: ['Top', 'Left', 'Height', 'Width', 'ZIndex', 'Visibility', 'Style'],
  Style: ['Border', 'TopBorder', 'BottomBorder', 'LeftBorder', 'RightBorder', 'BackgroundColor', 'FontStyle', 'FontFamily', 'FontSize', 'FontWeight', 'Format', 'TextDecoration', 'TextAlign', 'VerticalAlign', 'Color', 'PaddingLeft', 'PaddingRight', 'PaddingTop', 'PaddingBottom'],
  EmbeddedImage: ['MIMEType', 'ImageData'],
  GridLayoutDefinition: ['NumberOfColumns', 'NumberOfRows', 'CellDefinitions'],
  CellDefinition: ['ColumnIndex', 'RowIndex', 'ParameterName']
};
// Containers that are invalid or meaningless once empty, so removing their last child removes them too.
const REMOVE_WHEN_EMPTY = new Set(['DataSources', 'DataSets', 'ReportParameters', 'Fields', 'EmbeddedImages', 'QueryParameters', 'Variables', 'ParameterValues', 'Values', 'DefaultValue', 'ValidValues', 'ReportItems', 'Visibility', 'PageBreak']);

/**
 * A working copy of the report. Edit builders return non-overlapping edits against the current
 * text; `apply` commits a batch and re-parses, so look elements up again (by path) after applying.
 */
export class Draft {
  readonly original: string;
  xml: string;
  root?: XmlElement;
  private batches: TextEdit[][] = [];
  private readonly newline: string;
  private readonly unit: string;
  /** Pass the root from an existing parse of the same text to share its elements. */
  constructor(xml: string, root: XmlElement | undefined = parseElements(xml)[0]) {
    this.original = this.xml = xml;
    this.root = root;
    this.newline = xml.includes('\r\n') ? '\r\n' : '\n';
    // Indent unit: tabs, or the smallest space indentation used before a tag.
    let tabs = false, spaces = 0;
    for (const m of xml.matchAll(/\n([ \t]+)</g)) { if (m[1].startsWith('\t')) tabs = true; else spaces = spaces ? Math.min(spaces, m[1].length) : m[1].length; }
    this.unit = tabs ? '\t' : ' '.repeat(spaces || 2);
  }
  get(path: string): XmlElement {
    const e = resolvePath(this.root, path);
    if (!e) throw new Error('That item is no longer in the report. It may have been changed in the text editor.');
    return e;
  }
  find(path: string): XmlElement | undefined { return resolvePath(this.root, path); }
  child(e: XmlElement | undefined, name: string): XmlElement | undefined { return e?.children.find(c => c.name === name && prefixOf(c) === prefixOf(e)); }
  children(e: XmlElement | undefined, name: string): XmlElement[] { return e?.children.filter(c => c.name === name && prefixOf(c) === prefixOf(e)) || []; }
  text(e: XmlElement | undefined): string { return e && !e.children.length && !e.selfClosing ? textOf(this.xml, e).text : ''; }
  /** Text of a descendant reached through child names, or undefined if any step is missing. */
  at(e: XmlElement | undefined, ...names: string[]): XmlElement | undefined {
    for (const name of names) e = this.child(e, name);
    return e;
  }
  value(e: XmlElement | undefined, ...names: string[]): string | undefined { const target = this.at(e, ...names); return target && this.text(target); }

  apply(edits: TextEdit[]): void {
    if (!edits.length) return;
    const sorted = [...edits].sort((a, b) => b.start - a.start || b.end - a.end);
    for (let i = 1; i < sorted.length; i++) if (sorted[i].end > sorted[i - 1].start) throw new Error('Internal error: overlapping edits.');
    let xml = this.xml;
    for (const e of sorted) xml = xml.slice(0, e.start) + e.text + xml.slice(e.end);
    this.batches.push(edits); this.xml = xml; this.root = parseElements(xml)[0];
  }
  /** Edits that turn the original text into the current text. */
  edits(): TextEdit[] {
    if (this.batches.length <= 1) return this.batches[0] || [];
    const a = this.original, b = this.xml;
    let start = 0;
    while (start < a.length && start < b.length && a[start] === b[start]) start++;
    if (start > 0 && a[start - 1] === '\r') start--;
    let tail = 0;
    while (tail < a.length - start && tail < b.length - start && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
    if (tail > 0 && a[a.length - tail] === '\n' && a[a.length - tail - 1] === '\r' && a.length - tail - 1 >= start) tail--;
    return a === b ? [] : [{ start, end: a.length - tail, text: b.slice(start, b.length - tail) }];
  }

  private indentAt(offset: number): string | undefined {
    const lineStart = this.xml.lastIndexOf('\n', offset - 1) + 1;
    const before = this.xml.slice(lineStart, offset);
    return /^[ \t]*$/.test(before) ? before : undefined;
  }
  private childIndent(parent: XmlElement): string | undefined {
    if (parent.children.length) return this.indentAt(parent.children[0].start);
    const own = this.indentAt(parent.start), first = this.root?.children[0];
    return own !== undefined && first && this.indentAt(first.start) !== undefined ? own + this.unit : undefined;
  }
  /** Whether siblings put their own children on separate lines; new elements copy that style. */
  private nested(parent: XmlElement | undefined): boolean {
    const sample = parent?.children.find(c => c.children.length);
    return sample ? this.indentAt(sample.children[0].start) !== undefined : true;
  }
  render(build: Build, indent: string | undefined, prefix: string): string {
    const tag = build.tag.includes(':') ? build.tag : prefix + build.tag;
    const attrs = Object.entries(build.attrs || {}).map(([k, v]) => ` ${k}="${escapeAttribute(v)}"`).join('');
    if (build.children?.length) {
      const inner = indent === undefined
        ? build.children.map(c => this.render(c, undefined, prefix)).join('')
        : build.children.map(c => this.newline + indent + this.unit + this.render(c, indent + this.unit, prefix)).join('') + this.newline + indent;
      return `<${tag}${attrs}>${inner}</${tag}>`;
    }
    return build.text ? `<${tag}${attrs}>${escapeText(build.text)}</${tag}>` : `<${tag}${attrs} />`;
  }
  private prefix(e: XmlElement): string { return e.tag.includes(':') ? e.tag.slice(0, e.tag.indexOf(':') + 1) : ''; }
  private position(parent: XmlElement, name: string): { after?: XmlElement; before?: XmlElement } {
    const order = ORDER[parent.name] || [], rank = order.indexOf(name);
    const own = parent.children.filter(c => prefixOf(c) === prefixOf(parent));
    if (rank >= 0) {
      const after = own.filter(c => { const r = order.indexOf(c.name); return r >= 0 && r <= rank; }).at(-1);
      if (after) return { after };
      const before = own.find(c => order.indexOf(c.name) > rank);
      if (before) return { before };
    }
    const last = own.at(-1) || parent.children.at(-1);
    return last ? { after: last } : {};
  }

  insert(parent: XmlElement, items: Build[], at?: { after?: XmlElement; before?: XmlElement }): TextEdit[] {
    const { after, before } = at || this.position(parent, items[0].tag);
    const indent = this.childIndent(parent), prefix = this.prefix(parent);
    const rendered = items.map(b => this.render(b, this.nested(parent) ? indent : undefined, prefix));
    const separator = indent === undefined ? '' : this.newline + indent;
    if (after) return [{ start: after.end, end: after.end, text: rendered.map(t => separator + t).join('') }];
    if (before) return [{ start: before.start, end: before.start, text: rendered.map(t => t + separator).join('') }];
    const inner = indent === undefined ? rendered.join('') : rendered.map(t => separator + t).join('') + this.newline + (this.indentAt(parent.start) ?? '');
    if (parent.selfClosing) return [{ start: parent.start, end: parent.end, text: `<${parent.tag}${parent.attrs.replace(/\s+$/, '')}>${inner}</${parent.tag}>` }];
    const whitespace = /^\s*$/.test(this.xml.slice(parent.openEnd, parent.closeStart));
    return [{ start: whitespace ? parent.openEnd : parent.closeStart, end: parent.closeStart, text: inner }];
  }
  /** Replaces an element in place, keeping its indentation. */
  replace(e: XmlElement, build: Build): TextEdit[] {
    const indent = this.nested(e.parent) ? this.indentAt(e.start) ?? (e.parent && this.childIndent(e.parent)) : undefined;
    return [{ start: e.start, end: e.end, text: this.render(build, indent, e.parent ? this.prefix(e.parent) : '') }];
  }
  remove(e: XmlElement): TextEdit[] {
    let target = e;
    while (target.parent && REMOVE_WHEN_EMPTY.has(target.parent.name) && target.parent.children.length === 1) target = target.parent;
    let start = target.start, end = target.end;
    const indent = this.indentAt(start), rest = /^[ \t]*\r?\n/.exec(this.xml.slice(end, end + 200));
    // Remove the whole line when the element is alone on it.
    if (indent !== undefined && rest) { start -= indent.length; end += rest[0].length; }
    return [{ start, end, text: '' }];
  }
  setText(e: XmlElement, value: string): TextEdit[] {
    // A new value replaces xsi:nil.
    const attrs = e.attrs.replace(/\s+[\w.-]+:nil\s*=\s*(["'])[^"']*\1/, '').replace(/\s+$/, '');
    const nil = attrs !== e.attrs.replace(/\s+$/, '');
    if (!nil && !e.children.length && this.text(e) === value) return [];
    if (e.selfClosing || nil) return [{ start: e.start, end: e.end, text: `<${e.tag}${attrs}>${escapeText(value)}</${e.tag}>` }];
    return [{ start: e.openEnd, end: e.closeStart, text: escapeText(value) }];
  }
  setAttribute(e: XmlElement, name: string, value: string): TextEdit[] {
    const m = new RegExp(`(^|\\s)${name}\\s*=\\s*(["'])([\\s\\S]*?)\\2`, 'd').exec(e.attrs);
    const base = e.start + 1 + e.tag.length;
    if (m) return [{ start: base + m.indices![3]![0], end: base + m.indices![3]![1], text: escapeAttribute(value) }];
    const at = base + e.attrs.replace(/\s+$/, '').length;
    return [{ start: at, end: at, text: ` ${name}="${escapeAttribute(value)}"` }];
  }
  /** Sets, creates (with any missing ancestors) or, for undefined, removes a descendant leaf. */
  setLeaf(base: XmlElement, names: string[], value: string | undefined): TextEdit[] {
    let at = base, depth = 0;
    for (; depth < names.length; depth++) { const next = this.child(at, names[depth]); if (!next) break; at = next; }
    if (depth === names.length) return value === undefined ? this.remove(at) : this.setText(at, value);
    if (value === undefined) return [];
    let build: Build = { tag: names[names.length - 1], text: value };
    for (let i = names.length - 2; i >= depth; i--) build = { tag: names[i], children: [build] };
    return this.insert(at, [build]);
  }
}
