// NetBox DCIM API client for topology import

import { getClient, getCurrentMode } from './client';
import type { CliFlavor } from './sessions';
import type {
  NetBoxConfig,
  NetBoxDeviceFilter,
  Device,
  Connection,
  Topology,
  DeviceType,
} from '../types/topology';
import { mapNetBoxRoleToDeviceType } from '../types/topology';

/**
 * NetBox API device response
 */
export interface NetBoxDevice {
  id: number;
  name: string;
  device_role?: {
    id: number;
    slug: string;
    name: string;
  } | null;
  device_type?: {
    id: number;
    slug: string;
    model: string;
    manufacturer?: {
      id: number;
      slug: string;
      name: string;
    } | null;
  } | null;
  platform?: {
    id: number;
    slug: string;
    name: string;
  } | null;
  primary_ip?: {
    id: number;
    address?: string;
    display?: string;
  } | null;
  site?: {
    id: number;
    slug: string;
    name: string;
  } | null;
  status: {
    value: string;
    label: string;
  };
}

/**
 * NetBox interface response with connected endpoints
 */
export interface NetBoxInterface {
  id: number;
  name: string;
  device: { id: number; name: string };
  type: { value: string; label: string };
  enabled: boolean;
  connected_endpoints?: Array<{
    id: number;
    name: string;
    device: { id: number; name: string };
  }>;
  cable?: { id: number; label: string };
}

/**
 * Simplified neighbor representation for topology building
 */
export interface NetBoxNeighbor {
  deviceId: number;
  deviceName: string;
  localInterface: string;
  remoteInterface: string;
  cableId?: number;
  cableLabel?: string;
}

/**
 * NetBox API cable termination
 */
interface NetBoxTermination {
  object_id: number;
  object_type: string;
  object: {
    id: number;
    device?: {
      id: number;
      name: string;
    };
    name?: string;
  };
}

/**
 * NetBox API cable response
 */
export interface NetBoxCable {
  id: number;
  a_terminations: NetBoxTermination[];
  b_terminations: NetBoxTermination[];
  status: {
    value: string;
    label: string;
  };
  label?: string;
}

/**
 * NetBox paginated response
 */
interface NetBoxPaginatedResponse<T> {
  count: number;
  next: string | null;
  previous: string | null;
  results: T[];
}

/**
 * Build API URL with proper formatting (supports array params)
 */
function buildApiUrl(config: NetBoxConfig, path: string, params?: Record<string, string | string[]>): string {
  const baseUrl = config.url.replace(/\/$/, '');
  const url = new URL(`${baseUrl}/api${path}`);

  if (params) {
    Object.entries(params).forEach(([key, value]) => {
      if (value) {
        if (Array.isArray(value)) {
          // For array values, append each value (NetBox supports ?key=val1&key=val2)
          value.forEach(v => {
            if (v) url.searchParams.append(key, v);
          });
        } else {
          url.searchParams.set(key, value);
        }
      }
    });
  }

  return url.toString();
}

/**
 * Make authenticated API request to NetBox
 */
