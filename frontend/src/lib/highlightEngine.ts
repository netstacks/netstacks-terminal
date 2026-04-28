/**
 * HighlightEngine - Real-time keyword highlighting for xterm.js terminals
 *
 * This engine manages highlight rules and applies decorations to matching text
 * in the terminal buffer. It uses xterm.js decoration API and dynamic CSS injection.
 *
 * Also handles detection-style decorations (underline + hover + data-attributes)
 * for network identifiers, merging them with user highlight rules into single
 * decorations per text range.
 */

import type { Terminal, IDecoration } from '@xterm/xterm'
import type { HighlightRule } from '../api/highlightRules'
import { getEffectiveHighlightRules, listHighlightRules } from '../api/highlightRules'

/**
 * Represents a match found in the terminal buffer
 */
export interface Match {
  rule: HighlightRule
  line: number           // Absolute buffer line
  viewportRow: number    // Row index within visible viewport (0-based)
  startColumn: number
  endColumn: number
}

/**
 * Result from pattern matching within a line
 */
interface MatchResult {
  start: number
  end: number
}

/**
 * Extra properties for detection-style rules (underline, hover, data attributes)
 */
export interface DetectionRuleExtras {
  detectionType: string    // 'ipv4', 'mac', etc.
  borderStyle: string      // '1px dotted rgba(100,180,255,0.8)'
  cursor: string           // 'context-menu'
  tooltipPrefix: string    // 'Right-click for {type} options'
}

/**
 * Options for the HighlightEngine
 */
export interface HighlightEngineOptions {
  /** Debounce interval for scanning in milliseconds */
  scanDebounceMs?: number
  /** Maximum matches per scan to avoid performance issues */
  maxMatchesPerScan?: number
  /** Use requestIdleCallback for non-blocking scans (default: true) */
  useIdleCallback?: boolean
}

const DEFAULT_OPTIONS: Required<HighlightEngineOptions> = {
  scanDebounceMs: 100,
  maxMatchesPerScan: 500,
  useIdleCallback: true,
}

/**
 * HighlightEngine manages highlight rules and applies decorations
 * to matching text in an xterm.js terminal
 */
export class HighlightEngine {
  private terminal: Terminal
  private sessionId: string | undefined
  private rules: HighlightRule[] = []
  private decorations: IDecoration[] = []
  private adHocDecorations: IDecoration[] = []
  private styleElement: HTMLStyleElement | null = null
  private options: Required<HighlightEngineOptions>
  private scanDebounceTimer: number | null = null
  private idleCallbackId: number | null = null
  private destroyed = false

  // Cache compiled regex patterns for performance
  private compiledPatterns: Map<string, RegExp> = new Map()

  // Detection rule extras — keyed by rule ID
  private detectionExtras: Map<string, DetectionRuleExtras> = new Map()
  // Detection rules stored separately (merged into scan alongside user rules)
  private detectionRules: HighlightRule[] = []
  private detectionEnabled = false

  constructor(
    terminal: Terminal,
    sessionId?: string,
    options?: HighlightEngineOptions
  ) {
    this.terminal = terminal
    this.sessionId = sessionId
    this.options = { ...DEFAULT_OPTIONS, ...options }
  }

  /**
   * Load rules from API (effective rules for session or global rules)
   */
  async loadRules(): Promise<void> {
    if (this.destroyed) return

    try {
      if (this.sessionId) {
        this.rules = await getEffectiveHighlightRules(this.sessionId)
      } else {
        // For local terminal, just get global rules
        this.rules = (await listHighlightRules()).filter(
          r => r.session_id === null && r.enabled
        )
      }
      // Filter to only enabled rules and sort by priority
      this.rules = this.rules
        .filter(r => r.enabled)
        .sort((a, b) => a.priority - b.priority)

      // Pre-compile patterns
      this.compilePatterns()

      // Inject CSS styles for rules
      this.injectStyles()

      // Scan visible buffer with new rules
      this.scanBuffer()
    } catch (err) {
      console.error('Failed to load highlight rules:', err)
    }
  }

