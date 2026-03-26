import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AddressInfo } from 'node:net'

import { DenaliServer } from '../dist/index.js'

async function main() {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'denali-'))
  const udsPath = join(tmpRoot, 'origin.sock')

  const tcpOrigin = createServer((req, res) => {
    res.statusCode = 200
    res.setHeader('content-type', 'application/json')
    res.end(
      JSON.stringify({
        origin: 'tcp',
        method: req.method,
        url: req.url,
        xTest: req.headers['x-test'] ?? null,
      }),
    )
  })

  const udsOrigin = createServer((req, res) => {
    res.statusCode = 200
    res.setHeader('content-type', 'application/json')
    res.end(
      JSON.stringify({
        origin: 'unix',
        method: req.method,
        url: req.url,
      }),
    )
  })

  const cleanup = () => {
    tcpOrigin.close()
    udsOrigin.close()
    rmSync(tmpRoot, { recursive: true, force: true })
  }

  try {
    await new Promise<void>((resolve) => tcpOrigin.listen(0, '127.0.0.1', () => resolve()))
    await new Promise<void>((resolve) => udsOrigin.listen(udsPath, () => resolve()))

    const upstreamPort = (tcpOrigin.address() as AddressInfo).port
    const denaliPort = await pickFreePort()

    const server = new DenaliServer()

    server.addOrUpdate({
      id: 'tcp-route',
      matcher: {
        cel: "PathPrefix('/tcp') && Header('x-env', 'prod') && Query('name', 'denali')",
        priority: 100,
      },
      middlewares: [
        {
          type: 'add_header',
          name: 'x-test',
          value: 'denali',
          cel: "Header('x-env', 'prod') && Query('mw', 'on')",
        },
      ],
      upstreams: [
        {
          kind: 'tcp',
          address: `127.0.0.1:${upstreamPort}`,
          tls: false,
          sni: '',
          weight: 1,
        },
      ],
      loadBalancer: {
        algorithm: 'consistent_hash',
        maxIterations: 256,
        hashKeyCel: 'path',
      },
    })

    server.addOrUpdate({
      id: 'unix-route',
      matcher: {
        cel: "PathPrefix('/unix')",
        priority: 90,
      },
      middlewares: [],
      upstreams: [
        {
          kind: 'unix',
          address: udsPath,
          tls: false,
          sni: '',
          weight: 1,
        },
      ],
      loadBalancer: {
        algorithm: 'round_robin',
        maxIterations: 256,
      },
    })

    server.start({
      listeners: [
        {
          kind: 'tcp',
          addr: `127.0.0.1:${denaliPort}`,
        },
      ],
    })

    await new Promise((resolve) => setTimeout(resolve, 1000))

    const tcpHitResp = await fetch(`http://127.0.0.1:${denaliPort}/tcp/hello?name=denali&mw=on`, {
      headers: { host: 'example.local', 'x-env': 'prod' },
    })
    const tcpHitBody = await parseJsonResponse(tcpHitResp, 'tcp-hit')

    const tcpMissResp = await fetch(`http://127.0.0.1:${denaliPort}/tcp/hello?name=denali&mw=off`, {
      headers: { host: 'example.local', 'x-env': 'prod' },
    })
    const tcpMissBody = await parseJsonResponse(tcpMissResp, 'tcp-miss')

    const udsResp = await fetch(`http://127.0.0.1:${denaliPort}/unix/hello`, {
      headers: { host: 'example.local' },
    })
    const udsBody = await parseJsonResponse(udsResp, 'unix')

    console.log('tcp hit response:', tcpHitBody)
    console.log('tcp miss response:', tcpMissBody)
    console.log('unix route response:', udsBody)

    if (tcpHitBody.origin !== 'tcp' || tcpHitBody.xTest !== 'denali') {
      throw new Error(`unexpected tcp hit response: ${JSON.stringify(tcpHitBody)}`)
    }
    if (tcpMissBody.origin !== 'tcp' || tcpMissBody.xTest !== null) {
      throw new Error(`unexpected tcp miss response: ${JSON.stringify(tcpMissBody)}`)
    }
    if (udsBody.origin !== 'unix') {
      throw new Error(`unexpected unix response: ${JSON.stringify(udsBody)}`)
    }

    const status = server.status()
    console.log('server status:', status)

    server.stop()
  } finally {
    cleanup()
  }
}

async function pickFreePort(): Promise<number> {
  const probe = createServer()
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', () => resolve()))
  const port = (probe.address() as AddressInfo).port
  await new Promise<void>((resolve, reject) => probe.close((err) => (err ? reject(err) : resolve())))
  return port
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})

async function parseJsonResponse(resp: Response, label: string): Promise<any> {
  const text = await resp.text()
  if (!resp.ok) {
    throw new Error(`${label} response status=${resp.status} body=${text}`)
  }
  try {
    return JSON.parse(text)
  } catch (e) {
    throw new Error(`${label} response invalid json body=${text}; ${(e as Error).message}`)
  }
}