async function netboxFetch<T>(
  config: NetBoxConfig,
  path: string,
  params?: Record<string, string | string[]>
): Promise<T> {
  const url = buildApiUrl(config, path, params);

  const response = await fetch(url, {
    headers: {
      'Authorization': `Token ${config.token}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(`NetBox API error: ${response.status} ${response.statusText}`);
  }

  return response.json();
}

/**
 * Test NetBox API connectivity (via backend proxy for SSL bypass)
 */
export async function checkNetBoxConnection(config: NetBoxConfig): Promise<boolean> {
  if (getCurrentMode() === 'enterprise') return false;
  try {
    const { data } = await getClient().http.post('/netbox/test', { url: config.url, token: config.token });
    return data.success === true;
  } catch {
    return false;
  }
}

/**
 * Fetch devices from NetBox with multi-value filter support (via backend proxy for SSL bypass)
 */
export async function fetchDevices(
  config: NetBoxConfig,
  filters?: NetBoxDeviceFilter & { name?: string }
): Promise<NetBoxDevice[]> {
  if (getCurrentMode() === 'enterprise') return [];
  const body: {
    url: string;
    token: string;
    name?: string;
    sites?: string[];
    roles?: string[];
    manufacturers?: string[];
    platforms?: string[];
    statuses?: string[];
    tags?: string[];
  } = {
    url: config.url,
    token: config.token,
  };

  // Name filter (exact hostname match)
  if (filters?.name) {
    body.name = filters.name;
  }

  // Site filter (single or multi)
  if (filters?.sites && filters.sites.length > 0) {
    body.sites = filters.sites;
  } else if (filters?.site) {
    body.sites = [filters.site];
  }

  // Role filter (single or multi)
  if (filters?.roles && filters.roles.length > 0) {
    body.roles = filters.roles;
  } else if (filters?.role) {
    body.roles = [filters.role];
  }

  // Manufacturer filter (vendor)
  if (filters?.manufacturers && filters.manufacturers.length > 0) {
    body.manufacturers = filters.manufacturers;
  }

  // Platform filter
  if (filters?.platforms && filters.platforms.length > 0) {
    body.platforms = filters.platforms;
  }

  // Status filter
  if (filters?.statuses && filters.statuses.length > 0) {
    body.statuses = filters.statuses;
  }

  // Tag filter
  if (filters?.tags && filters.tags.length > 0) {
    body.tags = filters.tags;
  }

  const { data: devices } = await getClient().http.post('/netbox/proxy/devices', body);

  // Debug: Log first few devices to see primary_ip structure
  console.log('NetBox devices response (first 3):', devices.slice(0, 3).map((d: any) => ({
    name: d.name,
    primary_ip: d.primary_ip,
    primary_ip4: d.primary_ip4,
    primary_ip6: d.primary_ip6,
  })));
  return devices;
}

/**
 * Fetch a single device from NetBox by exact hostname match.
 * Returns the device data if found, or null if no match.
 */
export async function fetchDeviceByName(
  config: NetBoxConfig,
  hostname: string
): Promise<NetBoxDevice | null> {
  const devices = await fetchDevices(config, { name: hostname });
  return devices.length > 0 ? devices[0] : null;
}

/**
 * Count devices matching filters (for preview) - via backend proxy for SSL bypass
 */
export async function countDevices(
  config: NetBoxConfig,
  filters?: NetBoxDeviceFilter
): Promise<number> {
  if (getCurrentMode() === 'enterprise') return 0;
  const body: {
    url: string;
    token: string;
    sites?: string[];
    roles?: string[];
    manufacturers?: string[];
    platforms?: string[];
    statuses?: string[];
    tags?: string[];
  } = {
    url: config.url,
    token: config.token,
  };

  // Apply filters
  if (filters?.sites && filters.sites.length > 0) {
    body.sites = filters.sites;
  } else if (filters?.site) {
    body.sites = [filters.site];
  }

  if (filters?.roles && filters.roles.length > 0) {
    body.roles = filters.roles;
  } else if (filters?.role) {
    body.roles = [filters.role];
  }

  if (filters?.manufacturers && filters.manufacturers.length > 0) {
    body.manufacturers = filters.manufacturers;
  }

  if (filters?.platforms && filters.platforms.length > 0) {
    body.platforms = filters.platforms;
  }

  if (filters?.statuses && filters.statuses.length > 0) {
    body.statuses = filters.statuses;
  }

  if (filters?.tags && filters.tags.length > 0) {
    body.tags = filters.tags;
  }

  const { data } = await getClient().http.post('/netbox/proxy/devices/count', body);
  return data.count;
}

/**
 * Fetch cables for a set of devices
 */
export async function fetchCables(
  config: NetBoxConfig,
  deviceIds: number[]
): Promise<NetBoxCable[]> {
  if (deviceIds.length === 0) {
    return [];
  }

  // NetBox allows filtering by device_id
  // We may need to make multiple requests for large device sets
  const allCables: NetBoxCable[] = [];
  const chunkSize = 50; // Fetch cables in chunks to avoid URL length limits

  for (let i = 0; i < deviceIds.length; i += chunkSize) {
    const chunk = deviceIds.slice(i, i + chunkSize);

    for (const deviceId of chunk) {
      try {
        const response = await netboxFetch<NetBoxPaginatedResponse<NetBoxCable>>(
          config,
          '/dcim/cables/',
          { device_id: deviceId.toString(), limit: '500' }
        );

        // Add unique cables (avoid duplicates from bidirectional fetch)
        for (const cable of response.results) {
          if (!allCables.find(c => c.id === cable.id)) {
            allCables.push(cable);
          }
        }
      } catch (error) {
        console.warn(`Failed to fetch cables for device ${deviceId}:`, error);
      }
    }
  }

  return allCables;
}

// ============================================================================
// Topology Discovery Functions
// ============================================================================

/**
 * Fetch all pages of a paginated NetBox response
 */
async function fetchAllPages<T>(
  config: NetBoxConfig,
  path: string,
  params?: Record<string, string>
): Promise<T[]> {
  const allResults: T[] = [];
  let nextUrl: string | null = null;

  // First request
  const firstResponse = await netboxFetch<NetBoxPaginatedResponse<T>>(config, path, params);
  allResults.push(...firstResponse.results);
  nextUrl = firstResponse.next;

  // Fetch subsequent pages if any
  while (nextUrl) {
    const response = await fetch(nextUrl, {
      headers: {
        'Authorization': `Token ${config.token}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
    });
    if (!response.ok) {
      throw new Error(`NetBox API error: ${response.status} ${response.statusText}`);
    }
    const data: NetBoxPaginatedResponse<T> = await response.json();
    allResults.push(...data.results);
    nextUrl = data.next;
  }

  return allResults;
}

