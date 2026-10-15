import type { Profile } from './types';

export function validateProfile(input: unknown): Profile {
  const p = input as Profile;
  if (!p || typeof p !== 'object' || typeof p.id !== 'string' || !/^[\w-]{1,80}$/.test(p.id)) throw new Error('Connection must have a stable ID containing letters, numbers, underscores or hyphens.');
  if (p.id === 'demo' && p.auth !== 'demo') throw new Error('The ID demo is reserved for the simulated connection.');
  if (typeof p.name !== 'string' || !p.name.trim()) throw new Error('Enter a connection name.');
  if (!['windows', 'ntlm', 'basic', 'demo'].includes(p.auth)) throw new Error('Choose a supported authentication method.');
  if (p.auth !== 'demo') {
    let u: URL;
    try { u = new URL(p.serverUrl); } catch { throw new Error('Enter a full report server URL, such as https://host/reportserver.'); }
    if (!['https:', 'http:'].includes(u.protocol) || u.username || u.password || u.search || u.hash) throw new Error('Use an HTTP(S) report server URL without credentials, a query or a fragment.');
    if (u.protocol !== 'https:' && (p.auth === 'basic' || !p.allowHttp)) throw new Error(p.auth === 'basic' ? 'Basic authentication requires HTTPS.' : 'Use HTTPS, or explicitly allow HTTP in this connection.');
    if (/\/reports\/?$/i.test(u.pathname)) throw new Error('Use the report server endpoint (usually /reportserver), rather than the /reports portal.');
    if (['basic', 'ntlm'].includes(p.auth) && !p.username?.trim()) throw new Error('Enter a username for this authentication method.');
  }
  if (p.timeoutSeconds !== undefined && (!Number.isInteger(p.timeoutSeconds) || p.timeoutSeconds < 10 || p.timeoutSeconds > 600)) throw new Error('Timeout must be between 10 and 600 seconds.');
  if (p.parameterLanguage && !/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(p.parameterLanguage)) throw new Error('Use a language code such as en-US.');
  const folder = p.catalogFolder || '/';
  if (!folder.startsWith('/') || /[\x00-\x1f?#]/.test(folder)) throw new Error('Catalog folder must be an absolute SSRS path, such as /Reports.');
  for (const [name, o] of Object.entries(p.dataSources || {})) {
    if (!o || typeof o !== 'object' || !name || (o.reference !== undefined) === (o.connectionString !== undefined)) throw new Error(`Data source ${name}: supply either reference or connectionString.`);
    if (o.reference !== undefined && (!o.reference.startsWith('/') || /[\x00-\x1f]/.test(o.reference))) throw new Error(`Data source ${name}: shared reference must be an absolute catalog path.`);
    if (o.connectionString !== undefined && (typeof o.connectionString !== 'string' || /(?:^|;)\s*(?:password|pwd|user\s*id|uid|access\s*token)\s*=/i.test(o.connectionString))) throw new Error(`Data source ${name}: keep database credentials out of connection settings. Use SSRS shared credentials or the execution credential prompt.`);
  }
  return { ...p, name: p.name.trim(), serverUrl: p.serverUrl?.replace(/\/+$/, '') || '', catalogFolder: folder, parameterLanguage: p.parameterLanguage || 'en-US', timeoutSeconds: p.timeoutSeconds ?? 120 };
}
