# Hướng dẫn Tunnel TCP (Redis, Postgres, MySQL...)

> 🌐 Language / Ngôn ngữ: [English](tcp-tunnel.md) | **Tiếng Việt**

Tài liệu này hướng dẫn cách kích hoạt **tunnel TCP** của Nodejs-WSS-Tunnel để phơi bày các dịch vụ TCP (Redis, Postgres, MySQL...) đang chạy ở phía tunnel client (Google Colab, Kaggle, PC cục bộ) ra ngoài Internet thông qua máy chủ trung gian — ví dụ để một ứng dụng bên ngoài như **Rails** dùng Redis client kết nối vào Redis.

---

## 1. Tổng quan & Kiến trúc

```
+------------------------+   TCP (không mã hóa)   +-----------------------------+
|  External TCP client   | ---------------------> |   Nodejs Tunnel Server      |
|  (Rails / redis-cli)   |   <server-host>:6379   |   (TcpRouter)               |
+------------------------+                        +--------------+--------------+
                                                                 |
                                                                 | WebSocket (binary frames)
                                                                 | Basic Auth
                                                                 v
                                                 +---------------+---------------+
                                                 |   Tunnel Client (Colab/Kaggle) |
                                                 |   (serve/client.js)            |
                                                 +---------------+---------------+
                                                                 |
                                                                 | TCP (local, 127.0.0.1)
                                                                 v
                                                 +---------------+---------------+
                                                 |   Local service chạy tại client |
                                                 |   Redis trên 127.0.0.1:6379     |
                                                 +---------------------------------+
```

Đây là tunnel **đảo ngược**:

1. Tunnel client kết nối **chủ động** tới máy chủ qua WebSocket (do đó chạy được trong môi trường hạn chế như Colab/Kaggle, nơi không nhận kết nối đến).
2. Máy chủ nodejs lắng nghe TCP trên các cổng cấu hình (`TCP_TUNNEL_PORTS`).
3. Khi app bên ngoài (Rails) nối TCP tới `server-host:6379`, máy chủ tạo một luồng (stream) riêng và gửi frame `TCP_OPEN` cho tunnel client qua WebSocket.
4. Tunnel client mở kết nối TCP tới dịch vụ local (`TCP_TUNNEL_HOST:port`) — chính là Redis — rồi xác nhận bằng frame `TCP_OPEN_ACK`.
5. Chỉ sau ACK đó máy chủ mới bắt đầu chuyển tiếp dữ liệu (`TCP_CONNECT_ACK` cho agent trong agent mode), tránh race khi open bị từ chối mà dữ liệu vẫn được gửi. Sau đó dữ liệu truyền hai chiều qua các frame `TCP_DATA`/`TCP_CLOSE`/`TCP_ABORT`.

### Đặc điểm quan trọng

- **Giới hạn tunnel client (mặc định 1)**: máy chủ chấp nhận tối đa `MAX_TUNNEL_CLIENTS` tunnel client (mặc định `1`, cấu hình qua env); client vượt giới hạn bị từ chối với close code `1013`.
- **Port không được remap**: server gửi `port: serverPort` trong frame `TCP_OPEN` (`src/TcpRouter.js`), client dial đúng cổng đó tới `TCP_TUNNEL_HOST`. Nghĩa là dịch vụ local **phải listen đúng cổng** mà app ngoài nối tới (ví dụ Redis phải ở `6379`, không đổi được sang cổng khác).
- **Backpressure hai chiều**: frame `PAUSE`/`RESUME` kết hợp `bufferedAmount` của WebSocket và high/low water mark ngăn rò rỉ bộ nhớ khi một đầu chậm hơn đầu kia.

### Các frame TCP trong giao thức (`src/protocol.js`)

| Type | Giá trị | Ý nghĩa |
|------|---------|---------|
| `TCP_OPEN` | `0x40` | Server yêu cầu client mở kết nối TCP local tới `{ host, port }` |
| `TCP_DATA` | `0x41` | Dữ liệu hai chiều (payload thô) |
| `TCP_CLOSE` | `0x42` | Một bên đóng kết nối |
| `TCP_ABORT` | `0x43` | Hủy luồng kèm thông điệp lỗi |
| `TCP_OPEN_ACK` | `0x44` | Client xác nhận đã mở kết nối TCP local (server mới ACK cho agent) |
| `TCP_CONNECT` | `0x50` | Agent yêu cầu server cấp phát luồng cho cổng local |
| `TCP_CONNECT_ACK` | `0x51` | Server xác nhận cấp phát luồng cho agent |

