import { createServer as createHttp1 } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { IncomingMessage, ServerResponse } from 'node:http'

export type RequestHandler = (req: IncomingMessage, res: ServerResponse) => void

/** Default echo handler: returns method/url/headers/body as JSON */
export function defaultEchoHandler(req: IncomingMessage, res: ServerResponse): void {
  let body = ''
  req.on('data', (chunk) => { body += chunk })
  req.on('end', () => {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ method: req.method, url: req.url, headers: req.headers, body }))
  })
}

/**
 * Create an HTTP/1.1 upstream whose request handler can be swapped at runtime.
 * Call start() to bind to a random port; the actual port is available via .port.
 */
export function createDynamicUpstream() {
  let handler: RequestHandler = defaultEchoHandler
  const server = createHttp1((req, res) => handler(req, res))

  const instance = {
    server,
    /** Actual bound port — only valid after start() resolves */
    port: 0,
    setHandler(h: RequestHandler): void { handler = h },
    resetHandler(): void { handler = defaultEchoHandler },
    async start(): Promise<void> {
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
      instance.port = (server.address() as AddressInfo).port
    },
    stop(): Promise<void> {
      return new Promise((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      )
    },
  }
  return instance
}

export type DynamicUpstream = ReturnType<typeof createDynamicUpstream>

/**
 * Create a plain HTTP/2 (h2c) upstream server.
 * Call start() to bind to a random port; actual port is available via .port.
 */
export function createH2cUpstream() {
  const { createServer: createHttp2Plain } = require('node:http2')
  const server = createHttp2Plain((req: any, res: any) => {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ protocol: 'h2c', method: req.method, url: req.url }))
  })

  const instance = {
    server,
    port: 0,
    async start(): Promise<void> {
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
      instance.port = (server.address() as AddressInfo).port
    },
    stop(): Promise<void> {
      return new Promise((resolve, reject) =>
        server.close((err: Error | undefined) => (err ? reject(err) : resolve())),
      )
    },
  }
  return instance
}
