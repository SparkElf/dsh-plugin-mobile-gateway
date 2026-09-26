# VPS 会话预缓存架构

## 问题

手机只走公网时，每个字节都要穿两次桌面机的上行。

### 实测数据（本部署）

| 链路 | 吞吐 | 方法 |
|---|---|---|
| 本机直连 3080 | 18.8 MB/s | curl 本地 |
| 本机上行（→ VPS） | **929 KB/s** | SSH 传 20MB |
| 隧道聚合（20 并发） | 798 KB/s | VPS 侧并发 curl |
| VPS 下行（→ 手机） | **8.3 MB/s** | cloudflare 测速 |
| VPS 本地读缓存 | 380 MB/s | curl 127.0.0.1:7090 |
| **VPS 出网读缓存（=手机视角）** | **109 MB/s** | VPS 侧 curl 经 nginx |
| RTT（本机 ↔ VPS） | **172.95 ms** | ping，0% 丢包 |

单流测量会误导：39 KB 的页面在单流下只有 31 KB/s，那是**延迟主导**（一个 RTT 内传完），
不是带宽。带宽必须用并发或大响应体测。

结论：**隧道已经跑满上行**（798 / 929 KB/s），缓存路径快 **191 倍**，且与本机上行无关。

## 架构

```
后台（不在乎多久）：桌面机 → VPS 缓存      929 KB/s，12.9 MB 约 12.5 秒
手机打开会话：      VPS → 手机             109 MB/s，快 191 倍
实时事件：          仍走原隧道（量小）
```

## 已实现的组件

### 1. VPS 缓存服务（`bin/session-cache.mjs`）

零依赖 HTTP 服务，监听 `127.0.0.1:7090`，nginx 反代 `/cache/`。

| 端点 | 鉴权 | 用途 |
|---|---|---|
| `PUT /cache/:id` | 共享 secret | 桌面机推快照，query 带 `lastSeq`/`events`/`tokenHash` |
| `GET /cache/:id` | device token（比对 sha256）| 手机取快照，响应头带 cursor |
| `GET /cache` | 共享 secret | 桌面机看索引 |
| `DELETE /cache/:id` | 共享 secret | 删除 |

存储：`/var/lib/dsh-mobile-cache/<id>.bin` + `<id>.meta.json`。

**安全**：手机只能读；路径穿越被拒（`^[A-Za-z0-9._-]+$`）；空 hash 集拒绝一切读取。

### 2. 桌面推送器（`bin/push-session-cache.mjs`）

遍历本机会话，取最新的 format 版本，读到最高 seq，PUT 给 VPS。
限速、可重试、不在用户等待路径上。

**设备凭据**：网关只存 `tokenHash`，推送器读 hash 声明读权限 —— 明文 token 从不离开手机。

## 剩余工作

### 3. VPS 侧网关代理（未完成）

缓存里是 **zstd 压缩的 JSONL**（DSH 内部格式），手机要的是
`{kind:"history", events:[...], cursor, projections}`（协议视图，工具结果已折叠）。
两者之间需要网关 `historyPage()` 那套转换。

代理必须：
- 用 Node 内置 `http` upgrade 做 WebSocket 握手（VPS 无 npm、无 ws 库）
- 解析 text 帧（协议全是 JSON）
- `history` → 解压缓存 + 转换 + 应答
- 其它 → 回源到本机隧道

### 4. 自动触发（未完成）

现在是手工 `--once`。应改为：
- turn 结束后触发
- 或定时（如每 5 分钟）
- 会话不再增长时才推（避免推一个正在写的文件）

## 硬约束（重要）

协议里 **没有「从外部缓存取历史」的机制**：

- `endpoints` 只在配对载荷和 `/mgw/status` 出现，**不在 `hello`/`paired` 返回**
- `history` 响应只有 `events`/`cursor`/`projections`
- App 是预编译 APK，改不了

所以代理必须运行**完整的 `/ws/mobile` 协议**，并作为**一个额外的 endpoint** 提供 ——
手机连上它，history 从缓存答，实时回源。
