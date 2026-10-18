import { downloadAndUnzipVSCode, resolveCliArgsFromVSCodeExecutablePath, runTests } from '@vscode/test-electron';
import { build } from 'esbuild';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
const tests = { core: 'test/extension-host.ts', xml: 'test/xml-host.ts' };
for (const [name, entry] of Object.entries(tests)) await build({ entryPoints: [entry], bundle: true, outfile: `dist/${name}-test.cjs`, platform: 'node', format: 'cjs', target: 'node20', external: ['vscode'] });
// Terminals inside VS Code-based editors set this, which makes the test VS Code start as plain Node and reject its options.
delete process.env.ELECTRON_RUN_AS_NODE;
const vscodeExecutablePath = process.env.VSCODE_EXECUTABLE_PATH || await downloadAndUnzipVSCode('stable');
const common = ['--skip-welcome', '--skip-release-notes', '--disable-updates', '--disable-telemetry'];
const temp = await mkdtemp(path.join(os.tmpdir(), 'rdl-test-'));
try {
  // Without other extensions, in a trusted window: everything RDL Preview does on its own.
  await runTests({ vscodeExecutablePath, extensionDevelopmentPath: process.cwd(), extensionTestsPath: path.resolve('dist/core-test.cjs'), launchArgs: ['--disable-workspace-trust', '--disable-extensions', ...common, '--user-data-dir=' + path.join(temp, 'core-user'), '--extensions-dir=' + path.join(temp, 'core-extensions')] });
  if (process.env.SKIP_XML_TEST) console.log('Skipping the Red Hat XML test (SKIP_XML_TEST is set).');
  else {
    // With Red Hat XML installed, in Restricted Mode, with only an .rdl file in the workspace.
    const extensions = path.join(temp, 'xml-extensions'), user = path.join(temp, 'xml-user'), workspace = path.join(temp, 'workspace');
    const [cli, ...cliArgs] = resolveCliArgsFromVSCodeExecutablePath(vscodeExecutablePath, { reuseMachineInstall: true });
    const install = spawnSync(cli, [...cliArgs, '--extensions-dir=' + extensions, '--user-data-dir=' + user, '--install-extension', process.env.XML_EXTENSION || 'redhat.vscode-xml'], { encoding: 'utf8', stdio: 'inherit', shell: process.platform === 'win32' });
    if (install.status !== 0) throw new Error('Could not install Red Hat XML for the extension-host test. Set SKIP_XML_TEST=1 to skip it offline.');
    await mkdir(path.join(user, 'User'), { recursive: true });
    await writeFile(path.join(user, 'User', 'settings.json'), JSON.stringify({ 'security.workspace.trust.enabled': true, 'security.workspace.trust.startupPrompt': 'never', 'redhat.telemetry.enabled': false }));
    await mkdir(workspace);
    await copyFile('test/fixtures/sales.rdl', path.join(workspace, 'sales.rdl'));
    // runTests always disables workspace trust, so start VS Code directly with the same test arguments.
    const args = [workspace, ...common, '--no-sandbox', '--disable-gpu-sandbox', '--no-cached-data', '--user-data-dir=' + user, '--extensions-dir=' + extensions, '--extensionDevelopmentPath=' + process.cwd(), '--extensionTestsPath=' + path.resolve('dist/xml-test.cjs')];
    const code = await new Promise((resolve, reject) => spawn(vscodeExecutablePath, args, { stdio: 'inherit' }).on('error', reject).on('exit', resolve));
    if (code !== 0) throw new Error(`The Red Hat XML extension-host test failed with exit code ${code}.`);
  }
} finally { await rm(temp, { recursive: true, force: true }); }
