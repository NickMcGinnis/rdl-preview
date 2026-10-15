import http from 'node:http';
import https from 'node:https';
import { spawn } from 'node:child_process';
import path from 'node:path';
import type { Profile } from './types';

export interface Transport { post(url: string, action: string, body: string): Promise<{ status: number; body: string }>; dispose(): void }
const MAX_BYTES = 100 * 1024 * 1024;
export function runProcess(executable: string, args: string[], input: string, timeoutMs: number, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Error('Request cancelled.')); return; }
    const child = spawn(executable, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], shell: false });
    const output: Buffer[] = [], errors: Buffer[] = [];
    let size = 0, finished = false;
    const finish = (error?: Error) => {
      if (finished) return;
      finished = true; clearTimeout(timer); signal.removeEventListener('abort', cancel);
      if (error) { child.kill(); reject(error); } else resolve(Buffer.concat(output).toString('utf8'));
    };
    const cancel = () => finish(new Error('Request cancelled.'));
    const timer = setTimeout(() => finish(new Error('SSRS request timed out. Increase the connection timeout or check server connectivity.')), timeoutMs + 5000);
    signal.addEventListener('abort', cancel, { once: true });
    child.on('error', () => finish(new Error(`Could not start ${path.basename(executable)}. Install the required system transport or choose another authentication method.`)));
    child.stdout.on('data', (b: Buffer) => { size += b.length; if (size > MAX_BYTES) finish(new Error('The response exceeds the 100 MB preview limit.')); else output.push(b); });
    child.stderr.on('data', (b: Buffer) => { if (errors.reduce((n, v) => n + v.length, 0) < 8192) errors.push(b); });
    child.on('close', code => {
      // Do not surface transport stderr: it can contain credentials or server content.
      if (code !== 0) finish(new Error(`The system HTTP transport exited with code ${code}. Check authentication, HTTPS certificates, connectivity and whether your organization allows this transport.`));
      else finish();
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}
export const curlQuote = (value: string): string => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r/g, '\\r').replace(/\n/g, '\\n').replace(/\t/g, '\\t')}"`;
export function curlConfig(url: string, action: string, body: string, profile: Profile, password?: string): string {
  return [
    'silent', 'show-error', 'http1.1', 'request = "POST"', 'proto = "=http,https"',
    `url = ${curlQuote(url)}`, `header = ${curlQuote('Content-Type: text/xml; charset=utf-8')}`,
    `header = ${curlQuote(`SOAPAction: "${action}"`)}`, `data-binary = ${curlQuote(body)}`,
    `max-time = ${profile.timeoutSeconds ?? 120}`, 'connect-timeout = 20', 'max-filesize = 104857600',
    'write-out = "\\n%{http_code}"', profile.auth === 'ntlm' ? 'ntlm' : 'negotiate',
    `user = ${curlQuote(profile.auth === 'ntlm' ? `${profile.username}:${password ?? ''}` : ':')}`
  ].join('\n');
}
export function createTransport(profile: Profile, password: string | undefined, extensionPath: string): Transport {
  const controller = new AbortController();
  const timeoutMs = (profile.timeoutSeconds ?? 120) * 1000;
  return {
    dispose: () => controller.abort(),
    async post(url, action, body) {
      if (profile.auth === 'basic') {
        return new Promise((resolve, reject) => {
          const u = new URL(url);
          if (u.protocol !== 'https:') { reject(new Error('Basic authentication requires HTTPS.')); return; }
          const req = https.request(u, { method: 'POST', signal: controller.signal, headers: {
            'Content-Type': 'text/xml; charset=utf-8', SOAPAction: `"${action}"`, 'Content-Length': Buffer.byteLength(body),
            Authorization: `Basic ${Buffer.from(`${profile.username}:${password ?? ''}`).toString('base64')}`
          } }, response => {
            const chunks: Buffer[] = []; let bytes = 0;
            response.on('data', (b: Buffer) => { bytes += b.length; if (bytes > MAX_BYTES) req.destroy(new Error('Response exceeds the 100 MB preview limit.')); else chunks.push(b); });
            response.on('end', () => { clearTimeout(timer); resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }); });
            response.on('error', reject);
          });
          const timer = setTimeout(() => req.destroy(new Error('SSRS request timed out.')), timeoutMs);
          req.on('error', error => { clearTimeout(timer); reject(new Error(`HTTPS request failed (${(error as NodeJS.ErrnoException).code || 'network error'}). Check connectivity, certificate trust and authentication.`)); });
          req.end(body);
        });
      }
      if (process.platform === 'win32') {
        const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
        const raw = await runProcess(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', path.join(extensionPath, 'media', 'request.ps1')], JSON.stringify({ url, action, body, auth: profile.auth, username: profile.username, password, timeoutSeconds: profile.timeoutSeconds ?? 120 }), timeoutMs, controller.signal);
        try { return JSON.parse(raw.replace(/^\uFEFF/, '')); } catch { throw new Error('Windows transport returned an unexpected response. Check PowerShell availability and execution policy.'); }
      }
      const raw = await runProcess('/usr/bin/curl', ['--disable', '--config', '-'], curlConfig(url, action, body, profile, password), timeoutMs, controller.signal);
      const split = raw.lastIndexOf('\n');
      const status = Number(raw.slice(split + 1).trim());
      if (!status) throw new Error('No HTTP response was received. Check curl NTLM/SPNEGO support and your Kerberos ticket if using the current identity.');
      return { status, body: raw.slice(0, split) };
    }
  };
}
// Test-only HTTP transport. Never selected by a live profile.
export function loopbackTransport(): Transport {
  const controller = new AbortController();
  return { dispose: () => controller.abort(), post: (url, action, body) => new Promise((resolve, reject) => {
    const u = new URL(url);
    if (u.hostname !== '127.0.0.1') { reject(new Error('Fixture transport only accepts loopback.')); return; }
    const req = http.request(u, { method: 'POST', signal: controller.signal, headers: { SOAPAction: `"${action}"`, 'Content-Type': 'text/xml', 'Content-Length': Buffer.byteLength(body) } }, res => {
      const chunks: Buffer[] = []; res.on('data', b => chunks.push(b)); res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }));
    }); req.on('error', reject); req.end(body);
  }) };
}
