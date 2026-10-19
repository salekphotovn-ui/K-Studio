using System;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Net.Sockets;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Windows.Forms;

internal static class KStudioSetup
{
    private static string LocalDataRoot { get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "K Studio"); } }
    private static string InstallRoot { get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "K Studio"); } }
    private static string StartMenuRoot { get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "Microsoft", "Windows", "Start Menu", "Programs", "K Studio"); } }

    [STAThread]
    private static void Main()
    {
        Application.EnableVisualStyles();
        try
        {
            using (var client = new TcpClient())
            {
                var pending = client.BeginConnect("127.0.0.1", 4173, null, null);
                if (pending.AsyncWaitHandle.WaitOne(500) && client.Connected)
                {
                    MessageBox.Show("K Studio đang chạy. Hãy đợi tác vụ xong, đóng K Studio rồi chạy lại bộ cài.", "K Studio Setup", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                    return;
                }
            }

            var answer = MessageBox.Show("Cài K Studio vào thư mục người dùng hiện tại? Tài khoản Muse và dữ liệu sẽ được lưu riêng, không nằm trong bộ cài.", "K Studio Setup", MessageBoxButtons.YesNo, MessageBoxIcon.Question);
            if (answer != DialogResult.Yes) return;

            var tempRoot = Path.Combine(Path.GetTempPath(), "KStudioSetup-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(tempRoot);
            Directory.CreateDirectory(InstallRoot);
            try
            {
                using (var payload = Assembly.GetExecutingAssembly().GetManifestResourceStream("KStudioPayload.zip"))
                using (var archive = new ZipArchive(payload, ZipArchiveMode.Read))
                {
                    foreach (var entry in archive.Entries)
                    {
                        if (String.IsNullOrEmpty(entry.Name)) continue;
                        var outputPath = Path.GetFullPath(Path.Combine(tempRoot, entry.FullName));
                        var safeRoot = Path.GetFullPath(tempRoot) + Path.DirectorySeparatorChar;
                        if (!outputPath.StartsWith(safeRoot, StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException("Payload path is not safe.");
                        Directory.CreateDirectory(Path.GetDirectoryName(outputPath));
                        using (var input = entry.Open())
                        using (var output = new FileStream(outputPath, FileMode.Create, FileAccess.Write, FileShare.None)) input.CopyTo(output);
                    }
                }
                CopyDirectory(tempRoot, InstallRoot);
                CreateShortcuts();
            }
            finally { try { Directory.Delete(tempRoot, true); } catch { } }

            var launch = MessageBox.Show("Đã cài K Studio. Máy này cần Google Chrome để đăng nhập Muse. Mở K Studio ngay?", "K Studio Setup", MessageBoxButtons.YesNo, MessageBoxIcon.Information);
            if (launch == DialogResult.Yes)
                Process.Start(new ProcessStartInfo { FileName = Path.Combine(InstallRoot, "Mở K Studio.bat"), WorkingDirectory = InstallRoot, UseShellExecute = true });
        }
        catch (Exception error)
        {
            MessageBox.Show("Không cài được K Studio.\r\n\r\n" + error.Message, "K Studio Setup", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }

    private static void CreateShortcuts()
    {
        Directory.CreateDirectory(StartMenuRoot);
        Directory.CreateDirectory(LocalDataRoot);
        var uninstallPath = Path.Combine(LocalDataRoot, "uninstall-kstudio.ps1");
        File.WriteAllText(uninstallPath, UninstallerScript);
        CreateShortcut(Path.Combine(StartMenuRoot, "K Studio.lnk"), Path.Combine(InstallRoot, "Mở K Studio.bat"), InstallRoot, "Mở K Studio");
        CreateShortcut(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), "K Studio.lnk"), Path.Combine(InstallRoot, "Mở K Studio.bat"), InstallRoot, "Mở K Studio");
        CreateShortcut(Path.Combine(StartMenuRoot, "Gỡ cài đặt K Studio.lnk"), Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "WindowsPowerShell\\v1.0\\powershell.exe"), LocalDataRoot, "Gỡ K Studio, giữ dữ liệu Muse", "-NoProfile -ExecutionPolicy Bypass -File \"" + uninstallPath + "\"");
    }

    private static void CopyDirectory(string source, string destination)
    {
        Directory.CreateDirectory(destination);
        foreach (var file in Directory.GetFiles(source)) File.Copy(file, Path.Combine(destination, Path.GetFileName(file)), true);
        foreach (var directory in Directory.GetDirectories(source)) CopyDirectory(directory, Path.Combine(destination, Path.GetFileName(directory)));
    }

    private static void CreateShortcut(string shortcutPath, string targetPath, string workingDirectory, string description, string arguments = "")
    {
        var shellType = Type.GetTypeFromProgID("WScript.Shell");
        object shell = Activator.CreateInstance(shellType);
        object shortcut = shellType.InvokeMember("CreateShortcut", BindingFlags.InvokeMethod, null, shell, new object[] { shortcutPath });
        var type = shortcut.GetType();
        type.InvokeMember("TargetPath", BindingFlags.SetProperty, null, shortcut, new object[] { targetPath });
        type.InvokeMember("WorkingDirectory", BindingFlags.SetProperty, null, shortcut, new object[] { workingDirectory });
        type.InvokeMember("Description", BindingFlags.SetProperty, null, shortcut, new object[] { description });
        if (!String.IsNullOrEmpty(arguments)) type.InvokeMember("Arguments", BindingFlags.SetProperty, null, shortcut, new object[] { arguments });
        type.InvokeMember("Save", BindingFlags.InvokeMethod, null, shortcut, null);
        Marshal.FinalReleaseComObject(shortcut);
        Marshal.FinalReleaseComObject(shell);
    }

    private const string UninstallerScript = @"
$ErrorActionPreference = 'Stop'
if (Get-NetTCPConnection -LocalPort 4173 -State Listen -ErrorAction SilentlyContinue) {
  Write-Host 'Hay dong K Studio truoc khi go cai dat.' -ForegroundColor Yellow
  Read-Host 'Nhan Enter de dong'
  exit 1
}
$installRoot = Join-Path $env:LOCALAPPDATA 'Programs\K Studio'
$startMenu = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\K Studio'
Remove-Item -LiteralPath $installRoot -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $startMenu -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath (Join-Path ([Environment]::GetFolderPath('Desktop')) 'K Studio.lnk') -Force -ErrorAction SilentlyContinue
Write-Host 'Da go K Studio. Du lieu tai %LOCALAPPDATA%\K Studio duoc giu lai.' -ForegroundColor Green
Read-Host 'Nhan Enter de dong'
";
}
