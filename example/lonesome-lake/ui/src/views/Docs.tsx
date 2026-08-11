import type { ComponentChildren } from 'preact'
import { CodeBlock } from '../components/CodeBlock'
import { PageHeader } from '../components/PageHeader'

function Section(
  { title, children }: { title: string; children: ComponentChildren },
) {
  return (
    <div class='card border border-base-300 bg-base-100 shadow-sm'>
      <div class='card-body space-y-3'>
        <h3 class='card-title text-lg'>{title}</h3>
        {children}
      </div>
    </div>
  )
}

function P({ children }: { children: ComponentChildren }) {
  return <p class='text-sm leading-relaxed text-base-content/80'>{children}</p>
}

function InlineCode({ children }: { children: string }) {
  return <code class='font-mono text-[0.85em]'>{children}</code>
}

export function DocsView() {
  return (
    <div class='space-y-5'>
      <PageHeader
        title='Reference'
        description='How functions, matchers, and the admin API work in lonesome-lake.'
      />

      <Section title='Function authoring'>
        <P>
          A function is a directory under <InlineCode>functions/</InlineCode>
          {' '}
          containing a handler and an optional config:
        </P>
        <CodeBlock
          language='bash'
          value={`functions/<name>/
  handler.ts      # default export (req: Request) => Response | Promise<Response>
  config.yml     # optional: matcher / permissions / env / replicas / lazy / timeoutMs`}
        />
        <P>
          With no <InlineCode>config.yml</InlineCode> the default matcher is
          {' '}
          <InlineCode>PathPrefix('/&lt;name&gt;')</InlineCode>. TS is
          type-stripped at runtime; jsr/npm imports are allowed. The worker gets
          {' '}
          <InlineCode>read</InlineCode> on the functions dir,{' '}
          <InlineCode>import</InlineCode>, and the socket/port for serving by
          default; <InlineCode>run</InlineCode>/<InlineCode>ffi</InlineCode>/
          <InlineCode>sys</InlineCode> stay denied.
        </P>
        <P>
          Functions are managed by <strong>git</strong> — edit files under{' '}
          <InlineCode>functions/</InlineCode>, commit, and the runtime
          hot-reloads on the running host (watch + content hash). The panel and
          admin API are read-only; the <strong>Reload</strong>{' '}
          button re-scans the files after a <InlineCode>git pull</InlineCode>.
        </P>
      </Section>

      <Section title='config.yml'>
        <CodeBlock
          language='yaml'
          maxHeight='max-h-96'
          value={`listen: "127.0.0.1:18080"       # functions proxy only
               
threads: 1
workStealing: false

workerTransport:               # how the proxy reaches function workers
  kind: unix                   # or loopback
  dir: "./data/sockets"
  prefix: "fn-"

loadBalancer:
  algorithm: round_robin       # or consistent_hash

functionsDir: "./functions"    # everything resolves relative to cwd

admin:                         # management port: panel + admin API
  listen: "127.0.0.1:19090"    # blank disables it
  staticDir: "./static"        # web panel built here (same port)
  token: ""                    # set a token to require x-admin-token`}
        />
      </Section>

      <Section title='CEL matcher reference'>
        <P>
          Route matchers are CEL expressions evaluated per request. Common
          predicates:
        </P>
        <div class='overflow-x-auto'>
          <table class='table table-sm'>
            <thead>
              <tr>
                <th>function</th>
                <th>example</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td class='font-mono'>Method(m)</td>
                <td class='font-mono'>Method('POST')</td>
              </tr>
              <tr>
                <td class='font-mono'>Path(p)</td>
                <td class='font-mono'>Path('/api')</td>
              </tr>
              <tr>
                <td class='font-mono'>PathPrefix(p)</td>
                <td class='font-mono'>PathPrefix('/api')</td>
              </tr>
              <tr>
                <td class='font-mono'>PathRegexp(r)</td>
                <td class='font-mono'>PathRegexp('^/v[0-9]+/')</td>
              </tr>
              <tr>
                <td class='font-mono'>Host(h)</td>
                <td class='font-mono'>Host('*.example.com')</td>
              </tr>
              <tr>
                <td class='font-mono'>HostRegexp(r)</td>
                <td class='font-mono'>HostRegexp('.*')</td>
              </tr>
              <tr>
                <td class='font-mono'>Header(n, v)</td>
                <td class='font-mono'>Header('x-env', 'prod')</td>
              </tr>
              <tr>
                <td class='font-mono'>Query(n, v)</td>
                <td class='font-mono'>Query('debug', '1')</td>
              </tr>
              <tr>
                <td class='font-mono'>ClientIP(ip_or_cidr)</td>
                <td class='font-mono'>ClientIP('10.0.0.0/8')</td>
              </tr>
              <tr>
                <td class='font-mono'>JwtClaim(n, v)</td>
                <td class='font-mono'>JwtClaim('role', 'admin')</td>
              </tr>
            </tbody>
          </table>
        </div>
        <P>
          Value helpers: <InlineCode>HostValue()</InlineCode>,{' '}
          <InlineCode>PathValue()</InlineCode>,{' '}
          <InlineCode>MethodValue()</InlineCode>,{' '}
          <InlineCode>HeaderValue(n)</InlineCode>,{' '}
          <InlineCode>QueryValue(n)</InlineCode>,{' '}
          <InlineCode>ClientIPValue()</InlineCode>,{' '}
          <InlineCode>RequestTime()</InlineCode>,{' '}
          <InlineCode>now()</InlineCode>,{' '}
          <InlineCode>random()</InlineCode>. Use the{' '}
          <strong>Diagnostics</strong> tab to try rules offline.
        </P>
      </Section>

      <Section title='Admin API'>
        <P>Read-only + diagnostics. Functions are written only via git.</P>
        <div class='overflow-x-auto'>
          <table class='table table-sm'>
            <thead>
              <tr>
                <th>method</th>
                <th>path</th>
                <th>notes</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td class='font-mono'>GET</td>
                <td class='font-mono'>/admin/api/status</td>
                <td>runtime + function snapshot</td>
              </tr>
              <tr>
                <td class='font-mono'>GET</td>
                <td class='font-mono'>/admin/api/functions</td>
                <td>list functions</td>
              </tr>
              <tr>
                <td class='font-mono'>GET</td>
                <td class='font-mono'>/admin/api/functions/:name</td>
                <td>config + handler source</td>
              </tr>
              <tr>
                <td class='font-mono'>GET</td>
                <td class='font-mono'>/admin/api/logs</td>
                <td>ring buffer (since/source)</td>
              </tr>
              <tr>
                <td class='font-mono'>POST</td>
                <td class='font-mono'>/admin/api/reload</td>
                <td>re-scan config + functions after git pull</td>
              </tr>
              <tr>
                <td class='font-mono'>POST</td>
                <td class='font-mono'>/admin/api/invoke</td>
                <td>test a request through the proxy</td>
              </tr>
              <tr>
                <td class='font-mono'>POST</td>
                <td class='font-mono'>/admin/api/diagnostics/cel</td>
                <td>rule/expression/analyze</td>
              </tr>
            </tbody>
          </table>
        </div>
      </Section>

      <Section title='Deployment'>
        <P>
          cwd is the deployment root: run{' '}
          <InlineCode>deno task start</InlineCode> from the directory containing
          {' '}
          <InlineCode>config.yml</InlineCode> and{' '}
          <InlineCode>functions/</InlineCode>. Everything is resolved relative
          to cwd. Two separate ports by design:
        </P>
        <ul class='list list-inside space-y-1 text-sm'>
          <li>
            <InlineCode>listen</InlineCode>{' '}
            — functions proxy (function routes only)
          </li>
          <li>
            <InlineCode>admin.listen</InlineCode> — management: web panel +{' '}
            <InlineCode>/admin/api/*</InlineCode> on one port
          </li>
        </ul>
        <P>
          The panel and admin API share the management port; the proxy port
          never serves the panel or admin. Build the panel with{' '}
          <InlineCode>npm run build</InlineCode> into{' '}
          <InlineCode>admin.staticDir</InlineCode> (default{' '}
          <InlineCode>./static</InlineCode>).
        </P>
      </Section>
    </div>
  )
}
