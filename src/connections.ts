import * as vscode from 'vscode';
import { randomUUID, createHash } from 'node:crypto';
import { validateProfile } from './profiles';
import type { AuthMode, Profile } from './types';

const usesPassword = (p: Profile): boolean => p.auth === 'basic' || p.auth === 'ntlm';
const secretKey = (p: Profile): string => `connection:${p.id}:${createHash('sha256').update(JSON.stringify([p.auth, p.serverUrl, p.username || ''])).digest('hex')}`;

export const DEMO_PROFILE: Profile = { id: 'demo', name: 'Demo (simulated)', auth: 'demo', serverUrl: '', catalogFolder: '/', parameterLanguage: 'en-US' };
export type ConnectionChange = 'profiles' | 'selection';
export class Connections {
  private readonly listeners = new Set<(change: ConnectionChange) => void>();
  constructor(private context: vscode.ExtensionContext) {
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('rdlPreview.profiles')) this.changed('profiles'); }));
  }
  onChange(listener: (change: ConnectionChange) => void): vscode.Disposable { this.listeners.add(listener); return { dispose: () => this.listeners.delete(listener) }; }
  profiles(): Profile[] {
    const raw = vscode.workspace.getConfiguration('rdlPreview').get<unknown[]>('profiles', []);
    if (!Array.isArray(raw)) throw new Error('RDL Preview connections must be an array. Open Manage Connections to repair the settings.');
    const result = raw.map(validateProfile);
    if (new Set(result.map(p => p.id)).size !== result.length) throw new Error('Each RDL Preview connection needs a unique ID.');
    return result;
  }
  active(): Profile | undefined {
    const id = this.context.workspaceState.get<string>('activeProfile');
    return id === 'demo' ? DEMO_PROFILE : this.profiles().find(p => p.id === id);
  }
  private changed(change: ConnectionChange): void { for (const listener of this.listeners) listener(change); }
  async select(profile: Profile): Promise<void> { await this.context.workspaceState.update('activeProfile', profile.id); this.changed('selection'); }
  async switch(): Promise<Profile | undefined> {
    const options = [...this.profiles(), DEMO_PROFILE].map(profile => ({ label: profile.name, description: profile.auth === 'demo' ? 'Local simulated preview' : profile.serverUrl, profile }));
    const selected = await vscode.window.showQuickPick([...options, { label: '$(add) Add connection…', description: '', profile: undefined }], { title: 'RDL Preview — choose environment', placeHolder: 'The selected environment is used for the next preview' });
    if (!selected) return;
    if (!selected.profile) return this.add();
    await this.select(selected.profile); return selected.profile;
  }
  async password(profile: Profile): Promise<string | undefined> {
    if (!usesPassword(profile)) return;
    const key = secretKey(profile);
    let password = await this.context.secrets.get(key);
    if (password === undefined) {
      password = await vscode.window.showInputBox({ title: `Sign in to ${profile.name}`, prompt: `Password for ${profile.username}. Stored encrypted on this machine.`, password: true, ignoreFocusOut: true });
      if (password === undefined) throw new Error('Sign-in cancelled.');
      await this.context.secrets.store(key, password);
    }
    return password;
  }
  async manage(): Promise<void> {
    let profiles: Profile[];
    try { profiles = this.profiles(); } catch (e) {
      await vscode.window.showErrorMessage((e as Error).message);
      await vscode.commands.executeCommand('workbench.action.openSettings', 'rdlPreview.profiles'); return;
    }
    const selected = await vscode.window.showQuickPick([
      { label: '$(add) Add connection', action: 'add' },
      ...profiles.map(profile => ({ label: profile.name, description: profile.serverUrl, profile })),
      { label: '$(settings-gear) Edit advanced settings', action: 'settings' }
    ], { title: 'RDL Preview — manage connections' });
    if (!selected) return;
    if (!('profile' in selected)) {
      if (selected.action === 'settings') await vscode.commands.executeCommand('workbench.action.openSettings', 'rdlPreview.profiles');
      else await this.edit();
      return;
    }
    const p = selected.profile;
    const action = await vscode.window.showQuickPick(['Edit connection', 'Set or replace password', 'Edit data-source overrides and advanced settings', 'Delete connection'], { title: p.name });
    if (action === 'Edit connection') await this.edit(p);
    else if (action === 'Set or replace password') {
      if (!usesPassword(p)) { await vscode.window.showInformationMessage('This connection uses your current identity and has no saved password.'); return; }
      const password = await vscode.window.showInputBox({ title: `Password for ${p.name}`, prompt: `Replace password for ${p.username}`, password: true, ignoreFocusOut: true });
      if (password !== undefined) await this.context.secrets.store(secretKey(p), password);
    } else if (action?.startsWith('Edit data-source')) await vscode.commands.executeCommand('workbench.action.openSettings', 'rdlPreview.profiles');
    else if (action === 'Delete connection') {
      const answer = await vscode.window.showWarningMessage(`Delete saved connection "${p.name}" from this machine?`, { modal: true }, 'Delete');
      if (answer !== 'Delete') return;
      await this.save(profiles.filter(v => v.id !== p.id)); await this.context.secrets.delete(secretKey(p));
      if (this.context.workspaceState.get('activeProfile') === p.id) { await this.context.workspaceState.update('activeProfile', undefined); this.changed('selection'); }
    }
  }
  private async save(profiles: Profile[]): Promise<void> {
    // The configuration listener reports the change.
    await vscode.workspace.getConfiguration('rdlPreview').update('profiles', profiles, vscode.ConfigurationTarget.Global);
  }
  add(): Promise<Profile | undefined> { return this.edit(); }
  private async edit(existing?: Profile): Promise<Profile | undefined> {
    const name = await vscode.window.showInputBox({ title: 'Connection name', value: existing?.name, placeHolder: 'Development', ignoreFocusOut: true, validateInput: v => v.trim() ? undefined : 'Enter a name.' });
    if (name === undefined) return;
    const authChoice = await vscode.window.showQuickPick([
      { label: 'Windows / current identity', description: process.platform === 'win32' ? 'Native Windows credentials through PowerShell' : 'System curl + a valid Kerberos ticket (SPNEGO)', value: 'windows' },
      { label: 'NTLM / username and password', description: 'DOMAIN\\username; password stored encrypted', value: 'ntlm' },
      { label: 'Basic / username and password', description: 'Basic enabled on SSRS; HTTP requires explicit opt-in', value: 'basic' }
    ], { title: 'SSRS authentication', placeHolder: existing ? `Current method: ${existing.auth}` : 'Choose the method configured on your server' });
    if (!authChoice) return;
    const auth = authChoice.value as AuthMode;
    const serverUrl = await vscode.window.showInputBox({ title: 'Report server URL', prompt: 'Usually https://host/reportserver. Use the service endpoint, not the /reports portal.', value: existing?.serverUrl, ignoreFocusOut: true });
    if (serverUrl === undefined) return;
    let allowHttp = existing?.allowHttp === true && existing.auth === auth && existing.serverUrl === serverUrl.trim().replace(/\/+$/, '');
    if (/^http:/i.test(serverUrl.trim()) && !allowHttp) {
      const warning = auth === 'basic'
        ? 'Basic authentication over HTTP sends your username and password without encryption. RDL content, parameter values and report data also travel without TLS.'
        : 'This connection uses unencrypted HTTP. RDL content, parameter values and report data travel without TLS.';
      const answer = await vscode.window.showWarningMessage(warning, { modal: true }, 'Allow HTTP for this connection');
      if (!answer) return;
      allowHttp = true;
    }
    let username: string | undefined;
    if (auth !== 'windows') {
      username = await vscode.window.showInputBox({ title: 'SSRS username', value: existing?.username, placeHolder: auth === 'ntlm' ? 'DOMAIN\\username' : 'username', ignoreFocusOut: true, validateInput: v => v.trim() ? undefined : 'Enter a username.' });
      if (username === undefined) return;
    }
    const catalogFolder = await vscode.window.showInputBox({ title: 'Report catalog folder', prompt: 'Resolve relative shared data sources, datasets and subreports against this server folder.', value: existing?.catalogFolder || '/', ignoreFocusOut: true, validateInput: v => v.startsWith('/') ? undefined : 'Start the catalog path with /.' });
    if (catalogFolder === undefined) return;
    const profile = validateProfile({ ...existing, id: existing?.id || randomUUID(), name, auth, serverUrl: serverUrl.trim(), username, catalogFolder, allowHttp });
    const profiles = this.profiles().filter(p => p.id !== profile.id);
    if (existing && (existing.auth !== auth || existing.username !== username || existing.serverUrl !== profile.serverUrl)) await this.context.secrets.delete(secretKey(existing));
    await this.save([...profiles, profile]); await this.select(profile);
    await this.password(profile); return profile;
  }
}
