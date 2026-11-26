import { z } from 'zod';
import { PortProtocolSchema } from './game-template.js';

export const PortExposureSchema = z.enum(['required', 'optional_query', 'internal_only']);
export type PortExposure = z.infer<typeof PortExposureSchema>;

export interface InstancePortGuideEntry {
  key: string;
  label: string;
  port: number;
  defaultPort: number;
  protocol: z.infer<typeof PortProtocolSchema>;
  exposure: PortExposure;
  internalOnly: boolean;
  primary: boolean;
  note?: string;
}

export interface NetworkPrerequisiteItem {
  id: string;
  label: string;
  status: 'pass' | 'warn' | 'fail';
  detail: string;
}

export interface InstanceNetworkGuide {
  instanceId: string;
  instanceName: string;
  gameId: string;
  lanIp: string | null;
  publicIp: string | null;
  effectiveHost: string;
  ports: InstancePortGuideEntry[];
  routerNotes: string[];
  copyableRouterText: string;
  prerequisites: NetworkPrerequisiteItem[];
}

export interface FirewallPortStatus {
  key: string;
  label: string;
  port: number;
  protocol: z.infer<typeof PortProtocolSchema>;
  internalOnly: boolean;
  tcpAllowed: boolean;
  udpAllowed: boolean;
  ruleNames: string[];
  blockedByAppRule: boolean;
  exposedInternalWarning: boolean;
}

export type WindowsNetworkProfileKind = 'Private' | 'Public' | 'DomainAuthenticated' | 'Unknown';

export interface FirewallStatus {
  platform: string;
  supported: boolean;
  isAdmin: boolean;
  networkProfile: WindowsNetworkProfileKind;
  profileName: string | null;
  publicProfileWarning: boolean;
  internalExposureWarnings: string[];
  appBlockWarnings: string[];
  ports: FirewallPortStatus[];
  managedRulePrefix: string;
  scriptContent: string;
  scriptFilename: string;
}

export const FirewallApplyInputSchema = z.object({
  switchProfileToPrivate: z.boolean().optional().default(false),
});
export type FirewallApplyInput = z.input<typeof FirewallApplyInputSchema>;

export interface FirewallApplyResult {
  ok: boolean;
  method: 'direct' | 'uac' | 'manual';
  message: string;
  status: FirewallStatus;
}

export interface FirewallRemoveResult {
  ok: boolean;
  removedCount: number;
  message: string;
}

export type ConnectivityHopStatus = 'pass' | 'warn' | 'fail' | 'skip';

export interface ConnectivityHop {
  id: 'process_bind' | 'firewall' | 'lan_ip' | 'nat_cgnat' | 'wan_probe';
  label: string;
  status: ConnectivityHopStatus;
  summary: string;
  detail?: string;
  fixHint?: string;
  actionId?: 'open_firewall' | 'switch_private' | 'start_server' | 'configure_public_host';
}

export type WanProbePortState =
  | 'open'
  | 'closed'
  | 'timeout'
  | 'udp_unverifiable'
  | 'probe_unavailable';

export interface WanPortProbeResult {
  key: string;
  label: string;
  port: number;
  protocol: z.infer<typeof PortProtocolSchema>;
  reachable: boolean | null;
  status: WanProbePortState;
  detail: string;
  nodesChecked: number;
}

export interface InstanceConnectivityReport {
  instanceId: string;
  checkedAt: string;
  overallStatus: 'pass' | 'warn' | 'fail';
  publicIp: string | null;
  lanIp: string | null;
  effectiveHost: string;
  hops: ConnectivityHop[];
  wanProbes: WanPortProbeResult[];
}

export interface ConsolidatedPortMapEntry {
  instanceId: string;
  instanceName: string;
  gameId: string;
  instanceStatus: string;
  portKey: string;
  label: string;
  port: number;
  protocol: z.infer<typeof PortProtocolSchema>;
  internalOnly: boolean;
  primary: boolean;
  conflictWith: string[];
}
