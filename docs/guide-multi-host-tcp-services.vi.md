# Chia sẻ dịch vụ TCP cho nhiều máy ứng dụng

> Ngôn ngữ: [English](guide-multi-host-tcp-services.md) | **Tiếng Việt**

Hướng dẫn này kết nối Redis và PostgreSQL trên một máy dịch vụ (Computer A)
cho hai hoặc nhiều máy ứng dụng (Computer B, C, ...). Mô hình agent chỉ cần
cổng HTTP/WebSocket public của tunnel server.

## Kiến trúc

```text
Computer B ── 127.0.0.1:6379/5432 ── agent ─┐
Computer C ── 127.0.0.1:6379/5432 ── agent ─┼─ WSS /tcp ─ server
                                             └─ WSS /tunnel ─ Computer A
                                                                ├─ Redis 6379
                                                                └─ PostgreSQL 5432
```

Computer A chạy đúng một tunnel client. Mỗi máy ứng dụng chạy agent riêng và
có listener loopback độc lập. B và C có thể dùng cùng số cổng vì là hai máy khác
nhau.

## 1. Cấu hình tunnel server

Dùng hostname ổn định và ghim `INSTALL_UUID`:

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
agent `/tcp`. Nếu reverse proxy kết thúc TLS, cấu hình
`TCP_AGENT_TRUSTED_PROXIES` chỉ với IP hoặc CIDR của proxy trực tiếp; nếu không,
header protocol chuyển tiếp sẽ bị bỏ qua.

Build bundle trước khi chạy production:

```bash
node serve/build.js
npm run prod
```

## 2. Cài Computer A (máy dịch vụ)

Redis và PostgreSQL nên listen trên loopback. Computer A **không cần** clone
repository: chỉ tải script service-host từ release tag cố định và đáng tin cậy
(hoặc nhận đúng một file này từ quản trị viên), kiểm tra nội dung rồi chạy:

```bash
curl -fsSL \
  'https://raw.githubusercontent.com/dangkhoa2016/Nodejs-WSS-Tunnel/<release-tag>/scripts/setup-service-host.sh' \
  -o setup-service-host.sh
chmod 750 setup-service-host.sh

export SERVER_HOST='tunnel.example.com'
export INSTALL_UUID='<uuid-on-dinh>'
export TUNNEL_USERNAME='<tunnel-user>'
export TUNNEL_PASSWORD='<tunnel-secret-dai>'

./setup-service-host.sh
```

Thay `<release-tag>` bằng phiên bản bất biến được quản trị viên server phê
duyệt. Không cài script production trực tiếp từ nhánh `main` luôn thay đổi.

Kiểm tra client:

```bash
tail -f ~/.tunnel-client/client.log
```

Không chạy tunnel client khác trên B hoặc C. Client duy nhất trên A có thể dial
cả hai cổng vì server yêu cầu đúng cổng được phép trên `127.0.0.1`.

## 3. Cài Computer B

```bash
curl -fsSL \
  'https://raw.githubusercontent.com/dangkhoa2016/Nodejs-WSS-Tunnel/<release-tag>/scripts/setup-application-host.sh' \
  -o setup-application-host.sh
chmod 750 setup-application-host.sh

export SERVER_HOST='tunnel.example.com'
export INSTALL_UUID='<uuid-on-dinh>'
export AGENT_USERNAME='<agent-user>'
export AGENT_PASSWORD='<agent-secret-dai>'
export AGENT_PORTS='6379,5432'

./setup-application-host.sh
```

Ứng dụng trên B chỉ kết nối loopback:

```text
redis://<redis-user>:<redis-password>@127.0.0.1:6379
postgresql://<postgres-role>:<password>@127.0.0.1:5432/<database>
```

## 4. Cài Computer C và các máy khác

Tải cùng phiên bản `setup-application-host.sh` đã ghim trên C, D và mỗi máy tiêu
thụ mới, rồi chạy cùng lệnh. Dùng cùng hostname và UUID của server. Server hiện
chỉ có một cặp credential
transport, nên mọi agent dùng chung `AGENT_USERNAME`/`AGENT_PASSWORD` cho tới
khi mô hình xác thực được mở rộng.

