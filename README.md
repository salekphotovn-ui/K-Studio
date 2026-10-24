# K Studio

Ứng dụng cục bộ để xếp hàng tác vụ tạo ảnh và video bằng phiên Muse của người dùng.

## Cài bản EXE trên Windows

Chạy `scripts/build-windows-exe.ps1` trên máy phát triển để tạo `release\K-Studio-Setup-v<version>.exe`. Máy nhận chạy trình cài đặt; K Studio cài Node.js và Playwright riêng cùng ứng dụng, rồi tạo lối tắt. Bộ cài tự dò Chrome và bỏ qua nếu đã có. Nếu thiếu, bộ cài hỏi trước khi tải Chrome từ Google, xác minh chữ ký nhà phát hành rồi cài; nếu tự cài không thành công, nó mở trang Chrome chính thức để cài thủ công. Máy nhận cần Internet để đăng nhập Muse. Không gửi thư mục `.git`, `accounts.json`, profile trình duyệt, API key hay lịch sử cá nhân.

Gỡ K Studio bằng lối tắt **Gỡ cài đặt K Studio** trong Start Menu. Thao tác gỡ chỉ xóa chương trình, giữ dữ liệu và các phiên Muse ở `%LOCALAPPDATA%\K Studio`.

## Chạy bản mã nguồn trên Windows

1. Cài Node.js, Git và Google Chrome.
2. Chạy `npm ci` trong thư mục dự án.
3. Mở `Mở K Studio.bat`.

Để dùng `aspect_ratio` trong API cục bộ, cài FFmpeg gồm `ffmpeg` và `ffprobe` vào `PATH`, hoặc đặt biến `KSTUDIO_FFMPEG_PATH` và `KSTUDIO_FFPROBE_PATH` trỏ tới hai file thực thi.

Máy chủ chỉ nghe tại `127.0.0.1:4173`. Tài khoản Muse được đăng nhập riêng trong Chrome do ứng dụng mở.
K Studio giữ tối đa hai chat Muse riêng cho mỗi tài khoản và giao tối đa hai tác vụ cùng lúc trên tài khoản đó. Luồng đầu được chia đều cho các tài khoản sẵn sàng trước khi dùng luồng thứ hai. Công suất tối đa là hai lần số tài khoản đã đăng nhập, ví dụ 5 tài khoản đạt 10 luồng và 10 tài khoản đạt 20 luồng. Lô hỗn hợp xử lý ảnh trước rồi mới chuyển sang video. Cửa sổ đăng nhập nhỏ gọn; khi chạy hàng đợi, các cửa sổ Muse được ẩn trên Windows.

Mỗi máy trong team có API cục bộ với cổng và khóa riêng. Xem key trong **Cài đặt → API cục bộ cho AI khác** và đọc [LOCAL_API.md](LOCAL_API.md) để gửi lô từ script trên chính máy cài K Studio.

## Dữ liệu người dùng

Từ bản này, cấu hình, lịch sử, profile Muse và ảnh tham chiếu mặc định nằm tại `%LOCALAPPDATA%\K Studio`. Kết quả mới mặc định nằm trong thư mục `output` ở đó. Khi chạy lần đầu, ứng dụng **sao chép** dữ liệu cũ từ thư mục mã nguồn nếu dữ liệu mới chưa tồn tại; dữ liệu cũ không bị xóa. Nếu trước đó đã chọn thư mục kết quả riêng, cài đặt ấy được giữ nguyên.

Các tệp dữ liệu, profile đăng nhập và kết quả được loại khỏi Git bằng `.gitignore`. Không đưa chúng vào commit hoặc gói phát hành.

## Cập nhật từ GitHub

Mã nguồn được quản lý trong repository GitHub của K Studio. Máy phát triển có thể đẩy các bản sửa lên nhánh `main`; máy đã clone repository có thể đóng K Studio rồi chạy `Update-K-Studio.bat`. Script chỉ chấp nhận cập nhật fast-forward, không ghi đè thay đổi mã nguồn cục bộ và cài lại thư viện từ `package-lock.json`.

`Update-K-Studio.bat` chỉ cập nhật bản mã nguồn bằng Git. Máy đã cài bản EXE dùng lối tắt **Cập nhật K Studio** trong Start Menu. Lối tắt đọc bản phát hành chính thức mới nhất trên GitHub, tải bộ cài, kiểm tra SHA-256 do GitHub công bố, xác nhận hàng đợi đã kết thúc rồi mới cài đè. Người dùng xác nhận trước khi tải và trước khi cài. Dữ liệu `%LOCALAPPDATA%\K Studio` được giữ nguyên.

Nếu repository phát hành là riêng tư, từng máy cần cài GitHub CLI và chạy `gh auth login` một lần bằng tài khoản có quyền truy cập. Bản cập nhật phải được phát hành chính thức (không phải Draft) và có file `K-Studio-Setup-v<version>.exe`. Máy đã cài trước khi có lối tắt này cần cài đè thủ công một lần để nhận chức năng cập nhật.