---

## 2. Điều kiện tiên quyết

- Máy chủ nodejs có thể chạy `yarn dev` / `yarn prod` (Node.js >= 18).
- Máy chạy Redis (tunnel client) có **Node.js >= 18**, `curl`, và có **Redis đang chạy**.
- App bên ngoài (Rails) có đường truyền TCP tới máy chủ nodejs.

---

## 3. Cấu hình phía Server (nodejs)

Mọi biến môi trường TCP được đọc trong `src/config.js` và dùng trong `src/TcpRouter.js`.

### 3.1 Bảng biến môi trường

| Biến | Mặc định | Mô tả |
|------|----------|-------|
| `TCP_TUNNEL_PORTS` | *(trống)* | Danh sách cổng TCP cần phơi bày, phân tách bằng dấu phẩy. **Trống = tunnel TCP bị tắt.** VD: `6379,5432,3306` |
| `TCP_TUNNEL_HOST` | `127.0.0.1` | Host mà dịch vụ tunnel hóa nằm trên máy client (nơi client sẽ dial tới) |
| `TCP_TUNNEL_BIND_HOST` | `127.0.0.1` | Interface máy chủ sẽ bind. Để `0.0.0.0` nếu muốn app ngoài kết nối qua mạng |
| `TCP_TUNNEL_ALLOWED_IPS` | *(trống = cho phép tất cả)* | Danh sách IP/CIDR được phép nối vào cổng TCP tunnel (IPv4). VD: `127.0.0.1`, `10.0.0.0/8` |
| `TCP_CLIENT_ALLOWED_HOSTS` | `TCP_TUNNEL_HOST` | Các host/IP mà tunnel client được phép kết nối tới (lọc ở phía client) |
| `TCP_CONNECT_TIMEOUT_MS` | `10000` | Timeout để client mở kết nối TCP local (ms) |
| `TCP_MAX_CONNECTIONS_PER_PORT` | `20` | Số kết nối TCP đồng thời tối đa mỗi cổng (`0` = không giới hạn) |
| `TCP_SHUTDOWN_DRAIN_TIMEOUT_MS` | `5000` | Timeout drain các TCP stream đang hoạt động khi shutdown (ms) |

Ngoài ra vẫn bắt buộc có `TUNNEL_USERNAME` và `TUNNEL_PASSWORD` — nếu thiếu, server thoát ngay với `[FATAL]`.

### 3.2 Ví dụ `.env` cho Redis + Rails

```env
# ===== Server cơ bản =====
PORT=7860
TUNNEL_PATH=/tunnel
SERVER_HOST=https://your-server.example.com

# Bắt buộc — client WebSocket xác thực bằng các giá trị này
TUNNEL_USERNAME=admin
TUNNEL_PASSWORD=your_strong_secret

# ===== TCP Tunnel cho Redis =====
# Cổng Redis sẽ được phơi bày
TCP_TUNNEL_PORTS=6379

# Host Redis trên máy tunnel client (127.0.0.1 là chuẩn)
TCP_TUNNEL_HOST=127.0.0.1

# Bind 0.0.0.0 để Rails từ máy khác nối tới server-host:6379
TCP_TUNNEL_BIND_HOST=0.0.0.0

# Chỉ cho phép máy Rails (hoặc dải mạng) nối vào cổng 6379
TCP_TUNNEL_ALLOWED_IPS=203.0.113.10
# Hoặc dùng CIDR: TCP_TUNNEL_ALLOWED_IPS=203.0.113.0/24

# Client chỉ được phép dial tới Redis local
TCP_CLIENT_ALLOWED_HOSTS=127.0.0.1

TCP_CONNECT_TIMEOUT_MS=10000
TCP_MAX_CONNECTIONS_PER_PORT=20
TCP_SHUTDOWN_DRAIN_TIMEOUT_MS=5000
```

