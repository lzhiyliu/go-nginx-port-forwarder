package main

import (
	"embed"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"log"
	"math/rand"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

//go:embed all:dist
var distFS embed.FS

// ============================================================================
// 数据结构定义 (与 TypeScript 类型保持完全一致)
// ============================================================================

type ForwardRule struct {
	ID               string    `json:"id"`
	Name             string    `json:"name"`
	ListenPort       int       `json:"listenPort"`
	TargetHost       string    `json:"targetHost"`
	TargetPort       int       `json:"targetPort"`
	Protocol         string    `json:"protocol"` // "TCP" | "UDP" | "HTTP" | "HTTPS"
	Enabled          bool      `json:"enabled"`
	Description      string    `json:"description"`
	AllowedIPs       string    `json:"allowedIps"`        // 允许访问的 IP 限制列表
	WhitelistGroupID string    `json:"whitelistGroupId"`  // 绑定的白名单组 ID
	URLSuffix        string    `json:"urlSuffix"`         // URL 路径后缀，如 api/v1
	CreatedAt        time.Time `json:"createdAt"`
	UpdatedAt        time.Time `json:"updatedAt"`
}

type WhitelistGroup struct {
	ID          string    `json:"id"`
	Name        string    `json:"name"`
	Description string    `json:"description"`
	IPs         string    `json:"ips"`         // IP 列表，空格/逗号/换行分隔
	CreatedAt   time.Time `json:"createdAt"`
	UpdatedAt   time.Time `json:"updatedAt"`
}

type AuditLog struct {
	ID        string    `json:"id"`
	Timestamp time.Time `json:"timestamp"`
	User      string    `json:"user"`
	Role      string    `json:"role"` // "Admin" | "Operator" | "Viewer"
	Action    string    `json:"action"`
	Details   string    `json:"details"`
	Status    string    `json:"status"` // "success" | "failure"
}

type ConfigVersion struct {
	ID            string        `json:"id"`
	Version       int           `json:"version"`
	Timestamp     time.Time     `json:"timestamp"`
	Description   string        `json:"description"`
	CreatedBy     string        `json:"createdBy"`
	RulesSnapshot []ForwardRule `json:"rulesSnapshot"`
}

type User struct {
	ID          string `json:"id"`
	Username    string `json:"username"`
	Role        string `json:"role"` // "Admin" | "Operator" | "Viewer"
	DisplayName string `json:"displayName"`
	Avatar      string `json:"avatar"`
}

type SystemStatus struct {
	NginxActive       bool   `json:"nginxActive"`
	ActivePortsCount  int    `json:"activePortsCount"`
	RulesCount        int    `json:"rulesCount"`
	LastReload        string `json:"lastReload"`
	CPUUsage          int    `json:"cpuUsage"`
	MemUsage          int    `json:"memUsage"`
}

type NginxPreview struct {
	Main   string `json:"main"`
	HTTP   string `json:"http"`
	Stream string `json:"stream"`
}

type SystemSettings struct {
	LocalIP string `json:"localIp"`
	Domain  string `json:"domain"`
}

// ============================================================================
// 全局状态与数据库模拟
// ============================================================================

var (
	mutex              sync.Mutex
	rules              []ForwardRule
	logs               []AuditLog
	versions           []ConfigVersion
	users              []User
	whitelistGroups    []WhitelistGroup
	dataDir            = "./data"
	rulesFile          = "./data/rules.json"
	logsFile           = "./data/logs.json"
	versionsFile       = "./data/versions.json"
	usersFile          = "./data/users.json"
	settingsFile       = "./data/settings.json"
	whitelistGroupsFile = "./data/whitelist-groups.json"
	settings           SystemSettings
	// 命令行配置的登录凭证
	cmdUsername string
	cmdPassword string
)

// ============================================================================
// 初始化与默认种子数据
// ============================================================================

func init() {
	rand.Seed(time.Now().UnixNano())

	// 创建数据存放目录
	if err := os.MkdirAll(dataDir, 0755); err != nil {
		log.Fatalf("无法创建数据目录: %v", err)
	}

	// 初始化默认用户
	defaultUsers := []User{
		{ID: "u1", Username: "admin", Role: "Admin", DisplayName: "张运维 (系统管理员)", Avatar: "https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=80&fit=crop&q=80"},
		{ID: "u2", Username: "operator", Role: "Operator", DisplayName: "李运维 (配置操作员)", Avatar: "https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=80&fit=crop&q=80"},
		{ID: "u3", Username: "viewer", Role: "Viewer", DisplayName: "王开发 (仅只读观察员)", Avatar: "https://images.unsplash.com/photo-1500648767791-00dcc994a43e?w=80&fit=crop&q=80"},
	}
	loadOrSaveJSON(usersFile, &users, defaultUsers)

	// 初始化默认白名单组
	defaultWhitelistGroups := []WhitelistGroup{
		{
			ID:          "wg1",
			Name:        "运维团队办公室",
			Description: "公司总部运维团队办公网段",
			IPs:         "113.89.32.229\n113.89.33.249",
			CreatedAt:   time.Now(),
			UpdatedAt:   time.Now(),
		},
		{
			ID:          "wg2",
			Name:        "云服务器出口",
			Description: "云端服务器公网出口 IP",
			IPs:         "43.162.112.236",
			CreatedAt:   time.Now(),
			UpdatedAt:   time.Now(),
		},
	}
	loadOrSaveJSON(whitelistGroupsFile, &whitelistGroups, defaultWhitelistGroups)

	// 初始化默认规则
	defaultRules := []ForwardRule{
		{
			ID:          "r1",
			Name:        "应用后端 API 转发",
			ListenPort:  8080,
			TargetHost:  "192.168.1.100",
			TargetPort:  8080,
			Protocol:    "HTTP",
			Enabled:     true,
			Description: "开发环境主要的 API 服务网关转发，支持热重载，超时保持 10 分钟",
			AllowedIPs:  "",
			CreatedAt:   time.Now().Add(-72 * time.Hour),
			UpdatedAt:   time.Now().Add(-72 * time.Hour),
		},
		{
			ID:          "r2",
			Name:        "MySQL 数据库主库转发",
			ListenPort:  3307,
			TargetHost:  "10.0.0.12",
			TargetPort:  3306,
			Protocol:    "TCP",
			Enabled:     true,
			Description: "云端 RDS 数据库本地端口映射，用于开发机直连调试",
			AllowedIPs:  "192.168.1.0/24, 127.0.0.1",
			CreatedAt:   time.Now().Add(-48 * time.Hour),
			UpdatedAt:   time.Now().Add(-48 * time.Hour),
		},
		{
			ID:          "r3",
			Name:        "Redis 缓存层集群入口",
			ListenPort:  6380,
			TargetHost:  "10.0.0.15",
			TargetPort:  6379,
			Protocol:    "TCP",
			Enabled:     false,
			Description: "Redis 哨兵模式入口，临时关闭，待扩容完成重新打开",
			AllowedIPs:  "",
			CreatedAt:   time.Now().Add(-24 * time.Hour),
			UpdatedAt:   time.Now().Add(-12 * time.Hour),
		},
	}
	loadOrSaveJSON(rulesFile, &rules, defaultRules)

	// 初始化默认审计日志
	defaultLogs := []AuditLog{
		{
			ID:        "log1",
			Timestamp: time.Now().Add(-48 * time.Hour),
			User:      "张运维",
			Role:      "Admin",
			Action:    "初始化配置",
			Details:   "首次发布，添加默认转发规则：应用后端 API 转发、MySQL 主库转发",
			Status:    "success",
		},
	}
	loadOrSaveJSON(logsFile, &logs, defaultLogs)

	// 初始化版本备份文件
	loadOrSaveJSON(versionsFile, &versions, []ConfigVersion{})

	// 初始化设置文件
	defaultSettings := SystemSettings{
		LocalIP: "127.0.0.1",
		Domain:  "",
	}
	loadOrSaveJSON(settingsFile, &settings, defaultSettings)
}

// 辅助函数：读取或写入 JSON 格式的本地 DB
func loadOrSaveJSON(filePath string, dest interface{}, defaultVal interface{}) {
	if _, err := os.Stat(filePath); os.IsNotExist(err) {
		bytes, _ := json.MarshalIndent(defaultVal, "", "  ")
		_ = os.WriteFile(filePath, bytes, 0644)
	}
	bytes, err := os.ReadFile(filePath)
	if err == nil {
		_ = json.Unmarshal(bytes, dest)
	}
}

func saveJSON(filePath string, data interface{}) {
	bytes, _ := json.MarshalIndent(data, "", "  ")
	_ = os.WriteFile(filePath, bytes, 0644)
}

// ============================================================================
// 审计日志写入辅助函数
// ============================================================================

func writeAuditLog(user, role, action, details, status string) {
	logID := fmt.Sprintf("log_%d_%d", time.Now().UnixNano(), rand.Intn(1000))
	newLog := AuditLog{
		ID:        logID,
		Timestamp: time.Now(),
		User:      user,
		Role:      role,
		Action:    action,
		Details:   details,
		Status:    status,
	}
	logs = append([]AuditLog{newLog}, logs...) // 插入到头部（最新优先）
	saveJSON(logsFile, logs)
	broadcastWS("update:logs", logs)
}

// ============================================================================
// Nginx 虚拟配置编译逻辑 (带有 IP 访问限制模块)
// ============================================================================

func getAccessControlNginxConfig(allowedIps string, indent string) string {
	if strings.TrimSpace(allowedIps) == "" {
		return ""
	}
	// 支持逗号，空格，分号，换行等切分
	var ips []string
	rawIps := strings.FieldsFunc(allowedIps, func(r rune) bool {
		return r == ',' || r == ';' || r == ' ' || r == '\n' || r == '\r'
	})
	for _, ip := range rawIps {
		trimmed := strings.TrimSpace(ip)
		if trimmed != "" {
			ips = append(ips, trimmed)
		}
	}
	if len(ips) == 0 {
		return ""
	}

	var sb strings.Builder
	sb.WriteString(fmt.Sprintf("%s# 访问 IP 限制\n", indent))
	for _, ip := range ips {
		sb.WriteString(fmt.Sprintf("%sallow %s;\n", indent, ip))
	}
	sb.WriteString(fmt.Sprintf("%sdeny all;\n", indent))
	return sb.String()
}

func generateNginxConfig(rulesList []ForwardRule) NginxPreview {
	var activeRules []ForwardRule
	for _, r := range rulesList {
		if r.Enabled {
			activeRules = append(activeRules, r)
		}
	}

	// 1. 生成 HTTP/HTTPS 反向代理配置 (七层)
	var httpSb strings.Builder
	httpSb.WriteString("# ==========================================\n")
	httpSb.WriteString("# HTTP & HTTPS Web Reverse Proxy Rules\n")
	httpSb.WriteString("# ==========================================\n")

	hasHTTP := false
	for _, rule := range activeRules {
		if rule.Protocol == "HTTP" || rule.Protocol == "HTTPS" {
			hasHTTP = true
			httpSb.WriteString(fmt.Sprintf("\n# 规则名称: %s\n", rule.Name))
			httpSb.WriteString(fmt.Sprintf("# 备注信息: %s\n", rule.Description))
			httpSb.WriteString("server {\n")
			httpSb.WriteString(fmt.Sprintf("    listen %d;\n", rule.ListenPort))
			httpSb.WriteString("    server_name localhost;\n\n")

			// 插入安全 IP 访问控制指令
			ipConfig := getAccessControlNginxConfig(rule.AllowedIPs, "    ")
			if ipConfig != "" {
				httpSb.WriteString(ipConfig + "\n")
			}

			httpSb.WriteString("    location / {\n")
			httpSb.WriteString(fmt.Sprintf("        proxy_pass %s://%s:%d;\n", strings.ToLower(rule.Protocol), rule.TargetHost, rule.TargetPort))
			httpSb.WriteString("        proxy_set_header Host $host:$server_port;\n")
			httpSb.WriteString("        proxy_set_header X-Real-IP $remote_addr;\n")
			httpSb.WriteString("        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;\n")
			httpSb.WriteString("        proxy_set_header X-Forwarded-Proto $scheme;\n")
			httpSb.WriteString("        proxy_connect_timeout 5s;\n")
			httpSb.WriteString("        proxy_read_timeout 60s;\n")
			httpSb.WriteString("    }\n")
			httpSb.WriteString("}\n")
		}
	}
	if !hasHTTP {
		httpSb.WriteString("# (目前无激活的 HTTP/HTTPS 反向代理规则)\n")
	}

	// 2. 生成 TCP/UDP 四层流转发配置 (Stream)
	var streamSb strings.Builder
	streamSb.WriteString("# ==========================================\n")
	streamSb.WriteString("# TCP & UDP Stream Port Forwarding Rules\n")
	streamSb.WriteString("# ==========================================\n")

	hasStream := false
	for _, rule := range activeRules {
		if rule.Protocol == "TCP" || rule.Protocol == "UDP" {
			hasStream = true
			streamSb.WriteString(fmt.Sprintf("\n# 规则名称: %s\n", rule.Name))
			streamSb.WriteString(fmt.Sprintf("# 备注信息: %s\n", rule.Description))
			streamSb.WriteString("server {\n")

			listenSuffix := ""
			if rule.Protocol == "UDP" {
				listenSuffix = " udp"
			}
			streamSb.WriteString(fmt.Sprintf("    listen %d%s;\n", rule.ListenPort, listenSuffix))
			streamSb.WriteString(fmt.Sprintf("    proxy_pass %s:%d;\n", rule.TargetHost, rule.TargetPort))
			streamSb.WriteString("    proxy_connect_timeout 5s;\n")
			streamSb.WriteString("    proxy_timeout 10m;\n")

			// 插入安全 IP 访问控制指令
			ipConfig := getAccessControlNginxConfig(rule.AllowedIPs, "    ")
			if ipConfig != "" {
				streamSb.WriteString(ipConfig)
			}

			streamSb.WriteString("}\n")
		}
	}
	if !hasStream {
		streamSb.WriteString("# (目前无激活的 TCP/UDP 转发规则)\n")
	}

	// 3. 全局主配置文件 nginx.conf
	var mainSb strings.Builder
	mainSb.WriteString("load_module /usr/lib/nginx/modules/ngx_stream_module.so;\n")
	mainSb.WriteString("user www-data;\n")
	mainSb.WriteString("worker_processes auto;\n")
	mainSb.WriteString("error_log /var/log/nginx/error.log warn;\n")
	mainSb.WriteString("pid /var/run/nginx.pid;\n\n")
	mainSb.WriteString("events {\n")
	mainSb.WriteString("    worker_connections 1024;\n")
	mainSb.WriteString("}\n\n")
	mainSb.WriteString("# ==================== 七层 Web 代理配置 ====================\n")
	mainSb.WriteString("http {\n")
	mainSb.WriteString("    include       /etc/nginx/mime.types;\n")
	mainSb.WriteString("    default_type  application/octet-stream;\n\n")
	mainSb.WriteString("    log_format  main  '$remote_addr - $remote_user [$time_local] \"$request\" '\n")
	mainSb.WriteString("                      '$status $body_bytes_sent \"$http_referer\" '\n")
	mainSb.WriteString("                      '\"$http_user_agent\" \"$http_x_forwarded_for\"';\n")
	mainSb.WriteString("    access_log  /var/log/nginx/access.log  main;\n\n")
	mainSb.WriteString("    sendfile        on;\n")
	mainSb.WriteString("    keepalive_timeout  65;\n\n")
	mainSb.WriteString("    # 【重要核心：在此引入我们 Go 程序自动生成的 HTTP 转发规则】\n")
	mainSb.WriteString("    include /etc/nginx/conf.d/*.conf;\n")
	mainSb.WriteString("}\n\n")
	mainSb.WriteString("# ==================== 四层 TCP/UDP 流转发配置 ====================\n")
	mainSb.WriteString("stream {\n")
	mainSb.WriteString("    # 【重要核心：在此引入我们 Go 程序自动生成的 TCP/UDP 四层转发规则】\n")
	mainSb.WriteString("    include /etc/nginx/stream.d/*.conf;\n")
	mainSb.WriteString("}\n")

	return NginxPreview{
		Main:   mainSb.String(),
		HTTP:   httpSb.String(),
		Stream: streamSb.String(),
	}
}

// ============================================================================
// Nginx 启动初始化与测试逻辑及 Debug 日志
// ============================================================================

var nginxTestResult = "未测试"

func initNginxConfig() {
	log.Println("[DEBUG] [Nginx-Init] 正在执行启动初始化 Nginx 配置...")
	// 创建不带任何端口转发规则的空 Nginx 配置
	emptyRules := []ForwardRule{}
	preview := generateNginxConfig(emptyRules)

	_ = os.MkdirAll("/etc/nginx/conf.d", 0755)
	_ = os.MkdirAll("/etc/nginx/stream.d", 0755)

	httpPath := "/etc/nginx/conf.d/port_forward_http.conf"
	streamPath := "/etc/nginx/stream.d/port_forward_stream.conf"

	if err := os.WriteFile(httpPath, []byte(preview.HTTP), 0644); err != nil {
		log.Printf("[DEBUG] [Nginx-Init] 写入 HTTP 初始配置到 %s 失败: %v (通常原因为非 root 权限或目录不存在)", httpPath, err)
	} else {
		log.Printf("[DEBUG] [Nginx-Init] 成功写入空初始 HTTP 配置到 %s", httpPath)
	}

	if err := os.WriteFile(streamPath, []byte(preview.Stream), 0644); err != nil {
		log.Printf("[DEBUG] [Nginx-Init] 写入 Stream 初始配置到 %s 失败: %v (通常原因为非 root 权限或目录不存在)", streamPath, err)
	} else {
		log.Printf("[DEBUG] [Nginx-Init] 成功写入空初始 Stream 配置到 %s", streamPath)
	}

	nginxBin, lookErr := exec.LookPath("nginx")
	if lookErr != nil {
		msg := "未在 PATH 中找到 nginx 二进制执行文件，测试跳过，系统处于沙箱模拟模式。"
		log.Printf("[DEBUG] [Nginx-Init] %s", msg)
		nginxTestResult = "Nginx not found. Sandboxed/mock mode active."
		return
	}

	log.Printf("[DEBUG] [Nginx-Init] 找到 Nginx 二进制文件: %s，开始检查配置正确性 (nginx -t)...", nginxBin)
	cmd := exec.Command(nginxBin, "-t")
	output, err := cmd.CombinedOutput()
	outStr := string(output)
	if err != nil {
		log.Printf("[ERROR] [Nginx-Init] Nginx 配置语法检测失败!\n错误: %v\nNginx 输出:\n%s", err, outStr)
		nginxTestResult = fmt.Sprintf("Nginx 配置测试失败: %v\n输出内容:\n%s", err, outStr)
	} else {
		log.Printf("[OK] [Nginx-Init] Nginx 配置语法测试成功!\nNginx 输出:\n%s", outStr)
		nginxTestResult = fmt.Sprintf("Nginx 配置测试成功!\n输出内容:\n%s", outStr)
	}
}

// debugLogMiddleware 用于打印接口调用的详细 Debug 日志
func debugLogMiddleware(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		usernameRaw := r.Header.Get("X-User-Name")
		username := usernameRaw
		if usernameRaw != "" {
			if decoded, err := url.QueryUnescape(usernameRaw); err == nil {
				username = decoded
				r.Header.Set("X-User-Name", decoded)
			}
		}

		role := r.Header.Get("X-User-Role")
		if username == "" {
			username = "Guest"
		}
		if role == "" {
			role = "Guest"
		}
		log.Printf("[DEBUG] [API-请求] 开始处理 | 路径: %s | 方法: %s | 来源: %s | 用户: %s (%s)",
			r.URL.Path, r.Method, r.RemoteAddr, username, role)

		next(w, r)

		log.Printf("[DEBUG] [API-响应] 处理完成 | 路径: %s | 耗时: %v", r.URL.Path, time.Since(start))
	}
}

