# 无状态入口迁移说明（生产 Runbook）

本文只描述迁移步骤，**不在本次代码变更中执行**。所有命令都以 entry 主机（公网入口 VPS）为对象；桌面机的 DSH 网关和配对数据不需要迁移。

请先把占位符替换成实际值：

| 占位符 | 本部署示例 | 说明 |
|---|---|---|
| `<ENTRY_REPO>` | `/opt/dsh-mobile-stateless` | 新代码目录，建议与旧目录分开 |
| `<ENTRY_PORT>` | `7091` | nginx 当前转发到的本机端口 |
| `<NGINX_SITE>` | `/etc/nginx/sites-enabled/dsh-mobile` | 实际站点文件，先用 `grep -R` 确认 |
| `<SERVICE_USER>` | `dsh-mobile` | 运行入口网关的系统用户 |
| `DSH_UPSTREAM` | `http://127.0.0.1:7080` | 桌面机隧道在 entry 的本地入口 |
| `DSH_UPSTREAM_HOST` | `dsh.tokensfree.eu.cc` | 隧道按 Host 分流所需的名字 |
| `DSH_WS_PATH` | `/ws/mobile` | 移动网关路径 |

> 旧缓存目录 `/var/lib/dsh-mobile-cache` 含完整会话内容。删除前先确认它是可丢弃的；如果合规要求留档，只能加密后短期保存，并在验收后销毁，不能留在 entry 的普通磁盘或备份里。

## 0. 变更后的目标状态

- 运行 `stateless-gateway.mjs`，监听 `127.0.0.1:<ENTRY_PORT>`；
- 不再运行 `dsh-mobile-session-cache.service` 和 `dsh-mobile-cache-proxy.service`；
- `/var/lib/dsh-mobile-cache` 不存在；
- nginx 只转发 `/ws/mobile` 到新入口，不暴露 `/healthz` 或 `/mgw/*`；
- 入口进程不写任何 Session 历史或设备凭据，重启后没有可恢复状态。

## 1. 预检（只读）

在 entry 主机执行并保存输出：

```bash
# 当前旧服务与端口
systemctl list-units --all --type=service | grep -E 'dsh-mobile-(session-cache|cache-proxy)' || true
systemctl list-timers --all | grep -i dsh-mobile || true
ss -ltnp | grep -E ':(7090|7091)\b' || true

# 旧缓存目录与占用进程
sudo ls -ld /var/lib/dsh-mobile-cache 2>/dev/null || true
sudo du -sh /var/lib/dsh-mobile-cache 2>/dev/null || true
sudo fuser -vm /var/lib/dsh-mobile-cache 2>/dev/null || true

# nginx 当前把 /ws/mobile 转到哪个端口，是否还有 /cache/ 暴露
sudo grep -RIn --include='*.conf' -E '7090|7091|/cache/|/ws/mobile' /etc/nginx 2>/dev/null || true

# 现有入口代码、Node 路径和 systemd 单元
readlink -f /opt/dsh-mobile 2>/dev/null || true
command -v node
systemctl cat dsh-mobile-cache-proxy.service 2>/dev/null || true
systemctl cat dsh-mobile-session-cache.service 2>/dev/null || true
```

确认 `ss` 中 7091 是当前的 cache proxy，并记录 nginx 的 upstream 端口。若 7090/7091 属于其他业务，先停下来重新确认，不要直接套用本文。

## 2. 部署新代码并做本机 Canary

把本次 `stateless` 分支的代码放到独立目录，避免覆盖仍可能用于回滚的旧代码：

```bash
# 运行用户不存在时先创建（第 7 节不再重复）
sudo useradd --system --home /nonexistent --shell /usr/sbin/nologin <SERVICE_USER> 2>/dev/null || true

sudo install -d -m 0755 -o <SERVICE_USER> -g <SERVICE_USER> <ENTRY_REPO>
# 从发布包/仓库复制后：
sudo -u <SERVICE_USER> /usr/bin/node --check <ENTRY_REPO>/bin/stateless-gateway.mjs
sudo -u <SERVICE_USER> /usr/bin/node <ENTRY_REPO>/bin/stateless-gateway.mjs --help
```

