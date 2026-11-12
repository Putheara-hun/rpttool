// Production server: serves the built designer (dist/) and the database API on localhost.
//   npm run build && npm start      ->  http://localhost:5174
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApiHandler } from './api.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const PORT = Number(process.env.PORT) || 5174;
const HOST = process.env.HOST || '127.0.0.1';
const FRAME_ANCESTORS = (process.env.REPORTTOOL_FRAME_ANCESTORS ?? '').replace(/[;\r\n]/g, ' ').trim();
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
  '.mjs': 'text/javascript; charset=utf-8',
};

const api = createApiHandler();

function serveStatic(req, res) {
  const urlPath = decodeURIComponent((req.url ?? '/').split('?')[0]);
  let file = path.normalize(path.join(ROOT, urlPath));
  if (!file.startsWith(ROOT)) {
    res.statusCode = 403;
    return res.end('Forbidden');
  }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(ROOT, 'index.html');
  if (!fs.existsSync(file)) {
    res.statusCode = 404;
    return res.end('Build the app first: npm run build');
  }
  res.setHeader('Content-Type', TYPES[path.extname(file)] ?? 'application/octet-stream');
  // which systems may show the designer in an iframe, e.g. REPORTTOOL_FRAME_ANCESTORS="https://erp.example.com https://hr.example.com"
  if (FRAME_ANCESTORS && path.extname(file) === '.html') res.setHeader('Content-Security-Policy', `frame-ancestors 'self' ${FRAME_ANCESTORS}`);
  fs.createReadStream(file).pipe(res);
}

http
  .createServer((req, res) => api(req, res, () => serveStatic(req, res)))
  .listen(PORT, HOST, () => console.log(`ReportTool running at http://${HOST === '127.0.0.1' ? 'localhost' : HOST}:${PORT}`));
