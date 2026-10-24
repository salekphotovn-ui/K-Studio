using System;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Net;
using System.Net.Sockets;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
using Microsoft.Win32;
using System.Windows.Forms;

internal static class KStudioSetup
{
    private static string LocalDataRoot { get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "K Studio"); } }
    private static string LauncherRoot { get { return Path.Combine(LocalDataRoot, "Launcher"); } }
    private static string LauncherPath
    {
        get
        {
            var packagePath = Path.Combine(InstallRoot, "package.json");
            var version = File.Exists(packagePath) ? (System.Text.RegularExpressions.Regex.Match(File.ReadAllText(packagePath), "\\\"version\\\"\\s*:\\s*\\\"([^\\\"]+)\\\"").Groups[1].Value) : "current";
            return Path.Combine(LauncherRoot, "KStudioLauncher-v" + version + ".exe");
        }
    }
    private static string InstallRoot { get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "K Studio"); } }
    private static string StartMenuRoot { get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "Microsoft", "Windows", "Start Menu", "Programs", "K Studio"); } }

    [STAThread]
    private static void Main(string[] args)
    {
        Application.EnableVisualStyles();
        try
        {
            bool updateMode = args != null && Array.Exists(args, value => String.Equals(value, "--update", StringComparison.OrdinalIgnoreCase));
            using (var client = new TcpClient())
            {
                var pending = client.BeginConnect("127.0.0.1", 4173, null, null);
                if (pending.AsyncWaitHandle.WaitOne(500) && client.Connected)
                {
                    MessageBox.Show("K Studio đang chạy. Hãy đợi tác vụ xong, đóng K Studio rồi chạy lại bộ cài.", "K Studio Setup", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                    Environment.ExitCode = 2;
                    return;
                }
            }

            var chromePath = FindChrome();
            if (!updateMode && String.IsNullOrEmpty(chromePath) && !InstallChrome()) { Environment.ExitCode = 3; return; }

            if (!updateMode)
            {
                var answer = MessageBox.Show("Cài K Studio vào thư mục người dùng hiện tại? Tài khoản Muse và dữ liệu sẽ được lưu riêng, không nằm trong bộ cài.", "K Studio Setup", MessageBoxButtons.YesNo, MessageBoxIcon.Question);
                if (answer != DialogResult.Yes) { Environment.ExitCode = 4; return; }
            }

            var tempRoot = Path.Combine(Path.GetTempPath(), "KStudioSetup-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(tempRoot);
            Directory.CreateDirectory(InstallRoot);
            string shortcutWarning = null;
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
                var stagedLauncher = Path.Combine(tempRoot, "KStudioLauncher.exe");
                if (!File.Exists(LauncherPath))
                {
                    Directory.CreateDirectory(LauncherRoot);
                    if (File.Exists(stagedLauncher)) File.Copy(stagedLauncher, LauncherPath, true);
                }
                try { CreateShortcuts(); }
                catch (Exception shortcutError)
                {
                    shortcutWarning = GetRootException(shortcutError).Message;
                    WriteSetupLog("Shortcut creation failed", shortcutError);
                }
            }
            finally { try { Directory.Delete(tempRoot, true); } catch { } }

            var installedMessage = "Đã cài K Studio. Máy này cần Google Chrome để đăng nhập Muse.";
            if (!String.IsNullOrEmpty(shortcutWarning)) installedMessage += "\r\n\r\nKhông tạo được lối tắt tự động: " + shortcutWarning + "\r\nAnh vẫn có thể mở K Studio tại:\r\n" + Path.Combine(InstallRoot, "Mở K Studio.bat");
            if (updateMode) return;
            installedMessage += "\r\n\r\nMở K Studio ngay?";
            var launch = MessageBox.Show(installedMessage, "K Studio Setup", MessageBoxButtons.YesNo, shortcutWarning == null ? MessageBoxIcon.Information : MessageBoxIcon.Warning);
            if (launch == DialogResult.Yes)
                Process.Start(new ProcessStartInfo { FileName = LauncherPath, WorkingDirectory = LauncherRoot, UseShellExecute = true });
        }
        catch (Exception error)
        {
            Environment.ExitCode = 1;
            var rootError = GetRootException(error);
            var logPath = WriteSetupLog("Installation failed", error);
            MessageBox.Show("Không cài được K Studio.\r\n\r\n" + rootError.Message + "\r\n\r\nChi tiết: " + error.GetType().FullName + "\r\nNhật ký: " + logPath, "K Studio Setup", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }

    private static string FindChrome()
    {
        var candidates = new[]
        {
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "Google", "Chrome", "Application", "chrome.exe"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), "Google", "Chrome", "Application", "chrome.exe"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Google", "Chrome", "Application", "chrome.exe")
        };
        foreach (var candidate in candidates) if (File.Exists(candidate)) return candidate;
        foreach (var hive in new[] { Registry.CurrentUser, Registry.LocalMachine })
            foreach (var view in new[] { RegistryView.Registry64, RegistryView.Registry32 })
                try
                {
                    using (var baseKey = RegistryKey.OpenBaseKey(hive.Name == "HKEY_CURRENT_USER" ? RegistryHive.CurrentUser : RegistryHive.LocalMachine, view))
                    using (var key = baseKey.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe"))
                    {
                        var value = key == null ? null : key.GetValue(null) as string;
                        if (!String.IsNullOrEmpty(value) && File.Exists(value)) return value;
                    }
                }
                catch { }
        return null;
    }

    private static bool InstallChrome()
    {
        var consent = MessageBox.Show("Không tìm thấy Google Chrome. K Studio cần Chrome để mở và tự thao tác Muse. Cho phép bộ cài tải Chrome chính thức từ Google và cài cho tài khoản Windows hiện tại?", "Cần Google Chrome", MessageBoxButtons.YesNo, MessageBoxIcon.Information);
        if (consent != DialogResult.Yes) return false;
        var installer = Path.Combine(Path.GetTempPath(), "KStudio-ChromeSetup.exe");
        var verifyScript = Path.Combine(Path.GetTempPath(), "KStudio-VerifyChrome.ps1");
        try
        {
            ServicePointManager.SecurityProtocol = SecurityProtocolType.Tls12;
            using (var client = new WebClient()) client.DownloadFile("https://dl.google.com/chrome/install/latest/chrome_installer.exe", installer);
            File.WriteAllText(verifyScript, @"
param([string]$Installer)
$signature = Get-AuthenticodeSignature -LiteralPath $Installer
$signer = if ($signature.SignerCertificate) { $signature.SignerCertificate.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false) }
if ($signature.Status -ne 'Valid' -or $signer -ne 'Google LLC') { exit 1 }
");
            var powershell = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "WindowsPowerShell\\v1.0\\powershell.exe");
            var verify = Process.Start(new ProcessStartInfo { FileName = powershell, Arguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File \"" + verifyScript + "\" \"" + installer + "\"", UseShellExecute = false, CreateNoWindow = true, WindowStyle = ProcessWindowStyle.Hidden });
            verify.WaitForExit(30000);
            if (!verify.HasExited || verify.ExitCode != 0) throw new InvalidDataException("Không xác thực được chữ ký Google của bộ cài Chrome.");
            var install = Process.Start(new ProcessStartInfo { FileName = installer, Arguments = "/silent /install", UseShellExecute = false, CreateNoWindow = true, WindowStyle = ProcessWindowStyle.Hidden });
            install.WaitForExit(300000);
            if (!install.HasExited) { try { install.Kill(); } catch { } throw new TimeoutException("Cài Chrome quá thời gian chờ."); }
            if (String.IsNullOrEmpty(FindChrome())) throw new InvalidOperationException("Bộ cài đã chạy nhưng chưa tìm thấy chrome.exe.");
            return true;
        }
        catch (Exception error)
        {
            var open = MessageBox.Show("Không tự cài được Chrome: " + error.Message + "\r\n\r\nMở trang tải Chrome chính thức để cài thủ công, rồi chạy lại bộ cài K Studio?", "Không cài được Chrome", MessageBoxButtons.YesNo, MessageBoxIcon.Warning);
            if (open == DialogResult.Yes) Process.Start(new ProcessStartInfo { FileName = "https://www.google.com/chrome/", UseShellExecute = true });
            return false;
        }
        finally
        {
            try { File.Delete(installer); } catch { }
            try { File.Delete(verifyScript); } catch { }
        }
    }

    private static void CreateShortcuts()
    {
        Directory.CreateDirectory(StartMenuRoot);
        Directory.CreateDirectory(LocalDataRoot);
        var uninstallPath = Path.Combine(LocalDataRoot, "uninstall-kstudio.ps1");
        File.WriteAllText(uninstallPath, UninstallerScript);
        CreateShortcut(Path.Combine(StartMenuRoot, "K Studio.lnk"), LauncherPath, LauncherRoot, "Mở K Studio", iconPath: LauncherPath);
        CreateShortcut(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), "K Studio.lnk"), LauncherPath, LauncherRoot, "Mở K Studio", iconPath: LauncherPath);
        CreateShortcut(Path.Combine(StartMenuRoot, "Cập nhật K Studio.lnk"), Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "WindowsPowerShell\\v1.0\\powershell.exe"), InstallRoot, "Kiểm tra và cài bản K Studio mới", "-NoProfile -NoExit -ExecutionPolicy Bypass -File \"" + Path.Combine(InstallRoot, "Update-K-Studio-Installed.ps1") + "\"");
        CreateShortcut(Path.Combine(StartMenuRoot, "Gỡ cài đặt K Studio.lnk"), Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "WindowsPowerShell\\v1.0\\powershell.exe"), LocalDataRoot, "Gỡ K Studio, giữ dữ liệu Muse", "-NoProfile -ExecutionPolicy Bypass -File \"" + uninstallPath + "\"");
    }

    private static void CopyDirectory(string source, string destination)
    {
        Directory.CreateDirectory(destination);
        foreach (var file in Directory.GetFiles(source)) File.Copy(file, Path.Combine(destination, Path.GetFileName(file)), true);
        foreach (var directory in Directory.GetDirectories(source)) CopyDirectory(directory, Path.Combine(destination, Path.GetFileName(directory)));
    }

    private static void CreateShortcut(string shortcutPath, string targetPath, string workingDirectory, string description, string arguments = "", string iconPath = null)
    {
        IShellLinkW link = null;
        try
        {
            link = (IShellLinkW)new ShellLink();
            link.SetPath(targetPath);
            link.SetWorkingDirectory(workingDirectory);
            link.SetDescription(description);
            if (!String.IsNullOrEmpty(arguments)) link.SetArguments(arguments);
            if (!String.IsNullOrEmpty(iconPath)) link.SetIconLocation(iconPath, 0);
            link.SetShowCmd(1);
            ((IPersistFile)link).Save(shortcutPath, true);
        }
        finally
        {
            if (link != null && Marshal.IsComObject(link)) Marshal.FinalReleaseComObject(link);
        }
    }

    private static Exception GetRootException(Exception error)
    {
        while (error is TargetInvocationException && error.InnerException != null) error = error.InnerException;
        return error;
    }

    private static string WriteSetupLog(string heading, Exception error)
    {
        var logPath = Path.Combine(LocalDataRoot, "setup-error.log");
        try
        {
            Directory.CreateDirectory(LocalDataRoot);
            File.AppendAllText(logPath, "[" + DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + "] " + heading + Environment.NewLine + error.ToString() + Environment.NewLine + Environment.NewLine);
            return logPath;
        }
        catch { return "Không ghi được log; lỗi gốc: " + GetRootException(error).Message; }
    }

    [ComImport, Guid("00021401-0000-0000-C000-000000000046"), ClassInterface(ClassInterfaceType.None)]
    private class ShellLink { }

    [ComImport, Guid("000214F9-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IShellLinkW
    {
        void GetPath(IntPtr file, int maxPath, IntPtr findData, uint flags);
        void GetIDList(out IntPtr itemIdList);
        void SetIDList(IntPtr itemIdList);
        void GetDescription(IntPtr name, int maxName);
        void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string name);
        void GetWorkingDirectory(IntPtr directory, int maxPath);
        void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string directory);
        void GetArguments(IntPtr arguments, int maxPath);
        void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string arguments);
        void GetHotkey(out short hotkey);
        void SetHotkey(short hotkey);
        void GetShowCmd(out int showCommand);
        void SetShowCmd(int showCommand);
        void GetIconLocation(IntPtr iconPath, int maxPath, out int iconIndex);
        void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string iconPath, int iconIndex);
        void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string path, uint reserved);
        void Resolve(IntPtr window, uint flags);
        void SetPath([MarshalAs(UnmanagedType.LPWStr)] string path);
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
