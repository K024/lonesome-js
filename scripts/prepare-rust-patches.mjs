import { createHash } from 'node:crypto'
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const root = resolve(import.meta.dirname, '..')
const crate = {
  name: 'pingora-core',
  version: '0.8.1',
  sha256: '6a7ffe2f5acf9f94fd255cfd1438866bc9124f8f0c7d42562bd3f853df2094b7',
}
const archiveName = `${crate.name}-${crate.version}.crate`
const cacheDirectory = resolve(root, 'target', 'patch-cache')
const downloadedArchive = resolve(cacheDirectory, archiveName)
const patch = resolve(root, 'patches', `${crate.name}+${crate.version}.patch`)
const target = resolve(root, 'target', 'patch', `${crate.name}-${crate.version}`)
const pristineTarget = resolve(root, 'target', 'patch', `${crate.name}-${crate.version}-pristine`)
const marker = resolve(target, '.lonesome-patch.json')
const normalizedPatch = resolve(cacheDirectory, `${crate.name}-${crate.version}.patch.lf`)

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed:\n${result.stderr || result.stdout || 'unknown error'}`,
    )
  }
}

function cargoCacheArchive() {
  const cargoHome = process.env.CARGO_HOME ?? join(process.env.HOME ?? '', '.cargo')
  const cacheRoot = join(cargoHome, 'registry', 'cache')
  if (!existsSync(cacheRoot)) {
    return null
  }

  for (const registry of readdirSync(cacheRoot)) {
    const candidate = join(cacheRoot, registry, archiveName)
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      return candidate
    }
  }

  return null
}

async function downloadArchive() {
  mkdirSync(cacheDirectory, { recursive: true })
  const response = await fetch(
    `https://static.crates.io/crates/${crate.name}/${archiveName}`,
  )
  if (!response.ok) {
    throw new Error(`failed to download ${archiveName}: HTTP ${response.status}`)
  }
  writeFileSync(downloadedArchive, Buffer.from(await response.arrayBuffer()))
  return downloadedArchive
}

if (!existsSync(patch)) {
  throw new Error(`missing dependency patch: ${patch}`)
}

let archive = cargoCacheArchive()
if (!archive) {
  archive = existsSync(downloadedArchive) ? downloadedArchive : await downloadArchive()
}

const archiveSha256 = sha256(archive)
if (archiveSha256 !== crate.sha256) {
  throw new Error(
    `unexpected ${crate.name} archive checksum: expected ${crate.sha256}, got ${archiveSha256}`,
  )
}

const patchSha256 = sha256(patch)
if (existsSync(marker)) {
  const current = JSON.parse(readFileSync(marker, 'utf8'))
  if (
    current.crate === crate.name
    && current.version === crate.version
    && current.archiveSha256 === archiveSha256
    && current.patchSha256 === patchSha256
    && existsSync(pristineTarget)
    && existsSync(resolve(target, '.git'))
  ) {
    process.exit(0)
  }
}

rmSync(target, { recursive: true, force: true })
rmSync(pristineTarget, { recursive: true, force: true })
mkdirSync(dirname(target), { recursive: true })
run('tar', ['-xzf', archive, '-C', dirname(target)])
cpSync(target, pristineTarget, { recursive: true })

gitInit(target)
gitInit(pristineTarget)
applyPatch()

writeFileSync(
  marker,
  `${JSON.stringify({
    crate: crate.name,
    version: crate.version,
    archiveSha256,
    patchSha256,
  }, null, 2)}\n`,
)

function gitInit(dir) {
  run('git', ['-C', dir, 'init', '--quiet'])
  run('git', ['-C', dir, 'add', '-A'])
  run('git', [
    '-C',
    dir,
    '-c',
    'user.name=lonesome-js',
    '-c',
    'user.email=patch@local',
    'commit',
    '--quiet',
    '-m',
    `${crate.name} ${crate.version} pristine source`,
  ])
}

// `git apply` is line-ending sensitive: the committed patch can be checked out
// as CRLF on Windows (core.autocrlf=true) while the extracted crate source is
// LF, which makes every hunk fail. Normalize the patch to LF before applying.
function applyPatch() {
  writeFileSync(normalizedPatch, readFileSync(patch, 'utf8').replace(/\r\n/g, '\n'))
  run('git', ['-C', target, 'apply', '--whitespace=nowarn', normalizedPatch])
}
