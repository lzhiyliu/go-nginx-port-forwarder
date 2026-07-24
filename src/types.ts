export interface ForwardRule {
  id: string;
  name: string;
  listenPort: number;
  targetHost: string;
  targetPort: number;
  protocol: 'TCP' | 'UDP' | 'HTTP' | 'HTTPS';
  enabled: boolean;
  description: string;
  createdAt: string;
  updatedAt: string;
  allowedIps?: string;
  whitelistGroupId?: string;  // 绑定的白名单组 ID
  isPortOpen?: boolean;        // Real-time check result
  urlSuffix?: string;          // URL 路径后缀，如 api/v1
}

export interface WhitelistGroup {
  id: string;
  name: string;
  description: string;
  ips: string;          // IP 列表，空格/逗号/换行分隔
  createdAt: string;
  updatedAt: string;
}

export interface AppSettings {
  localIp: string;
  domain: string;
}

export interface ConfigVersion {
  id: string;
  version: number;
  timestamp: string;
  description: string;
  createdBy: string;
  rulesSnapshot: ForwardRule[];
}

export interface SystemStatus {
  nftablesActive: boolean;
  activePortsCount: number;
  rulesCount: number;
  lastReload: string;
  cpuUsage: number;
  memUsage: number;
  nftablesTestResult?: string;
  initLogs?: string[];
}

