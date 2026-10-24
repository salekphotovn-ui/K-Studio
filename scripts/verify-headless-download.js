const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('playwright-core');
const { findChrome } = require('../platform');

async function main() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'kstudio-headless-'));
  const server = http.createServer((req, res) => {
    if (req.url === '/file') {
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="sample.txt"' });
      res.end('ok');
    } else {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<a href="/file">download</a>');
    }
  });
  let context;
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    context = await chromium.launchPersistentContext(profile, {
      executablePath: findChrome(), headless: true, acceptDownloads: true,
    });
    const page = context.pages()[0] || await context.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByText('download').click()]);
    const saved = path.join(profile, 'sample.txt');
    await download.saveAs(saved);
    if (fs.readFileSync(saved, 'utf8') !== 'ok') throw new Error('Downloaded content mismatch.');
    console.log('Headless Chrome saved a downloaded file.');
  } finally {
    if (context) await context.close();
    await new Promise(resolve => server.close(resolve));
    const base = path.resolve(os.tmpdir());
    const target = path.resolve(profile);
    if (!target.startsWith(base + path.sep)) throw new Error('Temporary profile is outside the temp directory.');
    fs.rmSync(target, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
