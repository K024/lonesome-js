import { createServer } from 'node:http'
import { connect, type AddressInfo } from 'node:net'
import { LonesomeServer } from '../../dist/index.js'
import type { StartupConfig } from '../../dist/index.js'

const usedPorts = new Set<number>()

/**
 * Find a free TCP port by binding a probe server to port 0, reading the
 * assigned port, then immediately closing the probe. The port is returned to
 * the caller who passes it to Pingora (Pingora does not support port 0 /
 * auto-assignment).
 *
 * A port is never handed out twice within the same process, so consecutive
 * calls cannot return the same value even though the caller binds the returned
 * port only later.
 */
export async function pickFreePort(): Promise<number> {
  for (let i = 0; i < 1000; i++) {
    const probe = createServer()
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
    const port = (probe.address() as AddressInfo).port
    await new Promise<void>((resolve, reject) =>
      probe.close((err) => (err ? reject(err) : resolve())),
    )
    if (!usedPorts.has(port)) {
      usedPorts.add(port)
      return port
    }
  }
  throw new Error('pickFreePort: could not find an unused port')
}

/**
 * Wait until `port` accepts TCP connections or the deadline passes.
 * Pingora binds listeners asynchronously in a background thread, so
 * `server.start()` returning does not mean the port is actually listening.
 */
function waitForListening(port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs
    const attempt = (): void => {
      const sock = connect({ host: '127.0.0.1', port })
      const done = (ok: boolean): void => {
        sock.destroy()
        if (ok) {
          resolve(true)
        } else if (Date.now() >= deadline) {
          resolve(false)
        } else {
          setTimeout(attempt, 25)
        }
      }
      sock.once('connect', () => done(true))
      sock.once('error', () => done(false))
      sock.setTimeout(100, () => done(false))
    }
    attempt()
  })
}

/**
 * Start a LonesomeServer on a randomly chosen free port.
 * Returns the server instance and the port it is listening on.
 * The caller is responsible for calling server.stop() in after().
 *
 * If the server fails to actually listen (e.g. a rare port bind race), the
 * server is stopped and restarted on a fresh port.
 */
export async function startProxy(startup?: StartupConfig): Promise<{ server: LonesomeServer; port: number }> {
  for (let attempt = 0; ; attempt++) {
    const port = await pickFreePort()
    const server = new LonesomeServer()
    const effective = startup ?? {
      listeners: [{ kind: 'tcp', addr: `127.0.0.1:${port}` }],
    }
    server.start(effective)

    if (await waitForListening(port, 1500)) {
      return { server, port }
    }

    try {
      server.stop()
    } catch {
      // ok: server may not have fully started
    }

    if (startup || attempt >= 2) {
      throw new Error(`proxy failed to listen on 127.0.0.1:${port}`)
    }
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