先用 7092 端口做 canary（不要改 nginx）：

```bash
sudo -u <SERVICE_USER> env \
  DSH_UPSTREAM=http://127.0.0.1:7080 \
  DSH_UPSTREAM_HOST=dsh.tokensfree.eu.cc \
  DSH_WS_PATH=/ws/mobile \
  /usr/bin/node <ENTRY_REPO>/bin/stateless-gateway.mjs --port 7092
```

另一个终端检查：

```bash
curl -fsS http://127.0.0.1:7092/healthz | python3 -m json.tool
```

必须看到：

- `"mode": "stateless"`
- `"cache": { "enabled": false, ... }`（除非本次明确要开启内存缓存）
- `"upstream": { "host": "dsh.tokensfree.eu.cc", "path": "/ws/mobile", ... }`

如果 canary 起不来，先解决 `DSH_UPSTREAM` 可达性、Host 头和端口占用；不要进入下一步。

## 3. 切换 nginx

### 方案 A：零停机（推荐）

1. 让 canary 继续在 7092 运行。
2. 备份并修改 nginx upstream：

```bash
sudo cp <NGINX_SITE> /root/$(basename <NGINX_SITE>).bak-$(date +%F-%H%M)
sudo grep -n 'proxy_pass.*7091' <NGINX_SITE>
```

手工把该处改为 `proxy_pass http://127.0.0.1:7092;`（不要用未确认的全局 `sed`）。然后：

```bash
sudo nginx -t
sudo systemctl reload nginx
```

3. 用手机配对/打开一个已有 Session，确认历史、实时消息和命令菜单正常。
4. 此时 nginx 已指向 7092，可以安全停用旧 `dsh-mobile-cache-proxy.service`（见第 4 节），释放 7091 端口。
5. 按第 7 节把新入口作为 7091 的 systemd 服务启动；再把 nginx 的 upstream 改回 `<ENTRY_PORT>` 并 reload。
6. 用手机复验后，停掉 7092 的 canary。

### 方案 B：短暂停机（更简单）

如果入口可以接受几秒中断，直接停旧 proxy、在同一 7091 端口启动新服务：

```bash
sudo systemctl stop dsh-mobile-cache-proxy.service
sudo systemctl start dsh-mobile-gateway.service   # 第 7 节的单元
```

nginx 的 upstream 不需要改。旧 cache service 仍可在 7090 运行到验收结束，但新入口不会访问它。

## 4. 停用旧缓存服务

验收通过后执行。方案 A 中此时 nginx 已指向 7092，停旧 proxy 不会中断手机；如果还没切换 nginx，请先完成第 3 节。

```bash
sudo systemctl stop dsh-mobile-session-cache.service dsh-mobile-cache-proxy.service
sudo systemctl disable dsh-mobile-session-cache.service dsh-mobile-cache-proxy.service
sudo systemctl mask dsh-mobile-session-cache.service dsh-mobile-cache-proxy.service
```

如果预检发现独立的推送器（例如 `dsh-mobile-cache-push.service` / `.timer` 或 crontab 条目），一并停用：

```bash
systemctl list-units --all --type=service,timer | grep -i 'dsh-mobile' || true
# 对实际存在的 *cache* 推送单元执行 stop/disable/mask；不要停 helper 和证书续期单元
```

不要停用 `dsh-mobile-gateway-helper.service` 或 `dsh-mobile-gateway-cert-renew.timer`：它们负责 Nginx/证书，与 Session 缓存无关。

## 5. 删除缓存目录

先做路径核验，再删除。`readlink -f` 的输出必须逐字等于 `/var/lib/dsh-mobile-cache`：

```bash
sudo readlink -f /var/lib/dsh-mobile-cache
# 期望输出：/var/lib/dsh-mobile-cache
```

