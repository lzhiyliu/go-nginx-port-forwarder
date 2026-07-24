# nftables Port Forwarder 运维配置手册

基于 **nftables** 的可视化四层端口转发管理控制台。支持 TCP/UDP DNAT 规则配置、IP 白名单访问控制、规则自动热重载、配置版本快照与回滚、端口状态检测及审计日志。

---

## 目录

- [系统架构](#系统架构)
- [环境要求](#环境要求)
- [快速开始（测试环境）](#快速开始测试环境)
- [生产环境部署](#生产环境部署)
  - [方式一：Go 二进制部署](#方式一go-二进制部署)
  - [方式二：Node.js 部署](#方式二nodejs-部署)
  - [方式三：Docker 部署](#方式三docker-部署)
- [配置说明](#配置说明)
  - [管理账号](#管理账号)
  - [监听端口](#监听端口)
  - [HTTPS / TLS](#https--tls)
- [功能指南](#功能指南)
  - [登录认证](#登录认证)
  - [转发规则管理](#转发规则管理)
  - [白名单组管理](#白名单组管理)
  - [nftables 规则预览](#nftables-规则预览)
  - [自动热重载机制](#自动热重载机制)
  - [配置版本回滚](#配置版本回滚)
  - [端口状态检测](#端口状态检测)
- [API 参考](#api-参考)
- [日常运维](#日常运维)
  - [启动 / 停止 / 重启](#启动--停止--重启)
  - [日志查看](#日志查看)
  - [备份与恢复](#备份与恢复)
  - [健康检查](#健康检查)
- [故障排查](#故障排查)

---

## 系统架构

```
┌──────────────────────────────────────────────┐
│              浏览器管理界面 (React SPA)        │
│          http://<server>:3000                 │
└──────────────────┬───────────────────────────┘
                   │ HTTP + WebSocket
┌──────────────────▼───────────────────────────┐
│   nftables Port Forwarder 控制服务             │
│   (Go 二进制 / Node.js Express)               │
│   ├─ 端口转发规则 CRUD                        │
│   ├─ 白名单组管理 (命名集合优化)                │
│   ├─ nftables 规则生成与自动热重载              │
│   ├─ 版本快照与回滚                            │
│   ├─ 端口连通性检测                            │
│   └─ 审计日志                                 │
└──────────────────┬───────────────────────────┘
                   │ nft -f 刷写规则
┌──────────────────▼───────────────────────────┐
│               nftables 内核引擎                │
│   table ip port_forwarder                     │
│   ├─ set whitelist_<id>    (命名 IP 集合)     │
│   ├─ chain prerouting      (DNAT 入站流量)    │
│   └─ chain postrouting     (MASQUERADE 回程)  │
└──────────────────────────────────────────────┘
```

- **前端**：React 19 + TypeScript + Tailwind CSS，内嵌于后端服务
- **后端（二选一）**：
  - Go 二进制：编译为单一文件，无运行时依赖（生产推荐）
  - Node.js：Express + TypeScript，支持 Vite HMR 开发热更新
- **数据持久化**：JSON 文件（`data/` 目录）
- **实时推送**：WebSocket，规则与日志变更即时同步所有客户端
- **内核转发引擎**：nftables 原生 `dnat`/`masquerade`，高性能四层转发

---

## 环境要求

| 组件 | 测试环境 | 生产环境 |
|------|---------|---------|
| 操作系统 | Linux / macOS / Windows | **推荐 Linux** (Rocky Linux 9.x / Ubuntu 20.04+) |
| nftables | 0.9.8+ | 1.0+ |
| Go（仅 Go 部署） | 1.21+ | 1.21+ |
| Node.js（仅 Node 部署） | 22+ | 22+ LTS |
| 内存 | 512 MB | 1 GB+ |
| 磁盘 | 1 GB | 10 GB（含日志与备份） |

**前置条件**：服务器需预装 nftables，且服务运行用户需有 root 权限（写入 nftables 规则）。

```bash
# 确认 nftables 已安装并可执行
nft --version
```

---

## 快速开始（测试环境）

### Go 方式

```bash
# 1. 克隆代码
cd nginx-port-forwarder

# 2. 构建
go build -o nftables-port-forwarder main.go

# 3. 启动（默认账号 admin / 密码 Ruichi@2026.com）
sudo ./nftables-port-forwarder -u admin -p yourpassword

# 4. 访问
# 浏览器打开 http://localhost:3000
```

> 首次启动会自动执行 7 步初始化：安装 nftables → 加载内核模块 → 优化内核参数 → 检测网卡 → 配置 firewalld → 刷写初始规则 → 验证连通性。

### Node.js 方式

```bash
# 1. 安装依赖
npm install

# 2. 启动开发模式（Vite HMR + Express）
npm run dev

# 3. 或者构建后启动
npm run build
npm run start

# 4. 访问
# 浏览器打开 http://localhost:3000
```

---

## 生产环境部署

### 方式一：Go 二进制部署

适用于已有 Go 环境的场景，编译为单一二进制文件，无运行时依赖。

#### 1. 交叉编译

```bash
# 在开发机上编译目标平台的二进制文件
GOOS=linux GOARCH=amd64 go build -ldflags="-s -w" -o nftables-port-forwarder main.go
```

#### 2. 部署到服务器

```bash
# 上传到服务器
scp nftables-port-forwarder root@<server-ip>:/opt/nftables-port-forwarder/

# 同步数据目录（首次部署可跳过）
scp -r data/ root@<server-ip>:/opt/nftables-port-forwarder/
```

#### 3. 配置 systemd 服务

```bash
sudo tee /etc/systemd/system/nftables-port-forwarder.service << 'EOF'
[Unit]
Description=nftables Port Forwarder 管理服务
After=network.target nftables.service
Wants=nftables.service

[Service]
Type=simple
User=root
WorkingDirectory=/opt/nftables-port-forwarder
ExecStart=/opt/nftables-port-forwarder/nftables-port-forwarder -u admin -p YourSecurePassword
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

# 安全加固
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/opt/nftables-port-forwarder/data /tmp

[Install]
WantedBy=multi-user.target
EOF

# 启用并启动
sudo systemctl daemon-reload
sudo systemctl enable nftables-port-forwarder
sudo systemctl start nftables-port-forwarder
```

#### 4. 验证

```bash
sudo systemctl status nftables-port-forwarder
curl -s http://localhost:3000/api/system/status | jq .
```

### 方式二：Node.js 部署

适用于需要快速部署或已有 Node.js 环境的场景。

#### 1. 构建生产包

```bash
npm run build
# 产物: dist/ 目录
```

#### 2. 部署到服务器

```bash
scp -r dist/ package.json node_modules/ root@<server-ip>:/opt/nftables-port-forwarder/
scp -r data/ root@<server-ip>:/opt/nftables-port-forwarder/
```

#### 3. 配置 systemd 服务

```bash
sudo tee /etc/systemd/system/nftables-port-forwarder.service << 'EOF'
[Unit]
Description=nftables Port Forwarder 管理服务
After=network.target nftables.service
Wants=nftables.service

[Service]
Type=simple
User=root
WorkingDirectory=/opt/nftables-port-forwarder
ExecStart=/usr/bin/node dist/server.cjs
Restart=always
RestartSec=5
Environment=NODE_ENV=production
Environment=PORT=3000
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable nftables-port-forwarder
sudo systemctl start nftables-port-forwarder
```

### 方式三：Docker 部署

```dockerfile
# Dockerfile
FROM rockylinux:9

# 安装 nftables 和 Go 运行时
RUN dnf install -y nftables && dnf clean all

# 复制二进制与数据
COPY nftables-port-forwarder /opt/nftables-port-forwarder/
COPY data/ /opt/nftables-port-forwarder/data/

# 暴露端口
EXPOSE 3000

# 需要 NET_ADMIN 权限以操作 nftables
CMD ["/opt/nftables-port-forwarder/nftables-port-forwarder", "-u", "admin", "-p", "YourPassword"]
```

```bash
docker build -t nftables-port-forwarder .
docker run -d \
  --name nftables-port-forwarder \
  --network host \
  --cap-add=NET_ADMIN \
  -v /opt/nftables-port-forwarder/data:/opt/nftables-port-forwarder/data \
  nftables-port-forwarder
```

---

## 配置说明

### 管理账号

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| 用户名 | `admin` | 通过 `-u` 参数指定 |
| 密码 | `Ruichi@2026.com` | 通过 `-p` 参数指定 |

```bash
# Go 方式
./nftables-port-forwarder -u opsadmin -p Str0ng!P@ssw0rd

# Node.js 方式（需修改 server.ts 中的环境变量读取逻辑）
```

> **安全提醒**：生产环境务必修改默认密码！

### 监听端口

服务默认监听 **3000** 端口。修改方式：

- **Go**：未暴露参数，需修改源码 `main.go` 中的 `http.ListenAndServe`
- **Node.js**：设置环境变量 `PORT=8080`

### HTTPS / TLS

生产环境建议在前端加一层 Nginx 反向代理以启用 HTTPS：

```nginx
# /etc/nginx/sites-enabled/port-forwarder.conf
server {
    listen 443 ssl http2;
    server_name forwarder.your-domain.com;

    ssl_certificate     /etc/ssl/certs/your-cert.pem;
    ssl_certificate_key /etc/ssl/private/your-key.pem;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host:$server_port;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

---

## 功能指南

### 登录认证

1. 打开浏览器访问 `http://<server-ip>:3000`
2. 使用配置的管理员账号密码登录
3. 三种内置角色：Admin（全部权限）、Operator（规则管理）、Viewer（仅查看）

### 转发规则管理

**创建/编辑规则**：

| 字段 | 说明 | 示例 |
|------|------|------|
| 规则名称 | 便于识别的名称 | MySQL-测试库 |
| 监听端口 | 对外暴露的端口 (1-65535) | 3306 |
| 目标地址 | 后端服务的 IP 或域名 | 192.168.1.100 |
| 目标端口 | 后端服务的端口 | 3306 |
| 协议 | TCP / UDP 四层转发 | TCP |
| 启用状态 | 是否立即生效 | 是 |
| 绑定白名单组 | 选择 IP 访问控制组 | 内网白名单 |

**规则操作**：
- **启用/禁用**：一键开关，无需删除规则，变更后自动热重载
- **编辑**：修改任意参数后自动热重载使规则生效
- **复制**：快速创建相似规则的副本
- **删除**：永久删除规则，自动热重载移除对应 nftables 规则

**翻页功能**：规则过多时页面固定高度、表格内部滚动，底部提供分页控件（5/10/20 条每页）。

### 白名单组管理

白名单组用于统一管理 IP 访问控制。系统使用 **nftables 命名集合 (Named Sets)** 优化白名单，同一组的 IP 列表只在规则中定义一次，多条规则通过 `@setname` 引用，避免重复。

#### IP 白名单优先级（三级）

```
优先级 1：绑定白名单组 → ip saddr @whitelist_<groupId>
优先级 2：自动去重集合 → ip saddr @auto_wl_set_001（≥2 条规则共享相同 IP 时自动生成）
优先级 3：内联匿名集合 → ip saddr { ip1, ip2, ... }（单条规则独有 IP）
```

**创建白名单组**：

1. 左侧导航点击「白名单组管理」
2. 点击「新建白名单组」
3. 填写组名称、描述和 IP 列表

**IP 格式支持**：

```
# 单个 IP
192.168.1.100

# 多个 IP（逗号、空格、分号、换行分隔均可）
192.168.1.100, 192.168.1.101
10.0.0.5 10.0.0.6
172.16.0.1;172.16.0.2

# CIDR 网段
10.0.0.0/8
192.168.0.0/16
172.16.0.0/12

# 混合格式
192.168.1.100, 10.0.0.0/8, 172.16.0.5
```

**绑定规则与自动同步**：
- 创建/编辑转发规则时，在「绑定白名单组」下拉框中选择
- 选择"不限制"则所有 IP 均可访问
- **白名单组 IP 更新后，所有绑定该组的规则自动同步 AllowedIPs，并自动热重载生效**

### nftables 规则预览

点击规则表格顶部工具栏的「规则预览」按钮，可查看即将应用到内核的完整 nftables 配置文本：

```
# nftables port forwarding rules
# Generated: 2026-07-24T16:32:00+08:00
# Managed by Port Forwarder (nftables mode)

flush ruleset

table ip port_forwarder {
    # 自动去重：7 条规则共享此 IP 列表
    set auto_wl_set_000 {
        type ipv4_addr
        flags interval
        elements = { 113.89.32.229, 113.89.33.249, 43.162.112.236 }
    }

    chain prerouting {
        type nat hook prerouting priority dstnat; policy accept;

        ip saddr @auto_wl_set_000 tcp dport 8080 dnat to 192.168.1.100:8080
        ip saddr @auto_wl_set_000 tcp dport 8081 dnat to 43.156.44.91:8848
        ...
    }

    chain postrouting {
        type nat hook postrouting priority srcnat; policy accept;
        ct status dnat masquerade
    }
}
```

### 自动热重载机制

**无需手动操作**，以下操作完成后系统自动执行 `nft -f` 刷写 nftables 规则：

| 操作 | 触发条件 |
|------|---------|
| 新建规则 | 规则通过服务端校验并保存后 |
| 编辑规则 | 修改任意参数保存后 |
| 删除规则 | 确认删除后 |
| 启用/禁用规则 | 切换开关后 |
| 复制规则 | 副本创建后 |
| 白名单组更新 | IP 列表修改保存后（同步更新绑定规则再重载） |
| 白名单组删除 | 删除后（移除命名集合引用） |

重载前服务端执行严格校验（端口范围、IP 格式、协议合法性），只有校验通过才会保存并热重载，确保不会写入无效规则到内核。

### 配置版本回滚

每次热重载前系统自动创建配置快照版本，包含完整规则数据。

1. 点击「配置版本管理」
2. 选择目标版本
3. 点击「回滚」→ 规则数据恢复至该版本
4. 系统自动热重载使回滚版本生效

### 端口状态检测

「端口检测」功能可实时检查各监听端口是否正常响应：
- 🟢 绿色：端口正常监听
- 🔴 红色：端口无法连接
- 支持一键检测全部端口、按需重新检测

---

## API 参考

### 认证

```
POST /api/auth/login
Body: { "username": "admin", "password": "xxx" }
Response: { "success": true, "user": { ... } }
```

### 转发规则

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/rules` | 获取所有规则 |
| POST | `/api/rules` | 创建规则 |
| PUT | `/api/rules/:id` | 更新规则 |
| DELETE | `/api/rules/:id` | 删除规则 |

### 白名单组

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/whitelist-groups` | 获取所有组 |
| POST | `/api/whitelist-groups` | 创建组 |
| PUT | `/api/whitelist-groups/:id` | 更新组（自动同步绑定规则的 AllowedIPs） |
| DELETE | `/api/whitelist-groups/:id` | 删除组 |

### nftables 管理

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/nftables/preview` | 获取 nftables 规则预览（不应用） |
| POST | `/api/nftables/reload` | 热重载：创建版本快照后执行 `nft -f` |

### 版本管理

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/versions` | 获取版本列表 |
| POST | `/api/versions/rollback` | 回滚到指定版本 |

### 端口检测

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/ports/status` | 获取已缓存端口状态 |
| GET | `/api/ports/check-all` | 重新检测全部端口 |

### 系统

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/system/status` | 系统状态（nftables 运行状态、CPU/内存） |
| GET | `/api/system/init-logs` | 获取 7 步初始化日志 |
| POST | `/api/system/reset` | 一键重置规则与日志 |
| GET | `/api/settings` | 获取当前设置（本地 IP、域名） |
| POST | `/api/settings` | 更新固化设置 |
| GET | `/api/logs` | 获取审计日志 |
| GET | `/api/users` | 获取用户列表 |

### WebSocket

```
ws://<host>:3000/ws
事件类型：
  update:rules        - 规则列表变更
  update:versions     - 版本列表变更
  update:logs         - 审计日志更新
```

---

## 日常运维

### 启动 / 停止 / 重启

```bash
# systemd 管理
sudo systemctl start nftables-port-forwarder    # 启动
sudo systemctl stop nftables-port-forwarder     # 停止
sudo systemctl restart nftables-port-forwarder  # 重启
sudo systemctl status nftables-port-forwarder   # 查看状态
```

### 日志查看

```bash
# systemd 日志
journalctl -u nftables-port-forwarder -f            # 实时跟踪
journalctl -u nftables-port-forwarder -n 100        # 最近 100 条
journalctl -u nftables-port-forwarder --since "1 hour ago"  # 按时间筛选

# nftables 当前规则
nft list ruleset                                    # 查看全部内核规则
nft list table ip port_forwarder                    # 仅查看转发规则表

# 应用级审计日志
cat data/logs.json | jq .
```

### 备份与恢复

**数据目录备份**：

```bash
# 备份规则、白名单组、版本快照、审计日志
tar -czf backup-$(date +%Y%m%d).tar.gz data/

# 结合 cron 定期备份（每日凌晨 2 点）
0 2 * * * tar -czf /backup/nftables-pf-$(date +\%Y\%m\%d).tar.gz /opt/nftables-port-forwarder/data/
```

**恢复**：

```bash
# 1. 停止服务
sudo systemctl stop nftables-port-forwarder

# 2. 恢复数据
tar -xzf backup-20260724.tar.gz -C /opt/nftables-port-forwarder/

# 3. 启动服务
sudo systemctl start nftables-port-forwarder

# 4. 服务启动后自动初始化 nftables 规则
```

**nftables 规则备份**：

```bash
# 导出当前内核规则
nft list ruleset > nftables-backup-$(date +%Y%m%d).nft
```

### 健康检查

```bash
# 1. 服务进程是否存活
systemctl is-active nftables-port-forwarder

# 2. 端口是否监听
ss -tlnp | grep 3000

# 3. API 健康检查
curl -s http://localhost:3000/api/system/status | jq .

# 4. nftables 状态
nft list table ip port_forwarder   # 确认规则表存在
```

---

## 故障排查

### 问题：服务无法启动

```bash
# 检查端口占用
ss -tlnp | grep 3000

# 检查 systemd 日志
journalctl -u nftables-port-forwarder -xe

# 检查数据文件是否损坏
ls -la data/
cat data/rules.json | python3 -m json.tool > /dev/null || echo "JSON 格式错误"

# 检查 nftables 是否安装
nft --version
```

### 问题：热重载失败

```bash
# 1. 检查 nftables 语法
nft -c -f /tmp/port_forwarder.nft

# 2. 手动刷写测试
nft -f /tmp/port_forwarder.nft

# 3. 查看管理界面审计日志
# 「操作日志」选项卡 → 查看最近的重载记录

# 4. 查看服务初始化日志
curl -s http://localhost:3000/api/system/init-logs | jq .
```

### 问题：转发规则不生效

```bash
# 1. 确认规则已启用
# 管理界面检查「启用」切换开关

# 2. 确认 nftables 规则已写入
nft list table ip port_forwarder | grep "dnat"

# 3. 检查内核 IP 转发是否开启
sysctl net.ipv4.ip_forward

# 4. 确认监听端口未被占用
ss -tlnp | grep <监听端口>

# 5. 测试目标服务是否可达
nc -zv <目标IP> <目标端口>

# 6. 检查 conntrack 表（查看当前 NAT 连接）
conntrack -L -p tcp --dport <监听端口>
```

### 问题：白名单不生效

```bash
# 1. 确认规则已绑定白名单组
# 编辑规则 → 查看「绑定白名单组」字段

# 2. 确认白名单组 IP 格式正确（不支持域名，仅支持 IP/CIDR）

# 3. 查看生成的 nftables 配置中是否包含命名集合引用
curl -s http://localhost:3000/api/nftables/preview | grep -E "set whitelist|set auto_wl"

# 4. 确认规则中使用了命名集合引用
nft list table ip port_forwarder | grep "saddr @"
```

### 问题：多条规则 IP 列表重复

系统已内置**自动去重**机制：当 ≥2 条启用规则共享完全相同的 `allowedIps` 时，会自动生成 `auto_wl_set_NNN` 命名集合，规则中统一引用该集合名。建议将共享相同 IP 列表的规则绑定到同一白名单组以获得最佳管理体验。

### 问题：数据文件损坏

```bash
# 恢复最近的备份
sudo systemctl stop nftables-port-forwarder
tar -xzf /backup/nftables-pf-20260724.tar.gz -C /opt/nftables-port-forwarder/
sudo systemctl start nftables-port-forwarder

# 如无备份，可以手动修复 JSON 文件
vim data/rules.json
```

### 问题：服务器重启后规则丢失

nftables 规则存储在内存中，重启后需重新加载。本服务通过 systemd 管理，设置 `Wants=nftables.service`，服务启动时会自动执行 7 步初始化并刷写规则。

```bash
# 手动恢复
sudo systemctl restart nftables-port-forwarder
```

---

## 安全建议

1. **修改默认密码**：首次部署后立即通过 `-u` / `-p` 参数更改管理员凭证
2. **启用 HTTPS**：生产环境务必使用 Nginx 反向代理 + TLS 证书
3. **防火墙规则**：管理界面端口（3000）建议仅对运维内网开放
   ```bash
   sudo nft add rule inet filter input tcp dport 3000 ip saddr 192.168.1.0/24 accept
   sudo nft add rule inet filter input tcp dport 3000 drop
   ```
4. **文件权限**：数据目录设置合适权限
   ```bash
   chmod 700 /opt/nftables-port-forwarder/data
   ```
5. **定期备份**：配置 cron 定时任务备份 `data/` 目录
6. **审计日志**：定期检查操作日志，发现异常登录及时处理
7. **内核参数**：系统启动时自动优化（ip_forward、conntrack 等），无需手动配置
