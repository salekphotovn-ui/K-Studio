const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { chromium } = require('playwright-core');
const { readMuseQuota } = require('./muse-quota');

function hideWindow(root, profile) {
  spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', path.join(root, 'muse-window.ps1'), 'hide', profile, '0', '0', '1180', '850',
  ], { windowsHide: true, encoding: 'utf8', timeout: 12000 });
}

async function responseForPrompt(page, prompt) {
  return page.evaluate(promptText => {
    const normalize = value => String(value || '').replace(/\s+/g, ' ').trim();
    const needle = normalize(promptText);
    for (const container of document.querySelectorAll('[class*="max-w-3xl"]')) {
      const rows = [...container.children];
      let promptIndex = -1;
      for (let index = 0; index < rows.length; index++) {
        const text = normalize(rows[index].innerText);
        if (text.startsWith('You:') && text.includes(needle)) promptIndex = index;
      }
      if (promptIndex < 0) continue;
      let end = rows.length;
      for (let index = promptIndex + 1; index < rows.length; index++) {
        if (normalize(rows[index].innerText).startsWith('You:')) { end = index; break; }
      }
      const replies = rows.slice(promptIndex + 1, end);
      const buttons = replies.flatMap(row => [...row.querySelectorAll('button[aria-label]')]);
      const allImages = [...document.querySelectorAll('button[aria-label^="Open generated image"]')];
      const allVideos = [...document.querySelectorAll('button[aria-label^="Open generated video"],button[aria-label^="Open animated video"]')];
      const allEmbeddedVideos = [...document.querySelectorAll('video')];
      const allDownloads = [...document.querySelectorAll('button[aria-label="Download video"]')];
      const image = buttons.filter(button => allImages.includes(button)).at(-1);
      const video = buttons.filter(button => allVideos.includes(button)).at(-1);
      const embeddedVideo = replies.flatMap(row => [...row.querySelectorAll('video')]).at(-1);
      const directDownload = buttons.filter(button => allDownloads.includes(button)).at(-1);
      return {
        matched: true,
        replyText: replies.map(row => row.innerText || '').join('\n').slice(0, 3000),
        imageIndex: image ? allImages.indexOf(image) : -1,
        videoIndex: video ? allVideos.indexOf(video) : -1,
        embeddedVideoIndex: embeddedVideo ? allEmbeddedVideos.indexOf(embeddedVideo) : -1,
        directDownloadIndex: directDownload ? allDownloads.indexOf(directDownload) : -1,
      };
    }
    return { matched: false, replyText: '', imageIndex: -1, videoIndex: -1, embeddedVideoIndex: -1, directDownloadIndex: -1 };
  }, prompt);
}

async function saveEmbeddedVideo(page, videoIndex, tempDir, jobId) {
  const payload = await page.evaluate(async index => {
    const video = [...document.querySelectorAll('video')][index];
    const source = video?.currentSrc || video?.src || video?.querySelector('source')?.src;
    if (!source) throw new Error('Muse không có đường dẫn video để tải.');
    const response = await fetch(source);
    if (!response.ok) throw new Error(`Không tải được video nhúng (HTTP ${response.status}).`);
    const blob = await response.blob();
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 32768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
    return { base64: btoa(binary), mimeType: blob.type };
  }, videoIndex);
  const extension = /webm/i.test(payload.mimeType) ? '.webm' : /quicktime/i.test(payload.mimeType) ? '.mov' : '.mp4';
  fs.mkdirSync(tempDir, { recursive: true });
  const tempPath = path.join(tempDir, `${jobId}${extension}`);
  fs.writeFileSync(tempPath, Buffer.from(payload.base64, 'base64'));
  if (!fs.statSync(tempPath).size) throw new Error('Muse trả video rỗng.');
  return tempPath;
}

function scopedError(response) {
  const text = response.replyText || '';
  if (/weekly limit|usage limit|out of tokens|not enough tokens|hết token|hết hạn mức/i.test(text)) {
    const error = new Error('Muse báo hết token hoặc hạn mức.');
    error.code = 'MUSE_QUOTA';
    throw error;
  }
  const match = text.match(/something went wrong|generation failed|failed to generate|please try again later|temporarily unavailable|không thể tạo|không tạo được|gặp trục trặc khi tạo|tạo nội dung thất bại|đã xảy ra lỗi/i);
  if (match) {
    const error = new Error(`Muse báo lỗi tạo nội dung: ${text.slice(match.index, match.index + 300).trim()}`);
    error.code = 'MUSE_GENERATION_FAILED';
    throw error;
  }
}

