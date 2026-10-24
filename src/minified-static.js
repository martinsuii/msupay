import { existsSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';

// Serves the pre-minified sibling (x.min.js / x.min.css) when it exists, so
// the browser never receives source comments and internal implementation
// details. Falls back to the original file during development.
export function minifiedStatic(dir) {
  return (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    const ext = extname(req.path);
    if (ext !== '.js' && ext !== '.css') return next();

    let rel;
    try {
      rel = normalize(decodeURIComponent(req.path)).replace(/^[/\\]+/, '');
    } catch {
      return next();
    }
    if (!rel || rel.startsWith('..')) return next();

    const minPath = join(dir, rel.slice(0, -ext.length) + '.min' + ext);
    if (existsSync(minPath)) return res.sendFile(minPath);
    return next();
  };
}