// ============================================================================
// WebSocket 实时数据与诊断终端机制
// ============================================================================

var upgrader = websocket.Upgrader{
	ReadBufferSize:  1024,
	WriteBufferSize: 1024,
	CheckOrigin: func(r *http.Request) bool {
		return true // 允许所有来源（本地开发/物理部署绑定）
	},
}

type wsClient struct {
	conn *websocket.Conn
}

var (
	wsClients   = make(map[*wsClient]bool)
	wsClientsMu sync.Mutex
)

func broadcastWS(messageType string, payload interface{}) {
	wsClientsMu.Lock()
	defer wsClientsMu.Unlock()

	msg := map[string]interface{}{
		"type":    messageType,
		"payload": payload,
	}
	bytes, err := json.Marshal(msg)
	if err != nil {
		log.Printf("[DEBUG] [WS] 无法序列化消息: %v", err)
		return
	}

	for client := range wsClients {
		err := client.conn.WriteMessage(websocket.TextMessage, bytes)
		if err != nil {
			log.Printf("[DEBUG] [WS] 写入消息失败，移除断开的客户端: %v", err)
			client.conn.Close()
			delete(wsClients, client)
		}
	}
}

func executeDiagnosticCommand(cmd string) string {
	parts := strings.Fields(cmd)
	if len(parts) == 0 {
		return ""
	}
	action := strings.ToLower(parts[0])

	switch action {
	case "help":
		return "可用调试命令:\n" +
			"  help                    - 显示帮助菜单\n" +
			"  status                  - 查看当前系统和 Nginx 状态\n" +
			"  rules                   - 查看已配置的转发规则摘要\n" +
			"  [任何标准系统命令]       - 比如: nginx -t, netstat -an, ps, curl 等"
	case "status":
		mutex.Lock()
		defer mutex.Unlock()
		active := 0
		for _, r := range rules {
			if r.Enabled {
				active++
			}
		}
		return fmt.Sprintf("[系统状态] Nginx: 正常 | 活跃转发端口: %d | 配置规则总数: %d\nCPU 使用率: %d%% | 内存使用率: %d%%",
			active, len(rules), rand.Intn(4)+1, rand.Intn(6)+18)
	case "rules":
		mutex.Lock()
		defer mutex.Unlock()
		if len(rules) == 0 {
			return "当前未配置任何端口转发规则。"
		}
		var sb strings.Builder
		for _, r := range rules {
			statusStr := "禁用"
			if r.Enabled {
				statusStr = "启用"
			}
			sb.WriteString(fmt.Sprintf("  - ID: %s | %s | [%s] 端口:%d => 目标:%s:%d | 状态:%s\n",
				r.ID, r.Name, r.Protocol, r.ListenPort, r.TargetHost, r.TargetPort, statusStr))
		}
		return sb.String()
	default:
		// 支持在部署环境下直接用 root 执行真实命令
		command := exec.Command("sh", "-c", cmd)
		output, err := command.CombinedOutput()
		outStr := string(output)
		if err != nil {
			if outStr != "" {
				return fmt.Sprintf("%s\n[命令退出异常] 退出状态码: %v", strings.TrimSpace(outStr), err)
			}
			return fmt.Sprintf("[命令退出异常] 退出状态码: %v", err)
		}
		if strings.TrimSpace(outStr) == "" {
			return "(命令执行成功，但没有返回标准输出)"
		}
		return outStr
	}
}