确认没有进程占用：

```bash
sudo fuser -vm /var/lib/dsh-mobile-cache 2>/dev/null || true
```

删除：

```bash
sudo rm -rf -- /var/lib/dsh-mobile-cache
sudo test ! -e /var/lib/dsh-mobile-cache && echo 'cache directory removed'
```

再检查常见残留位置（只列出，不自动删除）：

```bash
sudo find /var/lib /var/cache -maxdepth 3 -iname '*dsh-mobile-cache*' -print 2>/dev/null || true
sudo find /tmp -maxdepth 2 -iname '*dsh-mobile-cache*' -print 2>/dev/null || true
```

如果发现 `*.bin` / `*.meta.json` 残留，按同样方式核验路径后删除；不要删除 `/var/lib/dsh-mobile-gateway`（这是 Helper 的 ACME 目录，不是会话缓存）。

## 6. 清理旧凭据与配置

旧缓存使用过共享 secret 和 device token hash 文件。停用后不应继续留在 entry：

```bash
sudo grep -RIn -E 'DSH_CACHE_SECRET|DSH_CACHE_TOKENS|DSH_CACHE_ROOT|/var/lib/dsh-mobile-cache' \
  /etc/systemd/system /etc/dsh-mobile* /etc/default 2>/dev/null || true
```

对实际存在的文件：

```bash
# 仅在确认是旧缓存配置后执行
sudo shred -u /etc/dsh-mobile-cache.env 2>/dev/null || sudo rm -f /etc/dsh-mobile-cache.env
```

同时从旧 unit 中删除 `Environment=DSH_CACHE_SECRET=...`、`Environment=DSH_CACHE_TOKENS=...` 和 `ReadWritePaths=/var/lib/dsh-mobile-cache`。修改 unit 后：

```bash
sudo systemctl daemon-reload
```

如果旧 `DSH_CACHE_SECRET` 曾出现在 shell history、工单或备份中，视为已泄露并轮换；设备 token 若也曾暴露，在 WebUI 撤销相关设备并重新配对。

## 7. 安装并启动新 systemd 单元

创建运行用户（已存在则跳过）：

```bash
sudo useradd --system --home /nonexistent --shell /usr/sbin/nologin <SERVICE_USER> 2>/dev/null || true
```

创建 `/etc/systemd/system/dsh-mobile-gateway.service`：

```ini
[Unit]
Description=DSH Mobile stateless entry gateway
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=<SERVICE_USER>
Group=<SERVICE_USER>
WorkingDirectory=<ENTRY_REPO>
Environment=DSH_UPSTREAM=http://127.0.0.1:7080
Environment=DSH_UPSTREAM_HOST=dsh.tokensfree.eu.cc
Environment=DSH_WS_PATH=/ws/mobile
ExecStart=/usr/bin/node <ENTRY_REPO>/bin/stateless-gateway.mjs --port 7091
Restart=always
RestartSec=2

# No local state is needed. Keep the filesystem read-only for the service;
# PrivateTmp supplies an ephemeral /tmp if Node needs one.
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
CapabilityBoundingSet=
LockPersonality=true

[Install]
WantedBy=multi-user.target
```

注意：

- `<SERVICE_USER>` 必须能读取 `<ENTRY_REPO>`；`ProtectSystem=strict` 会让 `/opt` 等路径只读，但读取不受影响。
- 不要添加 `StateDirectory=`、`CacheDirectory=`、`ReadWritePaths=/var/lib/dsh-mobile-cache` 或任何指向会话缓存的路径。
- 不要设置 `MemoryDenyWriteExecute=true`：Node 的 JIT 需要可写可执行内存。
- 如果使用 7092 做 canary，可先复制一份 unit 改端口；验收后删除。

启动：

```bash
# 确认 7091 已由旧 proxy 释放；若仍被占用，先停 dsh-mobile-cache-proxy.service
sudo ss -ltnp | grep ':7091' || true
sudo systemctl daemon-reload
sudo systemctl enable --now dsh-mobile-gateway.service
sudo systemctl status --no-pager dsh-mobile-gateway.service
curl -fsS http://127.0.0.1:7091/healthz | python3 -m json.tool
```

