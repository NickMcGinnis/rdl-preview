import type { DataSourceCredential, ExecutionInfo, ParameterValues, ReportParameter, ReportSession } from './types';
import { list, parseXml, xmlText } from './xml';
import { initialValues, validateValues } from './parameters';

// This small PDF fixture is authored here; it does not render RDL or query a database.
export function demoPdf(lines: string[]): Uint8Array {
  const text = ['BT /F1 18 Tf 52 740 Td (DEMO - simulated report preview) Tj /F1 11 Tf', ...lines.map(line => `0 -24 Td (${line.replace(/[^\x20-\x7e]/g, '?').replace(/([\\()])/g, '\\$1')}) Tj`), 'ET'].join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${Buffer.byteLength(text)} >>\nstream\n${text}\nendstream`
  ];
  let pdf = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((object, i) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => String(offset).padStart(10, '0') + ' 00000 n \n').join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}
export class DemoSession implements ReportSession {
  private parameters: ReportParameter[] = [];
  private values: ParameterValues = Object.create(null);
  dispose(): void {}
  async test(): Promise<void> {}
  async load(rdl: string): Promise<ExecutionInfo> {
    const report = parseXml(rdl).Report;
    if (!report) throw new Error('This file does not contain an RDL Report.');
    this.parameters = list(report.ReportParameters?.ReportParameter).map((p: any) => ({
      name: p['@_Name'], prompt: xmlText(p.Prompt) || p['@_Name'], type: xmlText(p.DataType) as ReportParameter['type'] || 'String',
      nullable: xmlText(p.Nullable) === 'true', allowBlank: xmlText(p.AllowBlank) === 'true', multiValue: xmlText(p.MultiValue) === 'true', promptUser: xmlText(p.Hidden) !== 'true',
      defaults: list(p.DefaultValue?.Values?.Value).map(xmlText).filter(v => !v.startsWith('=')),
      validValues: p.ValidValues?.ParameterValues ? list(p.ValidValues.ParameterValues.ParameterValue).map((v: any) => ({ label: xmlText(v.Label) || xmlText(v.Value), value: xmlText(v.Value) })) : undefined,
      dependencies: [], state: 'MissingValidValue'
    }));
    this.values = initialValues(this.parameters);
    return this.info();
  }
  private info(): ExecutionInfo {
    const errors = validateValues(this.parameters, this.values);
    return { id: 'demo', parameters: this.parameters.map(p => ({ ...p, defaults: this.values[p.name] || [], state: errors[p.name] ? 'MissingValidValue' : 'HasValidValue' })), credentialsRequired: false, dataSourcePrompts: [], warnings: ['Demo output is simulated: the RDL is not rendered and no queries run.'] };
  }
  async setParameters(values: ParameterValues): Promise<ExecutionInfo> { this.values = { ...this.values, ...values }; return this.info(); }
  async setCredentials(_credentials: DataSourceCredential[]): Promise<ExecutionInfo> { return this.info(); }
  async render(): Promise<Uint8Array> {
    if (Object.keys(validateValues(this.parameters, this.values)).length) throw new Error('Complete all required parameters before rendering.');
    return demoPdf(['No SSRS server was contacted. This page only lists the submitted parameter values.', '', ...Object.entries(this.values).map(([name, values]) => `${name}: ${values.map(v => v === null ? '(null)' : v).join(', ')}`)]);
  }
}