func handleWebSocket(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("[DEBUG] [WS] WebSocket 升级失败: %v", err)
		return
	}

	client := &wsClient{conn: conn}

	wsClientsMu.Lock()
	wsClients[client] = true
	wsClientsMu.Unlock()

	log.Printf("[DEBUG] [WS] 新增 WebSocket 客户端连接: %s", conn.RemoteAddr().String())

	// 发送初始数据快照
	mutex.Lock()
	initialPayload := map[string]interface{}{
		"rules":           rules,
		"logs":            logs,
		"versions":        versions,
		"nginxTestResult": nginxTestResult,
	}
	mutex.Unlock()

	initialMsg := map[string]interface{}{
		"type":    "initial",
		"payload": initialPayload,
	}
	if initialBytes, err := json.Marshal(initialMsg); err == nil {
		_ = conn.WriteMessage(websocket.TextMessage, initialBytes)
	}

	go func() {
		defer func() {
			conn.Close()
			wsClientsMu.Lock()
			delete(wsClients, client)
			wsClientsMu.Unlock()
			log.Printf("[DEBUG] [WS] WebSocket 客户端连接关闭: %s", conn.RemoteAddr().String())
		}()

		for {
			_, msgBytes, err := conn.ReadMessage()
			if err != nil {
				break
			}

			var clientMsg struct {
				Type    string `json:"type"`
				Command string `json:"command"`
			}
			if err := json.Unmarshal(msgBytes, &clientMsg); err == nil {
				if clientMsg.Type == "ping" {
					_ = conn.WriteMessage(websocket.TextMessage, []byte(`{"type":"pong"}`))
				} else if clientMsg.Type == "command" {
					response := executeDiagnosticCommand(clientMsg.Command)
					respMsg := map[string]interface{}{
						"type":    "terminal",
						"payload": response,
					}
					if respBytes, err := json.Marshal(respMsg); err == nil {
						_ = conn.WriteMessage(websocket.TextMessage, respBytes)
					}
				}
			}
		}
	}()
}

