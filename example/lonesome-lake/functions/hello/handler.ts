import { join } from 'jsr:@std/path@1'

export default function handler(req: Request): Response {
  const url = new URL(req.url)
  const name = url.searchParams.get('name') ?? 'world'
  return new Response(
    JSON.stringify({
      greeting: join('hi', name) + '!',
      role: Deno.env.get('GREETING'),
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      worker: 'hello',
    }),
    {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'x-fn': 'hello',
      },
    },
  )
}
