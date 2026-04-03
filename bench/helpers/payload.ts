export type PayloadPreset = 'tiny_hello' | 'medium_json'

export type PayloadData = {
  contentType: string
  body: string
}

function buildMediumJson(): string {
  const body = {
    message: 'denali benchmark payload',
    tags: ['bench', 'payload', 'medium'],
    requestHints: {
      cacheable: false,
      note: 'This payload is intentionally larger than tiny_hello to stress response serialization and transfer.',
    },
    items: Array.from({ length: 40 }, (_, idx) => ({
      id: idx + 1,
      sku: `SKU-${String(idx + 1).padStart(4, '0')}`,
      quantity: (idx % 5) + 1,
      price: Number((10 + idx * 0.37).toFixed(2)),
      category: idx % 2 === 0 ? 'alpha' : 'beta',
    })),
  }

  return JSON.stringify(body)
}

export function getPayload(preset: PayloadPreset): PayloadData {
  if (preset === 'tiny_hello') {
    return {
      contentType: 'text/plain; charset=utf-8',
      body: 'hello',
    }
  }

  return {
    contentType: 'application/json; charset=utf-8',
    body: buildMediumJson(),
  }
}
