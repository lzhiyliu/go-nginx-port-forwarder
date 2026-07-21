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
  isPortOpen?: boolean; // Real-time check result
  urlSuffix?: string;   // URL 路径后缀，如 api/v1
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
  nginxActive: boolean;
  activePortsCount: number;
  rulesCount: number;
  lastReload: string;
  cpuUsage: number;
  memUsage: number;
}

