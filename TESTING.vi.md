# Hướng dẫn Chạy & Quản lý Test Suite

> 🌐 Language / Ngôn ngữ: [English](TESTING.md) | **Tiếng Việt**

Tài liệu này hướng dẫn chi tiết cách chạy, cấu trúc và viết các bài kiểm thử (unit & integration tests) cho dự án **`Nodejs WSS Tunnel`**.

---

## 📊 Trạng thái Bộ Kiểm Thử (Test Suite Status)

Bộ test được xây dựng dựa trên **Node.js Test Runner chuẩn (`node:test`)**, không phụ thuộc vào framework kiểm thử bên thứ 3 (như Jest hay Mocha).

- Chạy `yarn test` để xem số lượng test hiện tại. Các test local real-service có thể bỏ qua khi Redis/Postgres không khả dụng; CI đặt `REQUIRE_TCP_SERVICES=1`.

---

## 🚀 Cách Chạy Test

### 1. Chạy Toàn Bộ Test Suite
Dùng lệnh chuẩn được cấu hình trong `package.json`:

```bash
npm test
```

Hoặc chạy trực tiếp qua Node.js test runner:

```bash
node --test test/*.test.js
```

### 2. Chạy Riêng Từng File Test

- **Kiểm thử Endpoint Quản trị Config & Health Check**:
  ```bash
  node --test test/config-endpoint.test.js
  ```

- **Kiểm thử Các Hàm Utility & Mã hóa HMAC**:
  ```bash
  node --test test/utils.test.js
  ```

- **Kiểm thử Hệ thống Logger & Dynamic Config Patching**:
  ```bash
  node --test test/logger.test.js
  ```

- **Kiểm thử Đơn vị StreamManager**:
  ```bash
  node --test test/stream-manager.test.js
  ```

- **Kiểm thử Vòng đời TCP StreamManager**:
  ```bash
  node --test test/stream-manager-tcp.test.js
  ```

- **Kiểm thử TCP Client Handler**:
  ```bash
  node --test test/tcp-client-handler.test.js
  ```

- **Kiểm thử TCP Router**:
  ```bash
  node --test test/tcp-router.test.js
  ```

- **Kiểm thử TCP Flow Control**:
  ```bash
  node --test test/tcp-flow-control.test.js
  ```

- **Kiểm thử TCP End-to-End**:
  ```bash
  node --test test/tcp-e2e.test.js
  ```

- **Kiểm thử TCP Cleanup**:
  ```bash
  node --test test/tcp-cleanup.test.js
  ```

- **Kiểm thử TCP Tích hợp Thực tế**:
  ```bash
  node --test test/tcp-real-integration.test.js
  ```

- **Kiểm thử TCP Stress**:
  ```bash
  node --test test/tcp-stress.test.js
  ```

- **Kiểm thử IP Allowlist**:
  ```bash
  node --test test/ip-allowlist.test.js
  ```

---

## 📁 Cấu trúc các File Test (`test/`)

### 1. `test/config-endpoint.test.js` (Integration Tests)
Kiểm thử tích hợp cho toàn bộ HTTP Server và Endpoint quản trị cấu hình:
- **Tự động spawn HTTP Server ngầm** trên Port ngẫu nhiên (`findFreePort()`).
- **Xác thực HMAC Signature (`/${serverUuid}-config`)**:
  - Từ chối truy cập không có chữ ký (trả về 404).
  - Từ chối chữ ký hết hạn (Expired expiration timestamp).
  - Từ chối chữ ký bị thay đổi (Tampered HMAC hex).
  - Từ chối sai secret key.
- **GET Request**: Trả về cấu hình `verbose` và `logFormat` hiện tại.
- **POST Request**: Cập nhật động cấu hình `verbose` (`true`/`false`) và `logFormat` (`text`/`json`). Kiểm tra validate kiểu dữ liệu truyền vào.
- **Method Not Allowed**: Đảm bảo trả về HTTP 405 cho `PUT`, `DELETE`.
- **Health Check**: Đảm bảo `/__health` và `/healthz` luôn trả về `200 ok`.

