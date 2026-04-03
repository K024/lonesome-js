import http from 'k6/http'
import { check } from 'k6'

export const options = {
  vus: Number(__ENV.K6_VUS || 50),
  duration: __ENV.K6_DURATION || '20s',
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<50'],
  },
}

const host = __ENV.BENCH_HOST || '127.0.0.1'
const port = Number(__ENV.BENCH_PORT || 8080)
const path = __ENV.BENCH_PATH || '/bench/target'
const url = `http://${host}:${port}${path}`

export default function () {
  const res = http.get(url)
  check(res, {
    'status is 200': (r) => r.status === 200,
  })
}
