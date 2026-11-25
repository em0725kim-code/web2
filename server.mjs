import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { pipeline } from 'node:stream/promises';

const { createCatalog } = createRequire(import.meta.url)('./data.js');
const geoFile = new URL('./전국주유소표준데이터/HangJeongDong_ver20261001.geojson', import.meta.url);
const files = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
  ['/home-map.webp', ['home-map.webp', 'image/webp']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/data.js', ['data.js', 'text/javascript; charset=utf-8']],
  ['/map.js', ['map.js', 'text/javascript; charset=utf-8']],
  ['/boundaries.geojson', [geoFile, 'application/geo+json; charset=utf-8']],
]);
let catalog;
const server = createServer(async (request, response) => {
  response.setHeader('Content-Security-Policy', "default-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
  response.setHeader('X-Content-Type-Options', 'nosniff');
  const route = request.url?.split('?')[0];
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { Allow: 'GET, HEAD' }).end();
    return;
  }
  try {
    if (route === '/regions.json') {
      catalog ??= readFile(geoFile, 'utf8').then(json => JSON.stringify(createCatalog(JSON.parse(json).features)));
      const payload = await catalog.catch(error => { catalog = undefined; throw error; });
      response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(request.method === 'HEAD' ? undefined : payload);
      return;
    }
    const entry = files.get(route);
    if (!entry) {
      response.writeHead(404).end();
      return;
    }
    const file = new URL(entry[0], import.meta.url);
    const { size } = await stat(file);
    response.writeHead(200, { 'Content-Type': entry[1], 'Content-Length': size });
    if (request.method === 'HEAD') response.end();
    else await pipeline(createReadStream(file), response);
  } catch (error) {
    if (!response.headersSent) response.writeHead(error.code === 'ENOENT' ? 404 : 500).end();
    else if (!response.destroyed) response.destroy();
  }
});

const port = Number(process.argv[2] ?? 8787);
server.on('error', error => {
  console.error(error.code === 'EADDRINUSE' ? `Port ${port} is already in use.` : error.message);
  process.exitCode = 1;
});
server.listen(port, '127.0.0.1', () => {
  console.log(`Local app: http://127.0.0.1:${server.address().port}`);
  console.log('Keep this window open while using the app. Press Ctrl+C to stop.');
});