  /**
   * Set rules directly (for live updates without API fetch)
   */
  setRules(rules: HighlightRule[]): void {
    if (this.destroyed) return

    this.rules = rules
      .filter(r => r.enabled)
      .sort((a, b) => a.priority - b.priority)

    this.compilePatterns()
    this.injectStyles()
    this.scanBuffer()
  }

  /**
   * Set detection rules with their interactive extras.
   * Detection rules produce underline + hover + data-attribute styling
   * in addition to any color from their HighlightRule definition.
   * When both a user highlight rule and a detection rule match the same
   * text range, they are merged into a single decoration.
   */
  setDetectionRules(rules: HighlightRule[], extras: Map<string, DetectionRuleExtras>): void {
    if (this.destroyed) return

    this.detectionRules = rules
      .filter(r => r.enabled)
      .sort((a, b) => a.priority - b.priority)
    this.detectionExtras = extras
    this.detectionEnabled = true

    // Recompile all patterns (user + detection)
    this.compilePatterns()
    this.injectStyles()
    this.scanBuffer()
  }

  /**
   * Disable detection rules (removes underlines but keeps user highlight colors)
   */
  clearDetectionRules(): void {
    this.detectionRules = []
    this.detectionExtras.clear()
    this.detectionEnabled = false

    this.compilePatterns()
    this.injectStyles()
    this.scanBuffer()
  }

  /**
   * Scan visible buffer lines for matches and apply decorations
   */
  scanBuffer(): void {
    if (this.destroyed) return

    // If no rules remain, just clear existing decorations and return
    const hasRules = this.rules.length > 0 || this.detectionRules.length > 0
    if (!hasRules) {
      this.clearRuleDecorations()
      return
    }

    // Cancel any pending scans
    if (this.scanDebounceTimer !== null) {
      window.clearTimeout(this.scanDebounceTimer)
      this.scanDebounceTimer = null
    }
    if (this.idleCallbackId !== null && 'cancelIdleCallback' in window) {
      window.cancelIdleCallback(this.idleCallbackId)
      this.idleCallbackId = null
    }

    // Debounce scanning
    this.scanDebounceTimer = window.setTimeout(() => {
      this.scanDebounceTimer = null
      // Use requestIdleCallback for non-blocking scans if available and enabled
      if (this.options.useIdleCallback && 'requestIdleCallback' in window) {
        this.idleCallbackId = window.requestIdleCallback(
          () => {
            this.idleCallbackId = null
            this.performScan()
          },
          { timeout: 200 } // Max wait time before forcing scan
        )
      } else {
        this.performScan()
      }
    }, this.options.scanDebounceMs)
  }

  /**
   * Actually perform the buffer scan
   */
  private performScan(): void {
    if (this.destroyed) return

    // Clear existing decorations first (but not ad-hoc)
    this.clearRuleDecorations()

    const buffer = this.terminal.buffer.active
    const viewportY = buffer.viewportY
    const rows = this.terminal.rows

    // All rules to scan: user rules + detection rules
    const allRules = [...this.rules, ...this.detectionRules]

    // Collect all matches, keyed by "line:start:end" for merging
    const matchMap = new Map<string, {
      highlightRule: HighlightRule | null  // User highlight rule (color source)
      detectionRule: HighlightRule | null  // Detection rule (underline source)
      line: number
      viewportRow: number
      startColumn: number
      endColumn: number
    }>()

    let totalMatches = 0

    // Scan visible viewport lines
    for (let i = 0; i < rows && totalMatches < this.options.maxMatchesPerScan; i++) {
      const lineIndex = viewportY + i
      const line = buffer.getLine(lineIndex)
      if (!line) continue

      const text = line.translateToString(true)
      if (!text.trim()) continue

      // Check each rule against the line
      for (const rule of allRules) {
        const lineMatches = this.matchPattern(text, rule)
        const isDetectionRule = this.detectionExtras.has(rule.id)

        for (const match of lineMatches) {
          if (totalMatches >= this.options.maxMatchesPerScan) break

          const key = `${lineIndex}:${match.start}:${match.end}`
          const existing = matchMap.get(key)

          if (existing) {
            // Merge: if this is a detection rule, add detection; if highlight, add highlight
            if (isDetectionRule && !existing.detectionRule) {
              existing.detectionRule = rule
            } else if (!isDetectionRule && !existing.highlightRule) {
              existing.highlightRule = rule
            }
          } else {
            matchMap.set(key, {
              highlightRule: isDetectionRule ? null : rule,
              detectionRule: isDetectionRule ? rule : null,
              line: lineIndex,
              viewportRow: i,
              startColumn: match.start,
              endColumn: match.end,
            })
            totalMatches++
          }
        }
      }
    }

    // Apply merged decorations
    this.applyMergedDecorations(matchMap)
  }

