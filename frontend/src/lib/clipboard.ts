/**
 * copyToClipboard — three-tier copy that works everywhere we ship.
 *
 * Order:
 *   1. @tauri-apps/plugin-clipboard-manager — preferred inside the
 *      Tauri WebView. Avoids the WebView's permission gating around
 *      navigator.clipboard (especially on first focus / unfocused).
 *   2. navigator.clipboard.writeText — for the (rare) non-Tauri build
 *      and for older Tauri WebViews that haven't loaded the plugin yet.
 *   3. document.execCommand('copy') textarea trick — last-ditch
 *      fallback. Deprecated, Chromium has flagged it for removal, but
 *      still works today as a hard backstop.
 *
 * Returns true on success.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  // 1. Tauri plugin (works inside the bundled app even when
  //    navigator.clipboard is locked down by the WebView).
  try {
    const { writeText } = await import('@tauri-apps/plugin-clipboard-manager')
    await writeText(text)
    return true
  } catch {
    // Plugin unavailable (non-Tauri context) or rejected — try the
    // standard browser API next.
  }

  // 2. Browser clipboard API.
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // Fall through to the deprecated fallback.
  }

  // 3. Last-ditch textarea + execCommand fallback.
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.left = '-9999px'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch {
    return false
  }
}
