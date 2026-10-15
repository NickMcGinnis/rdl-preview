import { XMLParser, XMLValidator } from 'fast-xml-parser';

export const escapeXml = (value: string): string => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
export function assertXml(xml: string): void {
  if (/<!\s*(DOCTYPE|ENTITY)\b/i.test(xml)) throw new Error('DTD and entity declarations are not supported. Remove them before previewing.');
  const result = XMLValidator.validate(xml);
  if (result !== true) throw new Error(`Invalid XML: ${result.err.msg} (line ${result.err.line}).`);
}
export function parseXml(xml: string): any {
  assertXml(xml);
  return new XMLParser({ ignoreAttributes: false, removeNSPrefix: true, parseTagValue: false, parseAttributeValue: false, trimValues: false, processEntities: true }).parse(xml);
}
export const list = <T>(value: T | T[] | undefined | null): T[] => value == null ? [] : Array.isArray(value) ? value : [value];
export function xmlText(value: any): string { return value == null ? '' : typeof value === 'object' ? String(value['#text'] ?? '') : String(value); }
export function nullableText(value: any): string | null { return value && typeof value === 'object' && (value['@_nil'] === 'true' || value['@_nil'] === true) ? null : xmlText(value); }