## 8. 验收清单

逐项确认：

```bash
# 新入口 active，旧缓存服务 inactive/masked
systemctl is-active dsh-mobile-gateway.service
systemctl is-active dsh-mobile-session-cache.service 2>/dev/null || true
systemctl is-active dsh-mobile-cache-proxy.service 2>/dev/null || true

# 缓存目录不存在
test ! -e /var/lib/dsh-mobile-cache && echo 'no cache dir'

# 只监听 loopback；7090 不应再出现
sudo ss -ltnp | grep -E ':(7090|7091)\b' || true

# 健康信息：mode=stateless，cache.enabled=false（未显式开启时）
curl -fsS http://127.0.0.1:7091/healthz | python3 -m json.tool

# 入口日志里没有 Session 内容；只应有连接/帧类型摘要
sudo journalctl -u dsh-mobile-gateway.service -n 50 --no-pager
```

手机侧：

1. 已配对设备直接打开一个历史较长的 Session，确认首屏和向前翻页正常。
2. 发送一条消息，确认实时流、命令/技能菜单、任务/Goal 正常。
3. 新建 Session 或切换 workspace，确认 live session 与 preset 正常。
4. 重启入口服务，再打开同一 Session；历史应从桌面机重新读取，且 `/var/lib/dsh-mobile-cache` 仍不存在。

可选的进程级检查：

```bash
PID=$(systemctl show -p MainPID --value dsh-mobile-gateway.service)
sudo ls -l /proc/$PID/fd 2>/dev/null | grep -E 'dsh-mobile-cache|session.*\.(bin|jsonl|json)' || true
sudo find /var/lib /var/cache -maxdepth 3 -iname '*dsh-mobile-cache*' -print 2>/dev/null || true
```

两条命令都不应列出会话缓存文件。

## 9. 回滚（仅在需要时）

回滚会把磁盘缓存路径重新打开，**不推荐长期使用**。如果新入口造成不可接受的中断：

```bash
sudo systemctl stop dsh-mobile-gateway.service
sudo systemctl unmask dsh-mobile-session-cache.service dsh-mobile-cache-proxy.service
sudo systemctl start dsh-mobile-session-cache.service dsh-mobile-cache-proxy.service
sudo systemctl status --no-pager dsh-mobile-cache-proxy.service
```

注意：

- 旧缓存目录已被删除；cache proxy 对未命中的 Session 会回源桌面网关，但吞吐回到旧隧道水平。
- 需要重新填充缓存时，再启动旧的桌面推送器；它同样需要 `--legacy-cache` 显式 opt-in，并会重新把 Session 写到 entry 磁盘。
- 回滚期间应把 nginx 的 upstream 指回旧 proxy 端口（如果新入口不在 7091）。

## 10. 清理与后续

稳定运行一段时间后，可以移除旧单元文件和 nginx 上的缓存入口：

```bash
sudo systemctl disable --now dsh-mobile-session-cache.service dsh-mobile-cache-proxy.service 2>/dev/null || true
sudo rm -f /etc/systemd/system/dsh-mobile-session-cache.service
sudo rm -f /etc/systemd/system/dsh-mobile-cache-proxy.service
sudo systemctl daemon-reload
```

nginx 侧确认只保留 `/ws/mobile` 的 upgrade 转发；删除任何 `/cache/` location。示例（按实际站点调整）：

```nginx
location /ws/mobile {
    proxy_pass http://127.0.0.1:7091;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
}
```

不要把 `/healthz`、`/mgw/*` 或 7090/7091 直接暴露到公网。最后确认备份、监控和日志系统不再采集 `/var/lib/dsh-mobile-cache`。

---

本文中的命令是迁移模板，未在本次代码改动中执行；执行前请按实际服务名、路径和 nginx 配置逐项核对。