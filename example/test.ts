import { createServer } from 'node:http'
import { AddressInfo } from 'node:net'

import { DenaliServer } from '../dist/index.js'

async function main() {
  const origin = createServer((req, res) => {
    res.statusCode = 200
    res.setHeader('content-type', 'application/json')
    res.end(
      JSON.stringify({
        method: req.method,
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
      id: 'rewrite-method-route',
      matcher: {
        rule: "PathPrefix('/rewrite')",
        priority: 100,
      },
      middlewares: [
        {
          type: 'rewrite_method',
          config: {
            method: 'POST',
            rule: "PathPrefix('/rewrite/post')",
          },
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

    await new Promise((resolve) => setTimeout(resolve, 600))

    const resp = await fetch(`http://127.0.0.1:${denaliPort}/rewrite/demo`)
    const body = await parseJsonResponse(resp)

    console.log('rewrite_method response:', body)

    const resp2 = await fetch(`http://127.0.0.1:${denaliPort}/rewrite/post/demo`)
    const body2 = await parseJsonResponse(resp2)

    console.log('rewrite_method response2:', body2)

    if (body2.method !== 'POST') {
      throw new Error(`expected rewritten method POST, got ${JSON.stringify(body2)}`)
    }

    server.stop()
  } finally {
    origin.close()
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

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