### 2. `test/utils.test.js` (Unit Tests)
Kiểm thử các hàm tiện ích trong `src/utils.js`:
- `generateSignedUrl()`: Đảm bảo sinh chữ ký SHA256 hex 64 ký tự và expiration timestamp chính xác.
- `validateHmacSignature()`: Kiểm tra tính đúng đắn của việc xác minh chữ ký HMAC, bao gồm các edge cases (thiếu tham số, timestamp không phải số, sai độ dài hex, chữ ký hết hạn).
- `roundtrip`: Kiểm tra sinh chữ ký và xác thực tương thích 100%.

### 3. `test/logger.test.js` (Unit Tests)
Kiểm thử hệ thống logging trong `src/logger.js`:
- `getConfig()` / `setConfig()`: Cập nhật động thuộc tính cấu hình không làm ảnh hưởng tính cô lập của object.
- `logStandard()`: Kiểm tra xuất log cho các danh mục hợp lệ (`ws`, `http`, `proxy`, `stream`, `heartbeat`, `auth`) và bỏ qua danh mục không hợp lệ.
- `logVerbose()`: Đảm bảo log verbose chỉ hoạt động khi cờ `serverConfig.verbose = true`.

### 4. `test/stream-manager.test.js` (Unit Tests)
Kiểm thử đơn vị cho stream manager trong `src/StreamManager.js`:
- `allocateStreamId()`: Trả về stream ID tăng dần bắt đầu từ 1.
- `createStream()`:
  - Lưu `meta` trên object state trả về (quan trọng để log `method`/`url` trong `HttpRouter`).
  - Lưu tất cả thuộc tính state cần thiết (`id`, `ws`, `req`, `res`, `cleaned`, `abortSent`, v.v.).
  - Đăng ký stream vào internal `streams` map.
  - Trả về `null` và gửi 503 khi `ws.send` thất bại (tunnel client không khả dụng).
- `cleanupStream()`: Xóa stream khỏi map và là idempotent (an toàn khi gọi nhiều lần).
- `abortStream()`:
  - Gửi frame `REQ_ABORT` đến client khi `notifyClient=true`.
  - Không gửi `REQ_ABORT` khi `notifyClient=false`.
  - Ghi response 502 JSON khi response chưa bắt đầu.
  - Không gửi duplicate frame `REQ_ABORT`.
  - Không làm gì nếu stream đã được cleanup.
- `handleClientFrame()`: Bỏ qua frame cho stream ID không xác định và frame từ kết nối WebSocket sai.

### 5. `test/stream-manager-tcp.test.js` (Unit Tests)
Kiểm thử đơn vị cho vòng đời TCP stream trong `src/StreamManager.js`:
- `createTcpStream()`: Lưu state với `mode: 'tcp'`, đăng ký trong streams map.
- `cleanupTcpStream()`: Xóa TCP stream, huỷ socket, gọi callback `onCleanup`, idempotent.
- `abortTcpStream()`: Gửi `TCP_ABORT` đến client khi `notifyClient=true`, nếu không thì cleanup im lặng.
- `getTcpStreams()`: Chỉ trả về TCP streams (không trả HTTP streams).
- `handleClientFrame` xử lý TCP: `TCP_DATA` ghi vào socket, `TCP_CLOSE` dọn dẹp, `PAUSE`/`RESUME` điều khiển `peerPausedForWrite`.

### 6. `test/tcp-client-handler.test.js` (Unit Tests)
Kiểm thử đơn vị cho `src/TcpClientHandler.js`:
- Routing frame: `TCP_OPEN`, `TCP_DATA`, `TCP_CLOSE`, `TCP_ABORT`, `PAUSE`, `RESUME` đều trả về `true`.
- Frame không xác định trả về `false` (chuyển sang HTTP handler).
- Xác thực host: `TCP_OPEN` với host không được phép sẽ gửi `TCP_ABORT`.
- `cleanupTcpStreams()`: Dọn dẹp tất cả TCP streams, giữ nguyên HTTP streams.

### 7. `test/tcp-router.test.js` (Unit Tests)
Kiểm thử đơn vị cho `src/TcpRouter.js`:
- Khởi động với `TCP_TUNNEL_PORTS` trống sẽ bỏ qua việc lắng nghe (không lỗi).
- `_handleConnection` từ chối khi không có WS client hoạt động.
- Theo dõi số lượng kết nối theo từng port.

