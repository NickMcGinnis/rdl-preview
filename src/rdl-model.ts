export interface XmlElement { name: string; tag: string; start: number; openEnd: number; closeStart: number; end: number; attrs: string; selfClosing: boolean; parent?: XmlElement; children: XmlElement[] }

const TOKENS = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<\/?[A-Za-z_][\w.:-]*(?:\s+(?:[^>"']|"[^"]*"|'[^']*')*)?\s*\/?>/g;
// Track exact ranges rather than serializing the entire document. Unknown elements,
// namespace declarations, designer metadata and formatting survive unchanged.
// Tolerates malformed input (mismatched or unclosed tags) so editor features keep working while typing.
export function parseElements(xml: string): XmlElement[] {
  const all: XmlElement[] = [], stack: XmlElement[] = [];
  for (const m of xml.matchAll(TOKENS)) {
    const raw = m[0], index = m.index!;
    if (raw.startsWith('<!') || raw.startsWith('<?')) continue;
    if (raw.startsWith('</')) {
      const tag = /^<\/([^\s>]+)/.exec(raw)![1];
      let at = stack.length - 1;
      while (at >= 0 && stack[at].tag !== tag) at--;
      if (at < 0) continue;
      // Unclosed descendants end where their ancestor closes.
      const [closed, ...unclosed] = stack.splice(at);
      for (const e of unclosed) { e.closeStart = index; e.end = index; }
      closed.closeStart = index; closed.end = index + raw.length;
      continue;
    }
    const match = /^<([\w.:-]+)([\s\S]*?)\/?\s*>$/.exec(raw)!;
    const selfClosing = /\/\s*>$/.test(raw);
    const parent = stack.at(-1);
    const e: XmlElement = { name: match[1].split(':').pop()!, tag: match[1], attrs: match[2], start: index, openEnd: index + raw.length, closeStart: index + raw.length, end: index + raw.length, selfClosing, parent, children: [] };
    all.push(e); parent?.children.push(e);
    if (!selfClosing) stack.push(e);
  }
  for (const e of stack) { e.closeStart = xml.length; e.end = xml.length; }
  return all;
}

export const prefixOf = (e: XmlElement): string => e.tag.includes(':') ? e.tag.slice(0, e.tag.indexOf(':')) : '';
const ENTITY = /&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-fA-F]+);/y;
const NAMED: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
const entity = (body: string): string => NAMED[body] ?? String.fromCodePoint(body[1] === 'x' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10));
export const decodeXml = (value: string): string => value.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, (_, body) => entity(body));

export interface Attribute { value: string; start: number; end: number }
export function attribute(e: XmlElement, name: string): Attribute | undefined {
  const m = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, 'd').exec(e.attrs);
  if (!m) return undefined;
  const base = e.start + 1 + e.tag.length;
  return { value: decodeXml(m[2]), start: base + m.indices![2]![0], end: base + m.indices![2]![1] };
}
/** Default namespace declared directly on this element, if any. */
export const defaultNamespace = (e: XmlElement): string | undefined => /(?:^|\s)xmlns\s*=\s*(["'])([\s\S]*?)\1/.exec(e.attrs)?.[2];

/** Decoded text of an element without child elements, with the source offset of each character (plus one past the end). */
export interface Text { text: string; offsets: number[] }
export function textOf(xml: string, e: XmlElement): Text {
  let text = ''; const offsets: number[] = [];
  const push = (value: string, offset: number) => { for (let i = 0; i < value.length; i++) offsets.push(offset); text += value; };
  for (let i = e.openEnd; i < e.closeStart;) {
    if (xml[i] === '&') {
      ENTITY.lastIndex = i;
      const m = ENTITY.exec(xml);
      if (m) { push(entity(m[1]), i); i += m[0].length; continue; }
    } else if (xml.startsWith('<![CDATA[', i)) {
      const close = xml.indexOf(']]>', i);
      const end = close < 0 || close > e.closeStart ? e.closeStart : close;
      for (let j = i + 9; j < end; j++) push(xml[j], j);
      i = end + 3; continue;
    } else if (xml.startsWith('<!--', i)) {
      const close = xml.indexOf('-->', i);
      i = close < 0 ? e.closeStart : close + 3; continue;
    }
    push(xml[i], i); i++;
  }
  offsets.push(e.closeStart);
  return { text, offsets };
}
/** Trimmed text of a leaf child element, or undefined when the child is missing. */
export function childText(xml: string, e: XmlElement, name: string): string | undefined {
  const child = e.children.find(c => c.name === name);
  return child && textOf(xml, child).text.trim();
}
