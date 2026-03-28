/**
 * Renders individual PDF pages to PNG images using a local HTTP server + puppeteer.
 * This avoids CORS/ESM issues with file:// URLs.
 */
import puppeteer from 'puppeteer';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const MIME = {
  '.html': 'text/html',
  '.mjs': 'text/javascript',
  '.js': 'text/javascript',
  '.png': 'image/png',
  '.pdf': 'application/pdf',
};

let server = null;
let browser = null;
let pupPage = null;
let port = 0;

const HTML = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>*{margin:0;padding:0;}canvas{display:block;}</style></head>
<body>
<canvas id="c"></canvas>
<script type="module">
import { getDocument, GlobalWorkerOptions } from '/pdfjs/pdf.mjs';
GlobalWorkerOptions.workerSrc = '/pdfjs/pdf.worker.mjs';

const params = new URLSearchParams(location.search);
const pdfUrl = params.get('pdf');
const pageNum = parseInt(params.get('page') || '1');
const scale = parseFloat(params.get('scale') || '2');

window.__done = false;
window.__err = null;

try {
  const resp = await fetch(pdfUrl);
  const buf = await resp.arrayBuffer();
  const pdf = await getDocument({ data: new Uint8Array(buf), disableWorker: true }).promise;
  const page = await pdf.getPage(pageNum);
  const vp = page.getViewport({ scale });
  const canvas = document.getElementById('c');
  canvas.width = vp.width;
  canvas.height = vp.height;
  await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
} catch(e) {
  window.__err = e.message;
}
window.__done = true;
</script>
</body></html>`;

export async function init() {
  // Start HTTP server
  server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;

    if (pathname === '/render') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(HTML);
      return;
    }

    if (pathname.startsWith('/pdfjs/')) {
      const file = pathname.replace('/pdfjs/', '');
      const filePath = path.join(__dirname, 'node_modules', 'pdfjs-dist', 'legacy', 'build', file);
      if (fs.existsSync(filePath)) {
        const ext = path.extname(filePath);
        res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
        fs.createReadStream(filePath).pipe(res);
      } else {
        res.writeHead(404); res.end();
      }
      return;
    }

    if (pathname.startsWith('/pdf/')) {
      // /pdf/<base64-encoded-absolute-path>
      const encoded = pathname.replace('/pdf/', '');
      const absPath = Buffer.from(encoded, 'base64url').toString('utf8');
      if (fs.existsSync(absPath)) {
        res.writeHead(200, { 'Content-Type': 'application/pdf' });
        fs.createReadStream(absPath).pipe(res);
      } else {
        res.writeHead(404); res.end('not found: ' + absPath);
      }
      return;
    }

    res.writeHead(404); res.end();
  });

  await new Promise(resolve => server.listen(0, '127.0.0.1', () => {
    port = server.address().port;
    resolve();
  }));

  browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
  pupPage = await browser.newPage();
  await pupPage.setViewport({ width: 2000, height: 1500 });
}

export async function close() {
  if (browser) await browser.close();
  if (server) server.close();
}

export async function renderPage(pdfAbsPath, pageNum, outPath, scale = 2.0) {
  const encodedPath = Buffer.from(pdfAbsPath, 'utf8').toString('base64url');
  const pdfUrl = `http://127.0.0.1:${port}/pdf/${encodedPath}`;
  const renderUrl = `http://127.0.0.1:${port}/render?pdf=${encodeURIComponent(pdfUrl)}&page=${pageNum}&scale=${scale}`;

  await pupPage.goto(renderUrl, { waitUntil: 'networkidle0', timeout: 30000 });
  await pupPage.waitForFunction(() => window.__done === true, { timeout: 20000 });

  const err = await pupPage.evaluate(() => window.__err);
  if (err) throw new Error(`Render error page ${pageNum}: ${err}`);

  const canvas = await pupPage.$('canvas');
  await canvas.screenshot({ path: outPath, type: 'png' });
  return outPath;
}

// Test when run directly
if (process.argv[1].endsWith('render_slide.mjs')) {
  await init();
  const out = 'C:\\Users\\noahm\\pdf_extract\\samples\\slide_test_p14.png';
  await renderPage('C:\\Users\\noahm\\downloads\\Pathology Slides\\2026 CCLN 3 Cardiovascular.pdf', 14, out);
  console.log('Saved:', out);
  await close();
}
