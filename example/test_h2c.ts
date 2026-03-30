import { createServer as createHttpServer } from 'node:http'
import { createServer } from 'node:http2'
import { AddressInfo } from 'node:net'

import { DenaliServer } from '../dist/index.js'

async function main() {
  const origin = createServer((req, res) => {
    res.statusCode = 200
    res.setHeader('content-type', 'application/json')
    res.end(
      JSON.stringify({
        protocol: 'h2c',
        method: req.method,
        host: req.headers.host,
        url: req.url,
      }),
    )
  })

  try {
    await new Promise<void>((resolve) => origin.listen(0, '127.0.0.1', () => resolve()))
    const upstreamPort = (origin.address() as AddressInfo).port
    const denaliPort = await pickFreePort()

    const server = new DenaliServer()

    server.addOrUpdate({
      id: 'h2c-route',
      matcher: {
        rule: "PathPrefix('/h2c')",
        priority: 100,
      },
      middlewares: [],
      upstreams: [
        {
          kind: 'tcp',
          address: `127.0.0.1:${upstreamPort}`,
          tls: false,
          h2c: true,
          sni: '',
          weight: 1,
        },
      ],
      loadBalancer: {
        algorithm: 'round_robin',
        maxIterations: 16,
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

    await sleep(300)

    const resp = await fetch(`http://127.0.0.1:${denaliPort}/h2c/demo?x=1`)
    const body = await parseJsonResponse(resp)

    console.log('h2c response:', body)

    if (body.protocol !== 'h2c') {
      throw new Error(`expected h2c upstream response, got ${JSON.stringify(body)}`)
    }
    if (body.url !== '/h2c/demo?x=1') {
      throw new Error(`unexpected upstream path: ${JSON.stringify(body)}`)
    }
  } finally {
    origin.close()
  }
}

async function pickFreePort(): Promise<number> {
  const probe = createHttpServer()
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', () => resolve()))
  const port = (probe.address() as AddressInfo).port
  await new Promise<void>((resolve, reject) =>
    probe.close((err) => (err ? reject(err) : resolve())),
  )
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
