// ponytail: esbuild build script — no config framework, ~40 lines
import * as esbuild from 'esbuild';
import { mkdirSync, cpSync, rmSync } from 'fs';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const root = dirname(fileURLToPath(import.meta.url));
// --firefox: same code, Firefox-flavored manifest (event page + gecko block) —
// one manifest.json in src stays Chromium; the FF delta lives here so the two
// can't drift. Output goes to dist-firefox/; zip it for AMO.
const firefox = process.argv.includes('--firefox');
// --release: store submission build — frozen version (from package.json),
// no dev model bundle (runtime download instead), zipped for upload
const release = process.argv.includes('--release');
const pkgVersion = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const dist = join(root, firefox ? 'dist-firefox' : 'dist');
// clean: stale files (e.g. previously-bundled models) must never survive
// into a build that no longer ships them
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

// build marker — content script logs it so you can verify in the page
// console which build the browser actually runs (stale tabs linger).
// hash = last commit; '*' suffix = uncommitted changes are included, so
// an unmarked hash is exactly that commit.
let buildId = 'dev';
try {
  const hash = execSync('git log -1 --format=%h', { cwd: root }).toString().trim();
  // release builds must be byte-reproducible (AMO rebuilds from source and
  // diffs) — no clock in the marker, version+commit only
  buildId = release ? `${pkgVersion}+${hash}` : buildId;
  if (!release) {
    const dirty = execSync('git status --porcelain -- src build.mjs', { cwd: root }).toString().trim().length > 0;
    buildId = hash + (dirty ? '*' : '') + ' ' + new Date().toISOString().slice(11, 19);
  }
} catch { /* not a repo — dev */ }

await Promise.all([
  // content scripts in MV3 must be classic scripts (no ESM/import.meta)
  esbuild.build({
    entryPoints: { content: join(root, 'src/content/content.ts') },
    bundle: true,
    format: 'iife',
    target: 'chrome120',
    minify: true,
    sourcemap: process.argv.includes('--watch') ? 'inline' : false,
    outfile: join(dist, 'content.js'),
    define: { 'process.env.NODE_ENV': '"production"', '__BUILD_ID__': JSON.stringify(buildId) },
    loader: { '.ts': 'ts' },
    banner: { js: 'var __dirname;' },
  }),
  // iframe inference worker — ORT stays external (loaded via importmap in worker.html;
  // bundling Emscripten output through esbuild breaks it)
  esbuild.build({
    entryPoints: { 'iframe-worker': join(root, 'src/iframe/worker.ts') },
    bundle: true,
    format: 'esm',
    target: 'chrome120',
    minify: true,
    outfile: join(dist, 'iframe/iframe-worker.js'),
    define: { 'process.env.NODE_ENV': '"production"' },
    loader: { '.ts': 'ts' },
    external: ['ort'],
  }),
  esbuild.build({
    entryPoints: { background: join(root, 'src/background/background.ts') },
    bundle: true,
    format: 'esm',
    target: 'chrome120',
    minify: true,
    sourcemap: process.argv.includes('--watch') ? 'inline' : false,
    outfile: join(dist, 'background.js'),
    define: { 'process.env.NODE_ENV': '"production"' },
    loader: { '.ts': 'ts' },
  }),
]);

