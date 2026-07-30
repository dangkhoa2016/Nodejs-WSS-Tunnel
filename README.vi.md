# Nodejs WSS Tunnel (Đường hầm đảo ngược HTTP qua WebSocket)

[![CI](https://github.com/dangkhoa2016/Nodejs-WSS-Tunnel/actions/workflows/ci.yml/badge.svg)](https://github.com/dangkhoa2016/Nodejs-WSS-Tunnel/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

> 🌐 Language / Ngôn ngữ: [English](README.md) | **Tiếng Việt**

Đường hầm đảo ngược HTTP qua WebSocket với hỗ trợ tunnel TCP (chế độ trực tiếp + TCP agent), xây dựng trên giao thức ghép kênh (multiplexing) nhị phân. Phơi bày các ứng dụng web UI cục bộ (Stable Diffusion WebUI, Ollama, ComfyUI, v.v.) đang chạy trong môi trường hạn chế kết nối (Google Colab, Kaggle, PC cục bộ) ra Internet thông qua một máy chủ trung gian.

---

## Kiến trúc hệ thống

```
                                       +------------------------------------------+
                                       |   Tunnel Client (Colab/Kaggle)           |
                                       |         (dist/client.js)                 |
                                       +--------------------+---------------------+
                                                            | WebSocket (Binary Frames)
                                                            | Yêu cầu Basic Auth
                                                            v
+------------------+   HTTP Request   +---------------------+---------------------+   HTTP Request   +-------------------+
|  End User Browser| ---------------> |      Intermediary Server (Node.js)       | ---------------> | Local Target App  |
|  (Public Web)    | <--------------- |  TunnelServer / HttpRouter / TcpRouter   | <--------------- | (e.g. 127.0.0.1:8000)|
+------------------+   HTTP Response  +---------------------+-----+---------------+   HTTP Response  +-------------------+
                                                            ^     ^
                                             TCP direct mode|     |TCP agent mode
                            +--------------------------------+     +--------------------------------+
                            | External TCP Client            |     | TCP Agent (app host)           |
                            | (Rails / redis-cli)            |     |  (dist/tcp-agent.js)           |
                            | -> server:<TCP_TUNNEL_PORT>    |     |  local listener :AGENT_PORTS   |
                            +--------------------------------+     +--------------------------------+
                                                                                | TCP (loopback)
                                                                                v
                                                                 +--------------------------------+
                                                                 | Local service on the app host  |
                                                                 | (Redis/Postgres/MySQL/etc.)    |
                                                                 +--------------------------------+
```

### Tính năng chính
1. **Giao thức nhị phân siêu nhẹ**: Header 6 byte `[Version(1B) | Type(1B) | StreamID(4B)]` tối ưu băng thông và mức sử dụng CPU.
2. **Backpressure & Điều khiển luồng**: Hỗ trợ các frame điều khiển `PAUSE`/`RESUME` kết hợp với `bufferedAmount` để ngăn rò rỉ bộ nhớ.
3. **Hỗ trợ Tunnel TCP**: Tunnel TCP thô (Redis, Postgres, MySQL, v.v.) song song với HTTP, có backpressure hai chiều, trong hai chế độ:
   - **Trực tiếp (Direct)**: máy chủ lắng nghe trên `TCP_TUNNEL_PORTS` và chuyển tiếp mỗi kết nối đến một dịch vụ TCP trên máy tunnel client (hỗ trợ danh sách trắng IPv4/CIDR).
   - **TCP agent**: một `tcp-agent.js` độc lập trên máy chủ ứng dụng phơi bày các port cục bộ qua endpoint WebSocket `/tcp` của máy chủ, nên không cần mở port vào máy chủ (thân thiện với PaaS).
4. **Bảo mật**:
   - Xác thực WebSocket qua HTTP Basic Auth (bắt buộc, so sánh thời gian hằng số).
   - Endpoint cấu hình quản trị được bảo vệ bằng URL ký HMAC-SHA256 có giới hạn thời gian.
   - Kết nối TCP được lọc bởi danh sách trắng IPv4 (hỗ trợ CIDR).
5. **Cài đặt Client một dòng**: Tải bundle độc lập và cấu hình qua `setup.sh`.
6. **Nâng cấp giao dịch (Transactional)**: Trình cài đặt tải về thư mục staging, kiểm tra bundle (`node --check`), rồi hoán đổi file một cách nguyên tử. Client cũ được giữ nguyên nếu staging thất bại.
7. **Cài đặt không cần TTY**: Mọi lời nhắc đều nhận biến môi trường (`TUNNEL_SERVER_URL`, `TUNNEL_USERNAME`, `TUNNEL_PASSWORD`, `TARGET_ORIGIN`), cho phép triển khai tự động hoàn toàn không có giao diện.
8. **Bundle độc lập**: Tunnel client và TCP agent được dựng sẵn (esbuild) thành `dist/client.js` và `dist/tcp-agent.js` -- không cần cây mã nguồn máy chủ để chạy tunnel client hay agent.
9. **Tắt máy nhẹ nhàng (Graceful Shutdown)**: Khi nhận SIGTERM/SIGINT, máy chủ thoát các stream đang hoạt động, đóng bộ lắng nghe TCP, và thoát sạch mà không cần cờ `--test-force-exit`.
10. **Kiểm tra sức khỏe**: Các endpoint `/__health` và `/healthz` luôn trả về `200 ok`.

---

## Cấu trúc thư mục

```text
.
├── biome.json              # Cấu hình lint và format (Biome)
├── dist/
│   ├── client.js           # Bundle esbuild độc lập cho tunnel clients (46KB, không có deps máy chủ)
│   └── tcp-agent.js        # Bundle esbuild độc lập cho TCP agents (27KB, không có deps máy chủ)
├── docs/
│   ├── tcp-tunnel.md                             # Hướng dẫn chi tiết TCP tunnel & TCP agent (EN)
│   ├── tcp-tunnel.vi.md                          # Hướng dẫn chi tiết TCP tunnel & TCP agent (VI)
│   ├── guide-external-app-to-tcp-services.md     # Hướng dẫn kết nối ứng dụng ngoài với TCP services (Redis) (EN)
│   ├── guide-external-app-to-tcp-services.vi.md  # Hướng dẫn kết nối ứng dụng ngoài với TCP services (Redis) (VI)
│   ├── setup-tcp-agent.sh                        # Script: mở TCP service qua tunnel (vd. Redis) tới máy này
│   └── setup-tunnel-client.sh                    # Script: chia sẻ service cục bộ (vd. Redis) ra Internet
├── serve/
│   ├── build.js            # Script bundler esbuild (dựng client.js + tcp-agent.js)
│   ├── client.js           # Mã nguồn tunnel client (import các module dùng chung)
│   ├── tcp-agent.js        # Mã nguồn TCP agent (listener cục bộ, chuyển tiếp qua WS /tcp)
│   ├── setup.sh            # Script cài đặt & khởi chạy client một dòng
│   ├── client-package.json # package.json tối thiểu cho cài đặt chỉ-client
│   └── tcp-agent-package.json # package.json tối thiểu cho cài đặt chỉ-agent
├── src/
│   ├── index.js            # Điểm vào máy chủ
│   ├── config.js           # Nạp & xác thực biến môi trường
│   ├── protocol.js         # FrameCodec & các hằng số giao thức nhị phân (dùng chung)
│   ├── TunnelServer.js     # Khởi tạo HTTP Server & WebSocketServer (ws), tắt máy nhẹ nhàng
│   ├── StreamManager.js    # Vòng đời ghép kênh stream HTTP + TCP
│   ├── ClientManager.js    # WebSocket clients, heartbeat & vòng đời
│   ├── HttpRouter.js       # Định tuyến HTTP, file tĩnh, kiểm tra sức khỏe, nâng cấp WebSocket
│   ├── TcpRouter.js        # Bộ lắng nghe tunnel TCP (chế độ trực tiếp), danh sách trắng IP, backpressure
│   ├── TcpAgentServer.js   # Endpoint WebSocket TCP agent (/tcp), giới hạn port & stream
│   ├── VirtualSocket.js    # Socket ảo phía máy chủ nối agent với tunnel client
│   ├── TcpFlowControl.js   # Đồng bộ pause/resume cho backpressure socket TCP
│   ├── TcpClientHandler.js # Trình xử lý frame TCP phía client
│   ├── ipAllowlist.js      # Bộ so khớp IPv4/CIDR
│   ├── WsFrameWriter.js    # Stream ghi được cho dữ liệu nhị phân WebSocket
│   ├── utils.js            # HMAC, SafeEqual, Sanitize Headers
│   └── logger.js           # Hệ thống ghi log (text / JSON, verbose)
├── public/                 # Tài nguyên trang đích (landing page)
├── test/                   # Bộ kiểm thử (test runner node:test tích hợp)
│   ├── artifact-routes.test.js
│   ├── client-build.test.js
│   ├── config-endpoint.test.js
│   ├── config-validation.test.js
│   ├── installer.test.js
│   ├── installer-e2e.test.js
│   ├── ip-allowlist.test.js
│   ├── logger.test.js
│   ├── shutdown.test.js
│   ├── stream-manager.test.js
│   ├── stream-manager-tcp.test.js
│   ├── tcp-agent-e2e.test.js
│   ├── tcp-agent-process.test.js
│   ├── tcp-agent-server.test.js
│   ├── tcp-cleanup.test.js
│   ├── tcp-client-handler.test.js
│   ├── tcp-e2e.test.js
│   ├── tcp-flow-control.test.js
│   ├── tcp-real-integration.test.js
│   ├── tcp-router.test.js
│   ├── tcp-stress.test.js
│   ├── utils.test.js
│   ├── virtual-socket.test.js
│   ├── websocket-auth.test.js
│   ├── helpers/
│   │   └── tcp-test-setup.js
│   └── fixtures/
│       ├── client-captures-env.js
│       ├── client-exits.js
│       ├── client-never-ready.js
│       └── client-writes-ready.js
└── Dockerfile
```

### Tài liệu chi tiết

Để tham khảo chi tiết hơn, xem các tài liệu trong `docs/`:
- [Hướng dẫn TCP Tunnel & TCP Agent (Tiếng Anh)](docs/tcp-tunnel.md)
- [Hướng dẫn TCP Tunnel & TCP Agent (Tiếng Việt)](docs/tcp-tunnel.vi.md)
- [Kết nối ứng dụng bên ngoài với TCP services (Redis) (Tiếng Anh)](docs/guide-external-app-to-tcp-services.md)
- [Kết nối ứng dụng bên ngoài với TCP services (Redis) (Tiếng Việt)](docs/guide-external-app-to-tcp-services.vi.md)

---

## Hướng dẫn cài đặt máy chủ

### Yêu cầu
- **Node.js**: >= 18.0.0
- **Trình quản lý gói**: Yarn (khuyến nghị) hoặc npm

### Bắt đầu nhanh

```bash
# Clone và cài đặt
git clone <repo> && cd Nodejs-WSS-Tunnel
corepack enable && yarn install

# Cấu hình
cp .env.example .env
# Sửa .env theo cài đặt của bạn (bắt buộc TUNNEL_USERNAME và TUNNEL_PASSWORD)

# Khởi chạy
yarn prod
```

### Dựng Client Bundle

```bash
yarn build:client
```

Tạo ra `dist/client.js` (tunnel client) và `dist/tcp-agent.js` (TCP agent) -- các bundle esbuild độc lập được phân phối cho tunnel clients và TCP agents. Cả hai đều không cần cây mã nguồn máy chủ.

### Biến môi trường

```env
PORT=7860
TUNNEL_PATH=/tunnel
SERVER_HOST=https://your-server-host

# Bắt buộc -- WebSocket clients phải xác thực
TUNNEL_USERNAME=your_username
TUNNEL_PASSWORD=your_password

# Giới hạn stream HTTP
MAX_CONCURRENT_STREAMS=200
STREAM_IDLE_TIMEOUT_MS=120000
HTTP_REQUEST_TIMEOUT_MS=0

# Giới hạn WebSocket / frame
WS_HIGH_WATER_BYTES=1048576
WS_LOW_WATER=524288
MAX_FRAME_PAYLOAD_BYTES=262144
WS_MAX_PAYLOAD_BYTES=2097152

# Đệm (Buffering)
MAX_DEST_BUFFER_BYTES=8388608
DRAIN_TIMEOUT_MS=30000

# TCP tunnel (tùy chọn, chế độ trực tiếp)
TCP_TUNNEL_HOST=127.0.0.1
TCP_TUNNEL_PORTS=6379,5432,3306
TCP_TUNNEL_BIND_HOST=127.0.0.1
TCP_TUNNEL_ALLOWED_IPS=127.0.0.1
TCP_CLIENT_ALLOWED_HOSTS=127.0.0.1
TCP_CONNECT_TIMEOUT_MS=10000
TCP_MAX_CONNECTIONS_PER_PORT=20
TCP_SHUTDOWN_DRAIN_TIMEOUT_MS=5000

# TCP agent qua WebSocket (tùy chọn, chế độ agent)
TCP_AGENT_PATH=/tcp
TCP_AGENT_ALLOWED_PORTS=6379
TCP_AGENT_USERNAME=agent
TCP_AGENT_PASSWORD=agent_secret
TCP_AGENT_ALLOWED_ORIGINS=
TCP_AGENT_REQUIRE_TLS=false
TCP_AGENT_MAX_STREAMS_PER_AGENT=100

# Admin config API
ADMIN_SECRET=your_admin_secret_key
LOG_FORMAT=text
VERBOSE=false
```

`INSTALL_UUID` là tùy chọn -- một UUID ngẫu nhiên sẽ được tạo khi khởi động nếu không được đặt.

### Docker

```bash
# Dựng và chạy
docker build -t tunnel-server .
docker run -d --restart=unless-stopped -p 7860:7860 \
  -e TUNNEL_USERNAME=admin \
  -e TUNNEL_PASSWORD=secret \
  tunnel-server
```

---

## Hướng dẫn kết nối Client (`client.js`)

Client (ví dụ: trên Google Colab hoặc máy cục bộ) kết nối đến Server qua script `setup.sh`:

> Máy chủ chỉ chấp nhận **một** tunnel client tại một thời điểm (`MAX_TUNNEL_CLIENTS` được cố định là 1); các client bổ sung bị từ chối với mã đóng `1013`.

**Yêu cầu trên máy client:** `curl`, `node` (>= 18), `npm`, `mv` hỗ trợ GNU `-T`

> Trên macOS: cài coreutils (`brew install coreutils`) để có `gmv -T`, sau đó `alias mv=gmv`.

### 1. Cài đặt tự động bằng lệnh một dòng
```bash
curl -fsSL https://<your-server-host>/<uuid>-install | bash
```

### 2. Cài đặt với biến môi trường được đặt sẵn
```bash
TUNNEL_SERVER_URL=wss://your-server-host/tunnel \
TUNNEL_USERNAME=admin \
TUNNEL_PASSWORD=secret \
TARGET_ORIGIN=http://127.0.0.1:8000 \
curl -fsSL https://your-server-host/<uuid>-install | bash
```

Các artifact được tải về một thư mục phát hành (release) bất biến duy nhất và được xác thực trước khi client đang chạy bị dừng. Việc xác thực thất bại sẽ xóa bản phát hành mới và giữ nguyên client hiện tại. Nếu một bản phát hành đã xác thực không vượt qua kiểm tra sẵn sàng (readiness) sau khi kích hoạt, trình cài đặt sẽ kích hoạt lại và xác minh bản phát hành trước đó.

### 3. Quản lý tiến trình Client
- **Xem log Client**: `tail -f ~/.tunnel-client/client.log`
- **Xóa log Client**: `> ~/.tunnel-client/client.log`
- **Dừng Client**: `kill $(cat ~/.tunnel-client/client.pid)`
- **Trạng thái sẵn sàng của Client**: File `client.ready` trong `~/.tunnel-client/` chứa PID của client và xác nhận client đã vượt qua kiểm tra sẵn sàng khi khởi động.

---

## TCP Tunnel & TCP Agent

Máy chủ hỗ trợ tunnel TCP thô (Redis, Postgres, MySQL, v.v.) song song với HTTP, trong hai chế độ bổ trợ nhau dùng chung các frame nhị phân (`TCP_OPEN`/`TCP_DATA`/`TCP_CLOSE`/`TCP_ABORT` + `PAUSE`/`RESUME`) và backpressure hai chiều.

### Chế độ trực tiếp (máy chủ mở bộ lắng nghe TCP)

Máy chủ lắng nghe trên từng port trong `TCP_TUNNEL_PORTS`. Với mỗi kết nối đến, máy chủ yêu cầu tunnel client đang kết nối quay số **cùng port đó** trên `TCP_TUNNEL_HOST` (thường là `127.0.0.1`), rồi chuyển tiếp dữ liệu theo cả hai hướng.

```
External TCP Client -- TCP :6379 --> Server :6379 -- WS /tunnel --> client.js -- 127.0.0.1:6379 --> Redis
```

- Kiểm soát truy cập bằng `TCP_TUNNEL_BIND_HOST` và `TCP_TUNNEL_ALLOWED_IPS` (danh sách trắng IPv4/CIDR).
- **Không đổi port**: dịch vụ cục bộ phải lắng nghe đúng port mà ứng dụng bên ngoài kết nối tới.

### Chế độ TCP agent (không cần mở port vào máy chủ)

Khi máy chủ chạy trên nền tảng PaaS/hosting chỉ có một port công cộng, hãy chạy **TCP agent** độc lập (`dist/tcp-agent.js`) trên máy chủ ứng dụng. Nó lắng nghe trên `AGENT_PORTS` cục bộ và chuyển tiếp kết nối qua endpoint WebSocket `/tcp` của máy chủ; tunnel client trên máy dịch vụ quay số dịch vụ cục bộ.

```
Rails -- 127.0.0.1:6379 --> tcp-agent.js -- WS /tcp --> Server -- WS /tunnel --> client.js -- 127.0.0.1:6379 --> Redis
```

> **Chế độ agent**: ứng dụng bên ngoài kết nối tới port cục bộ của agent trên máy chủ ứng dụng (ví dụ `redis://127.0.0.1:6379`), **không phải** tới máy chủ.

Endpoint `/tcp` chỉ tồn tại khi `TCP_AGENT_ALLOWED_PORTS` không rỗng. Nó được bảo vệ bằng Basic Auth (mặc định dùng thông tin đăng nhập tunnel, có thể ghi đè bằng `TCP_AGENT_USERNAME`/`TCP_AGENT_PASSWORD`) và hỗ trợ tùy chọn danh sách trắng Origin (`TCP_AGENT_ALLOWED_ORIGINS`) cùng kiểm tra TLS (`TCP_AGENT_REQUIRE_TLS`). Bundle agent được phân phối tại `/${INSTALL_UUID}-tcp-agent.js` kèm manifest tối thiểu tại `/${INSTALL_UUID}-tcp-agent-package.json`.

Hai chế độ có thể cùng tồn tại trên một máy chủ. Xem [docs/tcp-tunnel.vi.md](docs/tcp-tunnel.vi.md) để có hướng dẫn cấu hình đầy đủ và ví dụ Rails/Redis.

---

## Cấu hình quản trị & thời gian chạy (`/<uuid>-config`)

Máy chủ cho phép cập nhật cấu hình log theo thời gian thực (`verbose`, `logFormat`) **không cần khởi động lại máy chủ** qua các URL ký HMAC.

- **Endpoint**: `GET` / `POST` `/<uuid>-config?expires=<TIMESTAMP>&sig=<HMAC_HEX>`
- **POST Body (JSON)**:
  ```json
  {
    "verbose": true,
    "logFormat": "json"
  }
  ```

---

## Kiểm tra sức khỏe

Máy chủ phơi bày hai endpoint kiểm tra sức khỏe luôn trả về `200 ok`:

- `GET /__health`
- `GET /healthz`

Các endpoint này không yêu cầu xác thực. Ảnh Docker bao gồm chỉ thị `HEALTHCHECK` ping `/__health`.

---

## Tắt máy nhẹ nhàng

Máy chủ xử lý `SIGTERM` và `SIGINT` bằng cách:

1. Dừng các bộ lắng nghe TCP và endpoint WebSocket TCP agent (không kết nối mới) và hủy các stream TCP đang hoạt động, cho phép tối đa 5 giây để thoát dữ liệu (drain).
2. Đóng tất cả WebSocket clients (tunnel + agent) và HTTP server (mỗi WebSocket client bị buộc kết thúc sau 5 giây).
3. Thoát với mã 0 (hoặc 1 nếu `uncaughtException`).

Các bước trên chạy song song trong thời gian chờ tổng thể 10 giây, sau đó tiến trình thoát với mã 1. Lỗi của từng thành phần trong khi tắt máy được cô lập -- một thành phần lỗi không chặn các thành phần còn lại.

---

## Kiểm thử

Bộ kiểm thử sử dụng **test runner tích hợp của Node.js** (`node:test`). Không cần cờ `--test-force-exit` -- bộ kiểm thử thoát sạch sau khi tất cả kiểm thử hoàn thành.

```bash
npm test
```

Xem hướng dẫn kiểm thử chi tiết trong [TESTING.md](TESTING.md).

Chạy `yarn test` để xem số kiểm thử hiện tại. Các kiểm thử dịch vụ thực cục bộ có thể bỏ qua khi không có Redis/Postgres; CI đặt `REQUIRE_TCP_SERVICES=1`. Phạm vi TCP gồm kiểm thử đơn vị cho agent server và virtual socket, kiểm thử cấp tiến trình cho agent, và một kiểm thử end-to-end cho agent.

---

## CI

Các kiểm thử tự động chạy trên Node.js 20, 22, và 24 với dịch vụ Redis và Postgres sẵn sàng cho kiểm thử tích hợp.

---

## Giấy phép

Được cấp phép theo [MIT License](LICENSE).