> ⚠️ **Cảnh báo bảo mật**: nếu `TCP_TUNNEL_BIND_HOST=0.0.0.0` mà `TCP_TUNNEL_ALLOWED_IPS` để trống, server in cảnh báo `[config] SECURITY WARNING` vì Redis sẽ bị phơi ra toàn mạng. Luôn hẹp `TCP_TUNNEL_ALLOWED_IPS` lại.
>
> ⚠️ **Giới hạn IP**: bộ lọc chỉ hỗ trợ IPv4 (`src/ipAllowlist.js`). Địa chỉ IPv4-mapped (`::ffff:127.0.0.1`) được chuẩn hóa tự động, nhưng IPv6 thuần (`::1`) sẽ **không** khớp allowlist.

Sau khi sửa, khởi động lại server:

```bash
yarn dev
```

Log kỳ vọng (mỗi dòng có tiền tố timestamp ISO):

```text
[standard] [ws] startup address=0.0.0.0 port=7860 tunnelPath=/tunnel agentPath=/tcp allowedPorts=[6379] healthCheck=/__health installUuid=<uuid> installUrl=<server-host>/<uuid>-install
[standard] [tcp] listen port=6379 bindHost=0.0.0.0 target=127.0.0.1
```

`agentPath`/`allowedPorts` chỉ xuất hiện khi TCP agent endpoint được bật (`TCP_AGENT_ALLOWED_PORTS` khác rỗng). Đặt cố định `installUuid` trong `.env` dưới dạng `INSTALL_UUID=...` để URL artifact ổn định sau mỗi lần restart.

---

## 4. Cấu hình phía Tunnel Client (máy đang chạy Redis)

Có hai cách chạy client: dùng `setup.sh` (khuyên dùng, có cập nhật nguyên tử) hoặc chạy trực tiếp `node client.js`.

### 4.1 Biến môi trường của client

| Biến | Bắt buộc | Mô tả |
|------|----------|-------|
| `TUNNEL_SERVER_URL` | ✅ | Địa chỉ WebSocket tới máy chủ, VD `wss://your-server.example.com/tunnel` |
| `TUNNEL_USERNAME` / `TUNNEL_PASSWORD` | ✅ | Giống giá trị trên server |
| `TCP_TUNNEL_HOST` | | Host dịch vụ local mà client dial tới (mặc định `127.0.0.1`) |
| `TCP_CLIENT_ALLOWED_HOSTS` | | Hosts client được phép dial (mặc định `TCP_TUNNEL_HOST`) |
| `TCP_CONNECT_TIMEOUT_MS` | | Timeout dial kết nối local (mặc định `10000`) |

`TARGET_ORIGIN` (mặc định `http://127.0.0.1:8000`) chỉ dùng cho tunnel HTTP, không ảnh hưởng tunnel TCP.

### 4.2 Chạy trực tiếp `node client.js`

```bash
TUNNEL_SERVER_URL=wss://your-server.example.com/tunnel \
TUNNEL_USERNAME=admin \
TUNNEL_PASSWORD=your_strong_secret \
TCP_TUNNEL_HOST=127.0.0.1 \
TCP_CLIENT_ALLOWED_HOSTS=127.0.0.1 \
node serve/client.js
```

> `serve/client.js` tự nạp `dotenv` khi `NODE_ENV=development`, nên bạn có thể đặt các giá trị trên trong file `.env` ở thư mục chạy lệnh.

### 4.3 Cài qua `setup.sh`

```bash
TUNNEL_SERVER_URL=wss://your-server.example.com/tunnel \
TUNNEL_USERNAME=admin \
TUNNEL_PASSWORD=your_strong_secret \
curl -fsSL https://your-server.example.com/<install-uuid>-install | bash
```

`setup.sh` (xem `serve/setup.sh`):

