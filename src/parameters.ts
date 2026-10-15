import type { ParameterValues, ReportParameter } from './types';

export function initialValues(parameters: ReportParameter[], remembered: ParameterValues = {}): ParameterValues {
  const result: ParameterValues = Object.create(null);
  for (const p of parameters) {
    const old = remembered[p.name];
    const candidates = old ?? p.defaults;
    const valid = candidates.filter(v => (v !== null || p.nullable) && (p.validValues === undefined || p.validValues.some(o => o.value === v)));
    if (valid.length) result[p.name] = p.multiValue ? valid : valid.slice(0, 1);
  }
  return result;
}
export function validateValues(parameters: ReportParameter[], values: ParameterValues, partial = false): Record<string, string> {
  const errors: Record<string, string> = Object.create(null);
  for (const p of parameters) {
    const selected = values[p.name];
    if (!selected?.length) { if (!partial && p.promptUser) errors[p.name] = 'Enter or select a value.'; continue; }
    if (!p.multiValue && selected.length !== 1) { errors[p.name] = 'Choose one value.'; continue; }
    for (const v of selected) {
      if (v === null) { if (!p.nullable || p.multiValue) errors[p.name] = 'This parameter does not accept null.'; continue; }
      if (typeof v !== 'string') { errors[p.name] = 'Invalid parameter value.'; continue; }
      if (!v.length && !(p.type === 'String' && p.allowBlank)) errors[p.name] = 'A blank value is not allowed.';
      if (p.type === 'Integer' && !/^[+-]?\d+$/.test(v)) errors[p.name] = 'Enter a whole number.';
      if (p.type === 'Integer' && (!Number.isSafeInteger(Number(v)) || Number(v) < -2147483648 || Number(v) > 2147483647)) errors[p.name] = 'Enter a 32-bit whole number.';
      if (p.type === 'Float' && (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(v) || !Number.isFinite(Number(v)))) errors[p.name] = 'Enter a number using a decimal point.';
      if (p.type === 'Boolean' && !['true', 'false'].includes(v.toLowerCase())) errors[p.name] = 'Choose true or false.';
      if (p.type === 'DateTime' && !Number.isFinite(Date.parse(v))) errors[p.name] = 'Enter a valid date or date/time.';
      if (p.validValues !== undefined && !p.validValues.some(o => o.value === v)) errors[p.name] = 'Choose a value from the available choices.';
    }
  }
  return errors;
}
export function invalidateDependents(parameters: ReportParameter[], values: ParameterValues, changed: string): ParameterValues {
  const result = { ...values }, removed = new Set([changed]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const p of parameters) if (!removed.has(p.name) && p.dependencies.some(d => removed.has(d))) { removed.add(p.name); delete result[p.name]; grew = true; }
  }
  return result;
}
