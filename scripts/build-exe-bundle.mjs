import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

const WEB_DIST_DIR = path.join(ROOT, 'packages', 'web', 'dist');
const CATALOG_DIR = path.join(ROOT, 'catalog', 'games');
const ENV_EXAMPLE_PATH = path.join(ROOT, '.env.example');
const OUT_DIR = path.join(ROOT, 'dist-exe');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.txt': 'text/plain; charset=utf-8',
};

function collectFilesRecursively(baseDir, currentDir = baseDir, acc = {}) {
  for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
    const fullPath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      collectFilesRecursively(baseDir, fullPath, acc);
    } else if (entry.isFile()) {
      const rel = path.relative(baseDir, fullPath).split(path.sep).join('/');
      const ext = path.extname(entry.name).toLowerCase();
      acc[rel] = {
        contentBase64: fs.readFileSync(fullPath).toString('base64'),
        mimeType: MIME_TYPES[ext] || 'application/octet-stream',
      };
    }
  }
  return acc;
}

if (!fs.existsSync(path.join(WEB_DIST_DIR, 'index.html'))) {
  console.error('Error: packages/web/dist/index.html not found. Run `pnpm build` first.');
  process.exit(1);
}

fs.mkdirSync(OUT_DIR, { recursive: true });

const webAssets = collectFilesRecursively(WEB_DIST_DIR);
const catalogFiles = {};
for (const file of fs.readdirSync(CATALOG_DIR)) {
  if (file.endsWith('.yaml') || file.endsWith('.yml')) {
    catalogFiles[file] = fs.readFileSync(path.join(CATALOG_DIR, file), 'utf8');
  }
}
const envExample = fs.existsSync(ENV_EXAMPLE_PATH) ? fs.readFileSync(ENV_EXAMPLE_PATH, 'utf8') : '';
const rootPkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const appVersion = rootPkg.version || '1.0.0';

const embeddedModuleCode = `
export const IS_BUNDLED_EXE = true;
export const EMBEDDED_APP_VERSION = ${JSON.stringify(appVersion)};
export const EMBEDDED_WEB_ASSETS = ${JSON.stringify(webAssets)};
export const EMBEDDED_CATALOG_FILES = ${JSON.stringify(catalogFiles)};
export const EMBEDDED_ENV_EXAMPLE = ${JSON.stringify(envExample)};
`;

const embeddedAssetsPlugin = {
  name: 'serverforge-embedded-assets',
  setup(b) {
    b.onLoad({ filter: /embedded-assets\.(ts|js)$/ }, () => ({
      contents: embeddedModuleCode,
      loader: 'js',
    }));
  },
};

const bundlePath = path.join(OUT_DIR, 'serverforge.cjs');

await build({
  entryPoints: [path.join(ROOT, 'packages', 'server', 'src', 'index.ts')],
  outfile: bundlePath,
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  minify: true,
  sourcemap: false,
  plugins: [embeddedAssetsPlugin],
  external: [
    // Built-in Node 22 SQLite & SEA modules
    'node:sqlite',
    'node:sea',
    // Optional native performance addons that gracefully fall back to pure JS
    'cpu-features',
    'zlib-sync',
    'bufferutil',
    'utf-8-validate',
    'erlpack',
    '*.node',
  ],
  logLevel: 'info',
});

const seaConfig = {
  main: 'serverforge.cjs',
  output: 'sea-prep.blob',
  disableExperimentalSEAWarning: true,
  useSnapshot: false,
  useCodeCache: false,
};

fs.writeFileSync(path.join(OUT_DIR, 'sea-config.json'), JSON.stringify(seaConfig, null, 2) + '\n', 'utf8');

const sizeMb = (fs.statSync(bundlePath).size / (1024 * 1024)).toFixed(2);
console.log(`\n[build-exe-bundle] Built ${bundlePath} (${sizeMb} MB)`);
console.log(`[build-exe-bundle] Embedded ${Object.keys(webAssets).length} web assets and ${Object.keys(catalogFiles).length} game templates.`);