async function run(payload) {
  const context = await chromium.launchPersistentContext(payload.profileDir, {
    executablePath: payload.chromePath,
    headless: false,
    viewport: { width: 1160, height: 740 },
    args: ['--window-size=1180,850', '--start-minimized'],
    acceptDownloads: true,
  });
  try {
    hideWindow(payload.root, payload.profileDir);
    const page = context.pages()[0] || await context.newPage();
    await page.goto(payload.chatUrl || 'https://muse.ai/thread/new', { waitUntil: 'domcontentloaded' });
    hideWindow(payload.root, payload.profileDir);
    const textbox = page.getByRole('textbox', { name: /Message/i }).first();
    try { await textbox.waitFor({ state: 'visible', timeout: 30000 }); }
    catch { const error = new Error('Phiên Muse cần đăng nhập lại.'); error.code = 'MUSE_LOGIN_REQUIRED'; throw error; }
    if (payload.referenceImagePath) {
      const attach = page.locator('button[aria-label="Attach file"]').first();
      if (!await attach.count()) throw new Error('Không tìm thấy nút đính kèm ảnh trên Muse.');
      const chooserPromise = page.waitForEvent('filechooser', { timeout: 10000 });
      await attach.click();
      const chooser = await chooserPromise;
      await chooser.setFiles(payload.referenceImagePath);
      await page.getByRole('button', { name: 'Remove attachment', exact: true }).first().waitFor({ state: 'visible', timeout: 15000 });
      await page.waitForTimeout(700);
    }
    await textbox.fill(payload.prompt);
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    const deadline = Date.now() + payload.timeoutMs;
    let response;
    while (Date.now() < deadline) {
      response = await responseForPrompt(page, payload.prompt);
      if (response.matched) {
        scopedError(response);
        const ready = payload.type === 'Ảnh' ? response.imageIndex >= 0 : response.videoIndex >= 0 || response.embeddedVideoIndex >= 0 || response.directDownloadIndex >= 0;
        if (ready) break;
      }
      await page.waitForTimeout(1200);
    }
    const ready = response && (payload.type === 'Ảnh' ? response.imageIndex >= 0 : response.videoIndex >= 0 || response.embeddedVideoIndex >= 0 || response.directDownloadIndex >= 0);
    if (!ready) throw new Error(`Muse chưa hiện ${payload.type.toLowerCase()} gắn với prompt này trong thời gian chờ tối đa.`);
    if (payload.type === 'Video' && response.videoIndex < 0 && response.directDownloadIndex < 0) {
      const tempPath = await saveEmbeddedVideo(page, response.embeddedVideoIndex, payload.tempDir, payload.jobId);
      const quota = await readMuseQuota(page).catch(() => null);
      return { ok: true, tempPath, quota, chatUrl: page.url() };
    }
    let downloadButton;
    if (payload.type === 'Ảnh') {
      await page.getByRole('button', { name: /Open generated image/i }).nth(response.imageIndex).click();
      downloadButton = page.getByRole('button', { name: 'Download', exact: true });
    } else if (response.directDownloadIndex >= 0) {
      downloadButton = page.locator('button[aria-label="Download video"]').nth(response.directDownloadIndex);
    } else {
      await page.getByRole('button', { name: /Open (?:generated|animated) video/i }).nth(response.videoIndex).click();
      downloadButton = page.getByRole('button', { name: /Download/i }).last();
    }
    await downloadButton.waitFor({ state: 'visible', timeout: 15000 });
    const downloadPromise = page.waitForEvent('download', { timeout: 60000 });
    await downloadButton.click();
    const download = await downloadPromise;
    fs.mkdirSync(payload.tempDir, { recursive: true });
    const extension = path.extname(download.suggestedFilename()) || (payload.type === 'Ảnh' ? '.webp' : '.mp4');
    const tempPath = path.join(payload.tempDir, `${payload.jobId}${extension}`);
    await download.saveAs(tempPath);
    const quota = await readMuseQuota(page).catch(() => null);
    return { ok: true, tempPath, quota, chatUrl: page.url() };
  } finally {
    await context.close().catch(() => {});
  }
}

process.on('message', async payload => {
  try { process.send(await run(payload)); }
  catch (error) { process.send({ ok: false, error: error.message, code: error.code || 'KSTUDIO_ERROR' }); }
  finally { process.disconnect(); }
});
