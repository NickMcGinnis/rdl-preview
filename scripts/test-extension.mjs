import { runTests } from '@vscode/test-electron';
import { build } from 'esbuild';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
await build({ entryPoints: ['test/extension-host.ts'], bundle: true, outfile: 'dist/extension-test.cjs', platform: 'node', format: 'cjs', target: 'node20', external: ['vscode'] });
const executable = process.env.VSCODE_EXECUTABLE_PATH;
const temp = await mkdtemp(path.join(os.tmpdir(), 'rdl-test-'));
try { await runTests({ extensionDevelopmentPath: process.cwd(), extensionTestsPath: path.resolve('dist/extension-test.cjs'), ...(executable ? { vscodeExecutablePath: executable } : { version: 'stable' }), launchArgs: ['--disable-workspace-trust', '--disable-extensions', '--skip-welcome', '--skip-release-notes', '--disable-updates', '--disable-telemetry', '--user-data-dir=' + path.join(temp, 'user'), '--extensions-dir=' + path.join(temp, 'extensions')] });

} finally { await rm(temp, { recursive: true, force: true }); }
