// Terminal watcher hook for building AI context from terminal output
// Supports on-demand (default) and continuous (opt-in) modes

import { useState, useCallback, useRef, useMemo } from 'react';
import type { TerminalContext } from '../api/ai';
import { detectVendor } from '../utils/vendorDetection';

interface UseTerminalWatcherOptions {
  continuous?: boolean;  // Opt-in continuous mode
  bufferLines?: number;  // Lines to keep in buffer (default 50)
}

export function useTerminalWatcher(options: UseTerminalWatcherOptions = {}) {
  const { continuous = false, bufferLines = 50 } = options;
  const [context, setContext] = useState<TerminalContext>({});
  const bufferRef = useRef<string[]>([]);

  // Add output to buffer
  const addOutput = useCallback((output: string) => {
    const lines = output.split('\n');
    bufferRef.current = [...bufferRef.current, ...lines].slice(-bufferLines);

    if (continuous) {
      // Continuous mode: detect on every output
      const vendorInfo = detectVendor(output);
      if (vendorInfo) {
        setContext(prev => ({
          ...prev,
          detectedVendor: vendorInfo.vendor,
          detectedPlatform: vendorInfo.platform,
          hostname: vendorInfo.hostname || prev.hostname,
        }));
      }
    }
  }, [continuous, bufferLines]);

  // Get current context (parses buffer on-demand if not continuous)
  const getContext = useCallback((): TerminalContext => {
    const recentOutput = bufferRef.current.join('\n');

    if (!continuous) {
      // On-demand: parse buffer now
      const vendorInfo = detectVendor(recentOutput);
      return {
        recentOutput,
        detectedVendor: vendorInfo?.vendor,
        detectedPlatform: vendorInfo?.platform,
        hostname: vendorInfo?.hostname,
      };
    }

    return {
      ...context,
      recentOutput,
    };
  }, [continuous, context]);

  // Clear buffer and context
  const clear = useCallback(() => {
    bufferRef.current = [];
    setContext({});
  }, []);

  // Memoize return value to prevent infinite re-render loops
  // when used as dependency in effects
  return useMemo(
    () => ({ addOutput, getContext, clear, context }),
    [addOutput, getContext, clear, context]
  );
}