  /**
   * Match a pattern against text and return all match positions
   */
  private matchPattern(text: string, rule: HighlightRule): MatchResult[] {
    const results: MatchResult[] = []
    const pattern = this.compiledPatterns.get(rule.id)
    if (!pattern) {
      return results
    }

    // Reset lastIndex for global patterns
    pattern.lastIndex = 0

    let match
    while ((match = pattern.exec(text)) !== null) {
      results.push({
        start: match.index,
        end: match.index + match[0].length,
      })

      // Prevent infinite loops with zero-length matches
      if (match[0].length === 0) {
        pattern.lastIndex++
      }
    }

    return results
  }

  /**
   * Compile all rule patterns (user + detection) into RegExp objects
   */
  private compilePatterns(): void {
    this.compiledPatterns.clear()

    const allRules = [...this.rules, ...this.detectionRules]

    for (const rule of allRules) {
      // Skip if already compiled (detection rule might duplicate a user rule pattern)
      if (this.compiledPatterns.has(rule.id)) continue

      try {
        let pattern: string
        let flags = 'g'

        if (!rule.case_sensitive) {
          flags += 'i'
        }

        if (rule.is_regex) {
          pattern = rule.pattern
        } else {
          // Escape special regex characters for literal matching
          pattern = rule.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        }

        // Apply whole word boundary if needed
        // Note: Skip if pattern already has word boundaries (is_regex + whole_word)
        if (rule.whole_word && !rule.is_regex) {
          pattern = `\\b${pattern}\\b`
        }

        const compiledRegex = new RegExp(pattern, flags)
        this.compiledPatterns.set(rule.id, compiledRegex)
      } catch (err) {
        console.warn(`Invalid pattern for rule ${rule.name}:`, err)
      }
    }
  }

  /**
   * Apply merged decorations (highlight color + detection underline in one element)
   */
  private applyMergedDecorations(matchMap: Map<string, {
    highlightRule: HighlightRule | null
    detectionRule: HighlightRule | null
    line: number
    viewportRow: number
    startColumn: number
    endColumn: number
  }>): void {
    if (this.destroyed) return

    for (const entry of matchMap.values()) {
      try {
        const buffer = this.terminal.buffer.active
        const markerOffset = entry.viewportRow - buffer.cursorY
        const marker = this.terminal.registerMarker(markerOffset)
        if (!marker) continue

        // Determine colors: user highlight rule wins for foreground/background
        const colorRule = entry.highlightRule || entry.detectionRule
        const decorationOptions: Parameters<typeof this.terminal.registerDecoration>[0] = {
          marker,
          x: entry.startColumn,
          width: entry.endColumn - entry.startColumn,
          overviewRulerOptions: {
            color: colorRule?.foreground || colorRule?.background || '#ffffff',
          },
        }

        // Add foreground/background from the color source rule
        if (colorRule?.foreground) {
          (decorationOptions as any).foregroundColor = colorRule.foreground
        }
        if (colorRule?.background) {
          (decorationOptions as any).backgroundColor = colorRule.background
        }

        const decoration = this.terminal.registerDecoration(decorationOptions)

        if (decoration) {
          // If there's a detection rule, apply interactive styling via onRender
          const detectionExtras = entry.detectionRule
            ? this.detectionExtras.get(entry.detectionRule.id)
            : null

          if (detectionExtras) {
            decoration.onRender((element) => {
              try {
                element.style.borderBottom = detectionExtras.borderStyle
                element.style.cursor = detectionExtras.cursor
                element.style.pointerEvents = 'auto'
                element.title = detectionExtras.tooltipPrefix
                element.dataset.detectionType = detectionExtras.detectionType
              } catch {
                // xterm.js may throw "invalid characters" for some decoration renders
              }
            })
          }

          this.decorations.push(decoration)
        }
      } catch (err) {
        console.debug('Failed to apply decoration:', err)
      }
    }
  }

