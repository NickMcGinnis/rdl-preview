import { escapeXml, list, nullableText, parseXml, xmlText } from './xml';
import type { DataSourceCredential, ExecutionInfo, ParameterType, ParameterValues, Profile, ReportParameter, ReportSession } from './types';
import type { Transport } from './transport';

export const NS = 'http://schemas.microsoft.com/sqlserver/2005/06/30/reporting/reportingservices';
export function envelope(method: string, content: string, id?: string): string {
  return `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><soap:Header>${id ? `<ExecutionHeader xmlns="${NS}"><ExecutionID>${escapeXml(id)}</ExecutionID></ExecutionHeader>` : ''}</soap:Header><soap:Body><${method} xmlns="${NS}">${content}</${method}></soap:Body></soap:Envelope>`;
}
// ParameterValue.Value is minOccurs="0" but not nillable, so SSRS reads xsi:nil as "". Null is sent by omitting Value, as the .NET proxy does.
export function parameterXml(values: ParameterValues): string {
  return Object.entries(values).flatMap(([name, vs]) => vs.map(v => `<ParameterValue><Name>${escapeXml(name)}</Name>${v === null ? '' : `<Value>${escapeXml(v)}</Value>`}</ParameterValue>`)).join('');
}
const yes = (value: any) => xmlText(value).trim().toLowerCase() === 'true';
export function decodeInfo(raw: any, headerId?: string): ExecutionInfo {
  const parameters: ReportParameter[] = list(raw?.Parameters?.ReportParameter).map((p: any) => ({
    name: xmlText(p.Name), prompt: xmlText(p.Prompt) || xmlText(p.Name), type: xmlText(p.Type) as ParameterType || 'String',
    nullable: yes(p.Nullable), allowBlank: yes(p.AllowBlank), multiValue: yes(p.MultiValue), promptUser: p.PromptUser === undefined || yes(p.PromptUser),
    defaults: list(p.DefaultValues?.string).map(nullableText),
    validValues: p.ValidValues !== undefined && !(p.ValidValues && p.ValidValues['@_nil'] === 'true') ? list(p.ValidValues?.ValidValue).map((v: any) => ({ label: xmlText(v.Label) || xmlText(v.Value), value: nullableText(v.Value) })) : undefined,
    dependencies: list(p.Dependencies?.string).map(xmlText), state: xmlText(p.State) || 'MissingValidValue', error: xmlText(p.ErrorMessage) || undefined
  }));
  return { id: xmlText(raw?.ExecutionID) || headerId || '', parameters, credentialsRequired: yes(raw?.CredentialsRequired), dataSourcePrompts: list(raw?.DataSourcePrompts?.DataSourcePrompt).map((p: any) => ({ name: xmlText(p.Name), prompt: xmlText(p.Prompt) })), warnings: [] };
}
function faultMessages(detail: any): string[] {
  if (!detail || typeof detail !== 'object') return [];
  const messages: string[] = [];
  for (const [key, value] of Object.entries(detail)) {
    if (key === 'Message' && xmlText(value)) messages.push(xmlText(value));
    else if (typeof value === 'object') for (const child of list(value)) messages.push(...faultMessages(child));
  }
  return [...new Set(messages)];
}
export class SsrsSession implements ReportSession {
  private id = '';
  private readonly endpoint: string;
  constructor(private profile: Profile, private transport: Transport) {
    this.endpoint = `${profile.serverUrl.replace(/\/+$/, '').replace(/\/ReportExecution2005\.asmx$/i, '')}/ReportExecution2005.asmx`;
  }
  dispose(): void { this.transport.dispose(); }
  private async call(method: string, content = ''): Promise<any> {
    const response = await this.transport.post(this.endpoint, `${NS}/${method}`, envelope(method, content, this.id));
    if (response.status === 401) throw new Error('SSRS rejected the sign-in (HTTP 401). Check the connection authentication method and credentials.');
    if (response.status === 403) throw new Error('SSRS denied access (HTTP 403). Ask your administrator about report execution permissions.');
    if (response.status >= 300 && response.status < 400) throw new Error('SSRS redirected this request. Configure the final report server URL; redirects are not followed.');
    let parsed: any;
    try { parsed = parseXml(response.body); } catch { throw new Error(`SSRS returned an unexpected response (HTTP ${response.status}). Check that the URL points to /reportserver and not the web portal.`); }
    const root = parsed.Envelope;
    const fault = root?.Body?.Fault;
    if (fault) {
      const messages = faultMessages(fault.detail).slice(0, 8);
      const summary = xmlText(fault.faultstring) || 'Report execution failed.';
      const message = [summary, ...messages.filter(v => !summary.includes(v))].join('\n');
      throw new Error(message.length > 6000 ? message.slice(0, 6000) + '…' : message);
    }
    if (response.status < 200 || response.status >= 300) throw new Error(`SSRS returned HTTP ${response.status}. Check server availability and permissions.`);
    const result = root?.Body?.[`${method}Response`];
    if (!result) throw new Error(`SSRS response did not contain ${method}Response.`);
    const header = xmlText(root.Header?.ExecutionHeader?.ExecutionID);
    if (header) this.id = header;
    return result;
  }
  private info(result: any): ExecutionInfo {
    const info = decodeInfo(result.executionInfo ?? result.ExecutionInfo, this.id);
    if (!info.id) throw new Error('SSRS did not return an execution ID.');
    this.id = info.id;
    info.warnings = list(result.Warnings?.Warning).map((w: any) => xmlText(w.Message)).filter(Boolean);
    return info;
  }
  async load(rdl: string): Promise<ExecutionInfo> {
    this.id = '';
    return this.info(await this.call('LoadReportDefinition', `<Definition>${Buffer.from(rdl, 'utf8').toString('base64')}</Definition>`));
  }
  async setParameters(values: ParameterValues): Promise<ExecutionInfo> {
    return this.info(await this.call('SetExecutionParameters', `<Parameters>${parameterXml(values)}</Parameters><ParameterLanguage>${escapeXml(this.profile.parameterLanguage || 'en-US')}</ParameterLanguage>`));
  }
  async setCredentials(credentials: DataSourceCredential[]): Promise<ExecutionInfo> {
    const entries = credentials.map(c => `<DataSourceCredentials><DataSourceName>${escapeXml(c.name)}</DataSourceName><UserName>${escapeXml(c.username)}</UserName><Password>${escapeXml(c.password)}</Password></DataSourceCredentials>`).join('');
    return this.info(await this.call('SetExecutionCredentials', `<Credentials>${entries}</Credentials>`));
  }
  async render(): Promise<Uint8Array> {
    const result = await this.call('Render', '<Format>PDF</Format><DeviceInfo>&lt;DeviceInfo&gt;&lt;/DeviceInfo&gt;</DeviceInfo>');
    const data = Buffer.from(xmlText(result.Result).replace(/\s/g, ''), 'base64');
    if (!data.subarray(0, 5).equals(Buffer.from('%PDF-'))) throw new Error('SSRS did not return a PDF. Check the PDF rendering extension on the server.');
    return data;
  }
  async test(): Promise<void> { await this.call('ListRenderingExtensions'); }
}