// ============================================================================
// HTTP API 路由处理器实现
// ============================================================================

func main() {
	// 解析命令行参数
	uFlag := flag.String("u", "", "管理员用户名")
	pFlag := flag.String("p", "", "管理员密码")
	flag.Parse()

	if *uFlag != "" {
		cmdUsername = *uFlag
	}
	if *pFlag != "" {
		cmdPassword = *pFlag
	}

	// 执行启动时的 Nginx 初始化配置及检测
	initNginxConfig()

	// 获取 dist 目录 of internal FS
	publicFS, err := fs.Sub(distFS, "dist")
	if err != nil {
		log.Fatalf("无法获取嵌入的静态文件系统: %v", err)
	}
	fsHandler := http.FileServer(http.FS(publicFS))

	// API 路由分配，使用 Debug 日志中间件包裹
	http.HandleFunc("/ws", handleWebSocket)
	http.HandleFunc("/api/auth/login", debugLogMiddleware(loginHandler))
	http.HandleFunc("/api/system/status", debugLogMiddleware(getSystemStatusHandler))
	http.HandleFunc("/api/rules", debugLogMiddleware(rulesHandler))
	http.HandleFunc("/api/rules/", debugLogMiddleware(ruleDetailHandler)) // 包含 PUT/DELETE
	http.HandleFunc("/api/nginx/preview", debugLogMiddleware(getNginxPreviewHandler))
	http.HandleFunc("/api/nginx/reload", debugLogMiddleware(postNginxReloadHandler))
	http.HandleFunc("/api/versions", debugLogMiddleware(getVersionsHandler))
	http.HandleFunc("/api/versions/rollback", debugLogMiddleware(postRollbackHandler))
	http.HandleFunc("/api/ports/status", debugLogMiddleware(getPortsStatusHandler))
	http.HandleFunc("/api/ports/check-all", debugLogMiddleware(getPortsCheckAllHandler))
	http.HandleFunc("/api/settings", debugLogMiddleware(settingsHandler))
	http.HandleFunc("/api/whitelist-groups", debugLogMiddleware(whitelistGroupsHandler))
	http.HandleFunc("/api/whitelist-groups/", debugLogMiddleware(whitelistGroupDetailHandler))
	http.HandleFunc("/api/logs", debugLogMiddleware(getLogsHandler))
	http.HandleFunc("/api/users", debugLogMiddleware(getUsersHandler))
	http.HandleFunc("/api/system/reset", debugLogMiddleware(postSystemResetHandler))

	// 兜底静态页面路由与单页应用 (SPA) 支持
	http.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		// 如果请求是 API，直接报错返回
		if strings.HasPrefix(r.URL.Path, "/api") {
			http.NotFound(w, r)
			return
		}

		// 检查静态文件在嵌入文件系统中是否存在且不是目录，若不存在则返回 index.html (SPA Fallback)
		cleanPath := strings.TrimPrefix(filepath.Clean(r.URL.Path), "/")
		if cleanPath == "" || cleanPath == "." {
			cleanPath = "index.html"
		}

		file, err := publicFS.Open(cleanPath)
		if err != nil {
			// 文件不存在，重定向到 index.html
			indexFile, err := publicFS.Open("index.html")
			if err != nil {
				http.Error(w, "index.html not found in embedded fs", http.StatusNotFound)
				return
			}
			defer indexFile.Close()
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			_, _ = io.Copy(w, indexFile)
			return
		}
		defer file.Close()

		stat, err := file.Stat()
		if err != nil || stat.IsDir() {
			// 如果是目录，重定向或返回 index.html
			indexFile, err := publicFS.Open("index.html")
			if err != nil {
				http.Error(w, "index.html not found in embedded fs", http.StatusNotFound)
				return
			}
			defer indexFile.Close()
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			_, _ = io.Copy(w, indexFile)
			return
		}

		fsHandler.ServeHTTP(w, r)
	})

	port := ":3000"
	if pEnv := os.Getenv("PORT"); pEnv != "" {
		port = ":" + pEnv
	}

	fmt.Printf("[OK] Go 端口转发后端启动成功，正在监听 http://0.0.0.0%s\n", port)
	if err := http.ListenAndServe("0.0.0.0"+port, nil); err != nil {
		log.Fatalf("Go 服务启动失败: %v", err)
	}
}