- Tải bundle `client.js` từ `https://<server>/<INSTALL_UUID>-client.js`, kiểm tra bằng `node --check`, rồi kích hoạt nguyên tử (symlink `~/.tunnel-client/current`).
- Tạo file `.env` trong release dir với `TUNNEL_SERVER_URL`, `TUNNEL_USERNAME`, `TUNNEL_PASSWORD`, `TARGET_ORIGIN`.
- Chạy client nền và chờ file `client.ready` (chứa PID) làm tín hiệu sẵn sàng. Nếu thất bại sẽ rollback về bản trước.

Quản lý client:

```bash
tail -f ~/.tunnel-client/client.log     # theo dõi log
kill $(cat ~/.tunnel-client/client.pid) # dừng client (hãy kiểm tra PID thuộc về client.js trước)
```

> Các biến TCP (`TCP_TUNNEL_HOST`…) không được `setup.sh` ghi vào `.env`; nếu bạn cần đổi khỏi mặc định `127.0.0.1`, hãy chạy client bằng cách 4.2 hoặc thêm biến vào `.env` trong release dir rồi khởi động lại.

---

## 5. TCP Agent (PaaS / hosting)

Các chế độ trên giả định tunnel client chạy cùng máy với dịch vụ (Redis). Khi server được host trên nền tảng PaaS với **một cổng public duy nhất** và dịch vụ nằm trên một máy **khác**, server không thể mở `TCP_TUNNEL_PORTS` trực tiếp. Lúc này hãy dùng **TCP agent**: một tiến trình độc lập cài trên máy app, lắng nghe trên một cổng local và chuyển tiếp các kết nối qua cùng giao thức WebSocket, còn tunnel client dial tới dịch vụ local.

```
Rails ── localhost:6379 ──> tcp-agent.js ── WS /tcp ──> Server :7860 ── WS /tunnel ──> client.js ── 127.0.0.1:6379 ──> Redis
```

> **Chế độ agent:** server không mở TCP listener cho agent. Ứng dụng bên ngoài
> kết nối tới cổng local của agent trên máy app. Với ví dụ Rails, Redis URL
> trở thành `redis://127.0.0.1:6379` — không phải
> `redis://your-server.example.com:6379`.
>
> **Client dial host nào?** `TCP_TUNNEL_HOST` của server (mặc định `127.0.0.1`)
> chính là giá trị gửi trong `TCP_OPEN`, nên client dial
> `TCP_TUNNEL_HOST:<cổng-agent>` trên máy chạy dịch vụ. Client phải cho phép
> host đó trong `TCP_CLIENT_ALLOWED_HOSTS` (mặc định là `TCP_TUNNEL_HOST` của
> chính nó, nên `127.0.0.1` hoạt động ngay). Nếu đổi `TCP_TUNNEL_HOST` của
> server, phải cập nhật `TCP_CLIENT_ALLOWED_HOSTS` của client cho khớp — nếu
> không client log `[verbose] [tcp] open_reject ... reason=host_not_allowed`.

### 5.1 Khi nào dùng

- Server nằm trên PaaS/hosting (Render, Railway, Fly.io...) chỉ expose một cổng public, nên server không bind `TCP_TUNNEL_PORTS` được.
- Máy app chạy được một tiến trình Node.js nhỏ (Node.js >= 18) và có `curl` cùng `npm` (hoặc `yarn`/`pnpm`).
- Dịch vụ local bind `127.0.0.1` trên máy app.

### 5.2 Cài agent trên máy app

Tải bundle đã build sẵn và cài dependency duy nhất:

```bash
curl -fL https://your-server.example.com/<INSTALL_UUID>-tcp-agent.js -o tcp-agent.js
npm i ws
```

Hoặc cài qua manifest (cho bạn `package.json` kèm dependency đúng):

```bash
curl -fsSL https://your-server.example.com/<INSTALL_UUID>-tcp-agent-package.json -o package.json
npm i
```

> `<INSTALL_UUID>` là giá trị `INSTALL_UUID` của server (đặt trong file `.env`
> của server để ổn định giữa các lần khởi động). Các script cài đặt tự động
> đang tải `/tcp-agent.js` phải chuyển sang URL có prefix; script cài agent
> đứng lẻ có thể trỏ `AGENT_BUNDLE_URL` vào `https://your-server.example.com/<INSTALL_UUID>-tcp-agent.js`.

### 5.3 Biến môi trường của agent

