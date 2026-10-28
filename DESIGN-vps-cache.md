# 无状态入口网关设计

> 文件名保留为 `DESIGN-vps-cache.md` 以维持历史链接；内容已改为无状态入口设计。旧的 VPS 预缓存方案已废弃。

## 结论

公网 entry 主机只运行 `bin/stateless-gateway.mjs`。它把手机的 `dsh-mobile-v1` WebSocket 透明转发到桌面机的 DSH 网关：历史按需回源，实时事件照常双向转发，入口不写任何 Session 历史或设备凭据。

```text
手机
  │  wss://<入口>/ws/mobile
  ▼
nginx（TLS、只暴露 /ws/mobile）
  │  http://127.0.0.1:7091
  ▼
stateless-gateway
  │  DSH_UPSTREAM=http://127.0.0.1:7080
  │  Host: dsh.tokensfree.eu.cc
  │  WS: /ws/mobile
  ▼
桌面机 DSH 移动网关（唯一的数据与鉴权权威）
```

## 背景

旧方案在 entry 主机上运行两个常驻服务：

- `dsh-mobile-session-cache.service`（`bin/session-cache.mjs`，端口 7090）把完整 Session 快照写到 `/var/lib/dsh-mobile-cache`；
- `dsh-mobile-cache-proxy.service`（`bin/session-cache-proxy.mjs`，端口 7091）优先从磁盘缓存回答 `history`，其余流量回源桌面机。

它确实解决了桌面机上行慢的问题（历史页可在 entry 本地读取），但代价是 entry 主机落盘了完整的会话内容。这是本次事故的根因之一：缓存目录、备份、磁盘快照或误配置都会扩大会话数据的暴露面，而且缓存与实时事件之间还存在一致性窗口。

无状态方案接受“历史首屏要穿桌面机上行”的成本，换取更小的信任边界和更简单的故障模型。性能优化只能在不落盘、不持有凭据的前提下进行。

## 目标与非目标

目标：

- entry 主机不持久化任何 Session 历史、设备 token 或历史缓存。
- 历史从桌面机按需流式读取；实时事件、配对、鉴权、LAN/多网关、live session、preset 和现有协议保持兼容。
- 旧的磁盘缓存路径默认不可用；确需兼容时必须显式 opt-in，并在文档中标注风险。
- 提供一个可选的、进程内有界 TTL 缓存，默认关闭。

非目标：

- 不改变桌面机网关的数据模型、鉴权模型或 `dsh-mobile-v1` 协议。
- 不在 entry 主机做设备管理、配对、吊销或 Session 权限判断；这些仍由桌面网关负责。
- 不承诺冷启动首屏达到旧磁盘缓存的吞吐。

## 组件

### `bin/stateless-gateway.mjs`

- 零依赖：只使用 Node 内置模块；entry 主机不需要 `npm install`。
- 只监听 `127.0.0.1:7091`；公网 TLS 与路径隔离由 nginx 负责。
- 默认是 raw relay：握手完成后直接双向 pipe TCP，帧不被解析、不被缓冲，历史页和附件按 TCP 到达顺序流式通过。
- 握手只做必要转发：`Authorization`、`Sec-WebSocket-Protocol`（含配对码）、`X-DSH-Device-ID`、`X-DSH-Device-Token`、`X-DSH-Channel`、`Cookie`、`Origin`、`User-Agent` 等原样送到上游；`Host` 改为 `DSH_UPSTREAM_HOST`，`Connection`/`Upgrade` 按 WebSocket 握手重建。
- 上游的 101 和拒绝响应（尤其 401）原样回传，因此手机仍能按原有逻辑重新配对或重试。
- 不读取、不写入任何本地状态文件；没有 `--root`、`--tokens` 或 `--legacy-cache` 参数。
- `GET /healthz` 返回 `mode`、上游配置、连接数和缓存统计；不包含请求内容或凭据。该端点只应在 loopback 访问。

### `lib/ws-frame.mjs`

仅在启用可选内存缓存时使用。实现 RFC 6455 的文本/二进制帧、分片、控制帧和掩码规则；代理作为客户端时必须给上游帧加掩码，作为服务端时不得加掩码。默认 raw relay 不经过它。

### `lib/memory-history-cache.mjs`

可选缓存本体，见下文。

## 请求路径

### 配对与鉴权

手机仍通过 `Sec-WebSocket-Protocol: dsh-mobile-v1, dsh-pair.<code>` 发起首次配对，之后使用 `Authorization: Bearer <device-token>`。入口不解析 token、不保存 token，也不做本地白名单；它把握手原样转给桌面网关。桌面网关返回 101 才继续转发，返回 401 就原样拒绝手机。这样设备身份、吊销和在线状态只有一份。

### 历史

手机发送的 `history` 帧被转发到桌面网关，网关读取持久 Session 并按现有 `maxBytes` / `view` / `beforeSeq` 规则生成响应。入口默认不解析、不缓存；数据沿 TCP 流返回。入口重启后没有历史副本，下一次读取自然回源。

### 实时事件与 live session

上游的 `event`、`assistant-stream`、`question-*`、`approval-*` 等帧按原顺序转发；手机的 `message`、`subscribe`、`session-cancel`、`queue-update` 等请求原样转发。独立对话/控制连接通过 `X-DSH-Channel` 头保留，入口不会把两条 lane 合并。

## 无状态保证

具体到可检查的行为：

- 代码不导入 `node:fs`、`node:path` 的写接口或任何数据库；进程只读自身脚本和 Node 运行时。
- 没有 cache root、token 文件、Session 快照或元数据文件；启动时即使设置了 `DSH_CACHE_ROOT` 也会被忽略并打印警告。
- 进程退出即失去全部运行时状态；重启后同一历史页必须重新向上游请求。
- 可选内存缓存只保存响应 JSON 字符串，不保存 `Authorization`、设备 token、cookie 或握手头。
- `--trace` 只记录帧类型、`kind`、Session id 和字节数，不记录 payload。

