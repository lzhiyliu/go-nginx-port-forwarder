# Nginx Port Forwarder 运维配置手册

基于 Nginx 的可视化端口转发管理控制台，支持转发规则配置、白名单访问控制、配置热重载、审计日志及版本回滚。

---

## 目录

- [系统架构](#系统架构)
- [环境要求](#环境要求)
- [快速开始（测试环境）](#快速开始测试环境)
- [生产环境部署](#生产环境部署)
  - [方式一：Go 二进制部署](#方式一go-二进制部署)
  - [方式二：Node.js 部署](#方式二nodejs-部署)
  - [方式三：Docker 部署](#方式三docker-部署-recommend)
- [配置说明](#配置说明)
  - [管理账号](#管理账号)
  - [监听端口](#监听端口)
  - [HTTPS / TLS](#https--tls)
- [功能指南](#功能指南)
  - [登录认证](#登录认证)
  - [转发规则管理](#转发规则管理)
  - [白名单组管理](#白名单组管理)
  - [Nginx 配置管理](#nginx-配置管理)
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
│   Nginx Port Forwarder 控制服务               │
│   (Go 二进制 / Node.js Express)               │
│   ├─ 端口转发规则 CRUD                        │
│   ├─ 白名单组管理                              │
│   ├─ Nginx 配置生成与热重载                    │
│   ├─ 版本快照与回滚                            │
│   └─ 审计日志                                 │
└──────────────────┬───────────────────────────┘
                   │ 生成 nginx 配置
┌──────────────────▼───────────────────────────┐
│                 Nginx 引擎                     │
│   /etc/nginx/conf.d/port_forward_http.conf    │
│   /etc/nginx/stream.d/port_forward_stream.conf│
└──────────────────────────────────────────────┘
```

- **前端**：React 19 + TypeScript + Tailwind CSS，内嵌于后端服务
- **后端（二选一）**：
  - Go 二进制：编译为单一文件，无运行时依赖
  - Node.js：Express + TypeScript，需 Node.js 22+
- **数据持久化**：JSON 文件（`data/` 目录）
- **实时推送**：WebSocket，规则变更即时同步所有客户端

---

## 环境要求

| 组件 | 测试环境 | 生产环境 |
|------|---------|---------|
| 操作系统 | Linux / macOS / Windows | **推荐 Linux** (Ubuntu 20.04+ / CentOS 7+) |
| Nginx | 1.18+ | 1.24+ |
| Go（仅 Go 部署） | 1.21+ | 1.21+ |
| Node.js（仅 Node 部署） | 22+ | 22+ LTS |
| 内存 | 512 MB | 1 GB+ |
| 磁盘 | 1 GB | 10 GB（含日志与备份） |

**前置条件**：服务器需预装 Nginx，且服务运行用户需有 `/etc/nginx/` 目录写入权限。

```bash
# 确认 Nginx 已安装并可执行
nginx -v
```

---

## 快速开始（测试环境）

### Go 方式

```bash
# 1. 克隆代码
cd nginx-port-forwarder

# 2. 构建
go build -o nginx-port-forwarder main.go

# 3. 启动（默认账号 admin / 密码 Ruichi@2026.com）
sudo ./nginx-port-forwarder -u admin -p yourpassword

# 4. 访问
# 浏览器打开 http://localhost:3000
```

### Node.js 方式

```bash
# 1. 安装依赖
npm install

# 2. 启动开发模式
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
GOOS=linux GOARCH=amd64 go build -ldflags="-s -w" -o nginx-port-forwarder main.go
```

#### 2. 部署到服务器

```bash
# 上传到服务器
scp nginx-port-forwarder root@<server-ip>:/opt/nginx-port-forwarder/

# 同步数据目录（首次部署可跳过）
scp -r data/ root@<server-ip>:/opt/nginx-port-forwarder/
```

#### 3. 配置 systemd 服务

```bash
sudo tee /etc/systemd/system/nginx-port-forwarder.service << 'EOF'
[Unit]
Description=Nginx Port Forwarder 管理服务
After=network.target nginx.service
Wants=nginx.service

[Service]
Type=simple
User=root
WorkingDirectory=/opt/nginx-port-forwarder
ExecStart=/opt/nginx-port-forwarder/nginx-port-forwarder -u admin -p YourSecurePassword
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

# 安全加固
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/opt/nginx-port-forwarder/data /etc/nginx/conf.d /etc/nginx/stream.d
ReadOnlyPaths=/etc/nginx/nginx.conf

[Install]
WantedBy=multi-user.target
EOF

# 启用并启动
sudo systemctl daemon-reload
sudo systemctl enable nginx-port-forwarder
sudo systemctl start nginx-port-forwarder
```

#### 4. 验证

```bash
sudo systemctl status nginx-port-forwarder
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
scp -r dist/ package.json node_modules/ root@<server-ip>:/opt/nginx-port-forwarder/
scp -r data/ root@<server-ip>:/opt/nginx-port-forwarder/
```

#### 3. 配置 systemd 服务

```bash
sudo tee /etc/systemd/system/nginx-port-forwarder.service << 'EOF'
[Unit]
Description=Nginx Port Forwarder 管理服务
After=network.target nginx.service
Wants=nginx.service

[Service]
Type=simple
User=root
WorkingDirectory=/opt/nginx-port-forwarder
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
sudo systemctl enable nginx-port-forwarder
sudo systemctl start nginx-port-forwarder
```

### 方式三：Docker 部署（recommend）

```dockerfile
# Dockerfile
FROM nginx:1.24-alpine

# 安装 Go 运行时环境（如果使用 Go 方式）
# 或者安装 Node.js 运行时

# 复制 Nginx Port Forwarder 二进制
COPY nginx-port-forwarder /opt/nginx-port-forwarder/
COPY data/ /opt/nginx-port-forwarder/data/

# 暴露端口
EXPOSE 3000

# 确保 Nginx 目录可写
RUN mkdir -p /etc/nginx/conf.d /etc/nginx/stream.d

CMD ["/opt/nginx-port-forwarder/nginx-port-forwarder", "-u", "admin", "-p", "YourPassword"]
```

```bash
docker build -t nginx-port-forwarder .
docker run -d \
  --name nginx-port-forwarder \
  --network host \
  -v /opt/nginx-port-forwarder/data:/opt/nginx-port-forwarder/data \
  -v /etc/nginx/conf.d:/etc/nginx/conf.d \
  -v /etc/nginx/stream.d:/etc/nginx/stream.d \
  nginx-port-forwarder
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
./nginx-port-forwarder -u opsadmin -p Str0ng!P@ssw0rd

# Node.js 方式（server.ts 中硬编码，生产环境建议通过环境变量传入）
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
3. 登录后 30 分钟无操作自动退出

### 转发规则管理

**创建规则**：

| 字段 | 说明 | 示例 |
|------|------|------|
| 规则名称 | 便于识别的名称 | MySQL-测试库 |
| 监听端口 | 对外暴露的端口 (1-65535) | 3306 |
| 目标地址 | 后端服务的 IP 或域名 | 192.168.1.100 |
| 目标端口 | 后端服务的端口 | 3306 |
| 协议 | HTTP 或 TCP Stream | TCP |
| URL 路径后缀 | HTTP 模式下追加的路径 | api/v1 |
| 启用状态 | 是否立即生效 | 是 |
| 绑定白名单组 | 选择 IP 访问控制组 | 内网白名单 |

**规则操作**：
- **启用/禁用**：一键开关，无需删除规则
- **编辑**：修改任意参数后自动更新 Nginx 配置
- **复制**：快速创建相似规则
- **删除**：永久删除规则及对应 Nginx 配置

### 白名单组管理

白名单组用于统一管理 IP 访问控制，绑定到规则的组更新后，所有关联规则自动同步。

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

**绑定规则**：
- 创建/编辑转发规则时，在「绑定白名单组」下拉框中选择
- 选择"不限制"则所有 IP 均可访问
- **白名单组 IP 更新后，绑定的规则自动同步，无需手动修改**

### Nginx 配置管理

**查看配置预览**：
- 点击「Nginx 配置预览」查看即将生成的配置
- 按规则分组展示 HTTP 和 Stream 两个层级的配置

**热重载操作步骤**：

1. 点击「Nginx 配置预览」→ 确认配置正确
2. 点击「固化并更新系统设置」→ 将配置写入 `/etc/nginx/`
3. 服务自动执行 `nginx -t` 检查语法
4. 检查通过后执行 `nginx -s reload` 热重载
5. 重载结果在页面顶部显示

> **注意**：热重载不影响现有连接，Nginx 会优雅地关闭旧 worker 进程。

### 配置版本回滚

每次热重载前系统自动创建配置快照版本，包含完整规则数据。

1. 点击「配置版本管理」
2. 选择目标版本
3. 点击「回滚」→ 规则数据恢复至该版本
4. 执行热重载使回滚版本生效

### 端口状态检测

「端口检测」功能可实时检查各监听端口是否正常响应：
- 🟢 绿色：端口正常监听
- 🔴 红色：端口无法连接
- 支持一键检测全部端口

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
| PUT | `/api/whitelist-groups/:id` | 更新组（自动同步绑定规则） |
| DELETE | `/api/whitelist-groups/:id` | 删除组 |

### Nginx 管理

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/nginx/preview` | 获取配置预览 |
| POST | `/api/nginx/reload` | 热重载并创建版本快照 |

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
| GET | `/api/system/status` | 系统状态信息 |
| GET | `/api/settings` | 获取当前设置 |
| POST | `/api/settings` | 更新固化设置 |
| POST | `/api/system/reset` | 一键重置规则与日志 |

### WebSocket

```
ws://<host>:3000/ws
事件类型：
  update:rules      - 规则列表变更
  update:versions   - 版本列表变更
  update:logs       - 审计日志更新
```

---

## 日常运维

### 启动 / 停止 / 重启

```bash
# systemd 管理
sudo systemctl start nginx-port-forwarder    # 启动
sudo systemctl stop nginx-port-forwarder     # 停止
sudo systemctl restart nginx-port-forwarder  # 重启
sudo systemctl status nginx-port-forwarder   # 查看状态
```

### 日志查看

```bash
# systemd 日志
journalctl -u nginx-port-forwarder -f         # 实时跟踪
journalctl -u nginx-port-forwarder -n 100     # 最近 100 条
journalctl -u nginx-port-forwarder --since "1 hour ago"  # 按时间筛选

# Nginx 日志
tail -f /var/log/nginx/access.log             # 访问日志
tail -f /var/log/nginx/error.log              # 错误日志

# 应用级审计日志
# 在管理界面「操作日志」选项卡中查看
cat data/logs.json | jq .
```

### 备份与恢复

**数据目录备份**：

```bash
# 备份规则、白名单组、版本快照、审计日志
tar -czf backup-$(date +%Y%m%d).tar.gz data/

# 结合 cron 定期备份（每日凌晨 2 点）
0 2 * * * tar -czf /backup/nginx-pf-$(date +\%Y\%m\%d).tar.gz /opt/nginx-port-forwarder/data/
```

**恢复**：

```bash
# 1. 停止服务
sudo systemctl stop nginx-port-forwarder

# 2. 恢复数据
tar -xzf backup-20260724.tar.gz -C /opt/nginx-port-forwarder/

# 3. 启动服务
sudo systemctl start nginx-port-forwarder

# 4. 在管理界面执行热重载使规则生效
```

**Nginx 配置备份**：

```bash
# 备份当前生效的 Nginx 配置
cp /etc/nginx/conf.d/port_forward_http.conf /etc/nginx/conf.d/port_forward_http.conf.bak.$(date +%Y%m%d)
cp /etc/nginx/stream.d/port_forward_stream.conf /etc/nginx/stream.d/port_forward_stream.conf.bak.$(date +%Y%m%d)
```

### 健康检查

```bash
# 1. 服务进程是否存活
systemctl is-active nginx-port-forwarder

# 2. 端口是否监听
ss -tlnp | grep 3000

# 3. API 健康检查
curl -s http://localhost:3000/api/system/status | jq .

# 4. Nginx 状态
nginx -t                          # 配置语法检查
systemctl status nginx            # Nginx 进程状态
```

---

## 故障排查

### 问题：服务无法启动

```bash
# 检查端口占用
ss -tlnp | grep 3000

# 检查 systemd 日志
journalctl -u nginx-port-forwarder -xe

# 检查数据文件是否损坏
ls -la data/
cat data/rules.json | python3 -m json.tool > /dev/null || echo "JSON 格式错误"
```

### 问题：热重载失败

```bash
# 1. 检查 Nginx 语法
nginx -t

# 2. 检查配置文件是否正常生成
cat /etc/nginx/conf.d/port_forward_http.conf

# 3. 检查目录权限
ls -la /etc/nginx/conf.d/
ls -la /etc/nginx/stream.d/

# 4. 手动重载
nginx -s reload
```

### 问题：转发规则不生效

```bash
# 1. 确认规则已启用
# 管理界面检查「启用」开关状态

# 2. 确认 Nginx 已重载
# 每次修改规则后需执行热重载

# 3. 确认监听端口未被占用
ss -tlnp | grep <监听端口>

# 4. 测试目标服务是否可达
curl -v telnet://<目标IP>:<目标端口>

# 5. 检查防火墙规则
sudo iptables -L -n | grep <端口>
```

### 问题：白名单不生效

```bash
# 1. 确认规则已绑定白名单组
# 编辑规则 → 查看「绑定白名单组」字段

# 2. 确认白名单组 IP 格式正确（不支持域名）

# 3. 查看生成的 Nginx 配置中是否包含 allow/deny 指令
grep -A5 "allow\|deny" /etc/nginx/conf.d/port_forward_http.conf
```

### 问题：数据文件损坏

```bash
# 恢复最近的备份
sudo systemctl stop nginx-port-forwarder
tar -xzf /backup/nginx-pf-20260724.tar.gz -C /opt/nginx-port-forwarder/
sudo systemctl start nginx-port-forwarder

# 如无备份，可以手动修复 JSON 文件
vim data/rules.json
```

### 问题：内存占用过高

```bash
# 查看进程内存
ps aux | grep nginx-port-forwarder

# 如系规则数量过多引起，考虑优化：
# - 合并相似规则
# - 禁用不常用规则而非保留大量启用规则
# - 定期清理历史版本和审计日志
```

---

## 安全建议

1. **修改默认密码**：首次部署后立即通过 `-u` / `-p` 参数更改管理员凭证
2. **启用 HTTPS**：生产环境务必使用 Nginx 反向代理 + TLS 证书
3. **防火墙规则**：管理界面端口（3000）建议仅对运维内网开放
   ```bash
   sudo iptables -A INPUT -p tcp --dport 3000 -s 192.168.1.0/24 -j ACCEPT
   sudo iptables -A INPUT -p tcp --dport 3000 -j DROP
   ```
4. **文件权限**：数据目录和 Nginx 配置文件设置合适权限
   ```bash
   chmod 700 /opt/nginx-port-forwarder/data
   chmod 644 /etc/nginx/conf.d/port_forward_*.conf
   ```
5. **定期备份**：配置 cron 定时任务备份 `data/` 目录
6. **审计日志**：定期检查操作日志，发现异常登录及时处理
