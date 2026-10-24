$ErrorActionPreference = 'Stop'
$project = Split-Path -Parent $PSScriptRoot
$package = Get-Content -LiteralPath (Join-Path $project 'package.json') -Raw | ConvertFrom-Json
$release = Join-Path $project 'release'
$stage = Join-Path $release 'installer-stage'
$appStage = Join-Path $stage 'app'
$node = (Get-Command node.exe -ErrorAction Stop).Source
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$launcherBat = 'M' + [char]0x1EDF + ' K Studio.bat'
if (-not (Test-Path -LiteralPath $compiler)) { throw 'Khong tim thay bo bien dich C# co san cua Windows.' }

$releaseFull = [IO.Path]::GetFullPath($release)
$projectFull = [IO.Path]::GetFullPath($project).TrimEnd('\') + '\'
if (-not $releaseFull.StartsWith($projectFull, [StringComparison]::OrdinalIgnoreCase)) { throw 'Thu muc build nam ngoai du an.' }
if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
New-Item -ItemType Directory -Path $appStage -Force | Out-Null

$icon = Join-Path $project 'assets\KStudio.ico'
$launcher = Join-Path $appStage 'KStudioLauncher.exe'
$launcherArgs = @('/nologo', '/target:winexe', '/platform:x64', "/out:$launcher", "/win32icon:$icon", '/reference:System.Windows.Forms.dll', '/reference:System.Drawing.dll', (Join-Path $PSScriptRoot 'KStudioLauncher.cs'))
& $compiler @launcherArgs
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $launcher)) { throw 'Khong bien dich duoc K Studio Launcher.' }

$files = @(
  'server.js', 'platform.js', 'local-api.js', 'media-transform.js', 'muse-quota.js',
  'muse-task-worker.js', 'muse-multi-worker.js', 'muse-window.ps1', 'dashboard.html', 'package.json',
  $launcherBat, 'Start-K-Studio.ps1', 'Update-K-Studio-Installed.ps1', 'README.md', 'LOCAL_API.md',
  'KSTUDIO_API_FOR_AI.md'
)
foreach ($file in $files) { Copy-Item -LiteralPath (Join-Path $project $file) -Destination $appStage -Force }
New-Item -ItemType Directory -Path (Join-Path $appStage 'node_modules') -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $project 'node_modules\playwright-core') -Destination (Join-Path $appStage 'node_modules\playwright-core') -Recurse -Force
New-Item -ItemType Directory -Path (Join-Path $appStage 'runtime') -Force | Out-Null
Copy-Item -LiteralPath $node -Destination (Join-Path $appStage 'runtime\node.exe') -Force

$zip = Join-Path $stage 'KStudioPayload.zip'
Compress-Archive -Path (Join-Path $appStage '*') -DestinationPath $zip -CompressionLevel Optimal
$target = Join-Path $release ('K-Studio-Setup-v' + $package.version + '.exe')
$compilerArgs = @(
  '/nologo', '/target:winexe', '/platform:x64', "/out:$target", "/win32icon:$icon",
  "/resource:$zip,KStudioPayload.zip", '/reference:System.Windows.Forms.dll',
  '/reference:System.IO.Compression.dll', '/reference:System.IO.Compression.FileSystem.dll',
  (Join-Path $PSScriptRoot 'KStudioSetup.cs')
)
& $compiler @compilerArgs
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $target)) { throw 'Khong bien dich duoc bo cai EXE.' }
$sizeMb = [Math]::Round((Get-Item -LiteralPath $target).Length / 1MB, 1)
Write-Host "Da tao $target ($sizeMb MB)" -ForegroundColor Green
Remove-Item -LiteralPath $stage -Recurse -Force
