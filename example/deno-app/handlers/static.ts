/**
 * Example handler for the static-worker.
 */
export default function handler(req: Request): Response {
  const url = new URL(req.url)
  const path = url.pathname.replace('/static', '') || '/index.html'

  // Simulated static file map
  const files: Record<string, { type: string; body: string }> = {
    '/index.html': {
      type: 'text/html',
      body: '<h1>Hello from static-worker</h1>',
    },
    '/style.css': {
      type: 'text/css',
      body: 'body { font-family: sans-serif; }',
    },
    '/data.json': {
      type: 'application/json',
      body: JSON.stringify({ status: 'ok' }),
    },
  }

  const file = files[path]
  if (file) {
    return new Response(file.body, {
      status: 200,
      headers: { 'content-type': file.type, 'x-worker': 'static-worker' },
    })
  }

  return new Response('404 Not Found', {
    status: 404,
    headers: { 'content-type': 'text/plain', 'x-worker': 'static-worker' },
  })
}
