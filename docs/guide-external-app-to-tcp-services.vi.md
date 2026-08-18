# Kết nối ứng dụng bên ngoài tới dịch vụ TCP

> Ngôn ngữ: [English](guide-external-app-to-tcp-services.md) | **Tiếng Việt**

Dùng hướng dẫn này để chia sẻ Redis, PostgreSQL hoặc dịch vụ TCP khác từ một
máy dịch vụ (Computer A) cho một hoặc nhiều máy ứng dụng (B, C, ...).

## Chọn chế độ trực tiếp hoặc agent

| Nhu cầu | Chế độ trực tiếp | Chế độ agent |
|---|---|---|
| Ứng dụng kết nối tới | Cổng TCP public của server | Cổng loopback của agent |
| Cần thêm cổng TCP public | Có | Không |
| Phù hợp | VPS/mạng tự quản lý | PaaS và nhiều máy từ xa |
| Truyền tải bên ngoài | TCP thô | TCP local, sau đó WSS |

Chế độ trực tiếp đơn giản hơn khi server có thể mở và firewall đúng cổng
dịch vụ. Chế độ agent an toàn hơn cho PaaS và cho phép từng host B/C nhận
các listener `127.0.0.1` riêng thông qua cổng WebSocket có sẵn của server.

## Kiến trúc

```text
Computer B ── 127.0.0.1:6379/5432 ── agent ─┐
Computer C ── 127.0.0.1:6379/5432 ── agent ─┼─ WSS /tcp ─ server
                                             └─ WSS /tunnel ─ Computer A
                                                                ├─ Redis 6379
                                                                └─ PostgreSQL 5432
```

A chạy một tunnel client. Mỗi máy ứng dụng chạy agent độc lập. B và C có thể
dùng cùng cổng local vì chúng là các máy khác nhau.

## 1. Cấu hình server cho agent mode

```env
INSTALL_UUID=<uuid-on-dinh>
TUNNEL_USERNAME=<tunnel-user>
TUNNEL_PASSWORD=<tunnel-secret-dai>
MAX_TUNNEL_CLIENTS=1

TCP_AGENT_ALLOWED_PORTS=6379,5432
TCP_AGENT_USERNAME=<agent-user>
TCP_AGENT_PASSWORD=<agent-secret-dai>
TCP_AGENT_REQUIRE_TLS=true
TCP_AGENT_MAX_STREAMS_PER_AGENT=100
TCP_MAX_CONNECTIONS_PER_PORT=40
```

`MAX_TUNNEL_CLIENTS=1` là đủ vì chỉ A kết nối `/tunnel`. Server chấp nhận nhiều
agent `/tcp`. Nếu reverse proxy kết thúc TLS, chỉ thêm IP/CIDR proxy trực tiếp
vào `TCP_AGENT_TRUSTED_PROXIES`.

Build bundle trước khi chạy production:

```bash
node serve/build.js
npm run prod
```

## 2. Cài Computer A (máy dịch vụ)

Không cần checkout mã nguồn. Chỉ tải script từ release tag bất biến và
đáng tin cậy (hoặc nhận đúng file này từ quản trị viên):

```bash
curl -fsSL 'https://raw.githubusercontent.com/dangkhoa2016/Nodejs-WSS-Tunnel/<release-tag>/scripts/setup-service-host.sh' -o setup-service-host.sh
chmod 750 setup-service-host.sh

export SERVER_HOST='tunnel.example.com'
export INSTALL_UUID='<uuid-on-dinh>'
export TUNNEL_USERNAME='<tunnel-user>'
export TUNNEL_PASSWORD='<tunnel-secret-dai>'
./setup-service-host.sh
```

Giữ Redis và PostgreSQL trên loopback. Thay `<release-tag>` bằng phiên bản
bất biến đã duyệt; không cài script production từ nhánh `main` luôn thay đổi.

## 3. Cài Computer B (máy ứng dụng)

```bash
curl -fsSL 'https://raw.githubusercontent.com/dangkhoa2016/Nodejs-WSS-Tunnel/<release-tag>/scripts/setup-application-host.sh' -o setup-application-host.sh
chmod 750 setup-application-host.sh

export SERVER_HOST='tunnel.example.com'
export INSTALL_UUID='<uuid-on-dinh>'
export AGENT_USERNAME='<agent-user>'
export AGENT_PASSWORD='<agent-secret-dai>'
export AGENT_PORTS='6379,5432'
./setup-application-host.sh
```

