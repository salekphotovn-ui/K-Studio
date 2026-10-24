const assert = require('node:assert/strict');
const path = require('node:path');
const childProcess = require('node:child_process');
const { chromium } = require('playwright-core');

const originalSpawnSync = childProcess.spawnSync;
const originalLaunch = chromium.launchPersistentContext;
const hideCalls = [];
const profileDir = path.join(process.cwd(), '.unused-test-profile');
let closed = false;

childProcess.spawnSync = (command, args) => {
  hideCalls.push({ command, args });
  return { status: 0 };
};
chromium.launchPersistentContext = async () => ({
  pages: () => [page],
  close: async () => { closed = true; },
});

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
    if (process.platform === 'win32') {
      assert.equal(hideCalls.length, 2);
      for (const call of hideCalls) {
        assert.equal(call.args[call.args.indexOf('-File') + 1], path.join(process.cwd(), 'muse-window.ps1'));
        assert.ok(call.args.includes(profileDir));
      }
    }
    console.log('Multi-worker receives the window script and profile paths.');
  } finally {
    childProcess.spawnSync = originalSpawnSync;
    chromium.launchPersistentContext = originalLaunch;
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
