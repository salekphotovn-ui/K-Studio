const QUOTA_MAX_AGE_MS = 10 * 60 * 1000;

function quotaSnapshot(account) {
  const observed = Date.parse(account.quotaObservedAt || '');
  const percent = Number(account.quotaUsedPct);
  if (!Number.isFinite(observed) || Date.now() - observed > QUOTA_MAX_AGE_MS || !Number.isFinite(percent) || percent < 0 || percent > 100) {
    return { quota_used_pct: null, quota_observed_at: null, quota_reset_label: null, additional_tokens: null };
  }
  return { quota_used_pct: percent, quota_observed_at: account.quotaObservedAt, quota_reset_label: account.quotaResetLabel || null, additional_tokens: account.additionalTokensLabel || null };
}

async function readMuseQuota(page) {
  if (!page || page.isClosed()) return null;
  let opened = false;
  try {
    await page.getByRole('button', { name: 'Settings', exact: true }).first().click({ timeout: 5000 });
    await page.getByText('Settings', { exact: true }).last().click({ timeout: 5000 });
    opened = true;
    await page.getByText('Usage', { exact: true }).last().click({ timeout: 5000 });
    await page.getByText(/Weekly limit resets on|Hạn mức tuần/i).first().waitFor({ state: 'visible', timeout: 7000 });
    return await page.evaluate(() => {
      const dialogs = [...document.querySelectorAll('[role="dialog"]')].map(element => element.innerText || '');
      const text = dialogs.find(value => /Weekly limit resets on|Hạn mức tuần/i.test(value)) || '';
      const lines = text.split('\n').map(line => line.trim()).filter(Boolean);
      const weekly = lines.findIndex(line => /Weekly limit resets on|Hạn mức tuần/i.test(line));
      if (weekly < 0) return null;
      const percentLine = lines.slice(weekly + 1, weekly + 5).find(line => /^\d{1,3}(?:[.,]\d{1,2})?\s*%\s*(?:used|đã dùng)?$/i.test(line));
      if (!percentLine) return null;
      const percent = Number(percentLine.match(/^\d{1,3}(?:[.,]\d{1,2})?/)[0].replace(',', '.'));
      if (!Number.isFinite(percent) || percent < 0 || percent > 100) return null;
      const extraIndex = lines.findIndex(line => /Additional tokens|Token bổ sung/i.test(line));
      const additionalTokensLabel = extraIndex >= 0 ? lines.slice(extraIndex + 1, extraIndex + 5).find(line => /tokens? left|token còn|%\s*used/i.test(line)) || null : null;
      return { percent, resetLabel: lines[weekly], additionalTokensLabel };
    });
  } catch {
    return null;
  } finally {
    if (opened) await page.getByRole('button', { name: 'Close', exact: true }).last().click({ timeout: 3000 }).catch(() => page.keyboard.press('Escape').catch(() => {}));
    else await page.keyboard.press('Escape').catch(() => {});
  }
}

module.exports = { quotaSnapshot, readMuseQuota };
