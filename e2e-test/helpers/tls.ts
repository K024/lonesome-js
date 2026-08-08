import { mkdtempSync } from 'node:fs'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

export type GeneratedTlsCert = {
  certPath: string
  keyPath: string
  cleanup: () => void
}

function certArgs(keyPath: string, certPath: string, commonName: string): string[] {
  return [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-sha256',
    '-days',
    '1',
    '-nodes',
    '-keyout',
    keyPath,
    '-out',
    certPath,
    '-subj',
    `/CN=${commonName}`,
  ]
}

let _hasOpenssl: boolean | undefined

/**
 * True when the `openssl` CLI is resolvable on PATH.
 *
 * This is a presence check only — it does not exercise openssl certificate
 * operations. If a present openssl cannot run `req` (e.g. Strawberry portable
 * builds ship a broken `OPENSSLDIR` with no config file), configure
 * `OPENSSL_CONF` in the environment — the Strawberry install root's
 * `portableshell.bat` now sets it to the bundled `openssl.cnf` — so the TLS
 * tests can run; otherwise the TLS tests fail rather than silently skip.
 */
export function hasOpenssl(): boolean {
  if (_hasOpenssl === undefined) {
    try {
      execFileSync('openssl', ['version'], { stdio: 'ignore' })
      _hasOpenssl = true
    } catch {
      _hasOpenssl = false
    }
  }
  return _hasOpenssl
}

/**
 * Generate a short-lived self-signed certificate for local e2e tests.
 * Requires a working openssl CLI on the host.
 */
export function generateSelfSignedTlsCert(commonName = '127.0.0.1'): GeneratedTlsCert {
  const dir = mkdtempSync(join(tmpdir(), 'lonesome-e2e-tls-'))
  const certPath = join(dir, 'cert.pem')
  const keyPath = join(dir, 'key.pem')

  execFileSync('openssl', certArgs(keyPath, certPath, commonName), { stdio: 'ignore' })

  return {
    certPath,
    keyPath,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}