/**
 * Get interfaces for a device from NetBox
 */
export async function getDeviceInterfaces(
  config: NetBoxConfig,
  deviceId: number
): Promise<NetBoxInterface[]> {
  return fetchAllPages<NetBoxInterface>(config, '/dcim/interfaces/', {
    device_id: deviceId.toString(),
    limit: '500',
  });
}

/**
 * Get cables connected to a device from NetBox
 */
export async function getDeviceCables(
  config: NetBoxConfig,
  deviceId: number
): Promise<NetBoxCable[]> {
  return fetchAllPages<NetBoxCable>(config, '/dcim/cables/', {
    device_id: deviceId.toString(),
    limit: '500',
  });
}

/**
 * Get neighbors (connected devices) for a device
 * Combines interface connected_endpoints and cable data to build neighbor list
 */
export async function getDeviceNeighbors(
  config: NetBoxConfig,
  deviceId: number
): Promise<NetBoxNeighbor[]> {
  const neighbors: NetBoxNeighbor[] = [];
  const seenPairs = new Set<string>(); // Avoid duplicates

  // Approach 1: Get interfaces with connected_endpoints populated
  try {
    const interfaces = await getDeviceInterfaces(config, deviceId);

    for (const iface of interfaces) {
      if (iface.connected_endpoints && iface.connected_endpoints.length > 0) {
        for (const endpoint of iface.connected_endpoints) {
          // Only include if endpoint has a device (skip circuit terminations, etc.)
          if (endpoint.device) {
            const pairKey = `${deviceId}-${endpoint.device.id}-${iface.name}-${endpoint.name}`;
            if (!seenPairs.has(pairKey)) {
              seenPairs.add(pairKey);
              neighbors.push({
                deviceId: endpoint.device.id,
                deviceName: endpoint.device.name,
                localInterface: iface.name,
                remoteInterface: endpoint.name,
                cableId: iface.cable?.id,
                cableLabel: iface.cable?.label,
              });
            }
          }
        }
      }
    }
  } catch (error) {
    console.warn(`Failed to fetch interfaces for device ${deviceId}:`, error);
  }

  // Approach 2: Fallback to cables if interfaces didn't have connected_endpoints
  if (neighbors.length === 0) {
    try {
      const cables = await getDeviceCables(config, deviceId);

      for (const cable of cables) {
        // Find our device's termination and the remote termination
        const aTermination = cable.a_terminations[0];
        const bTermination = cable.b_terminations[0];

        if (!aTermination || !bTermination) continue;

        // Determine which side is ours and which is the neighbor
        let localTerm = aTermination;
        let remoteTerm = bTermination;

        if (bTermination.object?.device?.id === deviceId) {
          localTerm = bTermination;
          remoteTerm = aTermination;
        }

        // Skip if remote doesn't have device (circuit termination, etc.)
        if (!remoteTerm.object?.device?.id) continue;

        const pairKey = `${deviceId}-${remoteTerm.object.device.id}-${localTerm.object?.name || ''}-${remoteTerm.object?.name || ''}`;
        if (!seenPairs.has(pairKey)) {
          seenPairs.add(pairKey);
          neighbors.push({
            deviceId: remoteTerm.object.device.id,
            deviceName: remoteTerm.object.device.name,
            localInterface: localTerm.object?.name || 'unknown',
            remoteInterface: remoteTerm.object?.name || 'unknown',
            cableId: cable.id,
            cableLabel: cable.label,
          });
        }
      }
    } catch (error) {
      console.warn(`Failed to fetch cables for device ${deviceId}:`, error);
    }
  }

  return neighbors;
}

