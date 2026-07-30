# Hướng dẫn: Ứng dụng bên ngoài kết nối vào dịch vụ TCP (Redis) qua tunnel

> 🌐 Language / Ngôn ngữ: [English](guide-external-app-to-tcp-services.md) | **Tiếng Việt**

> Dùng hướng dẫn này khi một ứng dụng trên máy này cần truy cập một dịch vụ
> cục bộ (ví dụ Redis) chạy trên một máy khác nằm sau server tunnel
> `Nodejs-WSS-Tunnel`. Một thiết lập điển hình: Redis chạy trên máy nhà/server
> của bạn; ứng dụng đã deploy (Rails, Sidekiq, Python, Node...) trên một máy
> khác cần kết nối tới nó.

## 1. Tổng quan và kiến trúc

Tunnel gồm ba thành phần:

- **Tunnel client** (`docs/setup-tunnel-client.sh`) — chạy trên máy chứa dịch
  vụ (Redis). Nó kết nối tới server qua WebSocket `/tunnel`.
- **Server** (`Nodejs-WSS-Tunnel`) — relay luồng dữ liệu giữa client và các
  agent. Chỉ expose **1 cổng public duy nhất** (7860).
- **TCP agent** (`docs/setup-tcp-agent.sh`) — chạy trên máy ngoài / máy chạy
  ứng dụng. Nó lắng nghe trên một cổng local và bắc cầu tới server qua
  WebSocket `/tcp`.

```
Máy ngoài (app / redis-cli)
        |  TCP (local)   redis://127.0.0.1:6379
        v
   tcp-agent.js  -- WS /tcp -->  Server :7860  -- WS /tunnel -->  client.js
   (chạy trên máy ngoài)            (github.dev)              (máy chạy Redis)
                                                                      |
                                                                TCP (local)
                                                                      v
                                                          Redis 127.0.0.1:6379
```

Ứng dụng chỉ cần kết nối `redis://127.0.0.1:6379` trên máy ngoài. Không cần mở
cổng nào trên server.

## 2. Thuật ngữ

| Thuật ngữ | Là gì | Chạy ở đâu |
|---|---|---|
| Tunnel client | Điểm cuối WebSocket `/tunnel` để kết nối tới dịch vụ local | Máy chứa dịch vụ (Redis) |
| Server | Trung tâm relay (`Nodejs-WSS-Tunnel`) | Máy chủ công khai |
| TCP agent | Điểm cuối WebSocket `/tcp` để expose một cổng local | Máy ngoài / máy chạy ứng dụng |

## 3. Chuẩn bị

- Cả hai máy: Node.js >= 18 và `curl`.
- Máy ngoài cần thêm: `npm`.
- Thông tin xác thực server: Mặc định dùng `TUNNEL_USERNAME` / `TUNNEL_PASSWORD`. Nếu quản trị viên server cấu hình riêng `TCP_AGENT_USERNAME` / `TCP_AGENT_PASSWORD`, hãy dùng cặp tài khoản đó cho TCP agent.

### 3.1 Lấy giá trị thật ở đâu

| Giá trị | Nguồn |
|---|---|
| `<server-host>` | Người quản trị server tunnel của bạn |
| `<server-install-uuid>` | Dòng log `Install UUID: ...` của server; hãy đặt cố định trong `.env` của server (`INSTALL_UUID=...`) để URL artifact ổn định |
| `<server-tunnel-username>` / `<server-tunnel-password>` | `TUNNEL_USERNAME` / `TUNNEL_PASSWORD` của server |
| `<agent-username>` / `<agent-password>` | `TCP_AGENT_USERNAME` / `TCP_AGENT_PASSWORD` của server (tự động fallback sang `TUNNEL_USERNAME` / `TUNNEL_PASSWORD` khi không đặt) |
| `<redis-password>` | `requirepass` của Redis chạy trên máy tunnel client |

> Nếu `INSTALL_UUID` chưa được đặt trong `.env` của server, server sẽ sinh UUID
> mới mỗi lần khởi động lại, làm đổi mọi URL artifact.

## 4. Phần 1 — Máy chứa dịch vụ (Redis)

Trên máy chạy Redis:

1. Copy `docs/setup-tunnel-client.sh` sang máy đó.
2. Điền khối CONFIG: `SERVER_HOST`, `INSTALL_UUID`, `TUNNEL_USERNAME`,
   `TUNNEL_PASSWORD`. `TARGET_ORIGIN` là đích HTTP tunnel (không dùng cho
   đường TCP/Redis).
3. Chạy `bash setup-tunnel-client.sh`.

Kiểm tra:

```bash
tail -f ~/.tunnel-client/client.log
# tìm dòng: "Connected to tunnel server"
```

Client tự cài vào `~/.tunnel-client/`. Dừng bằng
`kill $(cat ~/.tunnel-client/client.pid)`.

## 5. Phần 2 — Máy ngoài / máy chạy ứng dụng

Trên máy ngoài:

1. Copy `docs/setup-tcp-agent.sh` sang máy đó.
2. Điền khối CONFIG: `SERVER_HOST`, `INSTALL_UUID`, `REDIS_PASSWORD`.
   Thông tin xác thực agent sẽ được hỏi nếu bạn chưa đặt `AGENT_USERNAME` /
   `AGENT_PASSWORD` (hoặc `TUNNEL_USERNAME` / `TUNNEL_PASSWORD`) trước.
3. Chạy `bash setup-tcp-agent.sh`.

Khi thành công script in ra `Agent connected to tunnel server.` và agent lắng
nghe tại `127.0.0.1:6379`. Kiểm tra:

```bash
redis-cli -h 127.0.0.1 -p 6379 -a <redis-password> ping
# PONG
```

Log: `$HOME/.redis-agent/agent.log`. Dừng: `kill $(cat $HOME/.redis-agent/agent.pid)`.

## 6. Cấu hình ứng dụng

URL đầy đủ (kèm password):

```
redis://:<redis-password>@127.0.0.1:6379
```

**Rails** — `config/cache_store.rb`:

```ruby
config.cache_store = :redis_cache_store, {
  url: "redis://:<redis-password>@127.0.0.1:6379",
  connect_timeout: 5,
  read_timeout: 5,
  write_timeout: 5
}
```

**Sidekiq** — `config/sidekiq.yml`:

```yaml
:concurrency: 5
:redis:
  url: redis://:<redis-password>@127.0.0.1:6379
```

**Python:**

```python
import redis
r = redis.Redis(host="127.0.0.1", port=6379, password="<redis-password>")
print(r.ping())  # True
```

**Node.js:**

```js
const redis = require('redis');
const client = redis.createClient({ url: 'redis://:<redis-password>@127.0.0.1:6379' });
await client.connect();
console.log(await client.ping()); // PONG
```

## 7. Kết nối trực tiếp (khi server mở cổng TCP)

Chỉ dùng được khi CẢ HAI điều kiện đúng:

1. Server bind TCP ra mạng: `TCP_TUNNEL_BIND_HOST=0.0.0.0`
   (hiện mặc định là `127.0.0.1`).
2. Nền tảng hosting forward cổng TCP đó ra công khai (github.dev hiện chưa
   forward cổng thứ hai).

Khi đã mở, ứng dụng có thể kết nối thẳng tới edge của server:

```bash
redis-cli -h <server-host> -p 443 -a <redis-password> --tls ping
# PONG
```

Nếu không, hãy dùng **Phần 2** (TCP agent).

## 8. Khắc phục sự cố

| Triệu chứng | Nguyên nhân / Xử lý |
|---|---|
| Log agent `Authentication failed` / log server `agent_ws_reject reason=invalid_credentials` | Sai thông tin xác thực. Mặc định agent dùng `TUNNEL_USERNAME` / `TUNNEL_PASSWORD`. Nếu server cài `TCP_AGENT_USERNAME` / `TCP_AGENT_PASSWORD` riêng, hãy đảm bảo điền đúng cặp credential của agent (mục 3). |
| Log server `tcp reject reason=no_client` | Chưa có tunnel client kết nối qua `/tunnel`. Chạy Phần 1 trên máy Redis; kiểm tra `tail -f ~/.tunnel-client/client.log` có dòng `Connected to tunnel server`. |
| `redis-cli ping` báo `NOAUTH` | Thiếu password: thêm `-a <redis-password>`. |
| `connect ECONNREFUSED` trên `127.0.0.1:6379` | Agent chưa chạy. Chạy lại Phần 2. |
| Redis báo `READONLY` / timeout khi tải cao | Kiểm tra `TCP_MAX_CONNECTIONS_PER_PORT` (server, mặc định 20) và `TCP_AGENT_MAX_STREAMS_PER_AGENT` (mặc định 100). |

## 9. Lưu ý bảo mật

- Luôn dùng `wss://` (TLS). Tunnel vận chuyển TCP plaintext giữa client và
  agent qua server.
- Giữ `AGENT_BIND_HOST=127.0.0.1` — không expose agent ra mạng.
- Giữ `requirepass` của Redis mạnh; không chia sẻ công khai.
- Chỉ một tunnel client được kết nối tới `/tunnel` tại một thời điểm (server
  nhận tối đa 1 client).