| Biến | Bắt buộc | Mô tả |
|------|----------|-------|
| `TUNNEL_SERVER_URL` | ✅ | Địa chỉ WebSocket tới server **kèm path của agent**, VD `wss://your-server.example.com/tcp` |
| `TUNNEL_USERNAME` / `TUNNEL_PASSWORD` | ✅ | Giống giá trị trên server (Basic Auth) |
| `AGENT_BIND_HOST` | | Interface agent lắng nghe các kết nối TCP local (mặc định `127.0.0.1`) |
| `AGENT_PORTS` | ✅ | Danh sách cổng local agent expose, phân tách bằng dấu phẩy, VD `6379` |
| `AGENT_USERNAME` / `AGENT_PASSWORD` | | Credentials WS của agent; fallback sang `TUNNEL_USERNAME` / `TUNNEL_PASSWORD` khi không đặt |

> Agent sẽ thoát kèm lỗi nếu thiếu `TUNNEL_SERVER_URL`, credentials
> (`AGENT_USERNAME`/`AGENT_PASSWORD` hoặc `TUNNEL_USERNAME`/`TUNNEL_PASSWORD`),
> hoặc `AGENT_PORTS`.

```bash
TUNNEL_SERVER_URL=wss://your-server.example.com/tcp \
TUNNEL_USERNAME=admin \
TUNNEL_PASSWORD=your_strong_secret \
AGENT_BIND_HOST=127.0.0.1 \
AGENT_PORTS=6379 \
node tcp-agent.js
```

### 5.4 Cấu hình phía server

Bật endpoint agent và khai báo các cổng agent được phép mở:

| Biến | Mặc định | Mô tả |
|------|----------|-------|
| `TCP_AGENT_PATH` | `/tcp` | WS path mà TCP agent kết nối tới |
| `TCP_AGENT_ALLOWED_PORTS` | *(trống)* | Danh sách cổng agent được phép mở, phân tách bằng dấu phẩy (**trống = tắt hẳn endpoint agent**) |
| `TCP_AGENT_USERNAME` | `TUNNEL_USERNAME` | Credentials WS của agent; fallback sang tunnel credentials khi không đặt |
| `TCP_AGENT_PASSWORD` | `TUNNEL_PASSWORD` | Credentials WS của agent; fallback sang tunnel credentials khi không đặt |
| `TCP_AGENT_ALLOWED_ORIGINS` | trống | Danh sách Origin được phép, phân tách bằng dấu phẩy; Origin header có mặt nhưng không nằm trong danh sách sẽ bị từ chối (403), không gửi Origin header thì được phép |
| `TCP_AGENT_REQUIRE_TLS` | `false` | Yêu cầu `req.socket.encrypted` hoặc `X-Forwarded-Proto: https` cho upgrade `/tcp` (nếu không sẽ 426) |
| `TCP_AGENT_MAX_STREAMS_PER_AGENT` | `100` | Số stream đồng thời tối đa mỗi agent (`0` = không giới hạn) |

Ví dụ tối thiểu:

```env
TCP_AGENT_ALLOWED_PORTS=6379
TCP_AGENT_PATH=/tcp
```

### 5.5 Lưu ý bảo mật

- Giữ `AGENT_BIND_HOST=127.0.0.1` — listener của agent không được public.
- WebSocket của agent dùng Basic Auth: mặc định là tunnel credentials (`TUNNEL_USERNAME`/`TUNNEL_PASSWORD`), có thể ghi đè riêng từng phía bằng `TCP_AGENT_USERNAME`/`TCP_AGENT_PASSWORD` (server) và `AGENT_USERNAME`/`AGENT_PASSWORD` (agent).
- Dùng `wss://` (TLS) khi đi qua Internet — tunnel TCP là plaintext.
- `TCP_AGENT_ALLOWED_PORTS` để trống sẽ tắt hẳn endpoint agent.
- `TCP_AGENT_REQUIRE_TLS` tin tưởng header `X-Forwarded-Proto`, vì vậy chỉ nên bật khi đứng sau reverse proxy kết thúc TLS có vệ sinh/ghi đè header này.

