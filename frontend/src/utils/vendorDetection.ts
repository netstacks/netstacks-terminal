// Vendor detection utility - simplified
// Device type should be set in session settings, not auto-detected

export interface VendorInfo {
  vendor: string;
  platform?: string;
  hostname?: string;
}

/**
 * Detect vendor from terminal output
 * Returns null - device type should come from session settings
 */
export function detectVendor(_output: string): VendorInfo | null {
  return null;
}

/**
 * Extract hostname from terminal output
 */
export function detectHostname(_output: string): string | undefined {
  return undefined;
}
