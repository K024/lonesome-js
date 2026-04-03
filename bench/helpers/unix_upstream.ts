import { createServer } from 'node:http'
import { access, rm } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { constants as fsConstants } from 'node:fs'

export type UnixUpstreamHandler = (req: IncomingMessage, res: ServerResponse) => void

async function removeIfExists(path: string): Promise<void> {
  try {
    await access(path, fsConstants.F_OK)
    await rm(path, { force: true })
  } catch {
    // already absent
  }
}

export function createUnixUpstream(socketPath: string, handler: UnixUpstreamHandler) {
  const server = createServer(handler)

  const instance = {
    socketPath,
    async start(): Promise<void> {
      await removeIfExists(socketPath)
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(socketPath, () => {
          server.off('error', reject)
          resolve()
        })
      })
    },
    async stop(): Promise<void> {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()))
      })
      await removeIfExists(socketPath)
    },
  }

  return instance
}
