const assert = require('node:assert/strict');
const path = require('node:path');
const { chromium } = require('playwright-core');

const originalLaunch = chromium.launchPersistentContext;
const profileDir = path.join(process.cwd(), '.unused-test-profile');
let closed = false;
let launchOptions;

chromium.launchPersistentContext = async (_profile, options) => {
  launchOptions = options;
  return ({
  pages: () => [page],
  close: async () => { closed = true; },
  });
};

const page = {
  goto: async () => {},
  url: () => 'https://muse.ai/thread/new',
  getByRole: () => ({ first: () => ({ waitFor: async () => { throw new Error('stop before sending'); } }) }),
};

async function main() {
  try {
    const { run } = require('../muse-multi-worker');
    const result = await run({
      root: process.cwd(), profileDir, chromePath: 'unused-chrome', tempDir: 'unused-downloads',
      tasks: [{ jobId: 'image-1', lane: 0, prompt: 'Ảnh: regression check', type: 'Ảnh', timeoutMs: 1000 }],
    });
    assert.equal(result.results[0].code, 'MUSE_LOGIN_REQUIRED');
    assert.equal(closed, true);
    assert.equal(launchOptions.headless, true);
    console.log('Multi-worker runs without a native Chrome window.');
  } finally {
    chromium.launchPersistentContext = originalLaunch;
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
