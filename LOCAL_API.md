# API cục bộ của K Studio

Mỗi máy trong team cài K Studio và tự đăng nhập tài khoản Muse của mình. Chương trình/script trên **chính máy đó** gọi API ở `http://127.0.0.1:4174`. Mỗi máy có hàng đợi, tài khoản và thư mục kết quả riêng. Không cần VPN hoặc mở Windows Firewall.

Giao diện K Studio vẫn ở `http://127.0.0.1:4173`. API cục bộ chỉ nghe ở `127.0.0.1`, dùng cổng và khóa riêng; không cho máy khác trong mạng gọi trực tiếp.

## Khởi động và lấy khóa

Chạy `Mở K Studio.bat` như bình thường. Lần chạy đầu tạo `%LOCALAPPDATA%\K Studio\local-api.json` (hoặc trong `KSTUDIO_DATA_DIR` nếu đã đặt biến đó). API mặc định bật với khóa ngẫu nhiên trong file này:

```json
{
  "enabled": true,
  "host": "127.0.0.1",
  "port": 4174,
  "apiKey": "khóa_ngẫu_nhiên_riêng_của_máy"
}
```

Giữ khóa trên máy; không đưa vào Git hay gửi cho máy khác. Mọi request cần header `X-Api-Key`. Có thể đổi `apiKey` rồi khởi động lại K Studio để thu hồi khóa cũ. Máy khác cài K Studio sẽ tự có khóa riêng. `host` chỉ được đặt là `127.0.0.1`.

Trong **Cài đặt → API cục bộ cho AI khác**, bấm **Sao chép** để lấy key hoặc **Hiện** để xem. Bấm **Tạo key mới** để key cũ hết hiệu lực ngay, không cần khởi động lại. Chỉ cấp key cho ứng dụng/script chạy trên cùng máy; AI chạy trong trình duyệt hay trên dịch vụ đám mây không thể tự truy cập `127.0.0.1` của máy này. Nếu cần AI tự gọi API, AI đó phải có thành phần chạy cục bộ trên máy K Studio và lưu key trong cấu hình riêng của nó.

## Gửi một lô

`POST /api/jobs` với JSON UTF-8. Ví dụ ảnh sang video, dùng ảnh sẵn có trên **cùng máy**:

```json
{
  "job_id": "du-an-a-001",
  "type": "video",
  "account": "auto",
  "workers": 3,
  "aspect_ratio": "16:9",
  "output_dir": "D:/Du an A/videos",
  "skip_existing": true,
  "max_retries": 1,
  "stop_if_quota_used_over_pct": 90,
  "items": [
    { "id": "canh-01", "prompt": "Animate this image with a slow camera push-in...", "image": "D:/Du an A/images/canh-01.webp" },
    { "id": "canh-02", "prompt": "Animate this image with a gentle pan...", "image": "D:/Du an A/images/canh-02.png" }
  ]
}
```

`type` là `image` hoặc `video`. `job_id` và `items[].id` chỉ dùng chữ Latin, số, `-`, `_`; mỗi item cần một ID duy nhất. Tối đa 300 item và 10 ảnh tham chiếu mỗi lô, ảnh tối đa 6 MB. Nếu không có `output_dir`, kết quả vào thư mục output K Studio: `videos/<job_id>` hoặc `images/<job_id>`. Nếu có, đó phải là đường dẫn tuyệt đối trên **máy này**; kết quả nằm trực tiếp trong thư mục đã chỉ định. API không ghi đè file cũ.

Mỗi tài khoản dùng chung Main chat Muse; `workers` nhận số nguyên từ `1` đến `4`; nếu bỏ qua, API lấy số luồng ảnh/video trong Cài đặt K Studio. Luồng chạy song song trong tài khoản được chọn; K Studio ghép phản hồi theo prompt. Nếu Muse từ chối do hạn mức, phần việc chưa gửi mới tiếp tục trên tài khoản kế tiếp. `GET /api/health` và phản hồi của lô báo số luồng đã cấu hình.

