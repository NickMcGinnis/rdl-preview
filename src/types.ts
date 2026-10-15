export type AuthMode = 'windows' | 'ntlm' | 'basic' | 'demo';
export interface DataSourceOverride { reference?: string; connectionString?: string; dataProvider?: string }
export interface Profile {
  id: string; name: string; serverUrl: string; auth: AuthMode; username?: string;
  catalogFolder?: string; parameterLanguage?: string; timeoutSeconds?: number; allowHttp?: boolean;
  dataSources?: Record<string, DataSourceOverride>;
}
export type ParameterType = 'String' | 'Integer' | 'Float' | 'Boolean' | 'DateTime';
export interface ReportParameter {
  name: string; prompt: string; type: ParameterType; nullable: boolean; allowBlank: boolean;
  multiValue: boolean; promptUser: boolean; defaults: (string | null)[];
  validValues?: { label: string; value: string | null }[];
  dependencies: string[]; state: string; error?: string;
}
export type ParameterValues = Record<string, (string | null)[]>;
export interface DataSourceCredential { name: string; username: string; password: string }
export interface ExecutionInfo {
  id: string; parameters: ReportParameter[]; credentialsRequired: boolean;
  dataSourcePrompts: { name: string; prompt: string }[]; warnings: string[];
}
export interface ReportSession {
  load(rdl: string): Promise<ExecutionInfo>;
  setParameters(values: ParameterValues): Promise<ExecutionInfo>;
  setCredentials(credentials: DataSourceCredential[]): Promise<ExecutionInfo>;
  render(): Promise<Uint8Array>;
  test(): Promise<void>;
  dispose(): void;
}