Kiểm tra trên từng máy ứng dụng:

```bash
REDISCLI_AUTH='<redis-password>' redis-cli --user '<redis-user>' -h 127.0.0.1 -p 6379 ping
PGPASSWORD='<password>' psql -h 127.0.0.1 -p 5432 -U '<postgres-role>' -d '<database>' -c 'SELECT 1'
```

## 5. Hiểu các giới hạn

- `TCP_AGENT_MAX_STREAMS_PER_AGENT` áp dụng riêng cho từng agent. Với `100`, B
  có thể có 100 stream và C có thể có 100 stream riêng.
- `TCP_MAX_CONNECTIONS_PER_PORT` là giới hạn tổng của mọi agent. Với `40`, B và
  C cộng lại có tối đa 40 kết nối Redis và 40 kết nối PostgreSQL.
- Giới hạn kết nối của database vẫn áp dụng sau giới hạn tunnel. Hãy định cỡ ba
  lớp dựa trên tải thực tế, không mặc định dùng giá trị vô hạn.

## 6. Tách danh tính và quyền người dùng

B và C hiện dùng chung credential transport, nên lớp transport chưa thể nhận
diện hoặc thu hồi riêng một máy. Hãy tách quyền tại database:

- Tạo một Redis ACL user cho B và một Redis ACL user cho C. Chỉ cấp command và
  key pattern mà từng ứng dụng cần.
- Tạo PostgreSQL role riêng cho B và C. Chỉ cấp database, schema, table và thao
  tác cần thiết.

Cách này cung cấp attribution và thu hồi riêng dù agent dùng chung credential
transport của server.

## 7. Thêm hoặc thu hồi một máy ứng dụng

Để thêm máy, tạo danh tính database rồi chạy script application-host trên máy
đó. Để thu hồi B mà không làm gián đoạn C:

1. vô hiệu hóa hoặc xóa Redis ACL user và PostgreSQL role của B;
2. dừng agent B bằng `kill $(cat ~/.tcp-agent/agent.pid)`;
3. xóa `~/.tcp-agent` trên B nếu máy được loại bỏ.

Nếu credential transport của agent bị lộ, đổi
`TCP_AGENT_USERNAME`/`TCP_AGENT_PASSWORD` trên server rồi khởi động lại mọi
agent được phép. Phiên bản hiện tại chưa thể chỉ đổi credential transport của B.

## 8. Checklist production

- [ ] A, B và C dùng cùng `SERVER_HOST` và `INSTALL_UUID` đã ghim.
- [ ] `/tunnel` và `/tcp` dùng WSS với chứng chỉ hợp lệ.
- [ ] Mọi agent giữ `AGENT_BIND_HOST=127.0.0.1`.
- [ ] Redis/PostgreSQL giữ xác thực và danh tính riêng theo máy.
- [ ] Giới hạn tổng và giới hạn mỗi agent đủ cho tải dự kiến.
- [ ] Log và health endpoint được giám sát.
- [ ] Đã thử xoay credential và thu hồi user database.

## 9. Khắc phục sự cố

| Triệu chứng | Kiểm tra |
|---|---|
| B kết nối nhưng C không kết nối | C dùng cùng hostname/UUID; credential và log agent C |
| Agent nhận 401 | `TCP_AGENT_USERNAME` và `TCP_AGENT_PASSWORD` |
| Agent nhận 426 | WSS và `TCP_AGENT_TRUSTED_PROXIES` tại điểm kết thúc TLS |
| Báo đạt giới hạn kết nối | Giới hạn tổng mỗi cổng và giới hạn stream mỗi agent |
| Redis trả `NOAUTH` | Redis ACL username và password |
| Redis trả `READONLY` | Redis topology; dùng primary có thể ghi |
| PostgreSQL từ chối đăng nhập | Role password, `pg_hba.conf`, database grants |