Ảnh tham chiếu có thể gửi qua đường dẫn `image` trên cùng máy, hoặc qua `image_data` dạng `data:image/webp;base64,...`. Mỗi item video nhận tối đa một ảnh. Với tác vụ ảnh, bỏ cả hai trường. K Studio chép ảnh vào vùng dữ liệu riêng trước khi xếp hàng, nên file gốc có thể tiếp tục được dùng.

`account: "auto"` bắt đầu từ tài khoản chính và chuyển sang tài khoản bật khác nếu Muse báo hết hạn mức. Có thể chỉ định tên hoặc ID tài khoản. Gửi lại cùng `job_id` và cùng nội dung sẽ trả lô cũ, không tạo trùng; cùng ID với nội dung khác trả `409`.

K Studio đọc hạn mức tuần thật ở **Muse → Settings → Usage**. `GET /api/health` trả `accounts[].quota_used_pct`, `quota_observed_at`, nhãn ngày đặt lại và token bổ sung. Nếu Muse không hiển thị số này hoặc số đã quá 10 phút, giá trị là `null`, không phải 0%. `GET /api/jobs/<job_id>` trả phần trăm của tài khoản đang dùng; mỗi item có `quota_before_pct`, `quota_after_pct`, `quota_delta_pct` khi đọc được trước/sau. Muse hiện chỉ hiển thị phần trăm nguyên nên một tác vụ nhỏ có thể hiện delta `0` dù đã dùng hạn mức.

Mặc định K Studio **không chặn theo phần trăm hạn mức tuần**. Muse có thể tiếp tục dùng token bổ sung khi phần miễn phí đạt 100%. Nếu cần giới hạn riêng cho một lô API, đặt `stop_if_quota_used_over_pct` (0–100); khi đó K Studio kiểm tra hạn mức trước mỗi item và dự phòng tối thiểu 1 điểm % cho ảnh, 4 điểm % cho video. `GET /api/health` vẫn trả `estimated_next_image_pct` và `estimated_next_video_pct` để tham khảo. Khi Muse thực sự báo hết token hoặc không thể tạo do hạn mức, K Studio chuyển việc chưa gửi sang tài khoản đã bật tiếp theo. Lô tạm dừng nếu không có tài khoản dùng được. Có thể gọi `POST /api/jobs/<job_id>/resume` sau khi xử lý nguyên nhân.

`aspect_ratio` nhận dạng `W:H`, ví dụ `16:9`, `9:16`, `1:1`. K Studio cắt giữa ảnh/video kết quả để bảo đảm đúng tỉ lệ file; vùng sát mép có thể bị mất. Máy cần FFmpeg và FFprobe trong `PATH`, hoặc đặt `KSTUDIO_FFMPEG_PATH` và `KSTUDIO_FFPROBE_PATH` trước khi mở K Studio. Không đặt trường này thì giữ nguyên tỉ lệ Muse trả về.

`max_retries` là số lần tự thử lại từ 0 đến 3, mặc định 1. K Studio tự thử lại lỗi trước khi prompt được gửi, khi Muse báo rõ tạo thất bại, và lỗi xử lý file đã tải. Nếu prompt đã được gửi nhưng kết quả không rõ (ví dụ hết thời gian chờ), K Studio báo lỗi để người dùng kiểm tra chat Muse trước khi gọi `/retry`; tự gửi lại lúc đó có thể tạo trùng và tốn hạn mức. Mỗi item trả `retries` để thấy số lần đã thử lại.

Kết quả được chép vào `<output_dir>/<id>.<định dạng gốc>` qua file `.part` trước khi xuất hiện với đuôi thật. Muse có thể trả WebP cho ảnh hoặc MP4/WebM/MOV cho video; API giữ đúng định dạng thực của file tải về. `skip_existing` mặc định bật.

## Theo dõi và tải file

