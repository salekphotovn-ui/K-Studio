# Đặc tả API cục bộ cho Muse Studio

Mục tiêu: một chương trình bên ngoài (script của Claude) gửi **cả danh sách cảnh trong 1 lần**, Muse tự chạy hết, **ghi file thẳng vào thư mục đích với tên đã định**, và chương trình chỉ cần **1 lần chờ** để biết kết quả. Gọi càng ít lần thì càng nhanh và càng ít token.

## Nguyên tắc
1. **Gửi theo lô.** Một request mang toàn bộ cảnh. Muse tự xếp hàng, tự chạy song song theo cài đặt, tự luân phiên tài khoản như hiện tại.
2. **Ghi file thẳng ra đích.** Client truyền `output_dir` và `id` cho từng cảnh; Muse lưu `output_dir/<id>.mp4` (ảnh: `<id>.jpg` hoặc `.png`). Không cần tải về hay đổi tên.
3. **Ảnh tham chiếu truyền bằng đường dẫn file trên máy**, không upload base64.
4. **Một endpoint chờ (long-poll).** Request treo đến khi lô xong hoặc hết thời gian chờ, thay cho việc hỏi trạng thái liên tục.
5. **Phản hồi gọn.** Không trả lại nguyên văn prompt; chỉ trả `id`, trạng thái, đường dẫn file, lỗi.
6. **Chạy lại an toàn.** Cùng `job_id` gửi lại thì không tạo trùng; cảnh đã có file ở đích thì bỏ qua.

## Kết nối
- Địa chỉ: `http://127.0.0.1:<port>` (ví dụ 8765), chỉ lắng nghe trên máy.
- Header bắt buộc: `X-Api-Key: <key>`, key hiển thị trong phần Cài đặt của app.
- JSON UTF-8. Đường dẫn Windows có dấu tiếng Việt phải dùng được (ví dụ `D:/KHOA HỌC CÔNG TRÌNH/...`).

## Endpoint

### 1. `GET /api/health`
Kiểm tra app và tài khoản.
```json
{
  "ok": true,
  "version": "0.3.20",
  "accounts": [
    {"name": "Tài khoản tạo video", "ready": true, "quota_used_pct": 8.3, "resets": "2026-10-22"},
    {"name": "Tài khoản 2", "ready": true, "quota_used_pct": 5.0, "resets": "2026-10-18"}
  ],
  "running_jobs": 0
}
```

### 2. `POST /api/jobs`: gửi một lô
```json
{
  "job_id": "tokyo-video-01",
  "type": "video",
  "account": "Tài khoản tạo video",
  "aspect_ratio": "16:9",
  "output_dir": "D:/KHOA HỌC CÔNG TRÌNH/visuals/tokyo/videos",
  "skip_existing": true,
  "max_retries": 1,
  "stop_if_quota_used_over_pct": 90,
  "items": [
    {"id": "s01", "prompt": "Animate this image: slow drone push-in ...", "image": "D:/KHOA HỌC CÔNG TRÌNH/visuals/tokyo/images/s01.jpg"},
    {"id": "s02", "prompt": "Animate this image: camera tilts down ...", "image": "D:/KHOA HỌC CÔNG TRÌNH/visuals/tokyo/images/s02.jpg"}
  ]
}
```
| Field | Bắt buộc | Ghi chú |
|---|---|---|
| `job_id` | có | Do client đặt. Gửi lại cùng `job_id` thì trả về lô cũ, không tạo trùng |
| `type` | có | `video` hoặc `image` |
| `account` | không | Tên tài khoản, hoặc `"auto"` để app tự luân phiên khi hết hạn mức hoặc bị Meta ngắt |
| `aspect_ratio` | không | Mặc định `16:9`. **Phải áp dụng đúng cho mọi item** (hiện giao diện tự quay về 9:16 sau mỗi lần chạy) |
| `output_dir` | có | App tự tạo thư mục nếu chưa có |
| `skip_existing` | không | Mặc định `true`: bỏ qua item đã có `<id>.mp4` |
| `max_retries` | không | Mặc định 1. Số lần tự thử lại một item lỗi |
| `stop_if_quota_used_over_pct` | không | Dừng lô khi tài khoản đã dùng quá ngưỡng này |
| `items[].id` | có | Dùng làm tên file đầu ra. Chỉ gồm chữ, số, `-`, `_` |
| `items[].prompt` | có | Một prompt, có thể nhiều dòng |
| `items[].image` | không | Ảnh bắt đầu (ảnh sang video) |
| `items[].images` | không | Danh sách ảnh tham chiếu nhân vật hoặc sản phẩm (tương đương chế độ "Dùng chung" / "Giữ nguyên nhân vật") |

Phản hồi trả về ngay, không chờ tạo xong:
```json
{"job_id": "tokyo-video-01", "accepted": 21, "skipped": ["s02"], "quota_estimate_pct": 57.8}
```

### 3. `GET /api/jobs/{job_id}?wait=900`: chờ kết quả
Treo tối đa `wait` giây (mặc định 0, tối đa 1800) và trả về **ngay khi lô kết thúc**: tất cả item xong hoặc lỗi, hoặc lô bị dừng.
```json
{
  "job_id": "tokyo-video-01",
  "state": "done",
  "done": 19, "failed": 1, "pending": 0, "skipped": 1,
  "quota_used_pct": 66.1,
  "items": [
    {"id": "s05", "state": "failed", "error": "timeout_12min"},
    {"id": "s09", "state": "done", "file": "D:/.../videos/s09.mp4", "seconds": 10}
  ]
}
```
- `state`: `queued` | `running` | `done` | `stopped` (dừng vì hạn mức, bị hủy hoặc tài khoản lỗi).
- Mặc định `items` **chỉ liệt kê item lỗi và item vừa xong kể từ lần gọi trước**, để phản hồi luôn ngắn. Thêm `?full=1` để lấy toàn bộ.
- Mã lỗi gợi ý: `timeout_12min`, `meta_rejected` (nội dung bị từ chối), `account_not_ready`, `quota_exceeded`, `file_not_found`, `unknown`.

### 4. `POST /api/jobs/{job_id}/retry`
`{"ids": ["s05"]}`: chạy lại các item lỗi trong cùng lô.

### 5. `POST /api/jobs/{job_id}/cancel`
Dừng lô. Item đang chạy được làm nốt; item đang chờ bị bỏ.

## Yêu cầu khi ghi file
- Ghi ra `<id>.part` rồi đổi tên thành `<id>.mp4` khi xong, để client không đọc nhầm file đang ghi dở.
- Không ghi đè file đã có, trừ khi request có `"overwrite": true`.
- Vẫn giữ một bản trong thư viện của app như hiện tại (không bắt buộc).

## Ví dụ luồng gọi (chỉ 2–3 request cho cả video)
```
POST /api/jobs                               → accepted 21
GET  /api/jobs/tokyo-video-01?wait=1800      → done 20, failed 1 (s05)
POST /api/jobs/tokyo-video-01/retry {"ids":["s05"]}
GET  /api/jobs/tokyo-video-01?wait=600       → done
```

## Mức tối thiểu nếu cần làm nhanh
Nếu chưa làm được tất cả, chỉ cần 3 phần sau là đủ dùng:
1. `POST /api/jobs` có `items[].id`, `prompt`, `image`, `output_dir`, `aspect_ratio`, `account`.
2. Ghi file `output_dir/<id>.mp4`.
3. `GET /api/jobs/{job_id}` trả về số item xong, lỗi, đang chờ (client tự hỏi lại mỗi 30 giây).