// static assets
// manifest gets a unique patch version each build: Chrome caches MV3
// service-worker code per extension version — without a bump, a reused
// profile keeps running the OLD background (stale prompt/parser) while the
// content script updates per-page. Lived this: 'llm raw (unavailable)'.
import { readFileSync, writeFileSync } from 'fs';
const manifest = JSON.parse(readFileSync(join(root, 'src/manifest.json'), 'utf8'));
if (release) {
  manifest.version = pkgVersion; // frozen — stores reject moving versions
} else {
  const [maj, min] = (manifest.version ?? '0.1').split('.');
  manifest.version = `${maj}.${min}.${Math.floor(Date.now() / 60000)}`; // minutes since epoch
}
if (firefox) {
  // Firefox MV3 ignores background.service_worker (uses background.scripts event
  // page instead; same message-driven code runs fine there) and needs a gecko id
  // for AMO. captureVisibleTab+activeTab needs FF126 → strict_min_version.
  // service_worker key dropped (FF ignores it — warning noise only, scripts wins)
  manifest.background = { scripts: ['background.js'], type: 'module' };
  manifest.browser_specific_settings = {
    // data_collection_permissions.required=['websiteContent'] is honest, not
    // boilerplate: translation POSTs page images/text to the user's own LLM or
    // cloud endpoint. AMO mandates this key for new submissions (Nov 2025+) and
    // it needs FF140 → strict_min_version (ESR128 is EOL anyway).
    gecko: { id: 'arn-manga-llm-translator@c0ffeeoverdose', strict_min_version: '140.0', data_collection_permissions: { required: ['websiteContent'] } },
    // Present = the add-on is offered on Firefox for Android (without it AMO is
    // desktop-only). 142 is the first Android FF that understands gecko's
    // data_collection_permissions, so it silences the AMO linter warning.
    gecko_android: { strict_min_version: '142.0' },
  };
}
writeFileSync(join(dist, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log(`manifest version ${manifest.version} (forces fresh service worker)`);
mkdirSync(join(dist, 'models'), { recursive: true });
// detection weights are runtime downloads (HF mirror, cached in IDB) —
// bundling is dev-only (release zips ship no weights: 50MB stays out of the
// package and every update). Missing files warn, never fail: on-device
// inference fetches them on first use, cloud users never need them.
if (!release) {
for (const [file, hint] of [
  ['models/ctd-int8.onnx', 'run: sh scripts/fetch-models.sh  (dev/E2E only — users download on first use)'],
  ['models/panel-yolo26n.onnx', 'run: scripts/export-panel-onnx.sh  (dev/E2E only — users download on first use)'],
]) {
  try {
    cpSync(join(root, file), join(dist, file));
  } catch {
    console.warn(`WARN: ${file} not bundled — ${hint}`);
  }
}
}
// ORT wasm binaries (fetched at runtime via env.wasm.wasmPaths)
mkdirSync(join(dist, 'ort'), { recursive: true });
// ORT 1.29+: webgpu + wasm both load the asyncify build (.mjs glue + .wasm);
// the plain simd-threaded pair covers a wasm-only fallback
for (const f of [
  'ort-wasm-simd-threaded.asyncify.mjs', 'ort-wasm-simd-threaded.asyncify.wasm',
  'ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm',
  'ort.webgpu.bundle.min.mjs',
]) {
  try { cpSync(join(root, `node_modules/onnxruntime-web/dist/${f}`), join(dist, 'ort', f)); }
  catch { console.warn(`WARN: ${f} not copied`); }
}
// Tesseract engine (bundled — MV3 forbids remote scripts; only the language
// data is user-managed via CDN download). simd-lstm only: Chromium always
// has SIMD, and we only ever use the LSTM engine.
mkdirSync(join(dist, 'tesseract'), { recursive: true });
for (const f of ['tesseract.min.js', 'worker.min.js']) {
  try { cpSync(join(root, `node_modules/tesseract.js/dist/${f}`), join(dist, 'tesseract', f)); }
  catch { console.warn(`WARN: tesseract.js ${f} not copied`); }
}
for (const f of ['tesseract-core-simd-lstm.wasm.js', 'tesseract-core-simd-lstm.wasm']) {
  try { cpSync(join(root, `node_modules/tesseract.js-core/${f}`), join(dist, 'tesseract', f)); }
  catch { console.warn(`WARN: tesseract-core ${f} not copied`); }
}
// iframe worker page
mkdirSync(join(dist, 'iframe'), { recursive: true });
cpSync(join(root, 'src/iframe/worker.html'), join(dist, 'iframe/worker.html'));
// options page (esbuild handles the JS; HTML copied)
mkdirSync(join(dist, 'options'), { recursive: true });
cpSync(join(root, 'src/options/options.html'), join(dist, 'options/options.html'));
// fixed OCR self-test image (deterministic pixels — never generated at runtime)
cpSync(join(root, 'src/options/ocr-test.png'), join(dist, 'options/ocr-test.png'));
await esbuild.build({
  entryPoints: { options: join(root, 'src/options/options.ts') },
  bundle: true,
  format: 'esm',
  target: 'chrome120',
  minify: true,
  outfile: join(dist, 'options/options.js'),
  define: { 'process.env.NODE_ENV': '"production"' },
  loader: { '.ts': 'ts' },
});
// action popup
mkdirSync(join(dist, 'popup'), { recursive: true });
cpSync(join(root, 'src/popup/popup.html'), join(dist, 'popup/popup.html'));
await esbuild.build({
  entryPoints: { popup: join(root, 'src/popup/popup.ts') },
  bundle: true,
  format: 'esm',
  target: 'chrome120',
  minify: true,
  outfile: join(dist, 'popup/popup.js'),
  define: { 'process.env.NODE_ENV': '"production"' },
  loader: { '.ts': 'ts' },
});
// fonts
mkdirSync(join(dist, 'fonts'), { recursive: true });
cpSync(join(root, 'src/fonts/Sriracha-Regular.ttf'), join(dist, 'fonts/Sriracha-Regular.ttf'));
// toolbar + store icons (CWS requires the 128px icon inside the zip)
mkdirSync(join(dist, 'icons'), { recursive: true });
cpSync(join(root, 'src/icons'), join(dist, 'icons'), { recursive: true });

// license: GPL-3.0 (CTD bundle) — distributed zips must carry both files
for (const f of ['LICENSE', 'NOTICE']) cpSync(join(root, f), join(dist, f));

if (release) {
  // store upload artifact: <name>-<version>-{chrome,firefox}.zip next to dist
  const out = join(root, `arn-manga-${pkgVersion}-${firefox ? 'firefox' : 'chrome'}.zip`);
  execSync(`zip -qr ${out} .`, { cwd: dist });
  console.log('release zip ->', out);
}

console.log(process.argv.includes('--watch') ? 'built (watch off — use rebuild for now)' : 'built ->', dist);
