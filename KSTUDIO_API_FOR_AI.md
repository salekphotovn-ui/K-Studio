# Hướng dẫn AI sử dụng K Studio API

Tài liệu này dành cho Claude, Codex hoặc một AI có khả năng gọi HTTP và đọc tệp trên máy đang cài K Studio. Bản tài liệu đi cùng K Studio v0.3.63 trở lên, tại `%LOCALAPPDATA%\Programs\K Studio\KSTUDIO_API_FOR_AI.md` trên từng máy Windows.

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

- Mỗi tài khoản chạy tối đa `1` tác vụ cùng lúc trong Main chat Muse.
- Công suất tối đa bằng số tài khoản Muse sẵn sàng; 5 tài khoản đạt 5 luồng, 10 tài khoản đạt 10.
- K Studio chia tác vụ cho các tài khoản sẵn sàng và xử lý tuần tự trên từng tài khoản.
- Đọc `/api/health` trước khi gửi. Bỏ trường `workers` để K Studio tự chọn công suất, hoặc dùng `capabilities.max_image_workers` cho lô ảnh và `capabilities.max_video_workers` cho lô video. Không ghi cứng `workers: 10`.
- Nếu máy chọn một tài khoản chỉ để tạo ảnh và loại tài khoản đó khỏi video, giới hạn video sẽ thấp hơn giới hạn ảnh. Mỗi máy có số tài khoản và giới hạn riêng.
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

Chỉ gửi lô khi `ok` là `true` và `capabilities.workers_per_account` là `1`. Trường `default_workers.image` và `default_workers.video` cho biết số luồng mặc định; `capabilities.max_image_workers` và `capabilities.max_video_workers` là mức tối đa cho từng loại. `capabilities.max_workers` là tổng số tài khoản sẵn sàng, có thể lớn hơn mức video khi tài khoản ảnh bị loại khỏi video. Luồng thực tế không vượt quá công suất tài khoản và số item trong lô.

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
D:/PROJECT/output/images/scene_001.<đuôi ảnh thực tế>
D:/PROJECT/output/images/scene_002.<đuôi ảnh thực tế>
```

Phần mở rộng thực tế có thể là `.webp`, `.png`, `.jpg` hoặc `.jpeg`. `items[].file` trong phản hồi là **đường dẫn API để tải file**, không phải đường dẫn ổ đĩa. Trước khi gửi video, tìm đúng file `<output_dir>/<id>` với đuôi ảnh thực tế và kiểm tra file tồn tại, dung lượng lớn hơn 0.

## 5. Gửi lô tạo video từ ảnh

Mỗi item phải có đúng một ảnh và một prompt tương ứng. Ảnh 1 ghép prompt 1, ảnh 2 ghép prompt 2.

```json
{
  "job_id": "project-videos-001",
  "type": "video",
  "account": "auto",
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
      "image": "D:/PROJECT/output/images/scene_002.png"
    }
  ]
}
```

Quy tắc ảnh tham chiếu:

- `image` phải là đường dẫn tuyệt đối trên máy K Studio.
- Hai đường dẫn ảnh ở ví dụ chỉ minh họa hai định dạng có thể gặp; lấy tên file thực tế của lô ảnh trên máy, không đoán đuôi file.
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
GET /api/jobs/{job_id}?wait=300
```

Ví dụ:

```http
GET /api/jobs/project-videos-001?wait=300
```

Nếu trạng thái vẫn là `queued` hoặc `running`, tiếp tục gọi lại endpoint này. `wait` tính bằng giây, tối đa 1800; dùng giá trị phù hợp với thời gian chờ HTTP của client. Không hỏi trạng thái liên tục mỗi vài giây. Tham số `full` không cần thiết vì phản hồi đã gồm trạng thái từng item.

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
GET /api/jobs/{job_id}?wait=300
```

Nếu lỗi là timeout sau khi prompt đã gửi, kiểm tra Main chat Muse của tài khoản đó trước khi retry để tránh tạo trùng và tốn token. Không tạo một lô mới chỉ để thử lại item lỗi của lô cũ.

## 9. Hủy lô

```http
POST /api/jobs/{job_id}/cancel
```

Tác vụ đang chạy có thể hoàn thành; các tác vụ chưa chạy sẽ bị hủy.

## 10. Quy trình chuẩn cho dự án ảnh và video

1. Gọi `GET /api/health`.
2. Gửi toàn bộ prompt ảnh bằng một `POST /api/jobs`, `type: image`; bỏ `workers` để K Studio tự chọn, hoặc dùng `capabilities.max_image_workers`.
3. Chờ lô ảnh bằng `GET /api/jobs/{job_id}?wait=300` và lặp lại khi còn chạy.
4. Thử lại các ảnh lỗi trong cùng lô.
5. Xác định chính xác file ảnh thực tế của từng `items[].id` trong `output_dir`; chỉ dùng ảnh đã tạo thành công hoặc đã có sẵn.
6. Gửi lô video bằng `POST /api/jobs`, `type: video`; bỏ `workers` hoặc dùng `capabilities.max_video_workers`. Mỗi item ghép đúng đường dẫn ảnh và prompt.
7. Chờ lô video hoàn tất.
8. Đọc `error` và `error_code` của từng video lỗi. Kiểm tra Main chat nếu bị timeout; sửa prompt khi lỗi do nội dung rồi gọi retry.
9. Báo cho người dùng số lượng thành công, số lượng lỗi và đường dẫn `output_dir`.

## 11. Mẫu chỉ dẫn ngắn cho AI

```text
Dùng K Studio API tại http://127.0.0.1:4174.
Đọc key từ %LOCALAPPDATA%\K Studio\local-api.json và gửi trong header X-Api-Key; không in key ra câu trả lời.
Kiểm tra GET /api/health trước.
Gửi toàn bộ cảnh theo lô qua POST /api/jobs.
Dùng `account:auto`, `max_retries:1`, không đặt ngưỡng hạn mức và bỏ `workers` để K Studio tự chọn. Nếu cần đặt tường minh, đọc `capabilities.max_image_workers` hoặc `capabilities.max_video_workers` từ `/api/health` theo loại lô. Mỗi tài khoản chỉ chạy 1 tác vụ trong Main chat.
Video phải ghép từng items[].image với đúng items[].prompt.
Chờ bằng GET /api/jobs/{job_id}?wait=300; gọi lại nếu lô còn chạy.
Chỉ retry item failed; có thể sửa prompt bằng trường items trong request retry.
Không tạo trùng item đã done và không đổi API key.
```