/**
 * Map NetBox device status to our DeviceStatus
 */
function mapNetBoxStatus(status?: string | null): Device['status'] {
  if (!status) return 'unknown';
  switch (status.toLowerCase()) {
    case 'active':
      return 'online';
    case 'offline':
    case 'failed':
    case 'decommissioning':
      return 'offline';
    case 'planned':
    case 'staged':
      return 'warning';
    default:
      return 'unknown';
  }
}

/**
 * Calculate device positions in a grid layout
 */
function calculateDevicePositions(devices: Device[]): void {
  // Group devices by type for layout
  const groups: Record<DeviceType, Device[]> = {
    'cloud': [],
    'firewall': [],
    'router': [],
    'switch': [],
    'server': [],
    'access-point': [],
    'load-balancer': [],
    'wan-optimizer': [],
    'voice-gateway': [],
    'wireless-controller': [],
    'storage': [],
    'virtual': [],
    'sd-wan': [],
    'iot': [],
    'unknown': [],
  };

  devices.forEach(device => {
    groups[device.type].push(device);
  });

  // Layout parameters
  const rows: DeviceType[] = ['cloud', 'firewall', 'router', 'switch', 'server', 'access-point', 'unknown'];
  const rowHeight = 1000 / (rows.length + 1);

  rows.forEach((type, rowIndex) => {
    const rowDevices = groups[type];
    if (rowDevices.length === 0) return;

    const y = (rowIndex + 1) * rowHeight;
    const colWidth = 1000 / (rowDevices.length + 1);

    rowDevices.forEach((device, colIndex) => {
      device.x = (colIndex + 1) * colWidth;
      device.y = y;
    });
  });
}

/**
 * Import topology from NetBox DCIM
 */
export async function importTopologyFromNetBox(
  config: NetBoxConfig,
  siteFilter?: string
): Promise<Topology> {
  // Fetch devices
  const netboxDevices = await fetchDevices(config, {
    site: siteFilter,
  });

  // Transform to our Device format
  const devices: Device[] = netboxDevices.map(nbDevice => ({
    id: `netbox-${nbDevice.id}`,
    name: nbDevice.name,
    type: mapNetBoxRoleToDeviceType(nbDevice.device_role?.slug),
    status: mapNetBoxStatus(nbDevice.status?.value),
    x: 0, // Will be calculated
    y: 0, // Will be calculated
    netboxId: nbDevice.id,
    site: nbDevice.site?.name,
    role: nbDevice.device_role?.name,
    platform: nbDevice.platform?.name,
    primaryIp: (nbDevice.primary_ip?.address || nbDevice.primary_ip?.display)?.split('/')[0], // Remove CIDR notation
  }));

  // Calculate positions
  calculateDevicePositions(devices);

  // Fetch cables
  const deviceIds = netboxDevices.map(d => d.id);
  const cables = await fetchCables(config, deviceIds);

  // Transform cables to connections
  const deviceIdMap = new Map(devices.map(d => [d.netboxId, d.id]));
  const connections: Connection[] = [];

  for (const cable of cables) {
    // Get device IDs from terminations
    const aTermination = cable.a_terminations[0];
    const bTermination = cable.b_terminations[0];

    if (!aTermination?.object?.device?.id || !bTermination?.object?.device?.id) {
      continue; // Skip non-device terminations
    }

    const sourceDeviceId = deviceIdMap.get(aTermination.object.device.id);
    const targetDeviceId = deviceIdMap.get(bTermination.object.device.id);

    if (!sourceDeviceId || !targetDeviceId) {
      continue; // Device not in our topology
    }

    connections.push({
      id: `cable-${cable.id}`,
      sourceDeviceId,
      targetDeviceId,
      sourceInterface: aTermination.object.name,
      targetInterface: bTermination.object.name,
      status: cable.status.value === 'connected' ? 'active' : 'inactive',
      label: cable.label,
      cableId: cable.id.toString(),
    });
  }

  const now = new Date().toISOString();

  return {
    id: `netbox-${Date.now()}`,
    name: siteFilter ? `NetBox: ${siteFilter}` : 'NetBox Import',
    devices,
    connections,
    source: 'netbox',
    siteFilter,
    createdAt: now,
    updatedAt: now,
  };
}

