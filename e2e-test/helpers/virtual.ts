import { createServer } from 'node:http'
import { Duplex } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  registerVirtualListener,
  unregisterVirtualListener,
  virtualPushEvent,
} from '../../dist/index.js'

export type VirtualHandler = (req: IncomingMessage, res: ServerResponse) => void

/**
 * A Duplex stream that bridges between the Rust virtual_js upstream events
 * and a Node.js HTTP server connection.
 */
class VirtualSocketDuplex extends Duplex {
  constructor(private readonly connId: string) {
    super()
    // Node.js HTTP server expects socket-like fields on incoming connections
    ;(this as any).remoteAddress = '127.0.0.1'
    ;(this as any).remotePort = 0
    ;(this as any).localAddress = '127.0.0.1'
    ;(this as any).localPort = 0
    ;(this as any).encrypted = false
  }

  _read(_size: number): void {
    // Data is pushed from Rust callback (on 'write' event)
  }

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

function defaultVirtualHandler(req: IncomingMessage, res: ServerResponse): void {
  let body = ''
  req.on('data', (c) => { body += c })
  req.on('end', () => {
    res.setHeader('content-type', 'application/json')
    res.end(
      JSON.stringify({
        upstream: 'virtual-js',
        method: req.method,
        url: req.url,
        headers: req.headers,
        body,
      }),
    )
  })
}

/**
 * Start a virtual-js upstream bound to the given listener key.
 * Returns a stop() function to tear it down.
 */
export function startVirtualUpstream(key: string, handler?: VirtualHandler) {
  const httpServer = createServer(handler ?? defaultVirtualHandler)
  const connMap = new Map<string, VirtualSocketDuplex>()

  registerVirtualListener(key, (kind, connId, data) => {
    if (kind === 'open') {
      const duplex = new VirtualSocketDuplex(connId)
      connMap.set(connId, duplex)
      duplex.on('close', () => connMap.delete(connId))
      httpServer.emit('connection', duplex)
      return
    }
    if (kind === 'write') {
      const duplex = connMap.get(connId)
      if (!duplex) throw new Error(`VirtualSocketDuplex not found for connId=${connId}`)
      duplex.push(data)
      return
    }
    if (kind === 'close') {
      const duplex = connMap.get(connId)
      if (!duplex) return
      duplex.push(null)
      duplex.end()
      connMap.delete(connId)
    }
  })

  return {
    connMap,
    stop(): void {
      unregisterVirtualListener(key)
      httpServer.close()
    },
  }
}