## 可选内存 TTL 缓存

默认关闭。启用方式：

```bash
node bin/stateless-gateway.mjs --memory-cache \
  --memory-cache-ttl 60 \
  --memory-cache-entries 16 \
  --memory-cache-bytes 33554432
```

设计约束：

- **只缓存不可变页**：请求必须带 `beforeSeq` 和非负的 `historyFormatVersion`。`beforeSeq` 之前的持久事件是 Session 日志的不可变前缀；不带 `beforeSeq` 的首屏会随新回合增长，缓存它可能让手机漏掉刚落盘的事件，因此永远回源。
- **精确键**：键包含 `sessionId`、`beforeSeq`、`maxMessages`、`maxBytes`、`view` 和 `historyFormatVersion`；任一字段不同都不会串页。
- **有界**：条目数（默认 16）、总字节数（默认 32 MiB）、TTL（默认 60 秒）同时生效；LRU 淘汰；单页超过总预算则不缓存。
- **不落盘**：Map 在进程内，退出即清；不写临时文件。
- **鉴权前置**：只有在桌面网关完成握手并返回 101 的连接上才会服务缓存；缓存不绕过配对，也不保存凭据。
- **并发保护**：同一 Session 同时有多个历史请求在途时，不缓存任何响应，避免把 A 页误记为 B 页的响应。
- **不改善冷启动**：首屏仍然要经过桌面机上行；缓存只减少重复的较早页请求。
- **会跳过桌面侧审计**：缓存命中在入口本地回答，不再经过桌面网关。若合规要求每次历史读取都回源并留痕，保持默认关闭。

## 旧磁盘缓存兼容

`bin/session-cache.mjs`、`bin/session-cache-proxy.mjs` 和 `bin/push-session-cache.mjs` 保留为兼容代码，但：

- 默认直接以退出码 2 拒绝启动；
- 必须显式传 `--legacy-cache` 或设置 `DSH_LEGACY_SESSION_CACHE=1`；
- 启动时向 stderr 打印“legacy disk cache enabled”警告；
- 仍会把完整 Session 历史写到 `/var/lib/dsh-mobile-cache`，并依赖 7090/7091 两个常驻服务；
- 文档与迁移说明明确标注“已废弃、不推荐、会落盘”。

新部署不应使用旧路径。迁移完成后应停用两个旧 service，并删除缓存目录。

## 协议兼容

入口是透明代理，不新增或修改任何帧：

- `hello`、`paired`、`history`、`event`、`assistant-stream`、命令/Goal/文件下载等帧均按原样通过。
- 入口不改变 `protocol: 3`、`historyFormatVersion`、`cursor` 或 `beforeSeq` 的语义。
- 配对码、`dsh-mobile-v1` 子协议和 `X-DSH-Channel` 都原样转发。
- 历史格式升级仍由桌面网关和客户端按 `PROTOCOL.md` 处理；入口没有自己的历史格式。

因此手机端不需要为无状态入口发版；它只是换了一个更薄的反向代理。

## 性能权衡

旧文档记录过本部署的测量：桌面机上行约 929 KB/s，入口下行约 8.3 MB/s，本地磁盘缓存读约 109 MB/s，因此旧缓存路径快约 191 倍。无状态入口不再使用这条快路径：

- 首屏和未命中的历史页都受桌面机上行限制；
- 大 Session 的首次打开会更慢，这是用隐私和信任边界换来的确定性；
- 可选内存缓存只对重复的较早页有帮助，不能改变首屏成本；
- 如果首屏性能不可接受，应优先升级桌面机上行、调整历史分页（`maxBytes` / `maxMessages`）或在客户端按页加载，而不是重新把完整 Session 落到 entry 主机。

## 失败模式与运维

| 现象 | 入口行为 | 处理 |
|---|---|---|
| 桌面网关不可达 | 握手返回 502 | 检查 `DSH_UPSTREAM`、隧道和桌面 `dsh web` |
| 上游握手超时 | 20 秒后返回 504 | 检查隧道 Host/端口 |
| 设备未配对或 token 失效 | 原样回传上游 401 | 手机重新扫码配对 |
| 手机断开 | 关闭上游 socket，清理连接计数 | 无需处理 |
| 入口重启 | 没有可恢复状态；内存缓存清空 | 手机重连，历史回源 |
| 内存缓存开启后内存上涨 | 受 entries/bytes/TTL 三重上限约束 | 检查 `/healthz` 的 `cache` 字段，必要时调小 |

## 验证

`npm test` 覆盖：

- `test/stateless-gateway.test.mjs`：无缓存时历史回源、实时双向转发、401 透传、设备/通道头保留、重启后无持久化、内存缓存命中/上限/TTL，以及并发历史请求不会被错误归属。
- `test/legacy-cache-optin.test.mjs`：三个旧入口默认拒绝启动，`--help` 仍可发现 `--legacy-cache`，无状态入口拒绝 `--root`。
- `test/ws-frame.test.mjs`：分片、跨 chunk、掩码方向、控制帧和缓存 LRU/TTL/上限。
- 既有 `session-cache` / `session-cache-proxy` 测试在显式 `--legacy-cache` 下继续覆盖兼容路径。

## 迁移

生产切换步骤见 [无状态迁移说明](docs/stateless-migration.md)。核心顺序是：先启动新入口并验证健康，再切 nginx 上游，最后停用旧缓存服务并删除 `/var/lib/dsh-mobile-cache`。