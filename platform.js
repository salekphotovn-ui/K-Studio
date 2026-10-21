const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { spawn, spawnSync } = require('node:child_process');

function dataRoot() {
  if (process.env.KSTUDIO_DATA_DIR) return path.resolve(process.env.KSTUDIO_DATA_DIR);
  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'K Studio');
  }
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'K Studio');
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'k-studio');
}

function chromeCandidates() {
  if (process.env.KSTUDIO_CHROME_PATH) return [process.env.KSTUDIO_CHROME_PATH];
  if (process.platform === 'darwin') return [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    path.join(os.homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
    '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  ];
  if (process.platform === 'win32') return [
    path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ].filter(Boolean);
  return ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
}

function findChrome() {
  return chromeCandidates().find(candidate => fs.existsSync(candidate)) || null;
}

function changeMuseWindowState() {
  // macOS first release leaves Muse visible to avoid Accessibility permission prompts.
  return true;
}

function watchMuseWindow() {
  return null;
}

function openPath(target, selectFile = false) {
  return new Promise((resolve, reject) => {
    let command, args;
    if (process.platform === 'darwin') {
      command = 'open';
      args = selectFile ? ['-R', target] : [target];
    } else if (process.platform === 'win32') {
      command = 'explorer.exe';
      args = [selectFile ? `/select,${target}` : target];
    } else {
      command = 'xdg-open';
      args = [target];
    }
    const child = spawn(command, args, { detached: true, stdio: 'ignore' });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}

function chooseOutputDirectory() {
  if (process.platform === 'darwin') {
    const result = spawnSync('osascript', ['-e', 'POSIX path of (choose folder with prompt "Chọn thư mục lưu kết quả K Studio")'], { encoding: 'utf8', timeout: 120000 });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      if (/User canceled|(-128)/i.test(result.stderr || result.stdout || '')) return '';
      throw new Error((result.stderr || result.stdout || 'Không mở được hộp thoại chọn thư mục.').trim());
    }
    return (result.stdout || '').trim().replace(/\/$/, '');
  }
  if (process.platform === 'win32') {
    const script = "Add-Type -AssemblyName System.Windows.Forms; $d=New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description='Chọn thư mục lưu kết quả K Studio'; if($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK){[Console]::Write($d.SelectedPath)}";
    const result = spawnSync('powershell.exe', ['-NoProfile', '-STA', '-Command', script], { encoding: 'utf8', windowsHide: false, timeout: 120000 });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error((result.stderr || 'Không mở được hộp thoại chọn thư mục.').trim());
    return (result.stdout || '').trim();
  }
  throw new Error('Hộp thoại chọn thư mục chưa hỗ trợ hệ điều hành này.');
}

module.exports = { dataRoot, chromeCandidates, findChrome, changeMuseWindowState, watchMuseWindow, openPath, chooseOutputDirectory };