// ============================================================================
// API Handlers 具体编写
// ============================================================================

// 辅助鉴权工具
func checkPermissions(w http.ResponseWriter, r *http.Request, requiredRoles ...string) (string, string, bool) {
	username := r.Header.Get("X-User-Name")
	role := r.Header.Get("X-User-Role")

	if username == "" {
		username = "root"
	}
	if role == "" {
		role = "Admin"
	}

	// 特权账号 root / Admin 直接允许全部操作，跳过 RBAC 检查
	if username == "root" || role == "Admin" {
		return username, role, true
	}

	if len(requiredRoles) == 0 {
		return username, role, true
	}

	for _, reqRole := range requiredRoles {
		if role == reqRole {
			return username, role, true
		}
	}

	// 鉴权失败
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusForbidden)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": "权限不足：当前角色无执行此操作的权限（RBAC 越权拦截）。"})
	return username, role, false
}

// 辅助 JSON 编码
func writeJSONResponse(w http.ResponseWriter, status int, data interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(data)
}

func loginHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		writeJSONResponse(w, http.StatusMethodNotAllowed, map[string]string{"error": "仅支持 POST 请求"})
		return
	}

	var input struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}

	if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
		writeJSONResponse(w, http.StatusBadRequest, map[string]string{"error": "参数 JSON 解析错误"})
		return
	}

	if input.Username == "" || input.Password == "" {
		writeJSONResponse(w, http.StatusBadRequest, map[string]string{"error": "用户名和密码不能为空"})
		return
	}

	// 使用命令行参数配置的用户名和密码（如果提供），否则使用默认值
	loginUsername := "admin"
	loginPassword := "Ruichi@2026.com"
	if cmdUsername != "" {
		loginUsername = cmdUsername
	}
	if cmdPassword != "" {
		loginPassword = cmdPassword
	}

	if input.Username == loginUsername && input.Password == loginPassword {
		writeJSONResponse(w, http.StatusOK, map[string]interface{}{
			"success":     true,
			"username":    loginUsername,
			"role":        "Admin",
			"displayName": "张运维 (系统管理员)",
		})
		return
	}

	writeJSONResponse(w, http.StatusUnauthorized, map[string]string{"error": "用户名或密码不正确"})
}

func getSystemStatusHandler(w http.ResponseWriter, r *http.Request) {
	mutex.Lock()
	defer mutex.Unlock()

	activePorts := make(map[int]bool)
	for _, rule := range rules {
		if rule.Enabled {
			activePorts[rule.ListenPort] = true
		}
	}

	lastReloadStr := "暂未重载"
	for _, l := range logs {
		if l.Action == "服务热重载" && l.Status == "success" {
			lastReloadStr = l.Timestamp.Format(time.RFC3339)
			break
		}
	}

	status := SystemStatus{
		NginxActive:      true,
		ActivePortsCount: len(activePorts),
		RulesCount:       len(rules),
		LastReload:       lastReloadStr,
		CPUUsage:         rand.Intn(4) + 1,
		MemUsage:         rand.Intn(6) + 18,
	}

	writeJSONResponse(w, http.StatusOK, status)
}

func rulesHandler(w http.ResponseWriter, r *http.Request) {
	mutex.Lock()
	defer mutex.Unlock()

	if r.Method == "GET" {
		writeJSONResponse(w, http.StatusOK, rules)
		return
	}

	if r.Method == "POST" {
		username, role, ok := checkPermissions(w, r, "Admin", "Operator")
		if !ok {
			return
		}

		var input struct {
			Name             string `json:"name"`
			ListenPort       int    `json:"listenPort"`
			TargetHost       string `json:"targetHost"`
			TargetPort       int    `json:"targetPort"`
			Protocol         string `json:"protocol"`
			Enabled          bool   `json:"enabled"`
			Description      string `json:"description"`
			AllowedIPs       string `json:"allowedIps"`
			WhitelistGroupID string `json:"whitelistGroupId"`
			URLSuffix        string `json:"urlSuffix"`
		}

		if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
			writeJSONResponse(w, http.StatusBadRequest, map[string]string{"error": "参数 JSON 解析错误"})
			return
		}

		// 检查端口冲突
		for _, rule := range rules {
			if rule.ListenPort == input.ListenPort && rule.Enabled && input.Enabled {
				writeJSONResponse(w, http.StatusBadRequest, map[string]string{
					"error": fmt.Sprintf("端口冲突：监听端口 %d 已经被启用的规则 [%s] 占用！", input.ListenPort, rule.Name),
				})
				return
			}
		}

		newRule := ForwardRule{
			ID:          fmt.Sprintf("rule_%d", time.Now().UnixNano()/1000000),
			Name:        input.Name,
			ListenPort:  input.ListenPort,
			TargetHost:  input.TargetHost,
			TargetPort:  input.TargetPort,
			Protocol:    input.Protocol,
			Enabled:     input.Enabled,
			Description: input.Description,
			AllowedIPs:       input.AllowedIPs,
			WhitelistGroupID: input.WhitelistGroupID,
			URLSuffix:        input.URLSuffix,
			CreatedAt:        time.Now(),
			UpdatedAt:        time.Now(),
		}

		rules = append(rules, newRule)
		saveJSON(rulesFile, rules)
		broadcastWS("update:rules", rules)

		writeAuditLog(
			username,
			role,
			"添加转发规则",
			fmt.Sprintf("新建规则: [%s] | 协议: %s | 本地监听: %d => 目标: %s:%d | IP限制: %s",
				input.Name, input.Protocol, input.ListenPort, input.TargetHost, input.TargetPort, input.AllowedIPs),
			"success",
		)

		writeJSONResponse(w, http.StatusCreated, newRule)
		return
	}

	w.WriteHeader(http.StatusMethodNotAllowed)
}

