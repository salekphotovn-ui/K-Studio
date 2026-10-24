using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Text.RegularExpressions;
using System.Windows.Forms;

internal sealed class KStudioLauncher : Form
{
    private readonly string root = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "K Studio");
    private readonly string progressFile = Path.Combine(Path.GetTempPath(), "KStudio-launch-" + Guid.NewGuid().ToString("N") + ".txt");
    private readonly string initialVersion;
    private readonly Label heading;
    private readonly Label message;
    private readonly Label detail;
    private readonly ProgressBar progress;
    private readonly Button closeButton;
    private readonly Timer timer;
    private Process startProcess;
    private DateTime startedAt;
    private bool relaunchedAfterUpdate;
    private bool finished;

    private KStudioLauncher()
    {
        initialVersion = ReadVersion();
        Text = "K Studio";
        FormBorderStyle = FormBorderStyle.FixedDialog;
        StartPosition = FormStartPosition.CenterScreen;
        MaximizeBox = false;
        MinimizeBox = false;
        ShowInTaskbar = true;
        ClientSize = new Size(560, 310);
        BackColor = Color.FromArgb(18, 13, 32);
        ForeColor = Color.FromArgb(246, 240, 255);
        Font = new Font("Segoe UI", 9F);

        var mark = new Label { Text = "K", Location = new Point(30, 28), Size = new Size(52, 52), TextAlign = ContentAlignment.MiddleCenter, Font = new Font("Segoe UI", 28F, FontStyle.Bold), ForeColor = Color.White, BackColor = Color.FromArgb(157, 52, 229) };
        heading = new Label { Text = "Đang mở K Studio", Location = new Point(100, 30), Size = new Size(420, 34), Font = new Font("Segoe UI", 18F, FontStyle.Bold), ForeColor = Color.White };
        message = new Label { Text = "Đang kiểm tra phiên bản…", Location = new Point(100, 68), Size = new Size(420, 26), ForeColor = Color.FromArgb(194, 176, 219) };
        var box = new Panel { Location = new Point(30, 108), Size = new Size(500, 122), BackColor = Color.FromArgb(29, 21, 48), BorderStyle = BorderStyle.FixedSingle };
        detail = new Label { Text = "K Studio v" + initialVersion, Location = new Point(18, 17), Size = new Size(456, 25), ForeColor = Color.FromArgb(224, 213, 241) };
        progress = new ProgressBar { Location = new Point(18, 51), Size = new Size(456, 13), Minimum = 0, Maximum = 100, Style = ProgressBarStyle.Marquee, MarqueeAnimationSpeed = 25 };
        var note = new Label { Text = "Tài khoản Muse và dữ liệu của anh được giữ nguyên.", Location = new Point(18, 78), Size = new Size(456, 22), ForeColor = Color.FromArgb(145, 126, 171) };
        box.Controls.Add(detail); box.Controls.Add(progress); box.Controls.Add(note);
        closeButton = new Button { Text = "Ẩn", Location = new Point(434, 252), Size = new Size(96, 34), FlatStyle = FlatStyle.Flat, BackColor = Color.FromArgb(34, 25, 54), ForeColor = Color.White, Enabled = false };
        closeButton.FlatAppearance.BorderColor = Color.FromArgb(87, 59, 123);
        closeButton.Click += delegate { Close(); };
        Controls.Add(mark); Controls.Add(heading); Controls.Add(message); Controls.Add(box); Controls.Add(closeButton);
        timer = new Timer { Interval = 400 };
        timer.Tick += Tick;
        Shown += delegate { Launch(false); timer.Start(); };
        FormClosed += delegate { timer.Stop(); try { File.Delete(progressFile); } catch { } };
    }

    [STAThread]
    private static void Main()
    {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        Application.Run(new KStudioLauncher());
    }

    private string ReadVersion()
    {
        try { return Regex.Match(File.ReadAllText(Path.Combine(root, "package.json")), "\\\"version\\\"\\s*:\\s*\\\"([^\\\"]+)\\\"").Groups[1].Value; }
        catch { return "?"; }
    }

    private void Launch(bool skipUpdate)
    {
        string script = Path.Combine(root, "Start-K-Studio.ps1");
        if (!File.Exists(script)) { Fail("Không tìm thấy tệp khởi chạy K Studio."); return; }
        string args = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File \"" + script + "\" -LauncherProgressFile \"" + progressFile + "\"";
        if (skipUpdate) args += " -SkipUpdateCheck";
        var info = new ProcessStartInfo { FileName = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "WindowsPowerShell\\v1.0\\powershell.exe"), Arguments = args, WorkingDirectory = root, UseShellExecute = false, CreateNoWindow = true, WindowStyle = ProcessWindowStyle.Hidden };
        startProcess = Process.Start(info);
        startedAt = DateTime.UtcNow;
        message.Text = skipUpdate ? "Đang khởi chạy phiên bản mới…" : "Đang kiểm tra cập nhật và mở K Studio…";
    }

    private void Tick(object sender, EventArgs e)
    {
        try
        {
            if (File.Exists(progressFile))
            {
                string[] fields = File.ReadAllText(progressFile).TrimStart('\uFEFF').Split('\n');
                string phase = fields.Length > 0 ? fields[0].Trim() : "";
                string msg = fields.Length > 1 ? fields[1].Trim() : "";
                string file = fields.Length > 2 ? fields[2].Trim() : "";
                long total = 0; if (fields.Length > 3) Int64.TryParse(fields[3].Trim(), out total);
                if (phase == "downloading")
                {
                    progress.Style = ProgressBarStyle.Continuous;
                    long bytes = 0; try { if (File.Exists(file)) bytes = new FileInfo(file).Length; } catch { }
                    int pct = total > 0 ? (int)Math.Min(89, bytes * 89 / total) : 5;
                    progress.Value = Math.Max(0, pct);
                    heading.Text = "Đang cập nhật K Studio";
                    message.Text = "Đang tải bản mới… " + (total > 0 ? pct.ToString() + "%" : "");
                    detail.Text = msg;
                }
                else if (phase == "available")
                {
                    heading.Text = "Có bản cập nhật mới"; message.Text = msg;
                }
                else if (phase == "verifying")
                {
                    progress.Style = ProgressBarStyle.Continuous; progress.Value = 92;
                    heading.Text = "Đang kiểm tra bộ cài"; message.Text = msg;
                }
                else if (phase == "installing")
                {
                    progress.Style = ProgressBarStyle.Continuous; progress.Value = 96;
                    heading.Text = "Đang cài đặt bản mới"; message.Text = msg;
                }
                else if (phase == "complete")
                {
                    progress.Style = ProgressBarStyle.Continuous; progress.Value = 100;
                    heading.Text = "Cập nhật xong"; message.Text = msg;
                }
                else if (phase == "error") { heading.Text = "Không kiểm tra được cập nhật"; message.Text = msg; }
            }
        }
        catch { }

        if (startProcess == null || finished) return;
        try
        {
            if (!startProcess.HasExited) return;
            string current = ReadVersion();
            if (current != initialVersion && !relaunchedAfterUpdate)
            {
                relaunchedAfterUpdate = true;
                Launch(true);
                return;
            }
            if (IsAppReady())
            {
                finished = true; timer.Stop();
                progress.Style = ProgressBarStyle.Continuous; progress.Value = 100;
                heading.Text = "K Studio đã mở"; message.Text = "Cửa sổ lệnh đã được ẩn."; detail.Text = "K Studio v" + current;
                closeButton.Enabled = true;
                var closeTimer = new Timer { Interval = 850 };
                closeTimer.Tick += delegate { closeTimer.Stop(); Close(); };
                closeTimer.Start();
                return;
            }
            if ((DateTime.UtcNow - startedAt).TotalSeconds > 120) Fail("Không mở được K Studio. Kiểm tra kết nối GitHub hoặc nhật ký trong thư mục dữ liệu.");
        }
        catch (Exception ex) { Fail("Không mở được K Studio: " + ex.Message); }
    }

    private bool IsAppReady()
    {
        try
        {
            using (var client = new WebClient())
            {
                client.Headers.Add("User-Agent", "K-Studio-Launcher");
                string response = client.DownloadString("http://127.0.0.1:4173/api/version");
                return response.IndexOf("appVersion", StringComparison.OrdinalIgnoreCase) >= 0;
            }
        }
        catch { return false; }
    }

    private void Fail(string text)
    {
        finished = true; timer.Stop(); heading.Text = "Không mở được K Studio"; message.Text = text; detail.Text = "Có thể đóng cửa sổ này và thử lại."; progress.Style = ProgressBarStyle.Continuous; progress.Value = 0; closeButton.Enabled = true;
    }
}