// ============================================================================
// Session Import Functions
// ============================================================================

/**
 * NetBox site response
 */
export interface NetBoxSite {
  id: number;
  slug: string;
  name: string;
}

/**
 * NetBox device role response
 */
export interface NetBoxRole {
  id: number;
  slug: string;
  name: string;
}

/**
 * NetBox manufacturer response
 */
export interface NetBoxManufacturer {
  id: number;
  slug: string;
  name: string;
}

/**
 * NetBox platform response
 */
export interface NetBoxPlatform {
  id: number;
  slug: string;
  name: string;
}

/**
 * NetBox tag response
 */
export interface NetBoxTag {
  id: number;
  slug: string;
  name: string;
  color: string;
}

/**
 * Session import result
 */
export interface SessionImportResult {
  sessions_created: number;
  folders_created: number;
  skipped: number;
  warnings: string[];
}

/**
 * Session import filter options (supports single or multi-value)
 */
export interface SessionImportFilter {
  /** Single site slug (legacy) */
  site?: string;
  /** Multiple site slugs */
  sites?: string[];
  /** Single role slug (legacy) */
  role?: string;
  /** Multiple role slugs */
  roles?: string[];
  /** Manufacturer slugs */
  manufacturers?: string[];
  /** Platform slugs */
  platforms?: string[];
  /** Status values */
  statuses?: string[];
  /** Tag slugs */
  tags?: string[];
}

/**
 * Fetch available sites from NetBox (via backend proxy for SSL bypass)
 */
export async function fetchSites(config: NetBoxConfig): Promise<NetBoxSite[]> {
  if (getCurrentMode() === 'enterprise') return [];
  const { data } = await getClient().http.post('/netbox/proxy/sites', { url: config.url, token: config.token });
  return data;
}

/**
 * Fetch available device roles from NetBox (via backend proxy)
 */
export async function fetchRoles(config: NetBoxConfig): Promise<NetBoxRole[]> {
  if (getCurrentMode() === 'enterprise') return [];
  const { data } = await getClient().http.post('/netbox/proxy/roles', { url: config.url, token: config.token });
  return data;
}

/**
 * Fetch available manufacturers (vendors) from NetBox (via backend proxy)
 */
export async function fetchManufacturers(config: NetBoxConfig): Promise<NetBoxManufacturer[]> {
  if (getCurrentMode() === 'enterprise') return [];
  const { data } = await getClient().http.post('/netbox/proxy/manufacturers', { url: config.url, token: config.token });
  return data;
}

/**
 * Fetch available platforms from NetBox (via backend proxy)
 */
export async function fetchPlatforms(config: NetBoxConfig): Promise<NetBoxPlatform[]> {
  if (getCurrentMode() === 'enterprise') return [];
  const { data } = await getClient().http.post('/netbox/proxy/platforms', { url: config.url, token: config.token });
  return data;
}

/**
 * Fetch available tags from NetBox (via backend proxy)
 */
export async function fetchTags(config: NetBoxConfig): Promise<NetBoxTag[]> {
  if (getCurrentMode() === 'enterprise') return [];
  const { data } = await getClient().http.post('/netbox/proxy/tags', { url: config.url, token: config.token });
  return data;
}

/**
 * NetBox device status values (fixed list)
 */
export const NETBOX_DEVICE_STATUSES = [
  { value: 'active', label: 'Active' },
  { value: 'planned', label: 'Planned' },
  { value: 'staged', label: 'Staged' },
  { value: 'failed', label: 'Failed' },
  { value: 'inventory', label: 'Inventory' },
  { value: 'decommissioning', label: 'Decommissioning' },
  { value: 'offline', label: 'Offline' },
];

/**
 * Source configuration for import (from saved NetBox source)
 */
export interface ImportSourceConfig {
  sourceId: string;
  defaultProfileId: string | null;
  profileMappings: {
    by_site: Record<string, string>;
    by_role: Record<string, string>;
  };
}

/**
 * Resolve profile ID for a device based on source profile mappings
 * Priority: role mapping > site mapping > default profile
 */
