import { createServer } from 'node:http'
import { AddressInfo } from 'node:net'
import { Duplex } from 'node:stream'

import {
  DenaliServer,
  registerVirtualListener,
  unregisterVirtualListener,
  virtualPushEvent,
} from '../dist/index.js'

class VirtualSocketDuplex extends Duplex {
  constructor(private readonly connId: string) {
    super()

    // Node HTTP server expects socket-like fields on incoming connection.
    ;(this as any).remoteAddress = '127.0.0.1'
    ;(this as any).remotePort = 0
    ;(this as any).localAddress = '127.0.0.1'
    ;(this as any).localPort = 0
    ;(this as any).encrypted = false
  }

  _read(_size: number): void {
    // Data is pushed from Rust callback (on write event) side.
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

  setNoDelay(_noDelay?: boolean): this {
    return this
  }

  setKeepAlive(_enable?: boolean, _initialDelay?: number): this {
    return this
  }

  setTimeout(_timeout: number, _callback?: () => void): this {
    return this
  }

  address() {
    return {
      address: '127.0.0.1',
      family: 'IPv4' as const,
      port: 0,
    }
  }
}

async function main() {
  const virtualServer = createServer((req, res) => {
    res.statusCode = 200
    res.setHeader('content-type', 'application/json')
    res.end(
      JSON.stringify({
        upstream: 'virtual-js',
        method: req.method,
        url: req.url,
        host: req.headers.host,
      }),
    )
  })

  const connMap = new Map<string, VirtualSocketDuplex>()
  const denali = new DenaliServer()

  try {
    registerVirtualListener(
      'demo-vjs',
      (kind, connId, data) => {
        if (kind === 'open') {
          const duplex = new VirtualSocketDuplex(connId)
          connMap.set(connId, duplex)

          duplex.on('close', () => {
            connMap.delete(connId)
          })

          virtualServer.emit('connection', duplex)
          return
        }

        if (kind === 'write') {
          const duplex = connMap.get(connId)
          if (!duplex) {
            throw new Error(`duplex not found for connId=${connId}`)
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
      },
    )

    const denaliPort = await pickFreePort()

    denali.addOrUpdate({
      id: 'virtual-js-route',
      matcher: {
        rule: "PathPrefix('/vjs')",
        priority: 100,
      },
      middlewares: [],
      upstreams: [
        {
          kind: 'virtual_js',
          address: 'demo-vjs',
          tls: false,
          sni: '',
          weight: 1,
        },
      ],
      loadBalancer: {
        algorithm: 'round_robin',
        maxIterations: 16,
      },
    })

    denali.start({
      listeners: [
        {
          kind: 'tcp',
          addr: `127.0.0.1:${denaliPort}`,
        },
      ],
    })

    await sleep(300)

    const resp = await fetch(`http://127.0.0.1:${denaliPort}/vjs/hello?x=1`, {
      headers: {
        'x-demo': 'vjs',
      },
    })

    const body = await parseJsonResponse(resp)
    console.log('virtual-js response:', body)

    if (body.upstream !== 'virtual-js') {
      throw new Error(`unexpected upstream marker: ${JSON.stringify(body)}`)
    }
    if (body.url !== '/vjs/hello?x=1') {
      throw new Error(`unexpected upstream url: ${JSON.stringify(body)}`)
    }
  } catch (err) {
    // Surface one more push error path if connection has already been dropped.
    if (connMap.size > 0) {
      for (const connId of connMap.keys()) {
        try {
          virtualPushEvent('error', connId, undefined, String(err))
        } catch {
          // ignored
        }
      }
    }
    throw err
  } finally {
    denali.stop()
    unregisterVirtualListener('demo-vjs')
    virtualServer.close()
  }
}

async function pickFreePort(): Promise<number> {
  const probe = createServer()
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', () => resolve()))
  const port = (probe.address() as AddressInfo).port
  await new Promise<void>((resolve, reject) => probe.close((err) => (err ? reject(err) : resolve())))
  return port
}

async function parseJsonResponse(resp: Response): Promise<any> {
  const text = await resp.text()
  if (!resp.ok) {
    throw new Error(`response status=${resp.status} body=${text}`)
  }
  return JSON.parse(text)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
