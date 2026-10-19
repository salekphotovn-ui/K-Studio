$ErrorActionPreference = 'Stop'
$installRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$installed = Get-Content -LiteralPath (Join-Path $installRoot 'package.json') -Raw | ConvertFrom-Json
$currentVersion = [version]$installed.version
$repository = if ($env:KSTUDIO_UPDATE_REPO) { $env:KSTUDIO_UPDATE_REPO } else { 'salekphotovn-ui/K-Studio' }
if ($repository -notmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$') { throw 'Tên kho cập nhật không hợp lệ.' }

function Assert-NoPendingJobs {
  $listener = Get-NetTCPConnection -LocalPort 4173 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $listener) { return $null }
  try {
    $serverProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $($listener.OwningProcess)"
    $bundledNode = Join-Path $installRoot 'runtime\node.exe'
    if (-not $serverProcess -or $serverProcess.ExecutablePath -ine $bundledNode) { throw 'Cổng 4173 đang được một tiến trình khác sử dụng.' }
    $version = Invoke-RestMethod -Uri 'http://127.0.0.1:4173/api/version' -TimeoutSec 4
    if (-not $version.appVersion) { throw 'Không nhận diện được máy chủ K Studio.' }
    $batches = @(Invoke-RestMethod -Uri 'http://127.0.0.1:4173/api/history' -TimeoutSec 5)
    $pending = @($batches | ForEach-Object { $_.jobs } | Where-Object { $_.status -notin @('Hoàn tất', 'Lỗi') })
    if ($pending.Count -gt 0) { throw "Còn $($pending.Count) tác vụ chưa kết thúc. Hãy xử lý hàng đợi trước khi cập nhật." }
    return $listener.OwningProcess
  } catch {
    throw "Không thể xác nhận K Studio đang rảnh: $($_.Exception.Message)"
  }
}

Write-Host "K Studio hiện tại: v$currentVersion" -ForegroundColor Cyan
$apiUrl = "https://api.github.com/repos/$repository/releases/latest"
$useGh = $false
$gh = Get-Command gh.exe -ErrorAction SilentlyContinue
if ($gh) {
  try {
    $releaseJson = & $gh.Source api "repos/$repository/releases/latest" 2>$null
    if ($LASTEXITCODE -eq 0) {
      $release = ($releaseJson -join "`n") | ConvertFrom-Json
      $useGh = $true
    }
  } catch { $useGh = $false }
}
if (-not $useGh) {
  try {
    $release = Invoke-RestMethod -Uri $apiUrl -Headers @{ 'User-Agent' = 'K-Studio-Updater'; 'Accept' = 'application/vnd.github+json' } -TimeoutSec 20
  } catch {
    throw 'Không đọc được bản phát hành. Nếu kho GitHub là riêng tư, hãy cài GitHub CLI, chạy gh auth login trên máy này và đảm bảo tài khoản có quyền truy cập kho.'
  }
}
if ($release.draft -or $release.prerelease -or $release.tag_name -notmatch '^v?(\d+\.\d+\.\d+)$') { throw 'Thông tin phiên bản trên GitHub không hợp lệ.' }
$latestVersion = [version]$Matches[1]
if ($latestVersion -le $currentVersion) { Write-Host 'Máy này đã có phiên bản mới nhất.' -ForegroundColor Green; return }

$assetName = "K-Studio-Setup-v$latestVersion.exe"
$asset = @($release.assets | Where-Object { $_.name -ceq $assetName }) | Select-Object -First 1
if (-not $asset -or $asset.digest -notmatch '^sha256:([0-9a-fA-F]{64})$') { throw 'Bản phát hành thiếu bộ cài hoặc mã SHA-256. Chưa thể cập nhật an toàn.' }
$expectedHash = $Matches[1].ToUpperInvariant()
$expectedPrefix = "https://github.com/$repository/releases/download/"
if (-not $asset.browser_download_url.StartsWith($expectedPrefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'Địa chỉ tải bộ cài không hợp lệ.' }

Write-Host "Có bản mới: v$latestVersion" -ForegroundColor Green
Assert-NoPendingJobs | Out-Null
$answer = Read-Host 'Tải và cài bản mới? Nhập C để tiếp tục'
if ($answer -notin @('C', 'c')) { Write-Host 'Đã hủy cập nhật.'; return }

$downloadDir = Join-Path ([IO.Path]::GetTempPath()) ('KStudioUpdate-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $downloadDir -Force | Out-Null
$installer = Join-Path $downloadDir $assetName
try {
  Write-Host 'Đang tải bộ cài từ GitHub...'
  if ($useGh) {
    & $gh.Source release download $release.tag_name --repo $repository --pattern $assetName --dir $downloadDir --clobber
    if ($LASTEXITCODE -ne 0) { throw 'GitHub CLI không tải được bộ cài.' }
  } else {
    Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $installer -UseBasicParsing -TimeoutSec 300
  }
  $actualHash = (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash.ToUpperInvariant()
  if ($actualHash -ne $expectedHash) { throw 'Mã SHA-256 không khớp. Bộ cài đã tải sẽ không được chạy.' }
  Write-Host 'Đã kiểm tra SHA-256.' -ForegroundColor Green

  $serverPid = Assert-NoPendingJobs
  if ($serverPid) {
    Write-Host 'Đang đóng máy chủ K Studio để cài bản mới...'
    & taskkill.exe /PID $serverPid /T /F | Out-Null
    for ($i = 0; $i -lt 20; $i++) {
      Start-Sleep -Milliseconds 500
      if (-not (Get-NetTCPConnection -LocalPort 4173 -State Listen -ErrorAction SilentlyContinue)) { break }
    }
    if (Get-NetTCPConnection -LocalPort 4173 -State Listen -ErrorAction SilentlyContinue) { throw 'Không đóng được K Studio. Hãy thử lại sau.' }
  }

  Write-Host 'Đang mở bộ cài. Xác nhận trong cửa sổ K Studio Setup.' -ForegroundColor Cyan
  $process = Start-Process -FilePath $installer -Wait -PassThru
  if ($process.ExitCode -ne 0) { throw "Bộ cài kết thúc với mã $($process.ExitCode)." }
  $newPackage = Get-Content -LiteralPath (Join-Path $installRoot 'package.json') -Raw | ConvertFrom-Json
  if ([version]$newPackage.version -ne $latestVersion) { throw 'Bộ cài đã đóng nhưng phiên bản trong thư mục cài đặt chưa thay đổi.' }
  Write-Host "Đã chạy bộ cài v$latestVersion. Dữ liệu và tài khoản Muse được giữ trong thư mục người dùng." -ForegroundColor Green
} finally {
  if (Test-Path -LiteralPath $downloadDir) { Remove-Item -LiteralPath $downloadDir -Recurse -Force -ErrorAction SilentlyContinue }
}
