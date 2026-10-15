import path from 'node:path';
import type { Profile } from './types';
import { assertXml, escapeXml, parseXml, xmlText } from './xml';

interface Element { name: string; tag: string; start: number; openEnd: number; closeStart: number; end: number; attrs: string; parent?: Element }
// Track exact ranges rather than serializing the entire document. Unknown elements,
// namespace declarations, designer metadata and formatting survive unchanged.
function elements(xml: string): Element[] {
  const all: Element[] = [], stack: Element[] = [];
  const tokens = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<\/?[A-Za-z_][\w.:-]*(?:\s+(?:[^>"']|"[^"]*"|'[^']*')*)?\s*\/?>/g;
  for (const m of xml.matchAll(tokens)) {
    const raw = m[0];
    if (raw.startsWith('<!') || raw.startsWith('<?')) continue;
    if (raw.startsWith('</')) {
      const e = stack.pop();
      if (e) { e.closeStart = m.index!; e.end = m.index! + raw.length; }
      continue;
    }
    const match = /^<([\w.:-]+)([\s\S]*?)\/?\s*>$/.exec(raw)!;
    const e: Element = { name: match[1].split(':').pop()!, tag: match[1], attrs: match[2], start: m.index!, openEnd: m.index! + raw.length, closeStart: m.index! + raw.length, end: m.index! + raw.length, parent: stack.at(-1) };
    all.push(e);
    if (!/\/\s*>$/.test(raw)) stack.push(e);
  }
  return all;
}
export function prepareRdl(xml: string, profile: Profile): string {
  assertXml(xml);
  const nodes = elements(xml);
  if (nodes[0]?.name !== 'Report') throw new Error('The selected XML file is not an RDL Report.');
  const edits: { start: number; end: number; text: string }[] = [];
  const ignored = new Set<Element>();
  const replaceInside = (node: Element, text: string) => {
    if (/\/\s*>$/.test(xml.slice(node.start, node.openEnd))) {
      edits.push({ start: node.start, end: node.end, text: `<${node.tag}${node.attrs}>${text}</${node.tag}>` });
    } else edits.push({ start: node.openEnd, end: node.closeStart, text });
  };
  const rawText = (n: Element): string => xmlText(Object.values(parseXml(xml.slice(n.start, n.end)))[0]);
  const absolute = (value: string): string => value.startsWith('/') ? value : path.posix.resolve(profile.catalogFolder || '/', value);
  for (const [name, override] of Object.entries(profile.dataSources || {})) {
    const ds = nodes.find(n => n.name === 'DataSource' && n.parent?.name === 'DataSources' && /\bName\s*=\s*(["'])([\s\S]*?)\1/.exec(n.attrs)?.[2] === escapeXml(name));
    if (!ds) throw new Error(`Data-source override "${name}" does not match a DataSource Name in this report.`);
    const children = nodes.filter(n => n.parent === ds);
    const existing = children.find(n => ['ConnectionProperties', 'DataSourceReference'].includes(n.name));
    if (!existing) throw new Error(`Data source "${name}" has no connection definition to override.`);
    const prefix = ds.tag.includes(':') ? ds.tag.slice(0, ds.tag.indexOf(':') + 1) : '';
    const tag = (n: string, v: string) => `<${prefix}${n}>${escapeXml(v)}</${prefix}${n}>`;
    let replacement: string;
    if (override.reference !== undefined) replacement = tag('DataSourceReference', override.reference);
    else if (existing.name === 'ConnectionProperties') {
      const descendants = nodes.filter(n => n.parent === existing);
      const cs = descendants.find(n => n.name === 'ConnectString');
      if (!cs) throw new Error(`Data source "${name}" has no ConnectString.`);
      replaceInside(cs, escapeXml(override.connectionString!));
      if (override.dataProvider) {
        const provider = descendants.find(n => n.name === 'DataProvider');
        if (!provider) throw new Error(`Data source "${name}" has no DataProvider.`);
        replaceInside(provider, escapeXml(override.dataProvider));
      }
      continue;
    } else replacement = `<${prefix}ConnectionProperties>${tag('DataProvider', override.dataProvider || 'SQL')}${tag('ConnectString', override.connectionString!)}</${prefix}ConnectionProperties>`;
    edits.push({ start: existing.start, end: existing.end, text: replacement });
    ignored.add(existing);
  }
  for (const node of nodes) {
    if (ignored.has(node)) continue;
    if (node.name === 'DataSourceReference' || node.name === 'SharedDataSetReference' || (node.name === 'ReportName' && node.parent?.name === 'Subreport')) {
      const value = rawText(node).trim();
      if (value && !value.startsWith('/')) replaceInside(node, escapeXml(absolute(value)));
    }
  }
  edits.sort((a, b) => b.start - a.start);
  let result = xml;
  for (const e of edits) result = result.slice(0, e.start) + e.text + result.slice(e.end);
  assertXml(result);
  return result;
}