function resolveProfileId(
  device: { site?: { slug: string } | null; device_role?: { slug: string } | null },
  sourceConfig: ImportSourceConfig | null
): string | null {
  if (!sourceConfig) return null;

  // Check role mapping first (higher priority)
  const roleSlug = device.device_role?.slug;
  if (roleSlug && sourceConfig.profileMappings.by_role[roleSlug]) {
    return sourceConfig.profileMappings.by_role[roleSlug];
  }

  // Check site mapping
  const siteSlug = device.site?.slug;
  if (siteSlug && sourceConfig.profileMappings.by_site[siteSlug]) {
    return sourceConfig.profileMappings.by_site[siteSlug];
  }

  // Fall back to default profile
  return sourceConfig.defaultProfileId;
}

/**
 * Existing session info for duplicate detection
 */
interface ExistingSession {
  id: string;
  name: string;
  host: string;
  netbox_device_id: number | null;
  netbox_source_id: string | null;
}

/**
 * Infer CLI flavor from NetBox device manufacturer/platform
 * Uses manufacturer name from device_type for network devices
 */
function inferCliFlavor(device: NetBoxDevice): CliFlavor {
  // Check manufacturer from device_type first
  const manufacturer = device.device_type?.manufacturer?.slug?.toLowerCase() ||
                       device.device_type?.manufacturer?.name?.toLowerCase() || '';

  // Check platform slug/name as fallback
  const platform = device.platform?.slug?.toLowerCase() ||
                   device.platform?.name?.toLowerCase() || '';

  // Cisco detection
  if (manufacturer.includes('cisco') || platform.includes('cisco')) {
    if (platform.includes('nxos') || platform.includes('nx-os') ||
        manufacturer.includes('nexus') || device.device_type?.model?.toLowerCase().includes('nexus')) {
      return 'cisco-nxos';
    }
    return 'cisco-ios';
  }

  // Juniper detection
  if (manufacturer.includes('juniper') || platform.includes('junos') || platform.includes('juniper')) {
    return 'juniper-junos';
  }

  // Arista detection
  if (manufacturer.includes('arista') || platform.includes('arista') || platform.includes('eos')) {
    return 'arista-eos';
  }

  // Palo Alto detection
  if (manufacturer.includes('palo') || manufacturer.includes('paloalto') ||
      platform.includes('panos') || platform.includes('pan-os')) {
    return 'paloalto';
  }

  // Fortinet detection
  if (manufacturer.includes('fortinet') || platform.includes('fortios') || platform.includes('forti')) {
    return 'fortinet';
  }

  // Linux/server detection based on role
  const role = device.device_role?.slug?.toLowerCase() || '';
  if (role.includes('server') || role.includes('linux') || role.includes('vm')) {
    return 'linux';
  }

  // Default to auto-detect
  return 'auto';
}

/**
 * Import NetBox devices as NetStacks sessions
 */
