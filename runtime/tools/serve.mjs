import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
const assets = new Map([['/assets/runtime/index.html', ['../dist/index.html', 'text/html; charset=utf-8']], ['/assets/runtime/host.js', ['../dist/host.js', 'text/javascript; charset=utf-8']]]);
assets.set('/tests/capabilities/index.html', ['../.test-fixtures/capabilities/index.html', 'text/html; charset=utf-8']);
assets.set('/tests/capabilities/host.js', ['../.test-fixtures/capabilities/host.js', 'text/javascript; charset=utf-8']);
createServer(async (request, response) => {
  const asset = assets.get(new URL(request.url, 'http://localhost').pathname);
  if (!asset) { response.writeHead(403).end(); return; }
  try {
    const body = await readFile(new URL(asset[0], import.meta.url));
    response.writeHead(200, { 'Content-Type': asset[1], 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }).end(body);
  } catch { response.writeHead(500).end(); }
}).listen(4187, '127.0.0.1');