| Phương thức | Đường dẫn | Công dụng |
| --- | --- | --- |
| `GET` | `/api/health` | Phiên bản và số lô đang chạy |
| `GET` | `/api/jobs/<job_id>` | Trạng thái lô và từng item |
| `GET` | `/api/jobs/<job_id>?wait=1800` | Chờ tối đa 1.800 giây rồi trả trạng thái |
| `GET` | `/api/jobs/<job_id>/files/<id>` | Tải file của item đã hoàn tất |
| `POST` | `/api/jobs/<job_id>/retry` | Thử lại item lỗi; có thể gửi prompt đã chỉnh bằng `items: [{"id":"canh-01","prompt":"prompt mới"}]` |
| `POST` | `/api/jobs/<job_id>/resume` | Kiểm tra lại hạn mức và tiếp tục item đang tạm dừng |
| `POST` | `/api/jobs/<job_id>/cancel` | Hủy item chờ; item đang tạo được làm xong |

Mọi endpoint đều cần `X-Api-Key`. Client có thể hỏi trạng thái mỗi 30–60 giây cho lô dài. Phản hồi không lặp lại prompt. Mỗi item lỗi trả `error_code` và `error` chứa thông báo Muse/K Studio để client phân tích.

Quy trình AI tự xử lý item lỗi:

1. Gọi `GET /api/jobs/<job_id>` và đọc `items[]` có `state: "failed"`, gồm `id`, `error_code` và `error`.
2. Dựa trên lỗi, client/AI tự sửa prompt trong ứng dụng gọi API. Local API không gọi một mô hình AI khác để tự viết prompt.
3. Gọi `POST /api/jobs/<job_id>/retry` với các item lỗi và prompt mới. Chỉ những ID trong `items` được gửi lại; các ảnh/video đã xong không bị tạo lại.

Ví dụ:

```json
{
  "items": [
    { "id": "v04", "prompt": "Animate the reference image with a simple slow camera pan, no text, 5 seconds." },
    { "id": "v08", "prompt": "Create a 5-second clip from the reference image; keep the scene unchanged and use subtle motion." }
  ]
}
```

Gửi `{"ids":["v04"]}` để thử lại prompt cũ cho một item; gửi `{}` để thử lại tất cả item lỗi bằng prompt hiện có. Có thể kết hợp `ids` và `items`; prompt mới chỉ áp dụng cho các ID được nêu. API chỉ nhận cập nhật cho item đang lỗi và từ chối item đang chạy/đã hoàn tất. Nếu lỗi chỉ rõ prompt không phù hợp, AI client nên sửa prompt; nếu lỗi là timeout hoặc Muse không mở được chat, nên xử lý kết nối trước thay vì đổi nội dung prompt.

Trường `file` là đường dẫn API để tải; file cũng nằm ở `output_dir` trên máy này.

Nếu nhận `401`, key mà client gửi đã khác key K Studio đang dùng. Sao chép lại key hiện tại từ **Cài đặt → API cục bộ cho AI khác** rồi cập nhật cấu hình client. Key trong một bản sao cũ của `%LOCALAPPDATA%` hoặc môi trường chạy tách biệt có thể không phải key của tiến trình K Studio hiện tại; không cần tạo key mới chỉ để xử lý `401`.

## Giới hạn hiện tại

- Muse có thể đổi bố cục Settings → Usage; khi không đọc được số thật, `quota_used_pct` là `null` và lô sẽ tạm dừng.
- Cắt file sau khi Muse tạo xong bảo đảm tỉ lệ pixel nhưng không thay đổi bố cục mà Muse đã tạo. FFmpeg phải có sẵn trên máy.
- Lỗi sau khi đã gửi prompt nhưng chưa tải được file cần kiểm tra trong Muse trước khi chạy lại để tránh tạo trùng.
- API hỗ trợ một ảnh tham chiếu cho mỗi prompt video; `images` dùng chung chưa có.
- Các lô chạy lần lượt trong hàng đợi K Studio; mỗi tài khoản dùng chung Main chat và số luồng đã đặt trong Cài đặt.

`API_MUSE_SPEC.md` là đặc tả mục tiêu ban đầu; tài liệu này ghi các endpoint đã triển khai.