  /**
   * Clear rule-based decorations (not ad-hoc)
   */
  private clearRuleDecorations(): void {
    for (const decoration of this.decorations) {
      try {
        decoration.dispose()
      } catch {
        // Ignore disposal errors
      }
    }
    this.decorations = []
  }

  /**
   * Clear all existing decorations (rule-based + ad-hoc)
   */
  clearDecorations(): void {
    this.clearRuleDecorations()
    this.clearAdHocDecorations()
  }

  /**
   * Clear ad-hoc (AI) decorations only
   */
  private clearAdHocDecorations(): void {
    for (const decoration of this.adHocDecorations) {
      try {
        decoration.dispose()
      } catch {
        // Ignore disposal errors
      }
    }
    this.adHocDecorations = []
  }

  /**
   * Generate CSS rule for a highlight rule
   * Uses !important to override xterm.js theme colors
   */
  private generateCssRule(rule: HighlightRule): string {
    const styleId = generateStyleId(rule)
    const styles: string[] = []

    if (rule.bold) {
      styles.push('font-weight: bold !important')
    }
    if (rule.italic) {
      styles.push('font-style: italic !important')
    }
    if (rule.underline) {
      styles.push('text-decoration: underline !important')
    }
    // Background and foreground with !important to override terminal theme
    if (rule.background) {
      styles.push(`background-color: ${rule.background} !important`)
    }
    if (rule.foreground) {
      styles.push(`color: ${rule.foreground} !important`)
    }

    if (styles.length === 0) return ''

    // Use high-specificity selector to override xterm styles
    return `.xterm .xterm-decoration-container .highlight-decoration.${styleId} { ${styles.join('; ')} }`
  }

  /**
   * Inject styles for all rules into document (includes detection hover styles)
   */
  private injectStyles(): void {
    // Clean up existing style element
    this.cleanupStyles()

    const hasRules = this.rules.length > 0 || this.detectionRules.length > 0
    if (!hasRules) return

    // Create new style element
    this.styleElement = document.createElement('style')
    this.styleElement.setAttribute('data-highlight-engine', 'true')

    const cssRules = this.rules
      .map(rule => this.generateCssRule(rule))
      .filter(css => css.length > 0)

    // Add detection hover styles if detection is enabled
    if (this.detectionEnabled) {
      cssRules.push(
        `.xterm .xterm-decoration-container [data-detection-type]:hover {
          background-color: rgba(100, 180, 255, 0.2);
          border-bottom-color: rgba(100, 180, 255, 1) !important;
          border-bottom-style: solid !important;
        }`
      )
    }

    this.styleElement.textContent = cssRules.join('\n')
    document.head.appendChild(this.styleElement)
  }

  /**
   * Clean up injected styles
   */
  private cleanupStyles(): void {
    if (this.styleElement && this.styleElement.parentNode) {
      this.styleElement.parentNode.removeChild(this.styleElement)
      this.styleElement = null
    }
  }

  /**
   * Clean up all resources
   */
  destroy(): void {
    this.destroyed = true

    if (this.scanDebounceTimer !== null) {
      window.clearTimeout(this.scanDebounceTimer)
      this.scanDebounceTimer = null
    }

    if (this.idleCallbackId !== null && 'cancelIdleCallback' in window) {
      window.cancelIdleCallback(this.idleCallbackId)
      this.idleCallbackId = null
    }

    this.clearDecorations()
    this.cleanupStyles()
    this.rules = []
    this.detectionRules = []
    this.detectionExtras.clear()
    this.compiledPatterns.clear()
  }

  /**
   * Get current rules
   */
  getRules(): HighlightRule[] {
    return [...this.rules]
  }

  /**
   * Check if engine is active
   */
  isActive(): boolean {
    return !this.destroyed && (this.rules.length > 0 || this.detectionRules.length > 0)
  }