### 5.6 Kiểm tra nhanh

```bash
redis-cli -h 127.0.0.1 -p 6379 ping
# PONG
```

Chế độ trực tiếp (`TCP_TUNNEL_PORTS` trên tunnel client) vẫn là lựa chọn chuẩn cho VPS; cả hai chế độ có thể cùng tồn tại trên một server.

---

## 6. Cấu hình Redis trên máy tunnel client

Redis chạy ở đâu cũng được miễn là tunnel client dial được tới nó. Cấu hình mặc định của Redis thường đã đủ:

```conf
# redis.conf (mặc định thường OK)
bind 127.0.0.1
protected-mode yes

# Nên bật nếu cần bảo mật thêm một lớp
requirepass your_redis_password
```

> Vì client dial tới `127.0.0.1:6379`, chỉ cần Redis bind `127.0.0.1`. Đừng bind `0.0.0.0` trên máy client trừ khi bạn có lý do — Redis local không cần lộ ra mạng.

Kiểm tra nhanh trên máy client:

```bash
redis-cli -h 127.0.0.1 -p 6379 ping
# PONG
```

---

## 7. Cấu hình ứng dụng ngoài (ví dụ Rails)

Điểm mấu chốt: app ngoài kết nối tới **máy chủ nodejs** (không phải máy Redis), đúng cổng trong `TCP_TUNNEL_PORTS`.

### 7.1 Rails cache / Redis client

`config/cache_store.rb`:

```ruby
config.cache_store = :redis_cache_store, {
  url: "redis://your-server.example.com:6379",
  # nếu Redis có requirepass:
  # url: "redis://:your_redis_password@your-server.example.com:6379",
  connect_timeout: 5,
  read_timeout: 5,
  write_timeout: 5
}
```

`config/redis.yml` (dùng bởi Sidekiq, Redis Objects...):

```yaml
production:
  url: redis://your-server.example.com:6379
  # nếu có requirepass:
  # url: redis://:your_redis_password@your-server.example.com:6379
```

Sidekiq trong `config/sidekiq.yml`:

```yaml
:concurrency: 5
:redis:
  url: redis://your-server.example.com:6379
```

### 7.2 Các framework khác

```bash
# redis-cli trực tiếp
redis-cli -h your-server.example.com -p 6379 ping

# Python
pip install redis
python -c "import redis; print(redis.Redis(host='your-server.example.com', port=6379).ping())"

# Node.js
npm install redis
node -e "const r=require('redis').createClient({url:'redis://your-server.example.com:6379'}); r.connect().then(()=>r.ping()).then(console.log)"
```

---

## 8. Kiểm thử & Verification

**Bước 1 — server có tunnel TCP chạy chưa?**

```text
[standard] [ws] startup address=0.0.0.0 port=7860 tunnelPath=/tunnel agentPath=/tcp allowedPorts=[6379] healthCheck=/__health installUuid=... installUrl=...
[standard] [tcp] listen port=6379 bindHost=0.0.0.0 target=127.0.0.1
```

Nếu thấy `[standard] [tcp] skip reason=TCP_TUNNEL_PORTS not configured` nghĩa là `TCP_TUNNEL_PORTS` để trống.

**Bước 2 — tunnel client đã kết nối?**

```text
[standard] [client] connected
```

Kiểm tra thêm health của server:

```bash
curl -s https://your-server.example.com/__health
# 200 ok
```

**Bước 3 — từ máy app ngoài, thử kết nối TCP:**

```bash
redis-cli -h your-server.example.com -p 6379 ping
# PONG  ->  tunnel hoạt động hoàn chỉnh
```

**Bước 4 — log verbose** (server): bật `VERBOSE=true` trong `.env` để xem chi tiết từng luồng:

```text
[verbose] [stream] tcp_allocate streamId=... serverPort=6379 clientCount=...
[verbose] [tcp] tcp_open_sent streamId=... port=6379 host=127.0.0.1
[verbose] [stream] tcp_open_ack streamId=...
```

Phía client, log verbose ghi nhận dial local:

```text
[verbose] [tcp] open streamId=... host=127.0.0.1 port=6379
[verbose] [tcp] local_connected streamId=... host=127.0.0.1 port=6379
```

