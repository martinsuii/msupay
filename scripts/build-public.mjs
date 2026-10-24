import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { transform } from 'esbuild';

const ROOT = new URL('../public', import.meta.url).pathname;
let count = 0;

async function walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(full);
      continue;
    }
    const ext = extname(entry.name);
    if (ext !== '.js' && ext !== '.css') continue;
    if (entry.name.endsWith('.min.js') || entry.name.endsWith('.min.css')) continue;

    const source = await readFile(full, 'utf8');
    const result = await transform(source, {
      loader: ext === '.js' ? 'js' : 'css',
      minify: true,
      legalComments: 'none',
      drop: ext === '.js' ? ['console', 'debugger'] : [],
      charset: 'utf8',
    });
    const out = full.slice(0, -ext.length) + '.min' + ext;
    await writeFile(out, result.code);
    count += 1;
  }
}

await walk(ROOT);
console.log(`[build] minified ${count} public asset(s)`);
