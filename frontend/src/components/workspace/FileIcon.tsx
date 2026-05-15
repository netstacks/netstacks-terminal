const ICON_MAP: Record<string, string> = {
  py: '🐍', python: '🐍',
  ts: '📘', tsx: '📘',
  js: '📒', jsx: '📒',
  json: '{}',
  yaml: '📋', yml: '📋',
  xml: '📰',
  md: '📝', markdown: '📝',
  css: '🎨',
  html: '🌐', htm: '🌐',
  sh: '⚡', bash: '⚡', zsh: '⚡',
  rs: '🦀',
  go: '🔵',
  java: '☕',
  c: '©', cpp: '©', h: '©',
  toml: '⚙',
  cfg: '⚙', conf: '⚙', ini: '⚙',
  j2: '📐', jinja: '📐', jinja2: '📐',
  yang: '🌿',
  tf: '🏗',
  sql: '🗄',
  log: '📜',
  txt: '📄',
  png: '🖼', jpg: '🖼', jpeg: '🖼', gif: '🖼', svg: '🖼', webp: '🖼',
  lock: '🔒',
  env: '🔐',
  gitignore: '🚫',
  dockerfile: '🐳',
  makefile: '🔨',
}

interface FileIconProps {
  name: string
  isDir: boolean
  isExpanded?: boolean
}

export default function FileIcon({ name, isDir, isExpanded }: FileIconProps) {
  if (isDir) {
    return <span className="workspace-file-entry-icon">{isExpanded ? '📂' : '📁'}</span>
  }

  const lower = name.toLowerCase()
  const ext = lower.split('.').pop() || ''
  const icon = ICON_MAP[ext] || ICON_MAP[lower] || '📄'

  return <span className="workspace-file-entry-icon">{icon}</span>
}
