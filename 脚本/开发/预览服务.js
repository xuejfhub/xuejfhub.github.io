const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
const legacyPaths = require('../../配置/旧址映射.json');
const mime = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
function createServer() {
  return http.createServer(async (request, response) => {
    if (!['GET', 'HEAD'].includes(request.method)) { response.writeHead(405); response.end(); return; }
    try {
      const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
      const requested = pathname.replace(/^\/+/, '') || 'index.html';
      const relative = Object.hasOwn(legacyPaths, requested) ? legacyPaths[requested] : requested;
      if (relative !== requested && requested.endsWith('.html')) {
        const original = new URL(request.url, 'http://localhost');
        response.writeHead(302, { Location: encodeURI('/' + relative) + original.search, 'Cache-Control': 'no-store' });
        response.end(); return;
      }
      const normalized = relative.replace(/\\/g, '/');
      const allowed = ['index.html', '404.html'].includes(normalized) || /^(资源|页面)\//.test(normalized);
      const file = path.resolve(root, relative);
      if (!allowed || normalized.split('/').some(part => part === '..' || part.startsWith('.')) || !file.startsWith(root + path.sep)) {
        response.writeHead(404); response.end('Not found'); return;
      }
      const data = await fs.readFile(file);
      response.writeHead(200, { 'Content-Type': `${mime[path.extname(file)] || 'application/octet-stream'}; charset=utf-8`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      response.end(request.method === 'HEAD' ? undefined : data);
    } catch {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Not found');
    }
  });
}
if (require.main === module) {
  const port = Number(process.env.PORT || 4173);
  const server = createServer();
  server.on('error', error => { console.error(error.message); process.exitCode = 1; });
  server.listen(port, '127.0.0.1', () => console.log(`Preview: http://127.0.0.1:${port}`));
}
module.exports = { createServer };
