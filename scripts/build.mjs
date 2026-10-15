import { build } from 'esbuild';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
await mkdir('dist', { recursive: true });
await build({ entryPoints: ['src/extension.ts'], bundle: true, outfile: 'dist/extension.js', platform: 'node', format: 'cjs', target: 'node20', external: ['vscode'], sourcemap: false, minify: false });
await mkdir('media/pdfjs', { recursive: true });
for (const name of ['pdf.mjs', 'pdf.worker.mjs']) await cp(`node_modules/pdfjs-dist/legacy/build/${name}`, `media/pdfjs/${name}`);
for (const name of ['cmaps', 'standard_fonts', 'wasm']) await cp(`node_modules/pdfjs-dist/${name}`, `media/pdfjs/${name}`, { recursive: true });
await cp('node_modules/pdfjs-dist/LICENSE', 'media/pdfjs/LICENSE');
const packages = ['fast-xml-parser', '@nodable/entities', 'fast-xml-builder', 'is-unsafe', 'path-expression-matcher', 'strnum', 'xml-naming', 'anynum'];
let notices = 'Third-party notices\n\nPDF.js: Apache-2.0. See media/pdfjs/LICENSE.\n';
for (const name of packages) {
  try {
    const pkg = JSON.parse(await readFile(`node_modules/${name}/package.json`, 'utf8'));
    let license = '';
    for (const file of ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'license']) { try { license = await readFile(`node_modules/${name}/${file}`, 'utf8'); break; } catch {} }
    notices += `\n${name}@${pkg.version} (${pkg.license})\n${license}\n`;
  } catch {}
}
await writeFile('dist/THIRD_PARTY_NOTICES.txt', notices);
