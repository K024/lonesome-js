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

/**
 * Generate a short-lived self-signed certificate for local e2e tests.
 * Requires openssl to be installed on the host.
 */
export function generateSelfSignedTlsCert(commonName = '127.0.0.1'): GeneratedTlsCert {
  const dir = mkdtempSync(join(tmpdir(), 'lonesome-e2e-tls-'))
  const certPath = join(dir, 'cert.pem')
  const keyPath = join(dir, 'key.pem')

  execFileSync('openssl', [
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
  ], { stdio: 'ignore' })

  return {
    certPath,
    keyPath,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}
