/**
 * CLI flavor detection utility
 * Detects the CLI flavor from device info or show version output
 */

import type { CliFlavor } from '../types/enrichment';

/**
 * Device info structure for flavor detection
 */
export interface DeviceInfo {
  vendor?: string;
  platform?: string;
  version?: string;
}

/**
 * Detect CLI flavor from device info and/or version output
 *
 * Detection rules (in order):
 * 1. vendor contains 'cisco' AND (version contains 'NX-OS' OR platform contains 'Nexus') -> 'cisco-nxos'
 * 2. vendor contains 'cisco' -> 'cisco-ios' (default for Cisco)
 * 3. vendor contains 'juniper' -> 'juniper-junos'
 * 4. vendor contains 'arista' -> 'arista-eos'
 * 5. versionOutput contains 'Linux' OR 'linux' OR 'Ubuntu' OR 'CentOS' -> 'linux'
 * 6. Default: 'cisco-ios' (most common)
 *
 * @param deviceInfo - Device info from show version parsing
 * @param versionOutput - Raw version output string for additional detection
 * @returns Detected CLI flavor
 */
export function detectCliFlavor(
  deviceInfo: DeviceInfo,
  versionOutput?: string
): CliFlavor {
  const vendor = (deviceInfo.vendor || '').toLowerCase();
  const platform = (deviceInfo.platform || '').toLowerCase();
  const version = (deviceInfo.version || '').toLowerCase();
  const output = (versionOutput || '').toLowerCase();

  // Check for Cisco NX-OS (Nexus switches)
  if (vendor.includes('cisco')) {
    if (
      version.includes('nx-os') ||
      platform.includes('nexus') ||
      output.includes('nx-os') ||
      output.includes('nexus')
    ) {
      return 'cisco-nxos';
    }
    // Default Cisco to IOS
    return 'cisco-ios';
  }

  // Check for Juniper
  if (vendor.includes('juniper') || output.includes('junos') || output.includes('juniper')) {
    return 'juniper-junos';
  }

  // Check for Arista
  if (vendor.includes('arista') || output.includes('arista') || output.includes('eos')) {
    return 'arista-eos';
  }

  // Check for Linux from version output
  if (
    output.includes('linux') ||
    output.includes('ubuntu') ||
    output.includes('centos') ||
    output.includes('debian') ||
    output.includes('redhat') ||
    output.includes('fedora') ||
    output.includes('gnu/')
  ) {
    return 'linux';
  }

  // Check platform for additional hints
  if (platform.includes('linux')) {
    return 'linux';
  }

  // Default to cisco-ios as most common
  return 'cisco-ios';
}

/**
 * Detect CLI flavor from version output only
 * Useful when device info is not available
 *
 * @param versionOutput - Raw version output string
 * @returns Detected CLI flavor
 */
export function detectCliFlavorFromOutput(versionOutput: string): CliFlavor {
  return detectCliFlavor({}, versionOutput);
}

/**
 * Get a human-readable name for a CLI flavor
 *
 * @param flavor - CLI flavor identifier
 * @returns Human-readable name
 */
export function getFlavorDisplayName(flavor: CliFlavor): string {
  const names: Record<CliFlavor, string> = {
    auto: 'Auto-Detect',
    'cisco-ios': 'Cisco IOS',
    'cisco-nxos': 'Cisco NX-OS',
    'juniper-junos': 'Juniper JunOS',
    'arista-eos': 'Arista EOS',
    paloalto: 'Palo Alto PAN-OS',
    fortinet: 'Fortinet FortiOS',
    linux: 'Linux',
  };
  return names[flavor] || flavor;
}