Kiểm tra hai dịch vụ qua loopback:

```bash
REDISCLI_AUTH='<redis-password>' redis-cli --user '<redis-user>' -h 127.0.0.1 -p 6379 ping
PGPASSWORD='<password>' psql -h 127.0.0.1 -p 5432 -U '<postgres-role>' -d '<database>' -c 'SELECT 1'
```

## 4. Cách hoạt động của installer

Cả hai installer dùng chung mô hình transactional:

- **Staging trước khi đổi phiên bản.** Script tải bundle và manifest
  `*-package.json` đã ghim, kiểm tra bundle, rồi cài dependencies
  (`npm install --omit=dev`) vào một thư mục riêng
  `~/.tunnel-client/releases/release.<random>` (hoặc
  `~/.tcp-agent/releases/...`). Tiến trình đang chạy chỉ bị dừng sau khi
  bản mới đã staged hoàn tất.
- **Activate nguyên tử.** `current` là symlink trỏ tới release đang hoạt động;
  `previous` trỏ tới bản known-good cuối cùng dùng để rollback.
- **Cổng readiness.** Sau khi activate, script đợi file `client.ready` /
  `agent.ready` chứa PID mới. `agent.ready` chỉ được ghi sau khi agent **bind
  mọi listener của `AGENT_PORTS` và mở WebSocket tới máy chủ**, nên việc bind
  port thất bại không bao giờ được báo là cài thành công; file bị vô hiệu hóa
  (xóa) khi một listener không bind được hoặc đóng ngoài dự kiến, hoặc khi
  WebSocket bị rớt.
  `client.ready` được ghi khi WebSocket đã xác thực tới `/tunnel` mở (client
  không bind listener nào) và bị xóa khi ngắt kết nối, xác thực thất bại,
  hoặc dừng.
  File ready được ghi nguyên tử (temp + rename) nên poller không bao giờ đọc
  phải nội dung dở dang. Nếu tiến trình thoát, hết thời gian, hoặc log
  `auth_failed` (sai credential), script giết candidate, kích hoạt lại
  `previous` và xác minh lại, khôi phục cấu hình thời gian chạy trước
  (thông tin đăng nhập, cổng và cài đặt dịch vụ được lưu từ tiến trình
  đang chạy trước khi dừng), rồi thoát **nonzero** để tool tự động biết
  bản mới chưa được áp dụng. Nếu không lấy được cấu hình thời gian chạy
  cũ (tiến trình cũ không còn chạy hoặc không đọc được environment),
  script từ chối dừng tiến trình đang chạy trừ khi đặt
  `ALLOW_CODE_ONLY_ROLLBACK=1`, lúc đó nó rollback bằng code trước đó với
  cấu hình runtime hiện tại của installer (không khôi phục environment của
  process trước đó).
- **An toàn tiến trình cũ.** `client.pid`/`agent.pid` cũ chỉ bị kill khi khớp
  đúng tiến trình dự kiến. Tiến trình không liên quan được giữ nguyên và cài
  đặt dừng lại.
- **Chạy lại để nâng cấp.** Chạy lại script với cùng `INSTALL_UUID` sẽ
  nâng cấp tại chỗ. Khi manifest đổi, dependencies được cài mới cho
  release đó.
- **Logs.** Output hiện tại vào `client.log`/`agent.log`; log cũ được xoay vào
  `logs/`. Candidate lỗi giữ lại `client.failed.*.log` (hoặc
  `agent.failed.*.log`) để chẩn đoán.
- **Giữ lại (retention).** Sau khi cài thành công, script dọn các release cũ
  (giữ `INSTALL_RELEASES_KEEP`, mặc định 3) và log đã xoay (giữ
  `SETUP_LOG_KEEP`, mặc định 5). Cả hai tham số phải là số nguyên với mức
  tối thiểu hợp lý, và việc dọn vẫn hoạt động khi thư mục chứa dấu cách.
- **Khoá chống chạy song song.** File lock khiến installer thứ hai thoát ngay
  với `Another installation is already running`.
- **Migrate legacy.** Bản cài trước transactional (bundle nằm ở gốc thư mục
  làm việc) được chuyển thành `releases/release.legacy.*` và dùng làm bản
  rollback.