### 8. `test/tcp-e2e.test.js` (End-to-End Test)
Kiểm thử tích hợp đầy đủ: TCP server thực -> WS tunnel -> TcpClientHandler -> local TCP server:
- Xác minh `TCP_OPEN` tạo kết nối `net.connect()` đến đích.
- Xác minh `TCP_DATA` truyền từ server qua WS đến local TCP socket.
- Xác minh echo response trả về dạng frame `TCP_DATA` đến server.
- Xác minh `TCP_CLOSE` dọn dẹp kết thúc.

### 9. `test/tcp-cleanup.test.js` (Unit Tests)
Kiểm thử đơn vị cho việc dọn dẹp TCP khi WebSocket ngắt kết nối:
- Dọn dẹp tất cả TCP streams khi WebSocket ngắt kết nối.
- Xử lý chu kỳ mở/đóng nhanh mà không rò rỉ tài nguyên.

### 10. `test/tcp-real-integration.test.js` (Integration Tests)
Kiểm thử tích hợp với hạ tầng thực (cần Redis/Postgres đang chạy):
- Redis PING/PONG qua TCP tunnel.
- Các thao tác Redis SET/GET/DEL qua TCP tunnel.
- Kết nối Postgres TCP qua tunnel.
- 5 Redis PING song song đồng thời.

### 11. `test/tcp-stress.test.js` (Stress Tests)
Kiểm thử tải và hiệu năng:
- 50 Redis PING đồng thời qua tunnel.
- Kiểm thử stress chu kỳ mở/đóng nhanh.

### 12. `test/ip-allowlist.test.js` (Unit Tests)
Kiểm thử đơn vị cho `src/ipAllowlist.js`:
- Allowlist trống cho phép tất cả IP.
- So khớp IP chính xác, CIDR `/32`, `/24`, `/16`, `/0`.
- Loại bỏ tiền tố IPv4-mapped IPv6.
- Nhiều mục allowlist, xử lý CIDR không hợp lệ.

### 13. `test/tcp-flow-control.test.js` (Unit Tests)
Kiểm thử đơn vị cho điều phối flow control TCP trong `src/TcpFlowControl.js`:
- `syncSocketReadState()` phối hợp `peerPausedRead` và `localPausedForWs` quyết định pause/resume socket thực tế.
- Pause ở WS trong khi peer đã pause giữ socket ở trạng thái pause.
- Resume ở WS trong khi peer vẫn pause giữ socket ở trạng thái pause.

---

### Bắt buộc Service trong CI
Các test Redis/Postgres thực (`tcp-real-integration.test.js`, `tcp-stress.test.js`) tự động bỏ qua (skip) khi không có service. Đặt `REQUIRE_TCP_SERVICES=1` để bắt buộc chúng phải chạy (thất bại thay vì bỏ qua) — hữu ích trong CI:
```bash
REQUIRE_TCP_SERVICES=1 node --test test/tcp-real-integration.test.js test/tcp-stress.test.js
```

## 💡 Lưu Ý Kỹ Thuật Khi Viết & Chạy Test

1. **Cô lập Môi trường Test (`NODE_ENV=test`)**:
   Khi chạy test, `src/config.js` sẽ bỏ qua việc nạp file `.env` cục bộ để tránh ghi đè Port cố định `7860`, giúp Server trong `config-endpoint.test.js` có thể lắng nghe trên Port ngẫu nhiên do test runner cấp phát.
2. **Không gọi `process.exit()` ở Top-Level**:
   Tất cả logic kiểm tra biến môi trường được gói gọn trong hàm `validateConfig()` (chỉ được gọi khi `TunnelServer.start()` được thực thi), giúp việc `import` các module trong unit test không bị ngắt tiến trình đột ngột.
3. **Scoping `before()` / `after()` Hooks**:
   Trong Node.js Test Runner, các hook `before()` và `after()` khởi tạo Server phải được bọc bên trong một block `describe(...)` chung để đảm bảo tiến trình khởi tạo hoàn tất trước khi các bài test con chạy.
4. **Biến Môi Trường `VERBOSE`**:
   Đặt `VERBOSE=true` trong `.env` để bật verbose logging khi khởi động. Biến này kiểm soát đầu ra `logVerbose()`. API endpoint `/admin/config` cũng có thể bật/tắt tại runtime.
