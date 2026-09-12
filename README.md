# BCTC Radar

App web **không máy chủ** tổng hợp báo cáo tài chính (BCTC) theo quý / năm của các mã chứng
khoán trong danh mục theo dõi: biểu đồ, bảng 8 kỳ, so sánh 2 kỳ theo từng dòng, cùng quý qua
các năm, và **cảnh báo lợi nhuận / lỗ đột biến**. Toàn bộ chạy trong trình duyệt, dữ liệu lưu
ở IndexedDB, chi phí 0. Độc lập hoàn toàn với KingStock và vn-stock-app.

```
Trình duyệt (GitHub Pages / file local, PWA)
 ├─ js/finfo.js    gọi VNDirect finfo (CORS *), ≤2 request song song, nghỉ 300 ms, retry 3
 ├─ js/store.js    IndexedDB: statements · meta · items · alerts · settings · watchlist
 ├─ js/sync.js     mở app → mã mới: nạp 5 năm quý + 10 năm năm; mã cũ: hỏi lại từ (quý cuối − 12 tháng)
 ├─ js/metrics.js  chuẩn hoá chỉ tiêu theo loại công ty, YoY/QoQ/biên/TB 4 quý   (thuần, test được)
 ├─ js/rules.js    8 quy tắc đột biến → cảnh báo, khoá `sym|rt|fd|rule`          (thuần, test được)
 ├─ js/charts.js   SVG thuần
 └─ js/app.js      3 tab: Danh mục · Cảnh báo · Cài đặt
```

## Chạy

**Local** (cần server tĩnh vì service worker và `fetch("data/seed.json")` không chạy trên `file://`):

```powershell
cd "c:\Claude code\bctc-radar"
python -m http.server 8080
# mở http://localhost:8080
```

**GitHub Pages** (miễn phí, HTTPS, cài lên điện thoại được):

1. Tạo repo public tên `bctc-radar` trên github.com.
2. Đưa toàn bộ thư mục này lên — cách không cần cài gì: *Add file → Upload files*, kéo thả
   cả thư mục (giữ nguyên cấu trúc `js/`, `data/`, `icons/`). Hoặc `git push` nếu đã cấu hình git.
3. *Settings → Pages → Build and deployment*: Source = *Deploy from a branch*, Branch = `main`,
   thư mục `/ (root)` → Save. Vài phút sau có link `https://<user>.github.io/bctc-radar/`.
4. Trên Android: mở link bằng Chrome → menu ⋮ → *Cài đặt ứng dụng*. Mở từ màn hình chính
   thì vẫn mở được khi mất mạng (số đã lưu), có mạng thì tự tải phần mới.

Mỗi lần sửa file tĩnh, **tăng `VERSION` trong `sw.js`** để điện thoại nhận bản mới.

**Test logic** (không cần trình duyệt): `node tests/run.js` — fixture là JSON thật của VNDirect.

## Cách app hoạt động

- **Lần đầu mở**: nạp danh mục từ `data/seed.json` (39 mã), tải 5 năm quý + 10 năm năm cho từng
  mã (2 mã song song, ~40 s cho 39 mã, ~92 request). Cảnh báo lần này chỉ tính cho **kỳ mới
  nhất** và đánh dấu *đã xem* — không dội mấy chục cảnh báo cũ lên chấm đỏ.
- **Mỗi lần mở sau**: hiện ngay từ IndexedDB (0 request), rồi nếu đã quá 1 giờ từ lần đồng bộ
  trước thì hỏi VNDirect phần mới (2 request nhỏ / mã, ~30 s cho 39 mã). Kỳ mới → chạy quy
  tắc → cảnh báo *chưa xem* → chấm đỏ. Kỳ cũ mà LNST đổi > 5% → cảnh báo *BCTC bị điều chỉnh*.
- Đang mở app thì tự làm mới mỗi 6 giờ (chỉnh được). Nút **Làm mới** bỏ qua khoá 1 giờ.
- Không có máy chủ nên **không** đẩy thông báo khi app đã đóng. Bật "Thông báo trình duyệt"
  trong Cài đặt thì khi app đang mở và thấy cảnh báo mới sẽ hiện thông báo hệ điều hành.
- Danh mục + cài đặt còn được chép sang `localStorage`; trình duyệt dọn IndexedDB thì số liệu
  tự nạp lại, danh mục không mất. Có Xuất / Nhập file JSON để chuyển máy.

