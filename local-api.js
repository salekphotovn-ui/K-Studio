const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { cropAvailable, parseAspectRatio, matchesAspect } = require('./media-transform');
const { quotaSnapshot } = require('./muse-quota');

const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp'];
const VIDEO_EXTENSIONS = ['.mp4', '.webm', '.mov'];
const MIME_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime' };
const ITEM_ID = /^[A-Za-z0-9_-]{1,80}$/;
const JOB_ID = /^[A-Za-z0-9_-]{1,120}$/;
const WINDOWS_DEVICE_NAME = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalJson(value[key])]));
  return value;
}

function inside(root, target) {
  const relative = path.relative(root, target);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function existingResult(base, type) {
  const extensions = type === 'Video' ? VIDEO_EXTENSIONS : IMAGE_EXTENSIONS;
  return extensions.map(ext => base + ext).find(file => fs.existsSync(file) && fs.statSync(file).isFile()) || null;
}

function finalizeTeamOutput(job) {
  if (!job.teamOutputBase || !job.outputPath) return;
  const extension = path.extname(job.outputPath).toLowerCase();
  const allowed = job.type === 'Video' ? VIDEO_EXTENSIONS : IMAGE_EXTENSIONS;
  if (!allowed.includes(extension)) throw new Error(`Định dạng kết quả ${extension || '(trống)'} chưa được API hỗ trợ.`);
  const target = job.teamOutputBase + extension;
  if (fs.existsSync(target)) throw new Error('File kết quả đã tồn tại; API không ghi đè.');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${job.teamOutputBase}.${crypto.randomUUID()}.part`;
  try {
    fs.copyFileSync(job.outputPath, temporary, fs.constants.COPYFILE_EXCL);
    if (fs.existsSync(target)) throw new Error('File kết quả đã tồn tại; API không ghi đè.');
    fs.renameSync(temporary, target);
    job.outputPath = target;
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function startLocalApi(deps) {
  const { dataRoot, outputRootDir, referenceDir, batches, accounts, queueBatch, persistHistory, runningBatches, accountReady, defaultQuotaThreshold, defaultWorkerCount } = deps;
  const configPath = path.join(dataRoot, 'local-api.json');
  let config;
  if (fs.existsSync(configPath)) config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  else {
    config = { enabled: true, host: '127.0.0.1', port: 4174, apiKey: crypto.randomBytes(32).toString('hex') };
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), { encoding: 'utf8', flag: 'wx' });
  }
  const host = String(config.host || '127.0.0.1');
  const port = Number(config.port || 4174);
  let key = String(config.apiKey || '');
  if (!key || key.length < 32 || !Number.isInteger(port) || port < 1 || port > 65535 || host !== '127.0.0.1') {
    throw new Error('Cấu hình local-api.json không hợp lệ: API chỉ được nghe ở 127.0.0.1, với khóa tối thiểu 32 ký tự và cổng hợp lệ.');
  }
  let listening = false;
  let listenError = null;
  const control = {
    status: () => ({ enabled: Boolean(config.enabled), listening, url: `http://${host}:${port}`, error: listenError }),
    reveal: () => key,
    rotate: () => {
      const next = crypto.randomBytes(32).toString('hex');
      const updated = { ...config, apiKey: next };
      fs.writeFileSync(configPath, JSON.stringify(updated, null, 2), 'utf8');
      config = updated;
      key = next;
      return { ok: true };
    },
  };
  if (!config.enabled) return control;

  function send(res, status, data) {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    res.end(JSON.stringify(data));
  }
  function authorized(req) {
    const supplied = req.headers['x-api-key'];
    if (typeof supplied !== 'string') return false;
    const a = Buffer.from(supplied), b = Buffer.from(key);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }
  function readJson(req) {
    return new Promise((resolve, reject) => {
      let length = 0;
      const chunks = [];
      req.on('data', chunk => {
        length += chunk.length;
        if (length > 90_000_000) { reject(new Error('Request vượt giới hạn 90 MB.')); req.destroy(); return; }
        chunks.push(chunk);
      });
      req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { reject(new Error('JSON không hợp lệ.')); } });
      req.on('error', reject);
    });
  }
  function state(batch) {
    if (batch.status === 'Đã hủy') return 'cancelled';
    if (batch.status.startsWith('Tạm dừng')) return 'paused';
    if (batch.status.startsWith('Hoàn tất')) return 'done';
    if (batch.status === 'Đang chạy trên Muse') return 'running';
    return 'queued';
  }
  function describe(batch) {
    const statuses = { 'Hoàn tất': 'done', 'Lỗi': 'failed', 'Trong hàng đợi': 'queued', 'Đã hủy': 'cancelled' };
    const items = batch.jobs.map(job => {
      const result = { id: job.externalId, state: job.localSkipped ? 'skipped' : statuses[job.status] || (job.status.startsWith('Đang') ? 'running' : 'failed') };
      if (batch.maxRetries != null) result.retries = job.retryCount || 0;
      if (job.quotaBeforePct != null) result.quota_before_pct = job.quotaBeforePct;
      if (job.quotaAfterPct != null) result.quota_after_pct = job.quotaAfterPct;
      if (job.quotaDeltaPct != null) result.quota_delta_pct = job.quotaDeltaPct;
      if (job.errorCode) result.error_code = job.errorCode;
      if (job.error) result.error = job.error;
      if (job.status === 'Hoàn tất' && job.outputPath) result.file = `/api/jobs/${encodeURIComponent(batch.externalJobId)}/files/${encodeURIComponent(job.externalId)}`;
      return result;
    });
    const counts = { done: 0, failed: 0, queued: 0, running: 0, cancelled: 0, skipped: 0 };
    for (const item of items) counts[item.state]++;
    const active = accounts.find(account => account.id === (batch.activeAccountId || batch.accountId));
    return { job_id: batch.externalJobId, state: state(batch), workers: batch.workers, ...counts, pending: counts.queued + counts.running, quota_threshold_pct: batch.quotaThreshold ?? defaultQuotaThreshold(), ...quotaSnapshot(active || {}), ...(batch.status.startsWith('Tạm dừng') && batch.error ? { reason: batch.error } : {}), items };
  }
  function findJob(id) {
    return Array.from(batches.values()).find(batch => batch.externalJobId === id);
  }
  function referenceImage(value, jobId) {
    if (value == null) return null;
    const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(value));
    if (!match) throw new Error('Ảnh tham chiếu phải là data URL PNG, JPG hoặc WebP.');
    const data = Buffer.from(match[2], 'base64');
    if (!data.length || data.length > 6 * 1024 * 1024 || data.toString('base64') !== match[2]) throw new Error('Ảnh tham chiếu không hợp lệ hoặc vượt 6 MB.');
    const extension = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' }[match[1]];
    fs.mkdirSync(referenceDir, { recursive: true });
    const file = path.join(referenceDir, jobId + extension);
    fs.writeFileSync(file, data, { flag: 'wx' });
    return file;
  }
  function referenceImageFile(value, jobId) {
    const source = String(value || '');
    const extension = path.extname(source).toLowerCase();
    if (!path.isAbsolute(source) || source.startsWith('\\\\') || !IMAGE_EXTENSIONS.includes(extension)) throw new Error('image phải là đường dẫn ảnh PNG, JPG hoặc WebP trên máy K Studio.');
    if (!fs.existsSync(source) || !fs.statSync(source).isFile() || fs.statSync(source).size > 6 * 1024 * 1024) throw new Error('Không tìm thấy ảnh tham chiếu hoặc ảnh vượt 6 MB.');
    fs.mkdirSync(referenceDir, { recursive: true });
    const file = path.join(referenceDir, jobId + extension);
    fs.copyFileSync(source, file, fs.constants.COPYFILE_EXCL);
    return file;
  }

  const api = http.createServer(async (req, res) => {
    if (!authorized(req)) return send(res, 401, { error: 'API key không hợp lệ.' });
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/api/health') return send(res, 200, { ok: true, version: require('./package.json').version, quota_threshold_pct: defaultQuotaThreshold(), default_workers: { image: defaultWorkerCount('Ảnh'), video: defaultWorkerCount('Video') }, accounts: accounts.filter(account => account.enabled).map(account => ({ name: account.name, ready: accountReady(account), quota_blocked: Boolean(account.quotaBlockedAt), estimated_next_image_pct: Math.max(1, Number(account.imageCostBufferPct) || 0), estimated_next_video_pct: Math.max(4, Number(account.videoCostBufferPct) || 0), ...quotaSnapshot(account) })), running_jobs: runningBatches.size });
    if (req.method === 'POST' && url.pathname === '/api/jobs') {
      try {
        const data = await readJson(req);
        const jobId = String(data.job_id || '');
        if (!JOB_ID.test(jobId) || WINDOWS_DEVICE_NAME.test(jobId)) return send(res, 400, { error: 'job_id chỉ gồm chữ, số, - và _ (tối đa 120 ký tự), không dùng tên thiết bị Windows.' });
        const type = data.type === 'video' ? 'Video' : data.type === 'image' ? 'Ảnh' : null;
        if (!type) return send(res, 400, { error: 'type phải là image hoặc video.' });
        const requestedWorkers = data.workers == null ? null : Number(data.workers);
        const workerMaximum = 5;
        if (requestedWorkers != null && (!Number.isInteger(requestedWorkers) || requestedWorkers < 1 || requestedWorkers > workerMaximum)) return send(res, 422, { error: `workers của ${type === 'Video' ? 'video' : 'ảnh'} phải là số nguyên từ 1 đến ${workerMaximum}.` });
        if (!Array.isArray(data.items) || !data.items.length || data.items.length > 300) return send(res, 400, { error: 'Mỗi lô cần 1–300 item.' });
        if (data.items.filter(item => item.image_data != null).length > 10) return send(res, 400, { error: 'Tối đa 10 ảnh base64 mỗi lô; dùng đường dẫn image trên máy cho lô lớn.' });
        if (data.images != null || data.overwrite != null || data.items.some(item => item.images != null)) return send(res, 422, { error: 'Phiên bản API này chưa hỗ trợ ảnh dùng chung hoặc overwrite.' });
        const aspectRatio = data.aspect_ratio == null ? null : parseAspectRatio(data.aspect_ratio);
        if (data.aspect_ratio != null && !aspectRatio) return send(res, 422, { error: 'aspect_ratio phải có dạng W:H, với tỉ lệ từ 1:4 đến 4:1.' });
        if (aspectRatio && !cropAvailable()) return send(res, 422, { error: 'Cần FFmpeg và FFprobe trên máy để đảm bảo đúng aspect_ratio. Đặt KSTUDIO_FFMPEG_PATH/KSTUDIO_FFPROBE_PATH hoặc thêm chúng vào PATH.' });
        const maxRetries = data.max_retries == null ? 1 : Number(data.max_retries);
        if (!Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 3) return send(res, 422, { error: 'max_retries phải là số nguyên từ 0 đến 3.' });
        const quotaThreshold = data.stop_if_quota_used_over_pct == null ? null : Number(data.stop_if_quota_used_over_pct);
        if (quotaThreshold != null && (!Number.isFinite(quotaThreshold) || quotaThreshold < 0 || quotaThreshold > 100)) return send(res, 422, { error: 'stop_if_quota_used_over_pct phải từ 0 đến 100.' });
        const ids = new Set();
        for (const item of data.items) {
          if (!ITEM_ID.test(String(item.id || '')) || WINDOWS_DEVICE_NAME.test(item.id) || ids.has(item.id) || !String(item.prompt || '').trim()) return send(res, 400, { error: 'Mỗi item cần id duy nhất, hợp lệ và prompt không rỗng.' });
          if ((item.image_data || item.image) && type !== 'Video') return send(res, 400, { error: 'Ảnh tham chiếu chỉ dùng cho video.' });
          if (item.image_data && item.image) return send(res, 400, { error: 'Mỗi item chỉ chọn image hoặc image_data.' });
          ids.add(item.id);
        }
        const rawDigest = crypto.createHash('sha256').update(JSON.stringify(data)).digest('hex');
        const digest = crypto.createHash('sha256').update(JSON.stringify(canonicalJson(data))).digest('hex');
        const previous = findJob(jobId);
        if (previous) return [digest, rawDigest].includes(previous.externalPayloadHash) ? send(res, 200, describe(previous)) : send(res, 409, { error: 'job_id đã được dùng với nội dung khác.' });
        const requestedAccount = data.account && data.account !== 'auto' ? accounts.find(account => (account.id === data.account || account.name === data.account) && account.enabled) : accounts.find(account => account.primary && account.enabled) || accounts.find(account => account.enabled);
        if (!requestedAccount) return send(res, 400, { error: 'Không tìm thấy tài khoản Muse đang bật.' });
        const configuredOutput = data.output_dir == null ? null : String(data.output_dir);
        if (configuredOutput && (!path.isAbsolute(configuredOutput) || configuredOutput.startsWith('\\\\'))) return send(res, 400, { error: 'output_dir phải là đường dẫn tuyệt đối trên máy này, không phải đường dẫn mạng.' });
        const dir = configuredOutput ? path.resolve(configuredOutput) : path.resolve(outputRootDir(), type === 'Video' ? 'videos' : 'images', jobId);
        const root = dir;
        if (aspectRatio && data.items.some(item => { const file = existingResult(path.join(dir, item.id), type); return file && !matchesAspect(file, aspectRatio); })) return send(res, 409, { error: 'File kết quả đã có nhưng khác aspect_ratio; dùng ID mới hoặc chuyển file cũ ra khỏi thư mục đích.' });
        if (data.skip_existing === false && data.items.some(item => existingResult(path.join(dir, item.id), type))) return send(res, 409, { error: 'Đã có file kết quả. API không ghi đè file hiện có.' });
        const batchWorkers = requestedWorkers || defaultWorkerCount(type);
        const batch = { id: crypto.randomUUID(), externalJobId: jobId, externalPayloadHash: digest, teamOutputRoot: root, status: 'Đang chờ', workers: batchWorkers, requestedWorkers, accountId: requestedAccount.id, aspectRatio: aspectRatio?.label || null, maxRetries, quotaThreshold, createdAt: new Date().toISOString(), jobs: [] };
        for (const item of data.items) {
          const id = crypto.randomUUID();
          const base = path.join(dir, item.id);
          const existing = existingResult(base, type);
          const cleanPrompt = String(item.prompt).replace(/^\s*(?:ảnh|anh|video)\s*:\s*/i, '').trim();
          const prompt = `${type === 'Ảnh' ? 'Ảnh:' : 'Video:'} ${cleanPrompt}`;
          const job = { id, externalId: item.id, prompt, type, status: existing && data.skip_existing !== false ? 'Hoàn tất' : 'Trong hàng đợi', outputPath: existing && data.skip_existing !== false ? existing : null, localSkipped: Boolean(existing && data.skip_existing !== false), teamOutputBase: base, aspectRatio: aspectRatio?.label || null, retryCount: 0 };
          if ((item.image_data || item.image) && job.status === 'Trong hàng đợi') job.referenceImagePath = item.image_data ? referenceImage(item.image_data, id) : referenceImageFile(item.image, id);
          batch.jobs.push(job);
        }
        batches.set(batch.id, batch);
        persistHistory();
        if (batch.jobs.some(job => job.status === 'Trong hàng đợi')) queueBatch(batch);
        else { batch.status = 'Hoàn tất'; persistHistory(); }
        return send(res, 201, describe(batch));
      } catch (error) { return send(res, 400, { error: error.message }); }
    }
    const match = /^\/api\/jobs\/([A-Za-z0-9_-]+)(?:\/(retry|cancel|resume|files\/([A-Za-z0-9_-]+)))?$/.exec(url.pathname);
    if (match) {
      const batch = findJob(match[1]);
      if (!batch) return send(res, 404, { error: 'Không tìm thấy lô.' });
      if (req.method === 'GET' && !match[2]) {
        const wait = Math.min(1800, Math.max(0, Number(url.searchParams.get('wait')) || 0));
        const end = Date.now() + wait * 1000;
        while (Date.now() < end && !['done', 'cancelled', 'paused'].includes(state(batch))) await new Promise(resolve => setTimeout(resolve, 1000));
        return send(res, 200, describe(batch));
      }
      if (req.method === 'GET' && match[3]) {
        const job = batch.jobs.find(item => item.externalId === match[3]);
        if (!job || job.status !== 'Hoàn tất' || !job.outputPath || !fs.existsSync(job.outputPath) || !inside(batch.teamOutputRoot || outputRootDir(), path.resolve(job.outputPath))) return send(res, 404, { error: 'Chưa có file kết quả.' });
        const extension = path.extname(job.outputPath).toLowerCase();
        res.writeHead(200, { 'content-type': MIME_TYPES[extension] || 'application/octet-stream', 'content-disposition': `attachment; filename="${job.externalId}${extension}"`, 'content-length': fs.statSync(job.outputPath).size, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
        return fs.createReadStream(job.outputPath).pipe(res);
      }
      if (req.method === 'POST' && match[2] === 'cancel') {
        if (['done', 'cancelled'].includes(state(batch))) return send(res, 200, describe(batch));
        batch.cancelRequested = true;
        for (const job of batch.jobs) if (job.status === 'Trong hàng đợi') job.status = 'Đã hủy';
        if (!runningBatches.has(batch.id)) batch.status = 'Đã hủy';
        persistHistory();
        return send(res, 200, describe(batch));
      }
      if (req.method === 'POST' && match[2] === 'resume') {
        if (!batch.status.startsWith('Tạm dừng') || !batch.jobs.some(job => job.status === 'Trong hàng đợi')) return send(res, 409, { error: 'Lô không có item đang tạm dừng.' });
        batch.error = null;
        batch.status = 'Đang chờ';
        persistHistory(); queueBatch(batch);
        return send(res, 200, describe(batch));
      }
      if (req.method === 'POST' && match[2] === 'retry') {
        if (runningBatches.has(batch.id)) return send(res, 409, { error: 'Đợi lô đang chạy kết thúc trước khi thử lại.' });
        try {
          const data = await readJson(req);
          const ids = Array.isArray(data.ids) ? data.ids.map(String) : [];
          if (data.ids != null && !Array.isArray(data.ids)) return send(res, 422, { error: 'ids phải là một mảng ID item.' });
          const updates = new Map();
          if (data.items != null) {
            if (!Array.isArray(data.items) || data.items.length > 300) return send(res, 422, { error: 'items phải là mảng tối đa 300 item dạng {id,prompt}.' });
            for (const item of data.items) {
              const id = String(item?.id || ''), prompt = String(item?.prompt || '').trim();
              if (!JOB_ID.test(id) || WINDOWS_DEVICE_NAME.test(id) || !prompt || updates.has(id)) return send(res, 422, { error: 'Mỗi item sửa prompt cần ID hợp lệ, duy nhất và prompt không rỗng.' });
              const cleanPrompt = prompt.replace(/^\s*(?:ảnh|anh|video)\s*:\s*/i, '').trim();
              if (!cleanPrompt) return send(res, 422, { error: `Prompt mới của item ${id} không được để trống.` });
              updates.set(id, cleanPrompt);
            }
          }
          const selectedIds = new Set([...ids, ...updates.keys()]);
          if (selectedIds.size > 300) return send(res, 422, { error: 'Tối đa 300 item mỗi lần thử lại.' });
          if (ids.some(id => !JOB_ID.test(id) || WINDOWS_DEVICE_NAME.test(id))) return send(res, 422, { error: 'ids chứa ID không hợp lệ.' });
          const failed = batch.jobs.filter(job => job.status === 'Lỗi');
          if ([...selectedIds].some(id => !failed.some(job => job.externalId === id))) return send(res, 409, { error: 'Chỉ có thể thử lại hoặc sửa prompt cho item đang lỗi trong lô này.' });
          const selected = failed.filter(job => selectedIds.size === 0 || selectedIds.has(job.externalId));
          if (!selected.length) return send(res, 400, { error: 'Không có item lỗi phù hợp.' });
          for (const job of selected) {
            const revised = updates.get(job.externalId);
            if (revised) job.prompt = `${job.type === 'Ảnh' ? 'Ảnh:' : 'Video:'} ${revised}`;
            job.status = 'Trong hàng đợi'; job.error = null; job.errorCode = null; job.startedAt = null; job.finishedAt = null; job.promptSent = false; job.retryCount = 0;
          }
          batch.cancelRequested = false;
          batch.status = 'Đang chờ';
          persistHistory(); queueBatch(batch);
          return send(res, 200, describe(batch));
        } catch (error) { return send(res, 400, { error: error.message }); }
      }
    }
    return send(res, 404, { error: 'Không tìm thấy endpoint.' });
  });
  api.listen(port, host, () => { listening = true; console.log(`K Studio local API: http://${host}:${port}`); });
  api.on('error', error => { listenError = error.message; listening = false; console.error(`Không mở được local API: ${error.message}`); });
  return control;
}

module.exports = { startLocalApi, finalizeTeamOutput };