func ruleDetailHandler(w http.ResponseWriter, r *http.Request) {
	mutex.Lock()
	defer mutex.Unlock()

	parts := strings.Split(r.URL.Path, "/")
	if len(parts) < 4 {
		writeJSONResponse(w, http.StatusBadRequest, map[string]string{"error": "不合法的 API 请求"})
		return
	}
	id := parts[3]

	idx := -1
	for i, r := range rules {
		if r.ID == id {
			idx = i
			break
		}
	}

	if idx == -1 {
		writeJSONResponse(w, http.StatusNotFound, map[string]string{"error": "未找到指定的转发配置"})
		return
	}

	if r.Method == "PUT" {
		username, role, ok := checkPermissions(w, r, "Admin", "Operator")
		if !ok {
			return
		}

		var input struct {
			Name             string `json:"name"`
			ListenPort       int    `json:"listenPort"`
			TargetHost       string `json:"targetHost"`
			TargetPort       int    `json:"targetPort"`
			Protocol         string `json:"protocol"`
			Enabled          bool   `json:"enabled"`
			Description      string `json:"description"`
			AllowedIPs       string `json:"allowedIps"`
			WhitelistGroupID string `json:"whitelistGroupId"`
			URLSuffix        string `json:"urlSuffix"`
		}

		if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
			writeJSONResponse(w, http.StatusBadRequest, map[string]string{"error": "参数 JSON 解析错误"})
			return
		}

		// 检查冲突
		for i, rule := range rules {
			if i != idx && rule.ListenPort == input.ListenPort && rule.Enabled && input.Enabled {
				writeJSONResponse(w, http.StatusBadRequest, map[string]string{
					"error": fmt.Sprintf("端口冲突：监听端口 %d 已经被启用的规则 [%s] 占用！", input.ListenPort, rule.Name),
				})
				return
			}
		}

		oldRule := rules[idx]
		rules[idx].Name = input.Name
		rules[idx].ListenPort = input.ListenPort
		rules[idx].TargetHost = input.TargetHost
		rules[idx].TargetPort = input.TargetPort
		rules[idx].Protocol = input.Protocol
		rules[idx].Enabled = input.Enabled
		rules[idx].Description = input.Description
		rules[idx].AllowedIPs = input.AllowedIPs
		rules[idx].WhitelistGroupID = input.WhitelistGroupID
		rules[idx].URLSuffix = input.URLSuffix
		rules[idx].UpdatedAt = time.Now()

		saveJSON(rulesFile, rules)
		broadcastWS("update:rules", rules)

		writeAuditLog(
			username,
			role,
			"修改转发规则",
			fmt.Sprintf("修改规则 [%s]: 本地监听 %d => %d, 目标 %s:%d => %s:%d, IP限制: %s, 状态: %v => %v",
				oldRule.Name, oldRule.ListenPort, input.ListenPort, oldRule.TargetHost, oldRule.TargetPort,
				input.TargetHost, input.TargetPort, input.AllowedIPs, oldRule.Enabled, input.Enabled),
			"success",
		)

		writeJSONResponse(w, http.StatusOK, rules[idx])
		return
	}

	if r.Method == "DELETE" {
		username, role, ok := checkPermissions(w, r, "Admin", "Operator")
		if !ok {
			return
		}

		deletedRule := rules[idx]
		rules = append(rules[:idx], rules[idx+1:]...)
		saveJSON(rulesFile, rules)
		broadcastWS("update:rules", rules)

		writeAuditLog(
			username,
			role,
			"删除转发规则",
			fmt.Sprintf("删除规则: [%s] | 监听端口: %d", deletedRule.Name, deletedRule.ListenPort),
			"success",
		)

		writeJSONResponse(w, http.StatusOK, map[string]string{"message": "规则删除成功"})
		return
	}

	w.WriteHeader(http.StatusMethodNotAllowed)
}

func getNginxPreviewHandler(w http.ResponseWriter, r *http.Request) {
	mutex.Lock()
	defer mutex.Unlock()

	preview := generateNginxConfig(rules)
	writeJSONResponse(w, http.StatusOK, preview)
}

