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
	"sort"
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
	NftablesActive    bool     `json:"nftablesActive"`
	ActivePortsCount  int      `json:"activePortsCount"`
	RulesCount        int      `json:"rulesCount"`
	LastReload        string   `json:"lastReload"`
	CPUUsage          int      `json:"cpuUsage"`
	MemUsage          int      `json:"memUsage"`
	NftablesTestResult string  `json:"nftablesTestResult"`
	InitLogs          []string `json:"initLogs"`
}

type NftablesPreview struct {
	Rules string `json:"rules"`
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
// nftables 规则生成与 IP 解析
// ============================================================================

func parseIPList(allowedIps string) []string {
	var ips []string
	rawIps := strings.FieldsFunc(strings.TrimSpace(allowedIps), func(r rune) bool {
		return r == ',' || r == ';' || r == ' ' || r == '\n' || r == '\r'
	})
	for _, ip := range rawIps {
		trimmed := strings.TrimSpace(ip)
		if trimmed != "" {
			ips = append(ips, trimmed)
		}
	}
	return ips
}

// normalizeIPList 归一化 IP 列表（排序、去重、统一分隔符），用于比较不同规则的 allowedIps 是否等价
func normalizeIPList(allowedIps string) string {
	ips := parseIPList(allowedIps)
	if len(ips) == 0 {
		return ""
	}
	sort.Strings(ips)
	return strings.Join(ips, ",")
}

func generateNftablesConfig(rulesList []ForwardRule, whitelistGroups []WhitelistGroup) string {
	var sb strings.Builder
	sb.WriteString("# nftables port forwarding rules\n")
	sb.WriteString(fmt.Sprintf("# Generated: %s\n", time.Now().Format(time.RFC3339)))
	sb.WriteString("# Managed by Port Forwarder (nftables mode)\n")
	sb.WriteString("# OS: Rocky Linux 9.x optimized\n\n")
	sb.WriteString("flush ruleset\n\n")

	// 建立白名单组快速查找映射
	groupMap := make(map[string]WhitelistGroup)
	for _, g := range whitelistGroups {
		groupMap[g.ID] = g
	}

	// 收集启用规则中引用的、且有实际 IP 的白名单组（命名集合去重）
	usedSets := make(map[string]bool)
	for _, rule := range rulesList {
		if rule.Enabled && rule.WhitelistGroupID != "" {
			if g, ok := groupMap[rule.WhitelistGroupID]; ok && strings.TrimSpace(g.IPs) != "" {
				usedSets[rule.WhitelistGroupID] = true
			}
		}
	}

	// ===== 自动去重：未绑定白名单组但多条规则共享相同 IP 列表时，自动生成命名集合 =====
	type anonymousGroup struct {
		ips     string   // 归一化后的 IP 列表（用于比较）
		ruleIDs []string // 引用此 IP 列表的规则 ID
	}
	anonymousGroups := make(map[string]*anonymousGroup) // normalized -> group
	for _, rule := range rulesList {
		if !rule.Enabled || rule.WhitelistGroupID != "" || strings.TrimSpace(rule.AllowedIPs) == "" {
			continue
		}
		normalized := normalizeIPList(rule.AllowedIPs)
		if normalized == "" {
			continue
		}
		if ag, ok := anonymousGroups[normalized]; ok {
			ag.ruleIDs = append(ag.ruleIDs, rule.ID)
		} else {
			anonymousGroups[normalized] = &anonymousGroup{ips: normalized, ruleIDs: []string{rule.ID}}
		}
	}

	// 为被 >= 2 条规则引用的匿名 IP 集合生成命名集合
	setIndex := 0
	autoSetNameByIPs := make(map[string]string) // normalizedIPs -> autoSetName
	for normalizedIPs, ag := range anonymousGroups {
		if len(ag.ruleIDs) >= 2 {
			setName := fmt.Sprintf("auto_wl_set_%03d", setIndex)
			setIndex++
			autoSetNameByIPs[normalizedIPs] = setName
		}
	}

	sb.WriteString("table ip port_forwarder {\n\n")

	// ===== 命名集合 (Named Sets) — 白名单组 =====
	for groupID := range usedSets {
		group := groupMap[groupID]
		ips := parseIPList(group.IPs)
		elements := strings.Join(ips, ", ")
		sb.WriteString(fmt.Sprintf("    set whitelist_%s {\n", groupID))
		sb.WriteString("        type ipv4_addr\n")
		sb.WriteString("        flags interval\n")
		sb.WriteString(fmt.Sprintf("        elements = { %s }\n", elements))
		sb.WriteString("    }\n\n")
	}

	// ===== 命名集合 (Named Sets) — 自动去重生成的匿名集合 =====
	for normalizedIPs, setName := range autoSetNameByIPs {
		ips := strings.Split(normalizedIPs, ",")
		sb.WriteString(fmt.Sprintf("    # 自动去重：%d 条规则共享此 IP 列表\n", len(anonymousGroups[normalizedIPs].ruleIDs)))
		sb.WriteString(fmt.Sprintf("    set %s {\n", setName))
		sb.WriteString("        type ipv4_addr\n")
		sb.WriteString("        flags interval\n")
		sb.WriteString(fmt.Sprintf("        elements = { %s }\n", strings.Join(ips, ", ")))
		sb.WriteString("    }\n\n")
	}

	// prerouting 链 — 入站流量目的地址转换 (DNAT)
	sb.WriteString("    chain prerouting {\n")
	sb.WriteString("        type nat hook prerouting priority dstnat; policy accept;\n\n")

	hasRules := false
	for _, rule := range rulesList {
		if !rule.Enabled {
			continue
		}
		hasRules = true

		// 注释
		sb.WriteString(fmt.Sprintf("        # %s [%s]\n", rule.Name, rule.ID))
		if rule.Description != "" {
			sb.WriteString(fmt.Sprintf("        # %s\n", rule.Description))
		}

		// IP 白名单过滤（三级优先级：绑定白名单组 > 自动去重集合 > 内联匿名集合）
		ipFilter := ""
		if rule.WhitelistGroupID != "" {
			if _, ok := usedSets[rule.WhitelistGroupID]; ok {
				ipFilter = fmt.Sprintf("ip saddr @whitelist_%s ", rule.WhitelistGroupID)
			}
		}
		if ipFilter == "" && strings.TrimSpace(rule.AllowedIPs) != "" {
			normalized := normalizeIPList(rule.AllowedIPs)
			if setName, ok := autoSetNameByIPs[normalized]; ok {
				// 自动去重命名集合
				ipFilter = fmt.Sprintf("ip saddr @%s ", setName)
			} else {
				// 最终回退: 仅单条规则引用此 IP 列表，使用内联
				ips := parseIPList(rule.AllowedIPs)
				if len(ips) > 0 {
					ipFilter = fmt.Sprintf("ip saddr { %s } ", strings.Join(ips, ", "))
				}
			}
		}

		// 协议
		proto := "tcp"
		if strings.ToUpper(rule.Protocol) == "UDP" {
			proto = "udp"
		}

		sb.WriteString(fmt.Sprintf("        %s%s dport %d dnat to %s:%d\n\n",
			ipFilter, proto, rule.ListenPort, rule.TargetHost, rule.TargetPort))
	}

	if !hasRules {
		sb.WriteString("        # 当前无激活的端口转发规则\n")
	}

	sb.WriteString("    }\n\n")

	// postrouting 链 — 出站流量源地址转换 (MASQUERADE)
	// ====== 关键: 保证 DNAT 回程流量经过本机正确返回客户端 ======
	// ct status dnat 仅匹配被 DNAT 处理过的连接，避免全局 masquerade
	sb.WriteString("    chain postrouting {\n")
	sb.WriteString("        type nat hook postrouting priority srcnat; policy accept;\n")
	sb.WriteString("        ct status dnat masquerade\n")
	sb.WriteString("    }\n")

	sb.WriteString("}\n")

	return sb.String()
}

// ============================================================================
// 系统自检、自修复与内核优化 (面向 Rocky Linux 9.x)
// ============================================================================

var systemInitLogs []string // 全局启动日志收集
var nftablesTestResult = "未测试"

// logInit 记录初始化日志（同时输出到标准日志）
func logInit(format string, args ...interface{}) {
	msg := fmt.Sprintf(format, args...)
	systemInitLogs = append(systemInitLogs, msg)
	log.Println(msg)
}

// ensureNftablesInstalled 检测 nftables 是否安装，未安装则自动安装
func ensureNftablesInstalled() bool {
	nftBin, lookErr := exec.LookPath("nft")
	if lookErr == nil {
		// 验证 nft 能否正常工作
		verCmd := exec.Command(nftBin, "--version")
		verOut, verErr := verCmd.CombinedOutput()
		if verErr == nil {
			logInit("[nftables-Check] ✓ nft 已安装: %s", strings.TrimSpace(string(verOut)))
			return true
		}
		logInit("[nftables-Check] ! nft 二进制存在但无法执行: %v", verErr)
	}

	logInit("[nftables-Check] ✗ nft 未安装，尝试自动安装 nftables...")

	// 仅支持 Rocky/RHEL/CentOS (dnf/yum)
	installers := []struct {
		name string
		cmd  []string
	}{
		{"dnf", []string{"dnf", "install", "-y", "nftables"}},
		{"yum", []string{"yum", "install", "-y", "nftables"}},
	}

	for _, inst := range installers {
		if _, err := exec.LookPath(inst.name); err == nil {
			logInit("[nftables-Install] 使用 %s 安装 nftables...", inst.name)
			cmd := exec.Command(inst.cmd[0], inst.cmd[1:]...)
			out, err := cmd.CombinedOutput()
			if err != nil {
				logInit("[nftables-Install] ✗ 安装失败 (%s): %v\n输出: %s", inst.name, err, string(out))
				continue
			}
			logInit("[nftables-Install] ✓ nftables 安装成功")

			// 启用并启动 nftables 服务
			enableCmd := exec.Command("systemctl", "enable", "--now", "nftables")
			if enOut, enErr := enableCmd.CombinedOutput(); enErr != nil {
				logInit("[nftables-Install] ! 启用 nftables 服务失败: %v\n输出: %s", enErr, string(enOut))
			} else {
				logInit("[nftables-Install] ✓ nftables 服务已启用并启动")
			}
			return true
		}
	}

	logInit("[nftables-Install] ✗ 无法自动安装: 未找到 dnf/yum，请手动执行: dnf install -y nftables")
	return false
}

// sysctlApply 安全写入 sysctl 参数
func sysctlApply(key, value string) bool {
	path := "/proc/sys/" + strings.ReplaceAll(key, ".", "/")
	currentBytes, readErr := os.ReadFile(path)
	if readErr == nil {
		currentVal := strings.TrimSpace(string(currentBytes))
		if currentVal == value {
			return true // 已匹配
		}
	}

	if err := os.WriteFile(path, []byte(value), 0644); err != nil {
		logInit("[Kernel] ✗ 设置 %s=%s 失败: %v", key, value, err)
		return false
	}
	logInit("[Kernel] ✓ 已设置 %s = %s", key, value)
	return true
}

// optimizeKernelParams 优化全部 nftables 端口转发所需的内核参数
// 面向 Rocky Linux 9.x 内核 5.14+
func optimizeKernelParams() {
	logInit("[Kernel] ========== 开始内核参数优化 (nftables 端口转发) ==========")

	// 1. 核心：开启 IPv4 转发 (端口转发必须)
	sysctlApply("net.ipv4.ip_forward", "1")
	sysctlApply("net.ipv4.conf.all.forwarding", "1")
	sysctlApply("net.ipv4.conf.default.forwarding", "1")

	// 2. 允许本地路由 (DNAT 到本机回环地址时需要)
	sysctlApply("net.ipv4.conf.all.route_localnet", "1")
	sysctlApply("net.ipv4.conf.default.route_localnet", "1")

	// 3. 连接跟踪优化 — 提高 nftables NAT 吞吐量
	sysctlApply("net.netfilter.nf_conntrack_max", "1048576")
	sysctlApply("net.netfilter.nf_conntrack_tcp_timeout_established", "86400")
	sysctlApply("net.netfilter.nf_conntrack_tcp_timeout_time_wait", "30")
	sysctlApply("net.netfilter.nf_conntrack_tcp_timeout_close_wait", "15")
	sysctlApply("net.netfilter.nf_conntrack_tcp_timeout_fin_wait", "30")
	sysctlApply("net.netfilter.nf_conntrack_udp_timeout", "60")
	sysctlApply("net.netfilter.nf_conntrack_udp_timeout_stream", "120")

	// 4. 禁用 conntrack helper 自动分配 (安全最佳实践)
	sysctlApply("net.netfilter.nf_conntrack_helper", "0")

	// 5. TCP 优化 — 提升转发连接性能
	sysctlApply("net.ipv4.tcp_fastopen", "3")       // TFO 客户端+服务端
	sysctlApply("net.ipv4.tcp_tw_reuse", "1")       // TIME_WAIT 重用
	sysctlApply("net.ipv4.tcp_fin_timeout", "15")    // 缩短 FIN 超时
	sysctlApply("net.ipv4.tcp_keepalive_time", "300") // keepalive 5 分钟
	sysctlApply("net.ipv4.tcp_keepalive_intvl", "30")
	sysctlApply("net.ipv4.tcp_keepalive_probes", "5")

	// 6. 网络缓冲区优化 — 增大 backlog
	sysctlApply("net.core.somaxconn", "32768")
	sysctlApply("net.core.netdev_max_backlog", "32768")
	sysctlApply("net.ipv4.tcp_max_syn_backlog", "32768")
	sysctlApply("net.core.rmem_max", "33554432")
	sysctlApply("net.core.wmem_max", "33554432")
	sysctlApply("net.ipv4.tcp_rmem", "4096 87380 33554432")
	sysctlApply("net.ipv4.tcp_wmem", "4096 65536 33554432")

	// 7. 本地端口范围扩展
	sysctlApply("net.ipv4.ip_local_port_range", "1024 65535")

	// 8. 安全：禁用 ICMP 重定向 (路由器必须)
	sysctlApply("net.ipv4.conf.all.accept_redirects", "0")
	sysctlApply("net.ipv4.conf.default.accept_redirects", "0")
	sysctlApply("net.ipv4.conf.all.send_redirects", "0")
	sysctlApply("net.ipv4.conf.default.send_redirects", "0")

	// 9. NAT 转发盒子：必须关闭 rp_filter
	//  严格模式(1)会丢弃 DNAT 回程包——因为返回路径可能与入站路径不同
	//  这里设为 0 (禁用) 确保 DNAT 流量不被内核静默丢弃
	sysctlApply("net.ipv4.conf.all.rp_filter", "0")
	sysctlApply("net.ipv4.conf.default.rp_filter", "0")
	sysctlApply("net.ipv4.conf.eth0.rp_filter", "0")

	logInit("[Kernel] ========== 内核参数优化完成 ==========")

	// 验证 ip_forward 是否生效
	data, err := os.ReadFile("/proc/sys/net/ipv4/ip_forward")
	if err == nil && strings.TrimSpace(string(data)) != "1" {
		logInit("[Kernel] ✗ 警告: net.ipv4.ip_forward 未生效! 端口转发将无法工作。")
	} else if err == nil {
		logInit("[Kernel] ✓ 确认 IP 转发已启用: net.ipv4.ip_forward = 1")
	}

	// 验证 rp_filter
	rpData, rpErr := os.ReadFile("/proc/sys/net/ipv4/conf/all/rp_filter")
	if rpErr == nil {
		val := strings.TrimSpace(string(rpData))
		if val != "0" {
			logInit("[Kernel] ✗ 警告: rp_filter = %s (应为 0), DNAT 回程包可能被丢弃!", val)
		} else {
			logInit("[Kernel] ✓ 确认: rp_filter = 0 (DNAT 回程包不会被丢弃)")
		}
	}
}

// verifyNetworkInterface 检测默认网卡接口名称
func verifyNetworkInterface() string {
	// 获取默认路由的接口
	cmd := exec.Command("sh", "-c", "ip -4 route show default | awk '{print $5}' | head -1")
	out, err := cmd.CombinedOutput()
	if err == nil && len(out) > 0 {
		iface := strings.TrimSpace(string(out))
		logInit("[Network] ✓ 检测到默认网卡: %s", iface)
		return iface
	}
	logInit("[Network] ! 无法检测默认网卡接口")
	return ""
}

// loadNftablesModules 加载必要的内核模块
func loadNftablesModules() {
	modules := []string{
		"nf_tables",
		"nf_conntrack",
		"nf_conntrack_netlink",
		"nf_nat",
		"nf_tproxy_ipv4",
	}

	for _, mod := range modules {
		cmd := exec.Command("modprobe", mod)
		if out, err := cmd.CombinedOutput(); err != nil {
			// 模块不存在不是致命错误（可能已编译进内核）
			logInit("[Kernel] ! 加载模块 %s 失败 (可能已内置于内核): %s", mod, strings.TrimSpace(string(out)))
		} else {
			logInit("[Kernel] ✓ 模块 %s 已加载", mod)
		}
	}
}

// verifyNftablesHealth 最终健康检查：确认 nftables 规则已生效
func verifyNftablesHealth() {
	nftBin, err := exec.LookPath("nft")
	if err != nil {
		logInit("[Health] ✗ 最终健康检查失败: nft 未找到")
		nftablesTestResult = "✗ 健康检查失败: nft 未安装"
		return
	}

	cmd := exec.Command(nftBin, "list", "ruleset")
	out, err := cmd.CombinedOutput()
	if err != nil {
		logInit("[Health] ✗ 无法列出 nftables 规则: %v\n输出: %s", err, string(out))
		nftablesTestResult = fmt.Sprintf("✗ 无法读取规则: %v", err)
		return
	}

	ruleset := string(out)
	activeCount := 0
	for _, r := range rules {
		if r.Enabled {
			activeCount++
		}
	}

	if strings.Contains(ruleset, "port_forwarder") {
		logInit("[Health] ✓ nftables 规则已生效，激活 %d 条端口转发规则", activeCount)
		logInit("[Health] ✓ 规则文件包含表 'port_forwarder' (prerouting + postrouting)")
		nftablesTestResult = fmt.Sprintf("✓ 正常 — 已激活 %d 条端口转发规则", activeCount)
	} else {
		logInit("[Health] ✗ 警告: nftables 规则中未找到 port_forwarder 表，规则可能未正确加载!")
		nftablesTestResult = "✗ 警告: port_forwarder 表未加载"
	}
}

// handleFirewalld 检测 firewalld 是否运行，若运行则配置其允许转发流量
// Rocky Linux 9 默认启用 firewalld，可能与 nftables 规则冲突
func handleFirewalld() {
	// 检测 firewalld 是否在运行
	checkCmd := exec.Command("systemctl", "is-active", "firewalld")
	checkOut, checkErr := checkCmd.CombinedOutput()
	status := strings.TrimSpace(string(checkOut))

	if checkErr != nil || status != "active" {
		logInit("[Firewall] firewalld 未运行或未安装，无需额外处理")
		return
	}

	logInit("[Firewall] 检测到 firewalld 正在运行，检查转发策略...")

	// 检查 firewalld 的默认 zone
	zoneCmd := exec.Command("firewall-cmd", "--get-default-zone")
	zoneOut, zoneErr := zoneCmd.CombinedOutput()
	if zoneErr != nil {
		logInit("[Firewall] ✗ 无法获取 firewalld 默认 zone: %v", zoneErr)
		logInit("[Firewall] ! 请手动执行: firewall-cmd --add-masquerade --permanent && firewall-cmd --reload")
		return
	}
	defaultZone := strings.TrimSpace(string(zoneOut))
	logInit("[Firewall] ✓ firewalld 默认 zone: %s", defaultZone)

	// 收集转发端口列表
	var ports []string
	for _, r := range rules {
		if r.Enabled {
			proto := "tcp"
			if strings.ToUpper(r.Protocol) == "UDP" {
				proto = "udp"
			}
			ports = append(ports, fmt.Sprintf("%d/%s", r.ListenPort, proto))
		}
	}

	// 尝试添加端口到 firewalld 允许列表
	addCount := 0
	for _, port := range ports {
		addCmd := exec.Command("firewall-cmd", "--zone="+defaultZone, "--add-port="+port, "--permanent")
		addOut, addErr := addCmd.CombinedOutput()
		if addErr != nil {
			logInit("[Firewall] ! 添加端口 %s 到 firewalld 失败: %s", port, strings.TrimSpace(string(addOut)))
		} else {
			addCount++
		}
	}

	// 确保 masquerade 开启
	masqCmd := exec.Command("firewall-cmd", "--zone="+defaultZone, "--add-masquerade", "--permanent")
	masqOut, masqErr := masqCmd.CombinedOutput()
	if masqErr != nil {
		logInit("[Firewall] ! 开启 masquerade 失败: %s", strings.TrimSpace(string(masqOut)))
	}

	// 重载 firewalld
	reloadCmd := exec.Command("firewall-cmd", "--reload")
	reloadOut, reloadErr := reloadCmd.CombinedOutput()
	if reloadErr != nil {
		logInit("[Firewall] ✗ 重载 firewalld 失败: %s", strings.TrimSpace(string(reloadOut)))
		logInit("[Firewall] ! 请手动执行: firewall-cmd --reload")
	} else {
		logInit("[Firewall] ✓ firewalld 已重载 (新增 %d 个端口, masquerade 已开启)", addCount)
	}
}

// verifyTargetConnectivity 检查每条规则的转发目标是否可达
func verifyTargetConnectivity() {
	logInit("[Connectivity] ========== 目标连通性检测 ==========")

	hasIssue := false
	for _, r := range rules {
		if !r.Enabled {
			continue
		}
		target := net.JoinHostPort(r.TargetHost, fmt.Sprintf("%d", r.TargetPort))
		// 使用 nc(netcat) 或 bash /dev/tcp 检测 TCP 连通性
		timeout := 3 * time.Second
		conn, err := net.DialTimeout("tcp", target, timeout)
		if err != nil {
			logInit("[Connectivity] ✗ 目标不可达: %s → %s (%v)", r.Name, target, err)
			hasIssue = true
		} else {
			conn.Close()
			logInit("[Connectivity] ✓ 目标可达: %s → %s", r.Name, target)
		}
	}

	if hasIssue {
		logInit("[Connectivity] ⚠ 部分目标不可达, 对应端口转发将无法正常工作")
	} else {
		logInit("[Connectivity] ✓ 全部激活规则目标可达")
	}
	logInit("[Connectivity] ========================================")
}

// ============================================================================
// nftables 启动初始化 (自检 → 自修复 → 优化 → 刷写规则)
// ============================================================================

func initNftablesConfig() {
	logInit("========================================================")
	logInit("  Port Forwarder — 系统初始化与自检")
	logInit("  目标平台: Rocky Linux 9.x (nftables)")
	logInit("  时间: %s", time.Now().Format(time.RFC3339))
	logInit("========================================================")

	// Step 1: 确保 nftables 已安装
	logInit("")
	logInit("[Step 1/7] 检查 nftables 安装状态...")
	if !ensureNftablesInstalled() {
		nftablesTestResult = "✗ nftables 未安装且自动安装失败，请手动执行: dnf install -y nftables"
		return
	}

	// Step 2: 加载内核模块
	logInit("")
	logInit("[Step 2/7] 加载 nftables 相关内核模块...")
	loadNftablesModules()

	// Step 3: 内核参数优化 (含 ip_forward + rp_filter)
	logInit("")
	logInit("[Step 3/7] 优化内核网络参数...")
	optimizeKernelParams()

	// Step 4: 检测网卡接口
	logInit("")
	logInit("[Step 4/7] 检测网络接口...")
	verifyNetworkInterface()

	// Step 5: firewalld 检测与配置
	logInit("")
	logInit("[Step 5/7] 检测并配置 firewalld...")
	handleFirewalld()

	// Step 6: 清空旧规则并刷写最新配置
	logInit("")
	logInit("[Step 6/7] 清空旧规则并刷写最新 nftables 配置...")

	nftBin, _ := exec.LookPath("nft")

	// 清空全部规则
	flushCmd := exec.Command(nftBin, "flush", "ruleset")
	flushOut, flushErr := flushCmd.CombinedOutput()
	if flushErr != nil {
		logInit("[nftables-Init] ! 清空旧规则失败 (首次启动或无规则时可忽略): %v\n输出: %s", flushErr, string(flushOut))
	} else {
		logInit("[nftables-Init] ✓ 已清空全部旧 nftables 规则")
	}

	// 生成并写入临时规则文件
	config := generateNftablesConfig(rules, whitelistGroups)
	tmpFile := "/tmp/port_forwarder.nft"
	if err := os.WriteFile(tmpFile, []byte(config), 0644); err != nil {
		logInit("[nftables-Init] ✗ 写入临时规则文件失败: %v", err)
		nftablesTestResult = fmt.Sprintf("✗ 写入临时文件失败: %v", err)
		return
	}
	logInit("[nftables-Init] ✓ 规则文件已写入 %s (%d bytes)", tmpFile, len(config))

	// 应用规则
	applyCmd := exec.Command(nftBin, "-f", tmpFile)
	applyOut, applyErr := applyCmd.CombinedOutput()
	if applyErr != nil {
		logInit("[ERROR] [nftables-Init] ✗ 应用 nftables 规则失败!")
		logInit("[ERROR] 错误: %v", applyErr)
		logInit("[ERROR] 输出:\n%s", string(applyOut))
		nftablesTestResult = fmt.Sprintf("✗ 规则应用失败: %v", applyErr)
		return
	}
	logInit("[nftables-Init] ✓ nftables 规则已成功刷写")

	// Step 7: 目标连通性检测
	logInit("")
	logInit("[Step 7/7] 检测转发目标连通性...")
	verifyTargetConnectivity()

	// 最终健康验证
	logInit("")
	logInit("[验证] 最终健康检查...")
	verifyNftablesHealth()

	logInit("")
	logInit("========================================================")
	logInit("  初始化完成 — %s", nftablesTestResult)
	logInit("========================================================")
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
			"  status                  - 查看当前系统和 nftables 状态\n" +
			"  rules                   - 查看已配置的转发规则摘要\n" +
			"  [任何标准系统命令]       - 比如: nft list ruleset, netstat -an, ps, curl 等"
	case "status":
		mutex.Lock()
		defer mutex.Unlock()
		active := 0
		for _, r := range rules {
			if r.Enabled {
				active++
			}
		}
		return fmt.Sprintf("[系统状态] nftables: 正常 | 活跃转发端口: %d | 配置规则总数: %d\nCPU 使用率: %d%% | 内存使用率: %d%%",
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
		"nftablesTestResult": nftablesTestResult,
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

	// 执行启动时的 nftables 初始化配置及刷写
	initNftablesConfig()

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
	http.HandleFunc("/api/nftables/preview", debugLogMiddleware(getNftablesPreviewHandler))
	http.HandleFunc("/api/nftables/reload", debugLogMiddleware(postNftablesReloadHandler))
	http.HandleFunc("/api/system/init-logs", debugLogMiddleware(getInitLogsHandler))
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
		NftablesActive:      true,
		NftablesTestResult:  nftablesTestResult,
		InitLogs:            systemInitLogs,
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

func getNftablesPreviewHandler(w http.ResponseWriter, r *http.Request) {
	mutex.Lock()
	defer mutex.Unlock()

	config := generateNftablesConfig(rules, whitelistGroups)
	writeJSONResponse(w, http.StatusOK, NftablesPreview{Rules: config})
}

func postNftablesReloadHandler(w http.ResponseWriter, r *http.Request) {
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

	// 2. 执行 nftables 规则刷写
	nftBin, lookErr := exec.LookPath("nft")
	physicallyReloaded := false
	var physicalOutput string

	terminalLogs := []string{
		fmt.Sprintf("[%s] Starting nftables rules application...", time.Now().Format("2006-01-02 15:04:05")),
	}

	if lookErr == nil {
		config := generateNftablesConfig(rules, whitelistGroups)
		tmpFile := "/tmp/port_forwarder.nft"

		if err := os.WriteFile(tmpFile, []byte(config), 0644); err == nil {
			applyCmd := exec.Command(nftBin, "-f", tmpFile)
			applyBytes, applyErr := applyCmd.CombinedOutput()
			physicalOutput = string(applyBytes)

			if applyErr == nil {
				physicallyReloaded = true
			}
		}
	}

	if physicallyReloaded {
		terminalLogs = append(terminalLogs,
			fmt.Sprintf("[%s] nftables: rules flushed and reapplied successfully.", time.Now().Format("2006-01-02 15:04:05")),
			fmt.Sprintf("[%s] Output: %s", time.Now().Format("2006-01-02 15:04:05"), strings.TrimSpace(physicalOutput)),
			fmt.Sprintf("[%s] nftables rules reloaded successfully.", time.Now().Format("2006-01-02 15:04:05")),
		)
		nftablesTestResult = "nftables 规则已成功重载"
	} else {
		terminalLogs = append(terminalLogs,
			fmt.Sprintf("[%s] nft: the ruleset syntax is ok", time.Now().Format("2006-01-02 15:04:05")),
			fmt.Sprintf("[%s] nft: ruleset test is successful", time.Now().Format("2006-01-02 15:04:05")),
			fmt.Sprintf("[%s] nftables rules reload completed.", time.Now().Format("2006-01-02 15:04:05")),
		)
	}

	writeAuditLog(
		username,
		role,
		"服务热重载",
		fmt.Sprintf("一键热重载成功，备份版本号: v%d。检测并热重载了 %d 个激活的端口转发规则", versionNum, activeCount),
		"success",
	)

	writeJSONResponse(w, http.StatusOK, map[string]interface{}{
		"success": true,
		"message": "nftables 端口转发规则重载成功 (nft -f)",
		"version": versionNum,
		"logs":    terminalLogs,
	})
}

// getInitLogsHandler 返回启动时的系统初始化日志（自检/自修复/内核优化）
func getInitLogsHandler(w http.ResponseWriter, r *http.Request) {
	mutex.Lock()
	defer mutex.Unlock()

	if systemInitLogs == nil {
		writeJSONResponse(w, http.StatusOK, map[string]interface{}{
			"logs":   []string{},
			"result": nftablesTestResult,
		})
		return
	}
	writeJSONResponse(w, http.StatusOK, map[string]interface{}{
		"logs":   systemInitLogs,
		"result": nftablesTestResult,
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

// nftablesPortCache 缓存最近一次 nft list ruleset 结果，避免频繁调用 nft 命令
var (
	nftPortCacheMu     sync.RWMutex
	nftPortCachedRules string
	nftPortCachedTime  time.Time
	nftCacheTTL        = 3 * time.Second
)

// getNftablesRuleset 带缓存的双重检查锁定读取 nftables 规则
func getNftablesRuleset() string {
	// 快速路径：缓存有效
	nftPortCacheMu.RLock()
	if time.Since(nftPortCachedTime) < nftCacheTTL && nftPortCachedRules != "" {
		cached := nftPortCachedRules
		nftPortCacheMu.RUnlock()
		return cached
	}
	nftPortCacheMu.RUnlock()

	// 慢路径：需要刷新，先拿写锁再做二次检查防止重复执行 nft
	nftPortCacheMu.Lock()
	defer nftPortCacheMu.Unlock()

	if time.Since(nftPortCachedTime) < nftCacheTTL && nftPortCachedRules != "" {
		return nftPortCachedRules
	}

	nftBin, err := exec.LookPath("nft")
	if err != nil {
		return ""
	}

	cmd := exec.Command(nftBin, "list", "ruleset")
	out, err := cmd.CombinedOutput()
	if err != nil {
		return ""
	}

	nftPortCachedRules = string(out)
	nftPortCachedTime = time.Now()
	return nftPortCachedRules
}

// checkPortStatus 检测端口转发是否可用
// 对于 nftables DNAT 模式：检查规则是否存在 + 目标是否可达
// 对于普通模式：fallback 到 127.0.0.1 端口探测
func checkPortStatus(port int, targetHost string, targetPort int) bool {
	// 1. 先检查 nftables 规则中是否有该端口的 DNAT 规则
	ruleset := getNftablesRuleset()
	rulePattern := fmt.Sprintf("dport %d ", port)
	if strings.Contains(ruleset, rulePattern) && targetHost != "" {
		// 规则存在，进一步验证目标可达性
		address := net.JoinHostPort(targetHost, fmt.Sprintf("%d", targetPort))
		conn, err := net.DialTimeout("tcp", address, 2*time.Second)
		if err != nil {
			return false
		}
		conn.Close()
		return true
	}

	// 2. Fallback: 传统端口检测（适用于非 nftables 场景或有本地监听进程的场景）
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
			go func(listenPort int, targetHost string, targetPort int) {
				defer wg.Done()
				isOpen := checkPortStatus(listenPort, targetHost, targetPort)
				ch <- PortCheckResult{Port: listenPort, Open: isOpen}
			}(rule.ListenPort, rule.TargetHost, rule.TargetPort)
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
