import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { analyzeRule } from '../dist/index.js'

describe('analyzeRule (static rule analysis)', () => {
  it('extracts exact Host/Path/PathPrefix constraints', () => {
    assert.deepEqual(analyzeRule("Host('example.com') && PathPrefix('/api')"), {
      hosts: ['example.com'],
      paths: [],
      pathPrefixes: ['/api'],
      fullyPrecheckable: true,
    })
  })

  it('deduplicates repeated literals', () => {
    const r = analyzeRule("Host('a') && Host('a')")
    assert.deepEqual(r.hosts, ['a'])
  })

  it('collects hosts across OR branches', () => {
    const r = analyzeRule("Host('a') || Host('b')")
    assert.deepEqual(r.hosts, ['a', 'b'])
    assert.equal(r.fullyPrecheckable, true)
  })

  it('keeps hosts under negation (conservative lower bound)', () => {
    const r = analyzeRule("!Host('a')")
    assert.deepEqual(r.hosts, ['a'])
    assert.equal(r.fullyPrecheckable, true)
  })

  it('extracts constraints across ternary branches', () => {
    const r = analyzeRule("Host('a') ? Path('/x') : PathPrefix('/y')")
    assert.deepEqual(r.hosts, ['a'])
    assert.deepEqual(r.paths, ['/x'])
    assert.deepEqual(r.pathPrefixes, ['/y'])
    assert.equal(r.fullyPrecheckable, true)
  })

  it('reports wildcard host patterns', () => {
    const r = analyzeRule("Host('*.example.com')")
    assert.deepEqual(r.hosts, ['*.example.com'])
    assert.equal(r.fullyPrecheckable, true)
  })

  it('reports mixed rules with unknown leaves as not fully precheckable', () => {
    const r = analyzeRule("Host('a') && Header('x', 'y')")
    assert.deepEqual(r.hosts, ['a'])
    assert.equal(r.fullyPrecheckable, false)
  })

  it('returns empty constraints for unanalyzable CEL', () => {
    assert.deepEqual(analyzeRule("HostValue() == 'a'"), {
      hosts: [],
      paths: [],
      pathPrefixes: [],
      fullyPrecheckable: false,
    })
  })

  it('returns empty constraints for HostRegexp', () => {
    const r = analyzeRule("HostRegexp('^[a-z]+\\\\.example\\\\.com$')")
    assert.deepEqual(r.hosts, [])
    assert.equal(r.fullyPrecheckable, false)
  })

  it('handles boolean literal rules as fully precheckable', () => {
    assert.deepEqual(analyzeRule('true'), {
      hosts: [],
      paths: [],
      pathPrefixes: [],
      fullyPrecheckable: true,
    })
  })

  it('throws on invalid CEL', () => {
    assert.throws(() => analyzeRule('!!'))
  })
})
