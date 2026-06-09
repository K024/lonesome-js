/**
 * Example handler for the api-worker.
 * Default export must be: (req: Request) => Response | Promise<Response>
 */
export default function handler(req: Request): Response {
  const url = new URL(req.url);
  return new Response(
    JSON.stringify({
      worker: 'api-worker',
      path: url.pathname,
      method: req.method,
      query: Object.fromEntries(url.searchParams),
      timestamp: new Date().toISOString(),
    }),
    {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'x-worker': 'api-worker',
      },
    },
  );
}