## Quy tắc cảnh báo (chỉ tiêu chính: LNST của công ty mẹ, mã 23000)

| Quy tắc | Điều kiện mặc định | Mức |
|---|---|---|
| Lỗ | LNST < 0 | cao |
| Đổi dấu | lãi ↔ lỗ so với cùng kỳ năm trước | cao |
| BCTC bị điều chỉnh | LNST của kỳ đã lưu đổi ≥ 5% khi tải lại | cao |
| YoY đột biến | \|YoY\| ≥ 70% | trung bình |
| QoQ đột biến | \|QoQ\| ≥ 70% (chỉ quý, không áp dụng khi lỗ) | trung bình |
| Lệch TB 4 quý | lệch ≥ 2σ và ≥ 20% so với TB 4 quý liền trước | thấp |
| Ngoài cốt lõi | (LNTT − LN thuần HĐKD) / \|LNTT\| ≥ 30% — bỏ qua ngân hàng | thấp |
| Doanh thu đột biến | \|YoY doanh thu\| ≥ 40% | thấp |

Chấm đỏ mặc định chỉ đếm mức *cao* + *trung bình*. Đổi ngưỡng chỉ ảnh hưởng kỳ sau; cảnh báo
đã ghi không bị tính lại.

## Nguồn dữ liệu — VNDirect finfo (không chính thức)

`https://api-finfo.vndirect.com.vn/v4/financial_statements?q=code:FPT~reportType:QUARTER~fiscalDate:gte:2021-01-01&size=5000&sort=fiscalDate`

- Trả mọi dòng của cả 3 báo cáo trong 1 call (~3.800 dòng / 5 năm quý, ~1,8 s). Số quý là
  **số riêng từng quý**. Có `createdDate` (ngày đăng) và `modifiedDate`.
- Mã chỉ tiêu thống nhất cho 4 mẫu BCTC: `21001` DTT · `21000` Tổng DT HĐKD (chứng khoán dùng
  làm doanh thu) · `421900` Thu nhập lãi thuần (ngân hàng dùng làm doanh thu) · `23100` LN gộp ·
  `23110` LN thuần HĐKD · `23800` LNTT · `23003` LNST · `23000` LNST công ty mẹ · `14000` VCSH ·
  `32000` LCTT HĐKD.
- Loại công ty nhận từ `modelType` có trong dữ liệu: DN thường 1/2/3 · chứng khoán 89/90/91 ·
  ngân hàng 101/102/103 · bảo hiểm 411/412/413 (= CĐKT / KQKD / LCTT). Tên chỉ tiêu:
  `/v4/financial_models?q=modelType:N` (bỏ trường `codeList`, rất nặng).
- Tên công ty: `/v4/stocks?q=code:A,B,…` — hỏi quá ~8 mã một lần thì trả 500, app tự chia.

### Bẫy đã gặp

- **WAF chặn User-Agent chứa `HeadlessChrome`** (403 "Access Denied") — chỉ ảnh hưởng trình duyệt
  headless khi test tự động; đặt `--user-agent` thường là qua. Người dùng thật không gặp.
- Nguồn không có tài liệu, endpoint khác (`ratios_latest`) đã 404 → mọi thứ về API gom trong
  `js/finfo.js`, fixture thật trong `tests/fixtures/` để `node tests/run.js` đỏ sớm. Mất nguồn
  thì app vẫn mở với số đã lưu và hiện băng vàng; phương án B là proxy Cloudflare Worker sang
  CafeF (CafeF không CORS và chỉ giữ ~2 năm).
- Dữ liệu nguồn có thể sai (VD FPT Q1–Q2/2026 doanh thu thuần giảm ~20% trong khi LN tăng).
  App không tự sửa; mỗi mã có link đối chiếu CafeF / Vietstock.
- Dòng EPS / tỷ lệ có giá trị đơn vị đồng, không phải tỷ — bảng tự nhận (mọi giá trị < 100.000)
  và ghi "(đ)".

## Nguồn khác đã thử và loại (12/09/2026)

CafeF `BaoCaoTaiChinh_V2.aspx` (HTML, không CORS, lùi tới 2021 là 404) · Vietstock (BCTC bắt
đăng nhập, API trả phí) · TCBS `apipubaws` (404, đã chết) · thư viện `vnstock` (cần Python +
pandas) · FireAnt (cần token cá nhân).