  /**
   * Apply ad-hoc highlights (e.g., from AI analysis)
   * These are not based on rules but direct line/column positions.
   * Disposes previous ad-hoc decorations before applying new ones to prevent stacking.
   */
  applyAdHocHighlights(highlights: AdHocHighlight[]): void {
    if (this.destroyed || highlights.length === 0) return

    // Clear previous ad-hoc decorations to prevent stacking
    this.clearAdHocDecorations()

    const buffer = this.terminal.buffer.active
    const viewportY = buffer.viewportY
    const rows = this.terminal.rows
    // registerMarker takes cursor-relative offsets
    const cursorAbsoluteY = buffer.baseY + buffer.cursorY

    for (const highlight of highlights) {
      // Only apply highlights visible in viewport
      if (highlight.line < viewportY || highlight.line >= viewportY + rows) {
        continue
      }

      try {
        // Apply inline highlight decoration (skip if no valid range)
        const highlightWidth = highlight.end - highlight.start
        if (highlightWidth <= 0) continue

        const marker = this.terminal.registerMarker(
          highlight.line - cursorAbsoluteY
        )
        if (!marker) continue

        const decoration = this.terminal.registerDecoration({
          marker,
          x: highlight.start,
          width: highlightWidth,
          overviewRulerOptions: {
            color: highlight.background || highlight.foreground || '#ffffff',
          },
        })

        if (decoration) {
          const hl = highlight // Capture for closure
          decoration.onRender(element => {
            try {
              element.classList.add('highlight-decoration', 'ai-highlight')
              if (hl.background) {
                element.style.backgroundColor = hl.background
              } else if (hl.foreground) {
                element.style.backgroundColor = hexToRgba(hl.foreground, 0.25)
                element.style.borderBottom = `2px solid ${hl.foreground}`
              }
              if (hl.className) {
                element.classList.add(hl.className)
              }
              element.style.cursor = 'pointer'
              element.style.pointerEvents = 'auto'
              if (hl.tooltip) {
                element.dataset.copilotTooltip = hl.tooltip
              }
            } catch {
              // xterm.js may throw "invalid characters" for some decoration renders
            }
          })
          this.adHocDecorations.push(decoration)
        }
      } catch (err) {
        console.debug('Failed to apply AI highlight:', err)
      }
    }
  }
}

/**
 * Represents an ad-hoc highlight (e.g., from AI analysis)
 */
export interface AdHocHighlight {
  line: number
  start: number
  end: number
  foreground?: string
  background?: string
  className?: string
  tooltip?: string
  /** Emoji/icon to show as a gutter annotation at the start of the line */
  gutterIcon?: string
  /** Click handler for the highlight decoration */
  onClick?: (highlight: AdHocHighlight) => void
}

/**
 * Generate a CSS-safe style ID from a rule
 */
export function generateStyleId(rule: HighlightRule): string {
  // Create a stable ID based on rule id
  return `hl-${rule.id.replace(/[^a-zA-Z0-9]/g, '')}`
}

/**
 * Convert hex color to rgba with specified alpha
 */
function hexToRgba(hex: string, alpha: number): string {
  // Handle shorthand hex (#rgb)
  let fullHex = hex.replace('#', '')
  if (fullHex.length === 3) {
    fullHex = fullHex.split('').map(c => c + c).join('')
  }

  const r = parseInt(fullHex.substring(0, 2), 16)
  const g = parseInt(fullHex.substring(2, 4), 16)
  const b = parseInt(fullHex.substring(4, 6), 16)

  if (isNaN(r) || isNaN(g) || isNaN(b)) {
    // Fallback for invalid hex
    return `rgba(128, 128, 128, ${alpha})`
  }

  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

/**
 * Match pattern against text (exported for testing)
 */
export function matchPattern(
  text: string,
  rule: HighlightRule
): MatchResult[] {
  const results: MatchResult[] = []

  try {
    let pattern: string
    let flags = 'g'

    if (!rule.case_sensitive) {
      flags += 'i'
    }

    if (rule.is_regex) {
      pattern = rule.pattern
    } else {
      pattern = rule.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    }

    if (rule.whole_word) {
      pattern = `\\b${pattern}\\b`
    }

    const regex = new RegExp(pattern, flags)
    let match

    while ((match = regex.exec(text)) !== null) {
      results.push({
        start: match.index,
        end: match.index + match[0].length,
      })

      if (match[0].length === 0) {
        regex.lastIndex++
      }
    }
  } catch {
    // Invalid pattern
  }

  return results
}
