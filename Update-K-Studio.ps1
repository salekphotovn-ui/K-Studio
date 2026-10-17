$ErrorActionPreference = 'Stop'
$project = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location -LiteralPath $project

if (-not (Get-Command git.exe -ErrorAction SilentlyContinue)) {
  throw 'Khong tim thay Git. Hay cai Git truoc khi cap nhat ban ma nguon.'
}
if (-not (Test-Path -LiteralPath (Join-Path $project '.git'))) {
  throw 'Thu muc nay chua la repository Git.'
}
$gitTrust = "safe.directory=$project"
$remote = (& git -c $gitTrust remote get-url origin 2>$null)
if ($LASTEXITCODE -ne 0 -or -not $remote) {
  throw 'Chua cau hinh GitHub origin. Them repository GitHub truoc khi cap nhat.'
}
$listener = Get-NetTCPConnection -LocalPort 4173 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($listener) {
  throw 'K Studio dang mo. Hay cho tat ca tac vu ket thuc va dong K Studio truoc khi cap nhat.'
}
$changes = (& git -c $gitTrust status --porcelain --untracked-files=no)
if ($LASTEXITCODE -ne 0) { throw 'Khong doc duoc trang thai Git.' }
if ($changes) { throw 'Ma nguon co thay doi chua commit. Hay xu ly thay doi truoc khi cap nhat.' }
$branch = (& git -c $gitTrust branch --show-current).Trim()
if ($LASTEXITCODE -ne 0 -or -not $branch) { throw 'Khong xac dinh duoc nhanh Git hien tai.' }

& git -c $gitTrust fetch origin $branch
if ($LASTEXITCODE -ne 0) { throw 'Khong tai duoc cap nhat tu GitHub.' }
& git -c $gitTrust pull --ff-only origin $branch
if ($LASTEXITCODE -ne 0) { throw 'Khong the cap nhat fast-forward. Ma nguon cua anh van duoc giu nguyen.' }

if (-not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) {
  throw 'Da cap nhat ma nguon nhung khong tim thay npm. Hay cai Node.js truoc khi mo K Studio.'
}
& npm.cmd ci --omit=dev --no-audit --no-fund
if ($LASTEXITCODE -ne 0) { throw 'Da cap nhat ma nguon nhung cai dependencies that bai.' }

Write-Host 'Da cap nhat K Studio tu GitHub. Dang mo ung dung...' -ForegroundColor Green
& (Join-Path $project 'Start-K-Studio.ps1')
