const { chromium } = require('playwright-core');

async function run(payload) {
  const context = await chromium.launchPersistentContext(payload.profileDir, {
    executablePath: payload.chromePath,
    headless: true,
    viewport: { width: 1160, height: 740 },
  });
  try {
    const page = context.pages()[0] || await context.newPage();
    await page.goto('https://muse.ai/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.getByRole('textbox', { name: /Message/i }).first().waitFor({ state: 'visible', timeout: 30000 });
    const heading = page.getByRole('button', { name: 'Side chats', exact: true });
    await heading.waitFor({ state: 'visible', timeout: 15000 });
    if (await heading.getAttribute('aria-expanded') === 'false') await heading.click();
    const section = heading.locator('xpath=ancestor::section[1]');
    const rows = section.locator('[data-testid="hatch-thread-row"]');
    const initialCount = await rows.count();
    if (initialCount > 500) throw new Error('Có quá 500 chat phụ; dừng để tránh xóa ngoài dự kiến.');
    if (payload.dryRun) return { ok: true, deleted: 0, initialCount };
    let deleted = 0;
    while (await rows.count()) {
      const before = await rows.count();
      const row = rows.first();
      const title = (await row.innerText()).trim();
      if (title === 'Main chat') throw new Error('Phát hiện Main chat trong danh sách chat phụ; dừng để bảo vệ Main chat.');
      await row.hover();
      await row.getByRole('button', { name: 'More thread actions' }).click({ timeout: 10000 });
      await page.getByRole('menuitem', { name: 'Delete', exact: true }).click({ timeout: 10000 });
      const dialog = page.getByRole('dialog', { name: 'Delete side chat?' });
      await dialog.waitFor({ state: 'visible', timeout: 10000 });
      await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
      await page.waitForFunction(count => {
        const heading = [...document.querySelectorAll('button')].find(button => button.textContent?.trim() === 'Side chats');
        const section = heading?.closest('section');
        return section && section.querySelectorAll('[data-testid="hatch-thread-row"]').length < count;
      }, before, { timeout: 15000 });
      deleted++;
      process.send?.({ kind: 'progress', deleted, initialCount });
    }
    return { ok: true, deleted, initialCount };
  } finally {
    await context.close();
  }
}

process.on('message', payload => {
  run(payload).then(result => { process.send?.(result, () => process.exit(0)); })
    .catch(error => { process.send?.({ ok: false, error: error.message }, () => process.exit(1)); });
});
