$ErrorActionPreference = 'Stop'
$project = Split-Path -Parent $MyInvocation.MyCommand.Path
$url = "http://127.0.0.1:4173/?launch=$([DateTimeOffset]::Now.ToUnixTimeSeconds())"

function Get-ChromeAppPath($registryPath) {
  try { return (Get-Item -LiteralPath $registryPath -ErrorAction Stop).GetValue('') }
  catch { return $null }
}

function Open-KStudio {
  $chromeCandidates = @(
    (Get-Command chrome.exe -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Source),
    (Get-ChromeAppPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe'),
    (Get-ChromeAppPath 'HKLM:\Software\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe'),
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
  )
  $chrome = $chromeCandidates | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
  if ($chrome) {
    Start-Process -FilePath $chrome -ArgumentList @('--new-window', $url)
    return
  }
  try { Start-Process -FilePath 'explorer.exe' -ArgumentList $url }
  catch { Start-Process -FilePath 'cmd.exe' -ArgumentList @('/c', 'start', '""', $url) }
}

$listener = Get-NetTCPConnection -LocalPort 4173 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($listener) {
  $canRestart = $false
  try {
    $oldHistory = @(Invoke-RestMethod -Uri 'http://127.0.0.1:4173/api/history' -TimeoutSec 3)
    $oldAccounts = Invoke-RestMethod -Uri 'http://127.0.0.1:4173/api/accounts' -TimeoutSec 3
    if (-not $oldAccounts.PSObject.Properties['accounts']) { throw 'K Studio API was not detected.' }
    $runningStatuses = @('["\u0110ang ch\u1ea1y tr\u00ean Muse","\u0110ang g\u1eedi l\u00ean Muse","\u0110ang t\u1ea1o tr\u00ean Muse"]' | ConvertFrom-Json)
    $active = @($oldHistory | Where-Object {
      $_.status -in $runningStatuses -or @($_.jobs | Where-Object { $_.status -in $runningStatuses }).Count -gt 0
    })
    if ($active.Count -gt 0) {
      Write-Host 'K Studio dang co tac vu; khong khoi dong lai de tranh gian doan.' -ForegroundColor Yellow
      Open-KStudio
      exit 0
    }
    $canRestart = $true
  } catch {
    Write-Host 'Khong the xac nhan may chu cu dang ranh; khong tu dong dung tien trinh.' -ForegroundColor Yellow
    Write-Host 'Dang mo giao dien hien tai. Hay dong may chu cu sau khi cac tac vu ket thuc de cap nhat.'
    Open-KStudio
    exit 0
  }

  if ($canRestart) {
    Write-Host 'Dang cap nhat may chu K Studio...' -ForegroundColor Green
    & taskkill.exe /PID $listener.OwningProcess /T /F | Out-Null
    for ($i = 0; $i -lt 10; $i++) {
      Start-Sleep -Milliseconds 500
      $listener = Get-NetTCPConnection -LocalPort 4173 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
      if (-not $listener) { break }
    }
    if ($listener) {
      Write-Host 'Khong dung duoc may chu cu. Hay dong cua so may chu cu roi bam lai.' -ForegroundColor Red
      exit 1
    }
  }
}

$node = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
if (-not $node) {
  Write-Host 'Khong tim thay Node.js. Hay cai Node.js roi bam file BAT lai.' -ForegroundColor Red
  exit 1
}

$dataDirectory = if ($env:KSTUDIO_DATA_DIR) { $env:KSTUDIO_DATA_DIR } else { Join-Path $env:LOCALAPPDATA 'K Studio' }
$logDirectory = Join-Path $dataDirectory 'logs'
New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
$serverOutputLog = Join-Path $logDirectory 'server.log'
$serverErrorLog = Join-Path $logDirectory 'server-error.log'
Start-Process -FilePath $node -WorkingDirectory $project -ArgumentList @('server.js') -WindowStyle Hidden -RedirectStandardOutput $serverOutputLog -RedirectStandardError $serverErrorLog | Out-Null

$ready = $false
for ($i = 0; $i -lt 30; $i++) {
  Start-Sleep -Seconds 1
  try {
    $version = Invoke-RestMethod -Uri 'http://127.0.0.1:4173/api/version' -TimeoutSec 2
    if ($version.version -eq 'kstudio-account-rotation-v18') {
      $page = Invoke-WebRequest -Uri $url -TimeoutSec 3 -UseBasicParsing
      if ($page.Content.Contains('video-reference-add') -and $page.Content.Contains('video-reference-folder')) { $ready = $true; break }
    }
  } catch {}
}

if (-not $ready) {
  Write-Host "K Studio chua khoi dong duoc. Kiem tra $serverErrorLog." -ForegroundColor Red
  exit 1
}

Open-KStudio




