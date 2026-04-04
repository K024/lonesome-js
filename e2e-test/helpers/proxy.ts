import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { LonesomeServer } from '../../dist/index.js'
import type { NapiStartupConfig } from '../../dist/index.js'

/**
 * Find a free TCP port by binding a probe server to port 0,
 * reading the assigned port, then immediately closing the probe.
 * The port is returned to the caller who passes it to Pingora
 * (Pingora does not support port 0 / auto-assignment).
 */
export async function pickFreePort(): Promise<number> {
  const probe = createServer()
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const port = (probe.address() as AddressInfo).port
  await new Promise<void>((resolve, reject) => probe.close((err) => (err ? reject(err) : resolve())))
  return port
}

/**
 * Start a LonesomeServer on a randomly chosen free port.
 * Returns the server instance and the port it is listening on.
 * The caller is responsible for calling server.stop() in after().
 */
export async function startProxy(startup?: NapiStartupConfig): Promise<{ server: LonesomeServer; port: number }> {
  const port = await pickFreePort()
  const server = new LonesomeServer()
  const defaultStartup: NapiStartupConfig = {
    listeners: [{ kind: 'tcp', addr: `127.0.0.1:${port}` }],
  }

  server.start(startup ?? defaultStartup)
  await sleep(600) // wait for Pingora runtime to become ready
  return { server, port }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
