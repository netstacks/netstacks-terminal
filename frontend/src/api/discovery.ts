// Discovery API client — mode-aware calls via getClient()
// Routes to agent (localhost:8080) in standalone, controller in enterprise

import { getClient } from './client';
import type {
  BatchDiscoveryRequest,
  TargetDiscoveryResult,
  TracerouteResolveRequest,
  HopResolutionResult,
  DiscoveryCapabilities,
} from '../types/discovery';

/**
 * Run batch neighbor discovery on multiple targets.
 * POST /api/discovery/batch
 * Returns per-target results with neighbors, method used, and errors.
 */
export async function runBatchDiscovery(
  request: BatchDiscoveryRequest
): Promise<TargetDiscoveryResult[]> {
  const { data } = await getClient().http.post('/discovery/batch', request);
  return data;
}

/**
 * Resolve traceroute hops to parent devices and run neighbor discovery.
 * POST /api/discovery/traceroute-resolve
 * Returns per-hop results with resolution info and discovered neighbors.
 */
export async function resolveTracerouteHops(
  request: TracerouteResolveRequest
): Promise<HopResolutionResult[]> {
  const { data } = await getClient().http.post('/discovery/traceroute-resolve', request);
  return data;
}

/**
 * Check what discovery capabilities are available.
 * GET /api/discovery/capabilities
 * Reports nmap availability, sudo access, and SNMP support.
 */
export async function getDiscoveryCapabilities(): Promise<DiscoveryCapabilities> {
  const { data } = await getClient().http.get('/discovery/capabilities');
  return data;
}
