# K Studio

Ứng dụng cục bộ để xếp hàng tác vụ tạo ảnh và video bằng phiên Muse của người dùng.

## Chạy bản mã nguồn trên Windows

1. Cài Node.js, Git và Google Chrome.
2. Chạy `npm ci` trong thư mục dự án.
3. Mở `Mở K Studio.bat`.

Máy chủ chỉ nghe tại `127.0.0.1:4173`. Tài khoản Muse được đăng nhập riêng trong Chrome do ứng dụng mở.

## Dữ liệu người dùng

Từ bản này, cấu hình, lịch sử, profile Muse và ảnh tham chiếu mặc định nằm tại `%LOCALAPPDATA%\K Studio`. Kết quả mới mặc định nằm trong thư mục `output` ở đó. Khi chạy lần đầu, ứng dụng **sao chép** dữ liệu cũ từ thư mục mã nguồn nếu dữ liệu mới chưa tồn tại; dữ liệu cũ không bị xóa. Nếu trước đó đã chọn thư mục kết quả riêng, cài đặt ấy được giữ nguyên.

Các tệp dữ liệu, profile đăng nhập và kết quả được loại khỏi Git bằng `.gitignore`. Không đưa chúng vào commit hoặc gói phát hành.

## Cập nhật từ GitHub cho bản mã nguồn

Sau khi tạo repository GitHub, cấu hình `origin` và đẩy nhánh `main` từ máy phát triển. Người dùng đã clone repository có thể đóng K Studio rồi chạy `Update-K-Studio.bat`. Script chỉ chấp nhận cập nhật fast-forward, không ghi đè thay đổi mã nguồn cục bộ và cài lại thư viện từ `package-lock.json`.

Script Git này dành cho bản mã nguồn. Bản EXE phân phối sau này sẽ tải gói phát hành có xác thực từ GitHub; người dùng EXE không cần Git. Cơ chế tải và cài EXE chưa được triển khai.