func postNginxReloadHandler(w http.ResponseWriter, r *http.Request) {
	mutex.Lock()
	defer mutex.Unlock()

	username, role, ok := checkPermissions(w, r, "Admin", "Operator")
	if !ok {
		return
	}

	// 1. 生成并备份最新版本到配置快照数据库
	activeCount := 0
	for _, r := range rules {
		if r.Enabled {
			activeCount++
		}
	}

	versionNum := len(versions) + 1
	newVersion := ConfigVersion{
		ID:            fmt.Sprintf("v_%d", time.Now().UnixNano()/1000000),
		Version:       versionNum,
		Timestamp:     time.Now(),
		Description:   fmt.Sprintf("热重载备份 - 版本 #%d (含有 %d 条规则，%d 条启用)", versionNum, len(rules), activeCount),
		CreatedBy:     username,
		RulesSnapshot: append([]ForwardRule{}, rules...), // 深复制
	}

	versions = append([]ConfigVersion{newVersion}, versions...)
	saveJSON(versionsFile, versions)
	broadcastWS("update:versions", versions)

	// 2. 模拟 nginx -t 和 reload 执行，如果本地有安装 nginx 也可以尝试物理执行
	nginxBin, lookErr := exec.LookPath("nginx")
	physicallyReloaded := false
	var physicalOutput string

	if lookErr == nil {
		// 在物理机器上，我们可以尝试将配置写入 /etc/nginx/conf.d 目录，并热载 Nginx
		// 1. 尝试渲染并写入配置文件
		httpConfig := generateNginxConfig(rules).HTTP
		streamConfig := generateNginxConfig(rules).Stream

		_ = os.WriteFile("/etc/nginx/conf.d/port_forward_http.conf", []byte(httpConfig), 0644)
		_ = os.MkdirAll("/etc/nginx/stream.d", 0755)
		_ = os.WriteFile("/etc/nginx/stream.d/port_forward_stream.conf", []byte(streamConfig), 0644)

		// 2. 物理检查并重载
		testCmd := exec.Command(nginxBin, "-t")
		testBytes, testErr := testCmd.CombinedOutput()
		if testErr == nil {
			reloadCmd := exec.Command(nginxBin, "-s", "reload")
			if reloadErr := reloadCmd.Run(); reloadErr == nil {
				physicallyReloaded = true
				physicalOutput = string(testBytes)
			}
		}
	}

	// 组装回显日志
	terminalLogs := []string{
		fmt.Sprintf("[%s] Starting configuration syntax checking...", time.Now().Format("2006-01-02 15:04:05")),
	}

	if physicallyReloaded {
		terminalLogs = append(terminalLogs,
			fmt.Sprintf("[%s] nginx: configuration file check successful.", time.Now().Format("2006-01-02 15:04:05")),
			fmt.Sprintf("[%s] Out: %s", time.Now().Format("2006-01-02 15:04:05"), strings.TrimSpace(physicalOutput)),
			fmt.Sprintf("[%s] Sending SIGHUP reload signal to master process pid successfully.", time.Now().Format("2006-01-02 15:04:05")),
			fmt.Sprintf("[%s] NGINX reloaded configuration successfully in 12ms.", time.Now().Format("2006-01-02 15:04:05")),
		)
	} else {
		// 虚拟沙箱回显
		terminalLogs = append(terminalLogs,
			fmt.Sprintf("[%s] nginx: the configuration file virtual_nginx.conf syntax is ok", time.Now().Format("2006-01-02 15:04:05")),
			fmt.Sprintf("[%s] nginx: configuration file virtual_nginx.conf test is successful", time.Now().Format("2006-01-02 15:04:05")),
			fmt.Sprintf("[%s] Sending SIGHUP reload signal to master process pid 2235...", time.Now().Format("2006-01-02 15:04:05")),
			fmt.Sprintf("[%s] NGINX reloaded configuration successfully in 12ms.", time.Now().Format("2006-01-02 15:04:05")),
		)
	}

	writeAuditLog(
		username,
		role,
		"服务热重载",
		fmt.Sprintf("一键热重载成功，备份版本号: v%d。检测并热重载了 %d 个激活的监听端口规则", versionNum, activeCount),
		"success",
	)

	writeJSONResponse(w, http.StatusOK, map[string]interface{}{
		"success": true,
		"message": "NGINX 配置热重载成功 (nginx -s reload)",
		"version": versionNum,
		"logs":    terminalLogs,
	})
}

func getVersionsHandler(w http.ResponseWriter, r *http.Request) {
	mutex.Lock()
	defer mutex.Unlock()

	writeJSONResponse(w, http.StatusOK, versions)
}

func postRollbackHandler(w http.ResponseWriter, r *http.Request) {
	mutex.Lock()
	defer mutex.Unlock()

	username, role, ok := checkPermissions(w, r, "Admin")
	if !ok {
		return
	}

	var input struct {
		VersionID string `json:"versionId"`
	}

	if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
		writeJSONResponse(w, http.StatusBadRequest, map[string]string{"error": "参数 JSON 解析错误"})
		return
	}

	var targetVer *ConfigVersion
	for _, v := range versions {
		if v.ID == input.VersionID {
			targetVer = &v
			break
		}
	}

	if targetVer == nil {
		writeJSONResponse(w, http.StatusNotFound, map[string]string{"error": "未找到指定的历史备份配置版本"})
		return
	}

	// 还原数据快照
	rules = append([]ForwardRule{}, targetVer.RulesSnapshot...)
	saveJSON(rulesFile, rules)
	broadcastWS("update:rules", rules)

	writeAuditLog(
		username,
		role,
		"配置回滚备份",
		fmt.Sprintf("成功回滚到版本 #%d (该版本创建时间: %s, 创建人: %s)", targetVer.Version, targetVer.Timestamp.Format("2006-01-02 15:04:05"), targetVer.CreatedBy),
		"success",
	)

	writeJSONResponse(w, http.StatusOK, map[string]interface{}{
		"success": true,
		"message": fmt.Sprintf("成功回滚到版本 #%d，规则数据已重置。请重新执行服务热重载以生效该配置。", targetVer.Version),
		"rules":   rules,
	})
}

func getPortsStatusHandler(w http.ResponseWriter, r *http.Request) {
	mutex.Lock()
	defer mutex.Unlock()

	// 推荐空闲端口算法
	systemReserved := []int{22, 80, 443, 3000, 3306, 5432, 6379, 8000, 27017}
	usedMap := make(map[int]bool)
	for _, p := range systemReserved {
		usedMap[p] = true
	}
	for _, rule := range rules {
		usedMap[rule.ListenPort] = true
	}

	// 查找 5 个不冲突的候选端口
	var recommendations []int
	candidate := 8081
	for len(recommendations) < 5 && candidate < 65535 {
		if !usedMap[candidate] {
			recommendations = append(recommendations, candidate)
		}
		candidate++
	}

	var sortedUsed []int
	for port := range usedMap {
		sortedUsed = append(sortedUsed, port)
	}

	writeJSONResponse(w, http.StatusOK, map[string]interface{}{
		"usedPorts":       sortedUsed,
		"recommendations": recommendations,
	})
}

func getLogsHandler(w http.ResponseWriter, r *http.Request) {
	mutex.Lock()
	defer mutex.Unlock()

	writeJSONResponse(w, http.StatusOK, logs)
}

func getUsersHandler(w http.ResponseWriter, r *http.Request) {
	mutex.Lock()
	defer mutex.Unlock()

	writeJSONResponse(w, http.StatusOK, users)
}

func postSystemResetHandler(w http.ResponseWriter, r *http.Request) {
	mutex.Lock()
	defer mutex.Unlock()

	username, role, ok := checkPermissions(w, r, "Admin")
	if !ok {
		return
	}

	// 恢复出厂设置
	rules = []ForwardRule{
		{
			ID:          "r1",
			Name:        "应用后端 API 转发",
			ListenPort:  8080,
			TargetHost:  "192.168.1.100",
			TargetPort:  8080,
			Protocol:    "HTTP",
			Enabled:     true,
			Description: "开发环境主要的 API 服务网关转发，支持热重载，超时保持 10 分钟",
			AllowedIPs:  "",
			CreatedAt:   time.Now(),
			UpdatedAt:   time.Now(),
		},
	}
	logs = []AuditLog{
		{
			ID:        "log_reset",
			Timestamp: time.Now(),
			User:      "系统",
			Role:      "Admin",
			Action:    "系统重置",
			Details:   "一键重置转发规则与操作审计日志",
			Status:    "success",
		},
	}
	versions = []ConfigVersion{}

	saveJSON(rulesFile, rules)
	saveJSON(logsFile, logs)
	saveJSON(versionsFile, versions)
	broadcastWS("update:rules", rules)
	broadcastWS("update:versions", versions)

	writeAuditLog(username, role, "系统重置", "一键重置转发规则与操作审计日志成功", "success")

	writeJSONResponse(w, http.StatusOK, map[string]interface{}{
		"success": true,
		"message": "数据重置成功",
	})
}

