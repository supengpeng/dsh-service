/**
 * Stage a publishable copy of this bundle under another package name.
 *
 * The working checkout stays `@local/dsh-service` so the profile keeps linking
 * it for development; only the staged copy carries the published name, version,
 * license, and `engines.dsh`. Every identifier that names the package — the
 * loader patch row, the Client module id — is rewritten in the copy, because a
 * published bundle is resolved by its package name.
 *
 * Usage: node scripts/stage-npm.mjs <package-name> <version> [output-directory]
 * Example: node scripts/stage-npm.mjs dsh-service-console 1.0.0 dist/npm
 */
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Package root, resolved from this script's location. */
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
/** Files every publish carries; `files` in the manifest mirrors this list. */
const COPIED = ['index.js', 'client.js', 'cordis.patch.yml', 'icon.svg', 'README.md', 'LICENSE', 'docs']
/** Supported DSH range, taken from the checkout this script stages from. */
const ENGINES_DSH = `^${JSON.parse(await readFile(join(root, '../../package.json'), 'utf8')).version}`

/**
 * Read one required argument.
 * @param position - argument index.
 * @param label - name used in the failure message.
 * @returns the argument text.
 */
function argument(position, label) {
  const value = process.argv[position]
  if (value === undefined || value === '') throw new Error(`stage-npm: missing ${label}`)
  return value
}

const name = argument(2, 'package name')
if (!/^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(name)) throw new Error(`stage-npm: "${name}" is not a valid npm package name`)
const version = argument(3, 'version')
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error(`stage-npm: "${version}" is not a valid version`)
const out = resolve(root, process.argv[4] ?? 'dist/npm')

await rm(out, { recursive: true, force: true })
await mkdir(out, { recursive: true })
for (const entry of COPIED) await cp(join(root, entry), join(out, entry), { recursive: true })
await mkdir(join(out, 'locale'), { recursive: true })
for (const entry of await readdir(join(root, 'locale'))) await cp(join(root, 'locale', entry), join(out, 'locale', entry))

const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
manifest.name = name
manifest.version = version
delete manifest.private
manifest.description = 'Manage the systemd unit that runs this DSH instance from the Web GUI and agent tools: status, supervision guarantees, restart history, rotated log segments, restart and stop, access URL, unit file editing, and one-click repair of unmet guarantees.'
manifest.keywords = ['dsh', 'dsh-bundle', 'systemd', 'service', 'deepseek-runtime']
manifest.license = 'MIT'
manifest.author = manifest.author ?? { name: 'supengpeng' }
manifest.engines = { ...(manifest.engines ?? {}), dsh: ENGINES_DSH }
manifest.files = ['index.js', 'client.js', 'cordis.patch.yml', 'locale/*.json', 'docs', 'icon.svg', 'README.md', 'LICENSE']
manifest.publishConfig = { access: 'public' }
await writeFile(join(out, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

const patchPath = join(out, 'cordis.patch.yml')
await writeFile(patchPath, (await readFile(patchPath, 'utf8')).replaceAll('@local/dsh-service', name), 'utf8')

const clientPath = join(out, 'client.js')
await writeFile(clientPath, (await readFile(clientPath, 'utf8')).replaceAll("id: '@local/dsh-service'", `id: '${name}'`), 'utf8')

console.log(`${name}@${version} staged at ${out}`)
console.log(`files: ${manifest.files.join(', ')}`)