Thêm vào đó, application host:

- bắt buộc `AGENT_PORTS` (không có default) và kiểm tra từng cổng;
- mặc định bind `127.0.0.1` (hoặc `::1`) và từ chối bind ngoài loopback trừ khi
  đặt `ALLOW_REMOTE_AGENT_BIND=1`;
- in lệnh `redis-cli`/`psql` với password được che thành
  `<redis-password>`/`<password>`.

## 5. Thêm Computer C và các máy sau

Tải cùng phiên bản `setup-application-host.sh` đã ghim và lặp lại mục 3 trên C,
D và mọi máy tiêu thụ. Tất cả dùng cùng `SERVER_HOST` và `INSTALL_UUID`. Server
hiện có một cặp credential transport của agent, nên các agent dùng chung cặp đó
cho tới khi mô hình xác thực được mở rộng.

Ứng dụng dùng URL loopback:

```text
redis://<redis-user>:<redis-password>@127.0.0.1:6379
postgresql://<postgres-role>:<password>@127.0.0.1:5432/<database>
```

## 6. Giới hạn khi có nhiều agent

- `TCP_AGENT_MAX_STREAMS_PER_AGENT` áp dụng độc lập cho từng agent.
- `TCP_MAX_CONNECTIONS_PER_PORT` là giới hạn tổng mọi agent trên cổng đó.
- Giới hạn kết nối Redis/PostgreSQL vẫn áp dụng sau giới hạn tunnel. Hãy định cỡ
  mọi lớp dựa trên tổng tải đo được.

## 7. Phân quyền và thu hồi từng người dùng

Credential transport hiện chưa phân biệt B với C. Tạo Redis ACL user và
PostgreSQL role riêng cho từng người dùng, chỉ cấp command, key, schema, table
và thao tác cần thiết.

Để thu hồi B mà không làm gián đoạn C:

1. vô hiệu hóa Redis ACL user và PostgreSQL role của B;
2. dừng agent B bằng `kill $(cat ~/.tcp-agent/agent.pid)` (hãy kiểm tra PID thuộc về `tcp-agent.js` trước);
3. xóa `~/.tcp-agent` nếu B bị loại bỏ.

Nếu secret agent dùng chung bị lộ, đổi nó trên server và mọi agent được phép.
Phiên bản hiện tại chưa hỗ trợ thu hồi secret transport riêng từng agent.

## 8. Chế độ trực tiếp

Chỉ dùng direct mode khi nền tảng forward đúng cổng TCP:

```env
TCP_TUNNEL_PORTS=6379,5432
TCP_TUNNEL_BIND_HOST=0.0.0.0
TCP_TUNNEL_ALLOWED_IPS=203.0.113.10,198.51.100.20
```

Kiểm tra Redis từ địa chỉ được phép:

```bash
REDISCLI_AUTH='<redis-password>' redis-cli -h <server-host> -p 6379 ping
```

Listener direct là TCP thô nếu không có TCP TLS proxy riêng. Luôn giới hạn bằng
firewall và `TCP_TUNNEL_ALLOWED_IPS`. Không có port remapping: dịch vụ trên A
phải listen đúng cổng được yêu cầu.

## 9. Checklist production

- [ ] Mọi máy dùng cùng hostname và UUID đã ghim.
- [ ] `/tunnel` và `/tcp` dùng WSS với chứng chỉ hợp lệ.
- [ ] Mọi agent giữ `AGENT_BIND_HOST=127.0.0.1`.
- [ ] Redis/PostgreSQL giữ xác thực và danh tính riêng theo người dùng.
- [ ] Giới hạn tổng và mỗi agent đủ cho tải dự kiến.
- [ ] Đã thử xoay credential và thu hồi user database.

## 10. Khắc phục sự cố

| Triệu chứng | Kiểm tra |
|---|---|
| B chạy nhưng C lỗi | Hostname/UUID, credential và log agent C |
| Agent nhận 401 | Username và password của agent |
| Agent nhận 426 | WSS và cấu hình trusted proxy |
| Báo đạt giới hạn | Giới hạn tổng mỗi cổng và stream mỗi agent |
| Redis trả `NOAUTH` | Redis ACL identity và password |
| Redis trả `READONLY` | Dùng Redis primary có thể ghi |
| PostgreSQL từ chối login | PostgreSQL role, password, `pg_hba.conf`, grants |
