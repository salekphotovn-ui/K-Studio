const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');

const ffmpeg = process.env.KSTUDIO_FFMPEG_PATH || 'ffmpeg';
const ffprobe = process.env.KSTUDIO_FFPROBE_PATH || (process.env.KSTUDIO_FFMPEG_PATH ? path.join(path.dirname(ffmpeg), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe') : 'ffprobe');

function toolAvailable(command) {
  const result = spawnSync(command, ['-version'], { windowsHide: true, timeout: 5000, stdio: 'ignore' });
  return !result.error && result.status === 0;
}

function cropAvailable() { return toolAvailable(ffmpeg) && toolAvailable(ffprobe); }

function parseAspectRatio(value) {
  if (value == null) return null;
  const match = /^(\d{1,2}):(\d{1,2})$/.exec(String(value));
  if (!match) return null;
  const width = Number(match[1]), height = Number(match[2]);
  if (!width || !height || width / height < 0.25 || width / height > 4) return null;
  const gcd = (a, b) => b ? gcd(b, a % b) : a;
  const divisor = gcd(width, height);
  return { label: `${width}:${height}`, value: width / height, width: width / divisor, height: height / divisor };
}

function run(command, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let errorText = '', settled = false;
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stderr.on('data', chunk => { errorText = (errorText + chunk.toString()).slice(-4000); });
    child.once('error', error => { if (!settled) { settled = true; clearTimeout(timer); reject(error); } });
    child.once('close', code => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (code === 0) resolve(errorText);
      else reject(new Error(`FFmpeg không xử lý được tỉ lệ khung hình: ${errorText.slice(-800) || `mã ${code}`}`));
    });
  });
}

function dimensions(file) {
  const info = spawnSync(ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'json', file], { encoding: 'utf8', windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024 });
  if (info.error || info.status !== 0) throw new Error('Không đọc được kích thước file kết quả để áp dụng tỉ lệ khung hình.');
  const stream = JSON.parse(info.stdout).streams?.[0];
  const sourceWidth = Number(stream?.width), sourceHeight = Number(stream?.height);
  if (!sourceWidth || !sourceHeight) throw new Error('File kết quả không có kích thước ảnh/video hợp lệ.');
  return { width: sourceWidth, height: sourceHeight };
}

function matchesAspect(file, aspectRatio) {
  const { width, height } = dimensions(file);
  return width * aspectRatio.height === height * aspectRatio.width;
}

async function cropToAspect(file, type, aspectRatio) {
  if (!aspectRatio) return file;
  const { width: sourceWidth, height: sourceHeight } = dimensions(file);
  const multiplier = type === 'Video' && (aspectRatio.width % 2 || aspectRatio.height % 2) ? 2 : 1;
  const unitWidth = aspectRatio.width * multiplier, unitHeight = aspectRatio.height * multiplier;
  const scale = Math.floor(Math.min(sourceWidth / unitWidth, sourceHeight / unitHeight));
  const width = unitWidth * scale, height = unitHeight * scale;
  if (width < 2 || height < 2) throw new Error('File kết quả quá nhỏ để cắt theo tỉ lệ yêu cầu.');
  if (width === sourceWidth && height === sourceHeight) return file;

  const extension = type === 'Video' ? '.mp4' : '.png';
  const target = path.join(path.dirname(file), path.parse(file).name + extension);
  const temporary = path.join(path.dirname(file), `.${path.parse(file).name}.${crypto.randomUUID()}${extension}`);
  const filter = `crop=${width}:${height}:${Math.floor((sourceWidth - width) / 2)}:${Math.floor((sourceHeight - height) / 2)}`;
  const args = type === 'Video'
    ? ['-v', 'error', '-nostdin', '-y', '-i', file, '-map', '0:v:0', '-map', '0:a?', '-vf', filter, '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', temporary]
    : ['-v', 'error', '-nostdin', '-y', '-i', file, '-vf', filter, '-frames:v', '1', temporary];
  try {
    await run(ffmpeg, args, 10 * 60 * 1000);
    if (!fs.existsSync(temporary) || !fs.statSync(temporary).size) throw new Error('FFmpeg không tạo được file đã cắt.');
    const backup = `${file}.${crypto.randomUUID()}.original`;
    if (target !== file && fs.existsSync(target)) throw new Error('File đích đã tồn tại; không ghi đè khi cắt tỉ lệ.');
    fs.renameSync(file, backup);
    try {
      fs.renameSync(temporary, target);
    } catch (error) {
      fs.renameSync(backup, file);
      throw error;
    }
    try { fs.unlinkSync(backup); } catch {}
    return target;
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

module.exports = { cropAvailable, parseAspectRatio, matchesAspect, cropToAspect };
