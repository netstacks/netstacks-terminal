/**
 * Topology Enrichment Types
 *
 * Types for progressive enrichment of topology device visualizations.
 * Each device gets enriched with data from DNS, NetBox, Netdisco, LibreNMS,
 * SNMP, ASN, and WHOIS sources.
 */

/** Device classification based on enrichment results */
export type HopClassification = 'managed' | 'external' | 'isp-transit' | 'timeout' | 'unknown';

/** Per-device enrichment data consolidated from all sources */
export interface DeviceEnrichmentResult {
  /** Device ID (key in the devices Map) */
  deviceId: string;
  ip: string | null;

  // DNS
  dnsHostnames: string[];

  // Classification
  classification: HopClassification;

  // Managed device info (NetBox/Netdisco/LibreNMS/SNMP)
  deviceName?: string;
  vendor?: string;
  model?: string;
  platform?: string;
  site?: string;
  role?: string;
  netboxId?: number;
  netboxUrl?: string;

  // Interface mapping
  interfaceName?: string;
  interfaceDescription?: string;

  // SNMP resources
  snmpSysName?: string;
  cpuPercent?: number;
  memoryPercent?: number;
  temperatureCelsius?: number;

  // External network info (WHOIS/ASN)
  asn?: string;
  asnName?: string;
  asnDescription?: string;
  whoisOrg?: string;
  whoisCountry?: string;
  whoisCidr?: string;
  whoisNetworkName?: string;

  // Source tracking
  sources: string[];
  enrichedAt: string;
}

/** Backward-compat alias */
export type HopEnrichment = DeviceEnrichmentResult;

/** Overall enrichment state for a topology */
export interface TopologyEnrichmentState {
  totalCount: number;
  enrichedCount: number;
  status: 'idle' | 'running' | 'complete' | 'error';
  devices: Map<string, DeviceEnrichmentResult>;
  asnZones: AsnZone[];
  error?: string;
}

/** Backward-compat alias */
export type TracerouteEnrichmentState = TopologyEnrichmentState;

/** ASN zone for visual grouping of consecutive same-ASN hops */
export interface AsnZone {
  asn: string;
  name: string;
  startHop: number;
  endHop: number;
  color: string;
}

/** Options for the enrichment engine */
export interface TopologyEnrichmentOptions {
  /** Callback on each device enriched */
  onProgress?: (state: TopologyEnrichmentState) => void;
  /** Enable DNS reverse lookup (default: true) */
  enableDns?: boolean;
  /** Enable WHOIS/ASN lookup (default: true) */
  enableWhois?: boolean;
  /** NetBox configurations (url + token + sourceId) */
  netboxConfigs?: Array<{ url: string; token: string; sourceId?: string }>;
  /** Netdisco source IDs to search */
  netdiscoSourceIds?: string[];
  /** LibreNMS source IDs to search */
  librenmsSourceIds?: string[];
  /** Pre-fetched MCP server objects for enrichment (includes tools) */
  mcpServers?: Array<{
    id: string;
    tools: Array<{
      id: string;
      name: string;
      enabled: boolean;
      input_schema: Record<string, unknown>;
    }>;
  }>;
}

/** Backward-compat alias */
export type TracerouteEnrichmentOptions = TopologyEnrichmentOptions;
