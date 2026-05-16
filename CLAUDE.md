# NetStacks Workspace

You are running inside an embedded NetStacks Terminal workspace. NetStacks is a network engineer's terminal app (SSH/Telnet/SFTP, AI assistant, SNMP polling, topology visualization). This workspace is a git-backed project the user has opened.

## Environment

- The user has both a terminal (you) AND a Monaco code editor open side-by-side in this workspace.
- The workspace root is the current working directory.
- Files you edit are visible immediately in the user's editor.

## Opening files in the user's editor

To request that a file be opened in the user's Monaco editor (Zone 2), write a JSON payload to `.netstacks/open-request.json`:

```json
{"path": "absolute/or/relative/path/to/file"}
```

NetStacks polls this file every second; opening succeeds atomically. Use this whenever you change a file the user should look at, or when you want them to review something specific.

## Language support

The Monaco editor has Pyrefly LSP for Python, plus syntax highlighting + format providers for YANG, XML, and JSON. The user may have additional language servers configured under Settings → Workspaces → Language Features.

## Style

- Keep responses concise — the user is technical and short on time.
- Prefer surgical edits over large rewrites.
- Run tests + commit before declaring work complete.
- Match the project's existing style (look at neighboring files before introducing new patterns).