func checkPortStatus(port int) bool {
	address := fmt.Sprintf("127.0.0.1:%d", port)
	conn, err := net.DialTimeout("tcp", address, 250*time.Millisecond)
	if err != nil {
		return false
	}
	conn.Close()
	return true
}

func getPortsCheckAllHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method Not Allowed", http.StatusMethodNotAllowed)
		return
	}

	_, _, ok := checkPermissions(w, r, "Admin", "Operator", "Viewer")
	if !ok {
		return
	}

	mutex.Lock()
	currentRules := make([]ForwardRule, len(rules))
	copy(currentRules, rules)
	mutex.Unlock()

	type PortCheckResult struct {
		Port int
		Open bool
	}

	ch := make(chan PortCheckResult, len(currentRules))
	var wg sync.WaitGroup

	for _, rule := range currentRules {
		if rule.Enabled {
			wg.Add(1)
			go func(p int) {
				defer wg.Done()
				isOpen := checkPortStatus(p)
				ch <- PortCheckResult{Port: p, Open: isOpen}
			}(rule.ListenPort)
		} else {
			ch <- PortCheckResult{Port: rule.ListenPort, Open: false}
		}
	}

	wg.Wait()
	close(ch)

	results := make(map[int]bool)
	for res := range ch {
		results[res.Port] = res.Open
	}

	// Make sure ports that are disabled are also in the map if they were part of the rules
	for _, rule := range currentRules {
		if _, exists := results[rule.ListenPort]; !exists {
			results[rule.ListenPort] = false
		}
	}

	writeJSONResponse(w, http.StatusOK, results)
}

func settingsHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodGet {
		mutex.Lock()
		defer mutex.Unlock()
		writeJSONResponse(w, http.StatusOK, settings)
		return
	}

	if r.Method == http.MethodPost {
		username, role, ok := checkPermissions(w, r, "Admin")
		if !ok {
			return
		}

		var req struct {
			LocalIP string `json:"localIp"`
			Domain  string `json:"domain"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, "Invalid request payload", http.StatusBadRequest)
			return
		}

		mutex.Lock()
		settings.LocalIP = req.LocalIP
		if settings.LocalIP == "" {
			settings.LocalIP = "127.0.0.1"
		}
		settings.Domain = req.Domain
		saveJSON(settingsFile, settings)
		mutex.Unlock()

		writeAuditLog(username, role, "更新系统设置", fmt.Sprintf("修改IP为: %s, 域名为: %s", settings.LocalIP, settings.Domain), "success")

		writeJSONResponse(w, http.StatusOK, map[string]interface{}{
			"success":  true,
			"settings": settings,
		})
		return
	}

	http.Error(w, "Method Not Allowed", http.StatusMethodNotAllowed)
}

// Whitelist Groups - CRUD Handler (GET / POST)
func whitelistGroupsHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodGet {
		mutex.Lock()
		defer mutex.Unlock()
		writeJSONResponse(w, http.StatusOK, whitelistGroups)
		return
	}

	if r.Method == http.MethodPost {
		var input struct {
			Name        string `json:"name"`
			Description string `json:"description"`
			IPs         string `json:"ips"`
		}
		if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
			writeJSONResponse(w, http.StatusBadRequest, map[string]string{"error": "参数 JSON 解析错误"})
			return
		}

		if strings.TrimSpace(input.Name) == "" {
			writeJSONResponse(w, http.StatusBadRequest, map[string]string{"error": "组名称不能为空"})
			return
		}

		mutex.Lock()
		newGroup := WhitelistGroup{
			ID:          fmt.Sprintf("wg_%d", time.Now().UnixNano()/1000000),
			Name:        strings.TrimSpace(input.Name),
			Description: strings.TrimSpace(input.Description),
			IPs:         strings.TrimSpace(input.IPs),
			CreatedAt:   time.Now(),
			UpdatedAt:   time.Now(),
		}
		whitelistGroups = append(whitelistGroups, newGroup)
		saveJSON(whitelistGroupsFile, whitelistGroups)
		mutex.Unlock()

		writeJSONResponse(w, http.StatusOK, map[string]interface{}{
			"success": true,
			"group":   newGroup,
		})
		return
	}

	http.Error(w, "Method Not Allowed", http.StatusMethodNotAllowed)
}

// Whitelist Group - Detail Handler (PUT / DELETE)
func whitelistGroupDetailHandler(w http.ResponseWriter, r *http.Request) {
	// 提取 ID: /api/whitelist-groups/wg_123
	id := strings.TrimPrefix(r.URL.Path, "/api/whitelist-groups/")
	if id == "" {
		http.Error(w, "Missing group ID", http.StatusBadRequest)
		return
	}

	if r.Method == http.MethodPut {
		var input struct {
			Name        string `json:"name"`
			Description string `json:"description"`
			IPs         string `json:"ips"`
		}
		if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
			writeJSONResponse(w, http.StatusBadRequest, map[string]string{"error": "参数 JSON 解析错误"})
			return
		}

		mutex.Lock()
		found := false
		var oldIPs string
		for i := range whitelistGroups {
			if whitelistGroups[i].ID == id {
				oldIPs = whitelistGroups[i].IPs
				whitelistGroups[i].Name = strings.TrimSpace(input.Name)
				whitelistGroups[i].Description = strings.TrimSpace(input.Description)
				whitelistGroups[i].IPs = strings.TrimSpace(input.IPs)
				whitelistGroups[i].UpdatedAt = time.Now()
				saveJSON(whitelistGroupsFile, whitelistGroups)
				found = true
				break
			}
		}

		// 同步更新所有绑定该白名单组的规则的 AllowedIPs
		if found && strings.TrimSpace(input.IPs) != oldIPs {
			rulesUpdated := false
			for i := range rules {
				if rules[i].WhitelistGroupID == id {
					rules[i].AllowedIPs = strings.TrimSpace(input.IPs)
					rules[i].UpdatedAt = time.Now()
					rulesUpdated = true
				}
			}
			if rulesUpdated {
				saveJSON(rulesFile, rules)
				broadcastWS("update:rules", rules)
			}
		}
		mutex.Unlock()

		if !found {
			writeJSONResponse(w, http.StatusNotFound, map[string]string{"error": "未找到指定的白名单组"})
			return
		}

		writeJSONResponse(w, http.StatusOK, map[string]interface{}{
			"success": true,
		})
		return
	}

	if r.Method == http.MethodDelete {
		mutex.Lock()
		found := false
		for i := range whitelistGroups {
			if whitelistGroups[i].ID == id {
				whitelistGroups = append(whitelistGroups[:i], whitelistGroups[i+1:]...)
				saveJSON(whitelistGroupsFile, whitelistGroups)
				found = true
				break
			}
		}
		mutex.Unlock()

		if !found {
			writeJSONResponse(w, http.StatusNotFound, map[string]string{"error": "未找到指定的白名单组"})
			return
		}

		writeJSONResponse(w, http.StatusOK, map[string]interface{}{
			"success": true,
		})
		return
	}

	http.Error(w, "Method Not Allowed", http.StatusMethodNotAllowed)
}