export async function importDevicesAsSessions(
  config: NetBoxConfig,
  filters: SessionImportFilter,
  createSessionFn: (session: {
    name: string;
    host: string;
    folder_id?: string | null;
    profile_id: string;
    netbox_device_id?: number | null;
    netbox_source_id?: string | null;
    cli_flavor?: CliFlavor;
  }) => Promise<{ id: string }>,
  createFolderFn: (name: string) => Promise<{ id: string }>,
  listFoldersFn: () => Promise<{ id: string; name: string }[]>,
  sourceConfig: ImportSourceConfig,
  listSessionsFn?: () => Promise<ExistingSession[]>
): Promise<SessionImportResult> {
  const result: SessionImportResult = {
    sessions_created: 0,
    folders_created: 0,
    skipped: 0,
    warnings: [],
  };

  // Fetch devices from NetBox
  const devices = await fetchDevices(config, filters);

  // Filter to only devices with primary_ip (check both address and display fields)
  const devicesWithIp = devices.filter(device => {
    const ipAddress = device.primary_ip?.address || device.primary_ip?.display;
    if (!ipAddress) {
      result.skipped++;
      result.warnings.push(`Skipped ${device.name}: no primary IP`);
      return false;
    }
    return true;
  });

  if (devicesWithIp.length === 0) {
    return result;
  }

  // Get existing folders
  const existingFolders = await listFoldersFn();
  const folderMap = new Map(existingFolders.map(f => [f.name, f.id]));

  // Get existing sessions for duplicate detection
  const existingSessions = listSessionsFn ? await listSessionsFn() : [];

  // Build lookup maps for duplicate detection
  // Map by netbox_device_id + netbox_source_id (for re-sync detection)
  const sessionsByNetBoxId = new Map<string, ExistingSession>();
  // Map by name + host (for fallback duplicate detection)
  const sessionsByNameHost = new Map<string, ExistingSession>();

  for (const session of existingSessions) {
    // Key by NetBox device ID if present
    if (session.netbox_device_id && session.netbox_source_id) {
      sessionsByNetBoxId.set(`${session.netbox_source_id}:${session.netbox_device_id}`, session);
    }
    // Key by name + host for fallback detection
    sessionsByNameHost.set(`${session.name}:${session.host}`, session);
  }

  // Group devices by site
  const devicesBySite = new Map<string, typeof devicesWithIp>();
  for (const device of devicesWithIp) {
    const siteName = device.site?.name || 'Unsorted';
    if (!devicesBySite.has(siteName)) {
      devicesBySite.set(siteName, []);
    }
    devicesBySite.get(siteName)!.push(device);
  }

  // Create folders and sessions
  for (const [siteName, siteDevices] of devicesBySite) {
    // Create folder if it doesn't exist
    let folderId = folderMap.get(siteName);
    if (!folderId) {
      try {
        const folder = await createFolderFn(siteName);
        folderId = folder.id;
        folderMap.set(siteName, folderId);
        result.folders_created++;
      } catch (error) {
        result.warnings.push(`Failed to create folder ${siteName}: ${error}`);
        continue;
      }
    }

    // Create sessions for each device
    for (const device of siteDevices) {
      try {
        // Strip CIDR notation from IP (e.g., "192.168.1.1/24" -> "192.168.1.1")
        // Use address field, fall back to display field
        const ipValue = device.primary_ip!.address || device.primary_ip!.display || '';
        const host = ipValue.split('/')[0];

        // Check for existing session (duplicate detection)
        let existingSession: ExistingSession | undefined;

        // First, check by NetBox device ID (most reliable for re-syncs)
        if (sourceConfig) {
          const netboxKey = `${sourceConfig.sourceId}:${device.id}`;
          existingSession = sessionsByNetBoxId.get(netboxKey);
        }

        // Fallback: check by name + host
        if (!existingSession) {
          const nameHostKey = `${device.name}:${host}`;
          existingSession = sessionsByNameHost.get(nameHostKey);
        }

        if (existingSession) {
          // Session already exists - skip it
          result.skipped++;
          result.warnings.push(`Skipped ${device.name}: session already exists`);
          continue;
        }

        // Resolve profile ID from source mappings
        const profileId = resolveProfileId(device, sourceConfig);

        // Profile is required - skip if no profile can be resolved
        if (!profileId) {
          result.skipped++;
          result.warnings.push(`Skipped ${device.name}: no credential profile configured`);
          continue;
        }

        // Infer CLI flavor from device manufacturer/platform
        const cliFlavor = inferCliFlavor(device);

        await createSessionFn({
          name: device.name,
          host,
          folder_id: folderId,
          profile_id: profileId,
          netbox_device_id: device.id,
          netbox_source_id: sourceConfig.sourceId,
          cli_flavor: cliFlavor,
        });
        result.sessions_created++;
      } catch (error) {
        result.warnings.push(`Failed to create session for ${device.name}: ${error}`);
      }
    }
  }

  return result;
}

// === IP Address Lookup (for traceroute enrichment) ===

/**
 * NetBox IP address result from IPAM search
 */
export interface NetBoxIpAddress {
  id: number;
  address: string;
  assigned_object?: {
    id: number;
    name: string;
    device?: { id: number; name: string };
  } | null;
}

/**
 * Search NetBox IPAM for an IP address.
 * Returns the IP address record with assigned device and interface info.
 * Uses backend proxy for SSL bypass.
 */
export async function fetchIpAddress(
  config: NetBoxConfig,
  ipAddress: string
): Promise<NetBoxIpAddress | null> {
  if (getCurrentMode() === 'enterprise') return null;
  try {
    const { data } = await getClient().http.post('/netbox/proxy/ip-addresses', {
      url: config.url,
      token: config.token,
      address: ipAddress,
    });

    if (!data || data === null) return null;

    return data as NetBoxIpAddress;
  } catch {
    return null;
  }
}
