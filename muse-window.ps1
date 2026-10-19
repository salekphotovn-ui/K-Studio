param(
  [Parameter(Mandatory = $true)][ValidateSet('hide', 'show', 'watch')][string]$Action,
  [Parameter(Mandatory = $true)][string]$ProfileDir,
  [long]$KnownHandle = 0,
  [int]$ParentProcessId = 0,
  [int]$Width = 0,
  [int]$Height = 0
)

$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class MuseWindowNative {
  public delegate bool EnumWindowsProc(IntPtr handle, IntPtr parameter);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr parameter);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr handle, StringBuilder text, int maxCount);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr handle);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr handle);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr handle, int command);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr handle);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr handle, IntPtr insertAfter, int x, int y, int width, int height, uint flags);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr handle, out uint processId);
}
'@

$profile = [System.IO.Path]::GetFullPath($ProfileDir).TrimEnd('\')
$process = Get-CimInstance Win32_Process -Filter "name = 'chrome.exe'" |
  Where-Object {
    $_.CommandLine -and
    $_.CommandLine.IndexOf($profile, [System.StringComparison]::OrdinalIgnoreCase) -ge 0 -and
    $_.CommandLine -notmatch '--type='
  } | Select-Object -First 1
if (-not $process) { throw 'Muse Chrome process not found.' }

if ($Action -eq 'watch') {
  if ($ParentProcessId -le 0) { throw 'K Studio process ID is required.' }
  $watchCallback = [MuseWindowNative+EnumWindowsProc]{
    param($candidate, $parameter)
    $windowProcessId = [uint32]0
    [void][MuseWindowNative]::GetWindowThreadProcessId($candidate, [ref]$windowProcessId)
    if ($windowProcessId -eq [uint32]$process.ProcessId -and [MuseWindowNative]::IsWindowVisible($candidate)) {
      $title = [System.Text.StringBuilder]::new(256)
      [void][MuseWindowNative]::GetWindowText($candidate, $title, 256)
      if ($title.Length -gt 0 -and $title.ToString() -notmatch '^(Default IME|MSCTFIME UI)$') {
        [void][MuseWindowNative]::ShowWindow($candidate, 0)
      }
    }
    return $true
  }
  while ($true) {
    if (-not (Get-Process -Id $ParentProcessId -ErrorAction SilentlyContinue)) { break }
    if (-not (Get-Process -Id $process.ProcessId -ErrorAction SilentlyContinue)) { break }
    [void][MuseWindowNative]::EnumWindows($watchCallback, [IntPtr]::Zero)
    Start-Sleep -Milliseconds 400
  }
  exit 0
}

$handle = [IntPtr]::Zero
if ($KnownHandle -gt 0) {
  $candidate = [IntPtr]::new($KnownHandle)
  $owner = [uint32]0
  [void][MuseWindowNative]::GetWindowThreadProcessId($candidate, [ref]$owner)
  if ([MuseWindowNative]::IsWindow($candidate) -and $owner -eq [uint32]$process.ProcessId) {
    $handle = $candidate
  }
}
$windowCandidates = [System.Collections.Generic.List[object]]::new()
$callback = [MuseWindowNative+EnumWindowsProc]{
  param($candidate, $parameter)
  $windowProcessId = [uint32]0
  [void][MuseWindowNative]::GetWindowThreadProcessId($candidate, [ref]$windowProcessId)
  if ($windowProcessId -eq [uint32]$process.ProcessId) {
    $title = [System.Text.StringBuilder]::new(256)
    [void][MuseWindowNative]::GetWindowText($candidate, $title, 256)
    if ($title.Length -gt 0 -and $title.ToString() -notmatch '^(Default IME|MSCTFIME UI)$') {
      $windowCandidates.Add([pscustomobject]@{ handle = $candidate; title = $title.ToString() })
    }
  }
  return $true
}
[void][MuseWindowNative]::EnumWindows($callback, [IntPtr]::Zero)
$main = $windowCandidates | Where-Object { $_.title -match 'Muse' } | Select-Object -First 1
if ($main) { $handle = $main.handle }
if ($handle -eq [IntPtr]::Zero) {
  $main = $windowCandidates | Where-Object { $_.title -match 'Google Chrome' } | Select-Object -First 1
  if ($main) { $handle = $main.handle }
}
if ($handle -eq [IntPtr]::Zero) { $handle = (Get-Process -Id $process.ProcessId).MainWindowHandle }
if ($handle -eq [IntPtr]::Zero -or -not [MuseWindowNative]::IsWindow($handle)) {
  throw 'Muse Chrome window not found.'
}
if ($Width -gt 0 -and $Height -gt 0) {
  # Keep the window position and resize the real Chrome frame as well as Playwright's viewport.
  if (-not [MuseWindowNative]::SetWindowPos($handle, [IntPtr]::Zero, 0, 0, $Width, $Height, 0x0016)) {
    throw 'Muse Chrome window could not be resized.'
  }
}

if ($Action -eq 'hide') {
  foreach ($item in $windowCandidates) { [void][MuseWindowNative]::ShowWindow($item.handle, 0) }
  if ([MuseWindowNative]::IsWindowVisible($handle)) { throw 'Muse window is still visible.' }
} else {
  foreach ($item in $windowCandidates) {
    if ($item.handle -ne $handle) { [void][MuseWindowNative]::ShowWindow($item.handle, 0) }
  }
  [void][MuseWindowNative]::ShowWindow($handle, 9)
  if (-not [MuseWindowNative]::IsWindowVisible($handle)) { [void][MuseWindowNative]::ShowWindow($handle, 5) }
  if (-not [MuseWindowNative]::IsWindowVisible($handle)) { throw 'Muse window could not be shown.' }
  [void][MuseWindowNative]::SetForegroundWindow($handle)
}

@{ ok = $true; handle = $handle.ToInt64(); processId = $process.ProcessId; visible = [MuseWindowNative]::IsWindowVisible($handle) } | ConvertTo-Json -Compress
