import { SCOPE_COLLECTIONS, resolve, scopeDataSet, type Analysis, type Collection, type Declaration } from './rdl-analysis';
import type { TextEdit } from './rdl-edit';

export const NAME_RULE = 'Names must start with a letter and contain only letters, digits and underscores.';
export const isValidName = (name: string): boolean => /^[A-Za-z][A-Za-z0-9_]*$/.test(name);
const LABELS: Record<Collection, string> = { Parameters: 'parameter', Fields: 'field', ReportItems: 'report item', DataSets: 'dataset', DataSources: 'data source', Variables: 'variable', Groups: 'group', EmbeddedImages: 'embedded image' };

/** The declaration at an offset, and the span there that names it: its Name attribute, a reference, or a scope string. */
export function declarationAt(analysis: Analysis, offset: number): { declaration: Declaration; start: number; end: number } | undefined {
  const own = analysis.declarations.find(d => d.start <= offset && offset <= d.end);
  if (own) return { declaration: own, start: own.start, end: own.end };
  const r = analysis.references.find(r => r.start <= offset && offset <= r.end);
  if (r) {
    const targets = resolve(analysis, r);
    // The same field name in several datasets: use the enclosing data region's dataset.
    const declaration = targets.length <= 1 || r.collection !== 'Fields' ? targets[0] : targets.find(d => d.dataSet === scopeDataSet(analysis, r.start));
    return declaration && { declaration, start: r.start, end: r.end };
  }
  const scope = analysis.scopes.find(s => s.start <= offset && offset <= s.end);
  const declaration = scope && analysis.declarations.find(d => SCOPE_COLLECTIONS.includes(d.collection) && d.name === scope.name);
  return declaration && { declaration, start: scope.start, end: scope.end };
}

/** Edits renaming a declaration and every reference to it. `skipped` counts ambiguous field references left alone. */
export function renameEdits(analysis: Analysis, target: Declaration, name: string): { edits: TextEdit[]; skipped: number } {
  if (!isValidName(name)) throw new Error(NAME_RULE);
  if (name === target.name) return { edits: [], skipped: 0 };
  const label = LABELS[target.collection];
  if (analysis.declarations.some(d => d !== target && d.collection === target.collection && d.name === name && (target.collection !== 'Fields' || d.dataSet === target.dataSet))) throw new Error(`A ${label} named "${name}" already exists${target.collection === 'Fields' ? ` in dataset "${target.dataSet}"` : ''}.`);
  const edits: TextEdit[] = [{ start: target.start, end: target.end, text: name }];
  let skipped = 0;
  const sameField = analysis.declarations.filter(d => d.collection === 'Fields' && d.name === target.name).length;
  for (const r of analysis.references) {
    if (r.collection !== target.collection || r.name !== target.name) continue;
    if (target.collection === 'Fields') {
      const owner = r.dataSet ?? (sameField === 1 ? target.dataSet : scopeDataSet(analysis, r.start));
      if (owner !== target.dataSet) { if (owner === undefined) skipped++; continue; }
    }
    edits.push({ start: r.start, end: r.end, text: name });
  }
  if (SCOPE_COLLECTIONS.includes(target.collection)) for (const s of analysis.scopes) if (s.name === target.name) edits.push({ start: s.start, end: s.end, text: name });
  return { edits, skipped };
}
