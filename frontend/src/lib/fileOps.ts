import { getClient } from '../api/client'
import { sftpLs, sftpDownload, sftpUpload, sftpMkdir, sftpRm, sftpRename } from '../api/sftp'
import type { FileOps, WorkspaceFileEntry } from '../types/workspace'

export class LocalFileOps implements FileOps {
  async readDir(path: string): Promise<WorkspaceFileEntry[]> {
    const { data } = await getClient().http.post('/local/list-dir', { path })
    return (data.entries || []).map((e: any) => ({
      name: e.name,
      path: e.path,
      isDir: e.is_dir,
      size: e.size || 0,
      modified: e.modified || null,
    }))
  }

  async readFile(path: string): Promise<string> {
    const { data } = await getClient().http.post('/local/read-file', { path })
    return data.content
  }

  async readFileBinary(path: string): Promise<Uint8Array> {
    const { data } = await getClient().http.post('/local/read-file-binary', { path })
    const binary = atob(data.content_base64 as string)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    return bytes
  }

  async writeFile(path: string, content: string): Promise<void> {
    await getClient().http.post('/local/write-file', { path, content })
  }

  async exists(path: string): Promise<boolean> {
    const { data } = await getClient().http.post('/local/exists', { path })
    return data.exists
  }

  async delete(path: string, isDir: boolean): Promise<void> {
    await getClient().http.post('/local/delete', { path, is_dir: isDir })
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    await getClient().http.post('/local/rename', { from: oldPath, to: newPath })
  }

  async mkdir(path: string): Promise<void> {
    await getClient().http.post('/local/mkdir', { path })
  }
}

export class RemoteFileOps implements FileOps {
  private sftpId: string
  constructor(sftpId: string) {
    this.sftpId = sftpId
  }

  async readDir(path: string): Promise<WorkspaceFileEntry[]> {
    const response = await sftpLs(this.sftpId, path)
    const results: WorkspaceFileEntry[] = response.entries
      .filter(e => e.name !== '.' && e.name !== '..')
      .map(e => ({
        name: e.name,
        path: e.path,
        isDir: e.is_dir,
        size: e.size,
        modified: e.modified,
      }))
    return results.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
    })
  }

  async readFile(path: string): Promise<string> {
    const blob = await sftpDownload(this.sftpId, path)
    return await blob.text()
  }

  async readFileBinary(path: string): Promise<Uint8Array> {
    const blob = await sftpDownload(this.sftpId, path)
    const buffer = await blob.arrayBuffer()
    return new Uint8Array(buffer)
  }

  async writeFile(path: string, content: string): Promise<void> {
    const blob = new Blob([content], { type: 'text/plain' })
    await sftpUpload(this.sftpId, path, blob)
  }

  async exists(path: string): Promise<boolean> {
    try {
      await sftpLs(this.sftpId, path)
      return true
    } catch {
      return false
    }
  }

  async delete(path: string, isDir: boolean): Promise<void> {
    await sftpRm(this.sftpId, path, isDir)
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    await sftpRename(this.sftpId, oldPath, newPath)
  }

  async mkdir(path: string): Promise<void> {
    await sftpMkdir(this.sftpId, path)
  }
}
