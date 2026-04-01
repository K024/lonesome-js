import assert from 'node:assert/strict'
import { request as httpRequest, IncomingMessage } from 'node:http'

export function proxyUrl(port: number, path: string): string {
  return `http://127.0.0.1:${port}${path}`
}

/** Bare fetch to proxy */
export function proxyFetch(port: number, path: string, opts?: RequestInit): Promise<Response> {
  return fetch(proxyUrl(port, path), opts)
}

/** Fetch + parse JSON body */
export async function getJson(
  port: number,
  path: string,
  opts?: RequestInit,
): Promise<{ res: Response; body: any }> {
  const res = await proxyFetch(port, path, opts)
  const text = await res.text()
  let body: any
  try {
    body = JSON.parse(text)
  } catch {
    body = text
  }
  return { res, body }
}

/** Fetch and assert HTTP status code */
export async function assertStatus(
  port: number,
  path: string,
  expected: number,
  opts?: RequestInit,
): Promise<Response> {
  const res = await proxyFetch(port, path, opts)
  // consume body to avoid keep-alive stalls
  await res.text()
  assert.strictEqual(
    res.status,
    expected,
    `${opts?.method ?? 'GET'} ${path}: expected status ${expected}, got ${res.status}`,
  )
  return res
}

/** Assert a response header equals a string or matches a regex */
export function assertHeader(res: Response, name: string, expected: string | RegExp): void {
  const val = res.headers.get(name)
  if (expected instanceof RegExp) {
    assert.match(
      val ?? '',
      expected,
      `header "${name}": value "${val}" does not match ${expected}`,
    )
  } else {
    assert.strictEqual(val, expected, `header "${name}": expected "${expected}", got "${val}"`)
  }
}

/** Assert a response header is absent (null) */
export function assertNoHeader(res: Response, name: string): void {
  const val = res.headers.get(name)
  assert.strictEqual(val, null, `header "${name}" should be absent, but got "${val}"`)
}

type CustomHostRequestOptions = {
  method?: string
  headers?: Record<string, string>
  body?: string
}

type RawHttpRequestOptions = {
  method?: string
  host?: string
  headers?: Record<string, string>
  body?: string | Buffer
}

/**
 * Make raw HTTP request and return undecoded bytes.
 * Use this when http host header/response compression behavior is under test.
 */
export async function requestRawHttp(
  port: number,
  path: string,
  options?: RawHttpRequestOptions,
): Promise<{ response: IncomingMessage; body: Buffer }> {
  return await new Promise<{ response: IncomingMessage; body: Buffer }>((resolve, reject) => {
    const req = httpRequest(
      {
        host: options?.host ?? '127.0.0.1',
        port,
        path,
        method: options?.method ?? 'GET',
        headers: options?.headers,
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
        })
        res.on('end', () => resolve({ response: res, body: Buffer.concat(chunks) }))
      },
    )

    req.on('error', reject)

    if (options?.body) {
      req.write(options.body)
    }

    req.end()
  })
}

/** Make HTTP request with explicit Host header (fetch does not support custom Host header) */
export async function requestWithCustomHost(
  port: number,
  path: string,
  host: string,
  options?: CustomHostRequestOptions,
): Promise<{ response: IncomingMessage; body: string }> {
  const { response, body } = await requestRawHttp(port, path, {
    method: options?.method,
    host: '127.0.0.1',
    headers: {
      ...(options?.headers ?? {}),
      host,
    },
    body: options?.body,
  })

  return { response, body: body.toString('utf8') }
}
