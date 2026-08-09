import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { evaluateRule, evaluateExpression } from '../dist/index.js'

describe('evaluateRule (offline rule evaluation)', () => {
  it('decides a cheap Host+PathPrefix rule via the fast path', () => {
    const r = evaluateRule("Host('example.com') && PathPrefix('/api')", {
      method: 'GET',
      path: '/api/v1',
      headers: [{ name: 'host', value: 'example.com' }],
    })
    assert.deepEqual(r, { precheck: 'true', matches: true })
  })

  it('rejects a cheap rule whose host does not match', () => {
    const r = evaluateRule("Host('example.com') && PathPrefix('/api')", {
      method: 'GET',
      path: '/api/v1',
      headers: [{ name: 'host', value: 'other.com' }],
    })
    assert.deepEqual(r, { precheck: 'false', matches: false })
  })

  it('treats a missing host header as an empty host', () => {
    const r = evaluateRule("Host('example.com')", {
      method: 'GET',
      path: '/',
    })
    assert.deepEqual(r, { precheck: 'false', matches: false })
  })

  it('matches method, query and headers through the full CEL program', () => {
    const r = evaluateRule("Method('POST') && Query('debug', '1') && Header('x-token', 'abc')", {
      method: 'POST',
      path: '/submit?debug=1',
      headers: [{ name: 'x-token', value: 'abc' }],
    })
    assert.equal(r.precheck, 'unknown')
    assert.equal(r.matches, true)
  })

  it('reports unknown precheck for unanalyzable rules and lets CEL decide', () => {
    const r = evaluateRule("PathValue().startsWith('/api')", {
      method: 'GET',
      path: '/api/v1',
    })
    assert.equal(r.precheck, 'unknown')
    assert.equal(r.matches, true)
  })

  it('throws on invalid rule', () => {
    assert.throws(() =>
      evaluateRule('Host(', { method: 'GET', path: '/' }),
    )
  })

  it('throws on runtime evaluation error', () => {
    assert.throws(() =>
      evaluateRule("PathPrefix('/') && NonExistFunction('x')", { method: 'GET', path: '/' }),
    )
  })
})

describe('evaluateExpression (arbitrary CEL)', () => {
  it('evaluates pure expressions without a request', () => {
    assert.equal(evaluateExpression("1 + 2"), 3)
    assert.equal(evaluateExpression("'a' + 'b'"), 'ab')
    assert.equal(evaluateExpression("true && false"), false)
  })

  it('exposes request-context values', () => {
    const r = evaluateExpression("MethodValue() + ' ' + HostValue() + ' ' + PathValue()", {
      method: 'POST',
      path: '/api/v1?debug=1',
      headers: [{ name: 'host', value: 'example.com' }],
    })
    assert.equal(r, 'POST example.com /api/v1')
  })

  it('supports non-scalar results (lists, maps, strings)', () => {
    const r = evaluateExpression("['a', 'b']", { method: 'GET', path: '/' })
    assert.deepEqual(r, ['a', 'b'])

    const m = evaluateExpression("{'k': PathValue(), 'n': 2}", { method: 'GET', path: '/x' })
    assert.deepEqual(m, { k: '/x', n: 2 })
  })

  it('decodes percent-encoded paths like the request path', () => {
    const r = evaluateExpression("PathValue()", { method: 'GET', path: '/cel/fn/%E4%BD%A0%E5%A5%BD' })
    assert.equal(r, '/cel/fn/你好')
  })

  it('uses empty defaults when no request is given', () => {
    const r = evaluateExpression("HeaderValue('x-token')", { method: 'GET', path: '/' })
    assert.equal(r, '')
  })

  it('throws on compile error', () => {
    assert.throws(() => evaluateExpression('1 +'))
  })

  it('throws on non-serializable result', () => {
    assert.throws(() => evaluateExpression("duration('1h')"))
  })
})
