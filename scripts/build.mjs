import { build } from 'esbuild';
import ts from 'typescript';
import { dictionaries } from './compact-dictionaries.mjs';
import { mkdir, readFile, writeFile, rm, copyFile, stat } from 'node:fs/promises';
import { create as createTar } from 'tar';
import { createHash } from 'node:crypto';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '..');
process.chdir(root);
await rm('dist', { recursive: true, force: true });
await mkdir('dist', { recursive: true });
await mkdir('publish', { recursive: true });
// Keep localized text in UTF-8 instead of expanding it to Unicode escape sequences.
const opts = { bundle: true, platform: 'browser', target: 'es2020', charset: 'utf8', minify: true,
  legalComments: 'eof', sourcemap: false, metafile: true, tsconfig: 'tsconfig.json' };
// Discover the host graph before pruning: UI-only translations must never enter index.js.
const hostOptions = { ...opts, entryPoints: ['src/index.ts'], outfile: 'dist/index.js', format: 'cjs' };
const graph = await build({ ...hostOptions, write: false });
const hostKeys = new Set();
const translationKeys = new Set(Object.keys(JSON.parse(await readFile('src/i18n/locales/zh-CN.json', 'utf8'))));
for (const file of Object.keys(graph.metafile.inputs)) {
  if (!file.startsWith('src/') || file.startsWith('src/i18n/') || !/\.tsx?$/.test(file)) continue;
  const source = ts.createSourceFile(file, await readFile(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const visit = node => {
    if (ts.isStringLiteralLike(node) && translationKeys.has(node.text)) hostKeys.add(node.text);
    ts.forEachChild(node, visit);
  };
  visit(source);
}
const host = await build({ ...hostOptions, plugins: [await dictionaries(hostKeys)] });
const panel = await build({ ...opts, entryPoints: ['src/panel/index.tsx'], outfile: 'dist/panel.js', format: 'iife', plugins: [await dictionaries()] });
for (const meta of [host.metafile, panel.metafile]) {
  for (const out of Object.values(meta.outputs)) {
    if (out.imports.length) throw new Error('Unexpected external runtime imports: ' + JSON.stringify(out.imports));
  }
}
await build({ ...opts, entryPoints: ['src/panel/mini.ts'], outfile: 'dist/mini.js', format: 'iife' });
await copyFile('src/panel/mini.css', 'dist/mini.css');
const css = await build({ entryPoints: ['src/panel/panel.css'], outfile: 'dist/panel.css', bundle: true,
  loader: { '.png': 'file' }, assetNames: 'assets/[name]-[hash]', metafile: true, target: 'es2020', minify: true });
await copyFile('src/panel/host.css', 'dist/host.css');
await copyFile('src/manifest.json', 'dist/manifest.json');
const manifest = JSON.parse(await readFile('src/manifest.json', 'utf8'));
await copyFile('LICENSE', 'dist/LICENSE');
// JPL is a plain uncompressed tar built the same way as the official Joplin generator (portable mode).
// mtime is pinned to npm's fixed date: a zero mtime makes Windows fail extraction with "EINVAL: futime" (#96),
// and a fixed value keeps the archive bytes and _publish_hash reproducible.
const JPL_MTIME = new Date('1985-10-26T08:15:00Z');
const runtimeFiles = ['mini.js', 'mini.css', 'host.css', 'index.js', 'panel.js', 'panel.css', 'manifest.json', 'LICENSE',
  ...Object.keys(css.metafile.outputs).filter(file => file !== 'dist/panel.css').map(file => path.relative('dist', file))];
const artifactBytes = {};
for (const name of runtimeFiles) {
  const size = (await stat('dist/' + name)).size;
  artifactBytes[name] = size;
  console.log(`  ${name}: ${size} bytes`);
}
const dest = `publish/${manifest.id}.jpl`;
await createTar({ file: dest, cwd: 'dist', portable: true, strict: true, mtime: JPL_MTIME }, runtimeFiles);
const archive = await readFile(dest);
await writeFile(`publish/${manifest.id}.json`, JSON.stringify({ ...manifest,
  _publish_hash: 'sha256:' + createHash('sha256').update(archive).digest('hex') }, null, 2) + '\n');
await writeFile('publish/build-metadata.json', JSON.stringify({ format: 1, inputs: Object.keys(host.metafile.inputs),
  panelInputs: Object.keys(panel.metafile.inputs), runtime: 'browser-compatible JavaScript', artifactBytes, hostTranslationKeys: [...hostKeys].filter(key => key.includes('.')).sort(), archiveBytes: archive.length }, null, 2));
console.log(`Built ${dest} (${archive.length} bytes)`);