---

## 9. Troubleshooting

| Triệu chứng | Nguyên nhân / Xử lý |
|-------------|---------------------|
| `[FATAL] TUNNEL_USERNAME and TUNNEL_PASSWORD must be set.` | Thiếu credentials trên server. Set `TUNNEL_USERNAME`/`TUNNEL_PASSWORD` trong `.env`. |
| `[standard] [tcp] skip reason=TCP_TUNNEL_PORTS not configured` | `TCP_TUNNEL_PORTS` để trống. Điền cổng muốn tunnel, VD `6379`. |
| Server in `[config] SECURITY WARNING: TCP_TUNNEL_BIND_HOST=0.0.0.0 with no TCP_TUNNEL_ALLOWED_IPS set.` | Đang bind `0.0.0.0` mà allowlist trống — Redis lộ ra toàn mạng. Hẹp `TCP_TUNNEL_ALLOWED_IPS` lại. |
| `[standard] [tcp] reject reason=ip_not_allowed` | IP của app ngoài không nằm trong `TCP_TUNNEL_ALLOWED_IPS`. Thêm IP/CIDR tương ứng. |
| `[verbose] [tcp] reject reason=no_client` | Chưa có tunnel client nào kết nối WebSocket. Chạy `client.js`/`setup.sh` trên máy Redis. |
| `[standard] [tcp] reject reason=per_port_limit` | Vượt `TCP_MAX_CONNECTIONS_PER_PORT` (mặc định 20). Tăng giá trị hoặc đặt `0` (không giới hạn). |
| `[standard] [client] disconnected code=1013 reason="Too many tunnel clients"` | Một client vượt giới hạn `MAX_TUNNEL_CLIENTS` bị từ chối. Tăng `MAX_TUNNEL_CLIENTS` để cho phép nhiều tunnel client đồng thời hơn. |
| `[standard] [client] auth_failed` | Sai `TUNNEL_USERNAME`/`TUNNEL_PASSWORD` phía client. |
| Client báo `[verbose] [tcp] connect_timeout` / `local_error ... ECONNREFUSED` | Client không dial được `TCP_TUNNEL_HOST:port`. Kiểm tra Redis đang chạy, đúng cổng `6379`, và `TCP_CLIENT_ALLOWED_HOSTS` chứa host đó. |
| Client báo `[verbose] [tcp] open_reject ... reason=host_not_allowed` | `TCP_CLIENT_ALLOWED_HOSTS` không chứa host client đang dial. |
| Rails báo timeout/`Connection reset` khi tải lớn | Kiểm tra `TCP_MAX_CONNECTIONS_PER_PORT`, `MAX_CONCURRENT_STREAMS`, và tăng `WS_HIGH_WATER_BYTES` nếu cần. |
| `redis-cli -h <server> -p 6379 ping` treo | Server không bind đúng interface (`TCP_TUNNEL_BIND_HOST`), hoặc tường lửa chặn cổng 6379 tới máy chủ. |

---

## 10. Security Best Practices

1. **Dùng `wss://`** cho WebSocket (TLS), không `ws://`, khi đi qua Internet — tunnel TCP là plaintext.
2. **Luôn hẹp `TCP_TUNNEL_ALLOWED_IPS`** về IP/CIDR của app ngoài khi bind `0.0.0.0`.
3. **Đặt `requirepass`** cho Redis để có lớp bảo mật thứ hai.
4. **Credential mạnh** cho `TUNNEL_USERNAME`/`TUNNEL_PASSWORD`; chúng bảo vệ toàn bộ tunnel (HTTP + TCP).
5. **Không bind `0.0.0.0` cho Redis trên máy client** — client dial `127.0.0.1` là đủ.
6. **Không expose admin**: endpoint `/__health` và `/healthz` công khai, các endpoint khác (install/config) cần URL/khóa tương ứng.
7. **Theo dõi log** cả server lẫn client (`~/.tunnel-client/client.log`) để phát hiện kết nối lạ từ `remoteAddr`.
8. **Chạy server sau reverse proxy** (nginx/caddy) với TLS nếu chưa có sẵn TLS.
