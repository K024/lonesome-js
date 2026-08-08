import { createServer } from 'node:http'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { defaultEchoHandler, type RequestHandler } from './upstream.js'

export function createUnixDynamicUpstream() {
  let handler: RequestHandler = defaultEchoHandler
  const server = createServer((req: IncomingMessage, res: ServerResponse) => handler(req, res))
  const path = join(tmpdir(), `lonesome-e2e-${randomUUID().replaceAll('-', '').slice(0, 12)}.sock`)

  return {
    server,
    path,
    setHandler(h: RequestHandler): void {
      handler = h
    },
    resetHandler(): void {
      handler = defaultEchoHandler
    },
    async start(): Promise<void> {
      rmSync(path, { force: true })
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(path, () => {
          server.off('error', reject)
          resolve()
        })
      })
    },
    async stop(): Promise<void> {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      rmSync(path, { force: true })
    },
  }
}
