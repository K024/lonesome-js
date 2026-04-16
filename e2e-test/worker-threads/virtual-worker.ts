import { createServer } from 'node:http'
import { Duplex } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { parentPort, workerData } from 'node:worker_threads'
import {
  registerVirtualListener,
  unregisterVirtualListener,
  virtualPushEvent,
} from '../../dist/index.js'

if (!parentPort) {
  throw new Error('parentPort is required')
}

const port = parentPort

type WorkerMessage =
  | { type: 'start' }
  | { type: 'stop' }
  | { type: 'shutdown' }

class VirtualSocketDuplex extends Duplex {
  private readonly connId: string

  constructor(connId: string) {
    super()
    this.connId = connId
    ;(this as any).remoteAddress = '127.0.0.1'
    ;(this as any).remotePort = 0
    ;(this as any).localAddress = '127.0.0.1'
    ;(this as any).localPort = 0
    ;(this as any).encrypted = false
  }

  _read(_size: number): void {}

  _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    try {
      virtualPushEvent('data', this.connId, chunk)
      callback()
    } catch (err) {
      callback(err as Error)
    }
  }

  _final(callback: (error?: Error | null) => void): void {
    try {
      virtualPushEvent('eof', this.connId)
      callback()
    } catch (err) {
      callback(err as Error)
    }
  }

  setNoDelay(_noDelay?: boolean): this { return this }
  setKeepAlive(_enable?: boolean, _initialDelay?: number): this { return this }
  setTimeout(_timeout: number, _callback?: () => void): this { return this }

  address() {
    return { address: '127.0.0.1', family: 'IPv4' as const, port: 0 }
  }
}

const key = workerData.key as string
const marker = workerData.marker as string
const delayMs = (workerData.delayMs as number | undefined) ?? 0

let httpServer: ReturnType<typeof createServer> | null = null
let connMap: Map<string, VirtualSocketDuplex> | null = null

function handler(_req: IncomingMessage, res: ServerResponse): void {
  setTimeout(() => {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ marker, pid: process.pid }))
  }, delayMs)
}

function startService(): void {
  if (httpServer) {
    return
  }

  httpServer = createServer(handler)
  connMap = new Map<string, VirtualSocketDuplex>()

  registerVirtualListener(key, (kind, connId, data) => {
    if (!connMap || !httpServer) {
      return
    }

    if (kind === 'open') {
      const duplex = new VirtualSocketDuplex(connId)
      connMap.set(connId, duplex)
      duplex.on('close', () => connMap?.delete(connId))
      httpServer.emit('connection', duplex)
      return
    }

    if (kind === 'write') {
      const duplex = connMap.get(connId)
      if (!duplex) {
        throw new Error(`VirtualSocketDuplex not found for connId=${connId}`)
      }
      duplex.push(data)
      return
    }

    if (kind === 'close') {
      const duplex = connMap.get(connId)
      if (!duplex) {
        return
      }
      duplex.push(null)
      duplex.end()
      connMap.delete(connId)
    }
  })

  port.postMessage({ type: 'started', key })
}

function stopService(): void {
  if (!httpServer) {
    return
  }

  unregisterVirtualListener(key)
  httpServer.close()
  httpServer = null
  connMap = null
  port.postMessage({ type: 'stopped', key })
}

port.on('message', (msg: WorkerMessage) => {
  if (msg.type === 'start') {
    startService()
    return
  }

  if (msg.type === 'stop') {
    stopService()
    return
  }

  if (msg.type === 'shutdown') {
    stopService()
    port.postMessage({ type: 'shutdown-ack', key })
    setImmediate(() => process.exit(0))
  }
})

process.on('uncaughtException', (err) => {
  port.postMessage({ type: 'worker-error', key, message: err.message })
})

process.on('unhandledRejection', (reason) => {
  const message = reason instanceof Error ? reason.message : String(reason)
  port.postMessage({ type: 'worker-error', key, message })
})
