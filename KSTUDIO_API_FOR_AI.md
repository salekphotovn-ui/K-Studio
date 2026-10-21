# Hướng dẫn AI sử dụng K Studio API

Tài liệu này dành cho Claude, Codex hoặc một AI có khả năng gọi HTTP và đọc tệp trên máy đang cài K Studio.

## 1. Kết nối

- Base URL: `http://127.0.0.1:4174`
- API chỉ nghe trên máy cục bộ. Không gọi địa chỉ này từ máy khác hoặc dịch vụ cloud.
- Mọi request phải gửi header:

```http
X-Api-Key: <API_KEY>
Content-Type: application/json
```

Đọc API key hiện tại từ:

```text
%LOCALAPPDATA%\K Studio\local-api.json
```

Quy tắc bảo mật:

- Không in API key ra câu trả lời, log hoặc tệp kết quả.
- Không tự tạo key mới.
- Nếu gặp `401`, đọc lại key hiện tại từ `local-api.json` rồi thử lại.

## 2. Cấu hình xử lý

- Ảnh: tối đa `5` tài khoản chạy song song.
- Video: tối đa `5` tài khoản chạy song song.
- Mỗi tài khoản chỉ xử lý một tác vụ tại một thời điểm.
- Mỗi tài khoản dùng Chrome profile và Main chat Muse riêng.
- Với lô hỗn hợp, tạo ảnh trước rồi mới tạo video.
- Dùng `"account": "auto"` để K Studio tự phân phối tác vụ.
- Không đặt `stop_if_quota_used_over_pct` trừ khi người dùng yêu cầu.

## 3. Kiểm tra trước khi gửi

Gọi:

```http
GET /api/health
```

Ví dụ PowerShell:

```powershell
$config = Get-Content "$env:LOCALAPPDATA\K Studio\local-api.json" -Raw | ConvertFrom-Json
$headers = @{ 'X-Api-Key' = $config.apiKey }
Invoke-RestMethod -Uri 'http://127.0.0.1:4174/api/health' -Headers $headers
```

Chỉ gửi lô khi `ok` là `true`. Trường `default_workers` cho biết số tài khoản mặc định dành cho ảnh và video.

## 4. Gửi lô tạo ảnh

Endpoint:

```http
POST /api/jobs
```

Mẫu request:

```json
{
  "job_id": "project-images-001",
  "type": "image",
  "account": "auto",
  "workers": 5,
  "output_dir": "D:/PROJECT/output/images",
  "skip_existing": true,
  "max_retries": 1,
  "items": [
    {
      "id": "scene_001",
      "prompt": "A small wooden cabin beside a calm lake at sunrise, realistic cinematic photograph"
    },
    {
      "id": "scene_002",
      "prompt": "A red fox sitting beneath an autumn maple tree, realistic cinematic photograph"
    }
  ]
}
```

K Studio lưu kết quả theo `items[].id`, ví dụ:

```text
D:/PROJECT/output/images/scene_001.webp
D:/PROJECT/output/images/scene_002.webp
```

Phần mở rộng thực tế có thể là `.webp`, `.png`, `.jpg` hoặc `.jpeg`.

## 5. Gửi lô tạo video từ ảnh

Mỗi item phải có đúng một ảnh và một prompt tương ứng. Ảnh 1 ghép prompt 1, ảnh 2 ghép prompt 2.

```json
{
  "job_id": "project-videos-001",
  "type": "video",
  "account": "auto",
  "workers": 5,
  "aspect_ratio": "16:9",
  "output_dir": "D:/PROJECT/output/videos",
  "skip_existing": true,
  "max_retries": 1,
  "items": [
    {
      "id": "scene_001",
      "prompt": "Animate the attached scene with a slow camera push-in and gentle natural movement. Preserve the original subject and composition. Duration 5 seconds.",
      "image": "D:/PROJECT/output/images/scene_001.webp"
    },
    {
      "id": "scene_002",
      "prompt": "Animate the fox gently turning its head while leaves drift. Preserve its appearance and the original scene. Duration 5 seconds.",
      "image": "D:/PROJECT/output/images/scene_002.webp"
    }
  ]
}
```

Quy tắc ảnh tham chiếu:

- `image` phải là đường dẫn tuyệt đối trên máy K Studio.
- Chấp nhận PNG, JPG, JPEG và WebP.
- Mỗi ảnh tối đa 6 MB.
- Một lô hỗ trợ tối đa 300 đường dẫn ảnh.
- Không tự cắt, đổi kích thước hoặc đổi định dạng ảnh trước khi gửi, trừ khi người dùng yêu cầu.
- Không dùng `image_data` cho lô lớn. Base64 chỉ phù hợp cho lô tối đa 10 ảnh.

## 6. Quy tắc đặt ID

- `job_id` phải mới và duy nhất cho mỗi nội dung lô.
- Gửi lại cùng `job_id` và cùng nội dung sẽ trả về lô cũ, không tạo trùng.
- Không gửi lại cùng `job_id` với nội dung khác.
- `job_id` chỉ gồm chữ, số, `_`, `-`; tối đa 120 ký tự.
- `items[].id` phải duy nhất trong lô; chỉ gồm chữ, số, `_`, `-`; tối đa 80 ký tự.
- K Studio không ghi đè file kết quả đã tồn tại.

## 7. Chờ kết quả

Sau khi tạo lô, dùng long polling:

```http
GET /api/jobs/{job_id}?wait=1800&full=1
```

Ví dụ:

```http
GET /api/jobs/project-videos-001?wait=1800&full=1
```

Nếu trạng thái vẫn là `queued` hoặc `running`, tiếp tục gọi lại endpoint này. Không hỏi trạng thái liên tục mỗi vài giây.

Các trạng thái chính:

- `queued`: đang chờ.
- `running`: đang xử lý.
- `done`: lô đã kết thúc.
- `paused`: cần đăng nhập hoặc không còn tài khoản phù hợp.
- `cancelled`: lô đã bị hủy.

Mỗi item có thể là:

- `queued`
- `running`
- `done`
- `failed`
- `skipped`
- `cancelled`

Khi item hoàn tất, file cũng đã được ghi trực tiếp vào `output_dir`.

## 8. Thử lại item lỗi

Chỉ thử lại những item có trạng thái `failed`.

Giữ nguyên prompt:

```http
POST /api/jobs/{job_id}/retry
```

```json
{
  "ids": ["scene_005", "scene_009"]
}
```

Sửa prompt rồi thử lại:

```json
{
  "items": [
    {
      "id": "scene_005",
      "prompt": "Revised prompt that removes the rejected or ambiguous instruction"
    }
  ]
}
```

Sau khi gọi retry, tiếp tục chờ bằng:

```http
GET /api/jobs/{job_id}?wait=1800&full=1
```

Không tạo một lô mới chỉ để thử lại item lỗi của lô cũ.

## 9. Hủy lô

```http
POST /api/jobs/{job_id}/cancel
```

Tác vụ đang chạy có thể hoàn thành; các tác vụ chưa chạy sẽ bị hủy.

## 10. Quy trình chuẩn cho dự án ảnh và video

1. Gọi `GET /api/health`.
2. Gửi toàn bộ prompt ảnh bằng một `POST /api/jobs`, `type: image`, `workers: 5`.
3. Chờ lô ảnh bằng `GET /api/jobs/{job_id}?wait=1800&full=1`.
4. Thử lại các ảnh lỗi trong cùng lô.
5. Xác định chính xác file ảnh của từng `items[].id`.
6. Gửi lô video bằng `POST /api/jobs`, `type: video`, `workers: 5`; mỗi item ghép đúng đường dẫn ảnh và prompt.
7. Chờ lô video hoàn tất.
8. Đọc `error` và `error_code` của từng video lỗi, sửa prompt khi cần rồi gọi retry.
9. Báo cho người dùng số lượng thành công, số lượng lỗi và đường dẫn `output_dir`.

## 11. Mẫu chỉ dẫn ngắn cho AI

```text
Dùng K Studio API tại http://127.0.0.1:4174.
Đọc key từ %LOCALAPPDATA%\K Studio\local-api.json và gửi trong header X-Api-Key; không in key ra câu trả lời.
Kiểm tra GET /api/health trước.
Gửi toàn bộ cảnh theo lô qua POST /api/jobs.
Dùng account:auto, ảnh workers:5, video workers:5, max_retries:1 và không đặt ngưỡng hạn mức.
Video phải ghép từng items[].image với đúng items[].prompt.
Chờ bằng GET /api/jobs/{job_id}?wait=1800&full=1.
Chỉ retry item failed; có thể sửa prompt bằng trường items trong request retry.
Không tạo trùng item đã done và không đổi API key.
```
