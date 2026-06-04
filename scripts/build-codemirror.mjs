import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

await mkdir(path.join(rootDir, 'vendor'), { recursive: true });

await build({
  entryPoints: [path.join(rootDir, 'src', 'codemirror-editor.js')],
  outfile: path.join(rootDir, 'vendor', 'codemirror-editor.bundle.js'),
  bundle: true,
  format: 'iife',
  globalName: 'MonospireCodeMirror',
  platform: 'browser',
  target: ['chrome120'],
  sourcemap: false,
  minify: false,
  legalComments: 'none'
});
