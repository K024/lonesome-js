export default async function handler(req: Request): Promise<Response> {
  await new Promise((resolve) => setTimeout(resolve, 300))
  return new Response(
    JSON.stringify({
      slow: true,
      path: new URL(req.url).pathname,
      worker: 'slow',
    }),
    {
      status: 200,
      headers: { 'content-type': 'application/json', 'x-fn': 'slow' },
    },
  )
}
