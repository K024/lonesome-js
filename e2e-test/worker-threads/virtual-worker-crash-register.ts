import { parentPort, workerData } from 'node:worker_threads'
import { registerVirtualListener } from '../../dist/index.js'

if (!parentPort) {
  throw new Error('parentPort is required')
}

const key = workerData.key as string

registerVirtualListener(key, () => {})
parentPort.postMessage({ type: 'started', key })

setImmediate(() => {
  process.exit(1)
})
