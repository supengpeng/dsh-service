/**
 * Host half of the DSH service console bundle.
 *
 * One implementation serves both callers: the settings page reaches it over the
 * JSON route below, and the agent tools call the same functions. The unit,
 * unit directory, log path, and restart delay are Config fields so a profile
 * patch can retarget another deployment.
 */
import { execFile, spawn } from 'node:child_process'
import { mkdtemp, open, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { gunzip } from 'node:zlib'

/** Path prefix of the settings-page JSON route. */
const ROUTE_PATH = '/api/dsh-service'
/** systemctl actions the control entry point accepts. */
const UNIT_ACTIONS = ['start', 'stop', 'restart', 'enable', 'disable']
/** Largest log tail a single request may ask for. */
const MAX_LOG_LINES = 2000
/** Bytes read backwards from the end of the log file. */
const LOG_WINDOW_BYTES = 96 * 1024
/** Bytes one backwards entry-URL search reads per step. */
const URL_CHUNK_BYTES = 64 * 1024
/** Largest decompressed rotated segment one request may read. */
const MAX_SEGMENT_BYTES = 32 * 1024 * 1024
/** Most history events one payload carries. */
const HISTORY_EVENT_LIMIT = 20
/** Journal priority systemd assigns to errors. */
const PRIORITY_ERROR = '3'
/** Lowercase journal message fragments that mark a failed start or process exit. */
const FAILURE_MARKERS = ['failed with result', 'main process exited, code=', 'start request repeated too quickly', 'killed']
/** Largest JSON request body the settings page may send (a unit file plus envelope). */
const MAX_BODY_BYTES = 256 * 1024
/** systemctl properties reported by the status entry point. */
const SHOW_PROPERTIES = [
  'Id', 'Description', 'LoadState', 'ActiveState', 'SubState', 'UnitFileState', 'FragmentPath',
  'MainPID', 'NRestarts', 'ActiveEnterTimestamp', 'ExecMainStartTimestamp', 'InvocationID',
]

/** Decompresses one rotated log segment. */
const gunzipBuffer = promisify(gunzip)

/** A refusal the caller can act on, unlike a failed command whose output it cannot use. */
class ServiceError extends Error {
  /**
   * @param code - stable machine tag returned to the page and the tools.
   * @param message - human-readable reason.
   * @param hint - optional next action for the reader.
   */
  constructor(code, message, hint) {
    super(message)
    this.name = 'ServiceError'
    this.code = code
    this.hint = hint
  }
}

/**
 * Validate the row's Config and fill deployment defaults.
 * @param raw - the row's `config`, absent when the patch declares none.
 * @returns the resolved settings every operation reads.
 */
export function resolveSettings(raw) {
  const value = raw ?? {}
  if (typeof value !== 'object' || value === null) throw new ServiceError('invalid-config', 'dsh-service: config must be an object')
  const unit = optionalString(value, 'unit', 'dsh.service')
  if (!/^[A-Za-z0-9@._:-]+\.service$/.test(unit)) throw new ServiceError('invalid-config', `dsh-service: unit "${unit}" is not a systemd service unit name`)
  const unitDir = optionalString(value, 'unitDir', '/etc/systemd/system')
  if (!unitDir.startsWith('/')) throw new ServiceError('invalid-config', 'dsh-service: unitDir must be an absolute directory')
  const logPath = optionalString(value, 'logPath', '/root/dsh.log')
  const publicUrl = optionalString(value, 'publicUrl', undefined)
  if (publicUrl !== undefined && !/^https?:\/\/\S+$/.test(publicUrl)) throw new ServiceError('invalid-config', 'dsh-service: publicUrl must be an http(s) URL')
  const repairRestart = optionalString(value, 'repairRestart', 'on-failure')
  if (!RESTART_POLICIES.includes(repairRestart)) throw new ServiceError('invalid-config', `dsh-service: repairRestart must be one of ${RESTART_POLICIES.join(', ')}`)
  return {
    unit,
    unitDir,
    unitPath: join(unitDir, unit),
    logPath,
    publicUrl,
    restartDelaySeconds: numberField(value, 'restartDelaySeconds', 3, 1, 60),
    logTailLines: numberField(value, 'logTailLines', 200, 1, MAX_LOG_LINES),
    historyLines: numberField(value, 'historyLines', 200, 10, 2000),
    logSegmentLimit: numberField(value, 'logSegmentLimit', 5, 1, 20),
    repairRestart,
    repairRestartSec: numberField(value, 'repairRestartSec', 10, 1, MAX_RESTART_SECONDS),
    repairWantedBy: optionalString(value, 'repairWantedBy', 'multi-user.target'),
    urlSearchBytes: numberField(value, 'urlSearchBytes', 4 * 1024 * 1024, URL_CHUNK_BYTES, 64 * 1024 * 1024),
  }
}

/**
 * Read one optional string field.
 * @param value - config object.
 * @param field - field name.
 * @param fallback - value used when the field is absent.
 * @returns the configured string.
 */
function optionalString(value, field, fallback) {
  const candidate = value[field]
  if (candidate === undefined) return fallback
  if (typeof candidate !== 'string' || candidate === '') throw new ServiceError('invalid-config', `dsh-service: ${field} must be a non-empty string`)
  return candidate
}

/**
 * Read one bounded integer field.
 * @param value - config object.
 * @param field - field name.
 * @param fallback - value used when the field is absent.
 * @param low - smallest accepted value.
 * @param high - largest accepted value.
 * @returns the configured number.
 */
function numberField(value, field, fallback, low, high) {
  const candidate = value[field]
  if (candidate === undefined) return fallback
  if (typeof candidate !== 'number' || !Number.isInteger(candidate) || candidate < low || candidate > high) {
    throw new ServiceError('invalid-config', `dsh-service: ${field} must be an integer from ${low} to ${high}`)
  }
  return candidate
}

/**
 * Run one command and collect its output.
 * @param command - executable name or absolute path.
 * @param args - argument vector.
 * @param signal - caller cancellation.
 * @returns stdout and stderr.
 */
function runCommand(command, args, signal) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { signal, timeout: 20_000, maxBuffer: 1 << 20, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error === null) {
        resolve({ stdout, stderr })
        return
      }
      const detail = (stderr ?? '').trim() || error.message
      reject(Object.assign(
        new ServiceError(error.code === 'ENOENT' ? 'command-missing' : 'command-failed', `${command}: ${detail}`),
        { exitCode: error.code },
      ))
    })
  })
}

/**
 * Split `key=value` output of `systemctl show`.
 * @param text - command output.
 * @returns one property record.
 */
function parseProperties(text) {
  const properties = {}
  for (const line of text.split('\n')) {
    const separator = line.indexOf('=')
    if (separator <= 0) continue
    properties[line.slice(0, separator)] = line.slice(separator + 1).trim()
  }
  return properties
}

/**
 * Convert an all-digit property to a number.
 * @param text - raw property value.
 * @returns the number, or undefined when absent or not numeric.
 */
function digitsToNumber(text) {
  if (text === undefined || text === '') return undefined
  return /^\d+$/.test(text) ? Number(text) : undefined
}

/**
 * Read the last `maxLines` lines of the configured service log.
 * @param settings - resolved deployment settings.
 * @param maxLines - line budget.
 * @param signal - caller cancellation.
 * @returns log text, file size, and modification time.
 */
async function readLogTail(settings, maxLines, signal) {
  return readTail(settings.logPath, maxLines, signal, false)
}

/**
 * Read the last `maxLines` lines of one log file.
 *
 * A plain file is read from a byte window at its end, so file size never bounds
 * the work. A gzip segment is decompressed whole, because a compressed tail
 * cannot be located without decoding. A missing file reads as empty.
 * @param path - absolute path of the log file or rotated segment.
 * @param maxLines - line budget.
 * @param signal - caller cancellation.
 * @param compressed - whether the file is a gzip segment.
 * @returns log text, file size in bytes, and modification time.
 * @throws ServiceError with code `log-unreadable` when the path is not a readable regular file, or a gzip segment does not decode within {@link MAX_SEGMENT_BYTES}.
 */
async function readTail(path, maxLines, signal, compressed) {
  let info
  try {
    info = await stat(path)
  } catch (error) {
    if (error.code === 'ENOENT') return { lines: [], bytes: 0, updatedAt: null }
    throw new ServiceError('log-unreadable', `${path}: ${error.message}`)
  }
  if (!info.isFile()) throw new ServiceError('log-unreadable', `${path} is not a regular file`)
  signal?.throwIfAborted()
  const window = compressed ? await readDecompressedText(path, signal) : await readTextWindow(path, info, signal)
  let lines = window.text.split('\n')
  // A mid-line window start would render its partial remainder as a line of its own.
  if (window.partialStart) lines = lines.slice(1)
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  return { lines: lines.slice(-maxLines), bytes: info.size, updatedAt: info.mtime.toISOString() }
}

/**
 * Read the byte window at the end of a plain log file.
 * @param path - absolute file path.
 * @param info - the file's stat result, taken by the caller.
 * @param signal - caller cancellation.
 * @returns the window text and whether it starts mid-line.
 */
async function readTextWindow(path, info, signal) {
  const start = Math.max(0, info.size - LOG_WINDOW_BYTES)
  const handle = await open(path, 'r')
  try {
    const buffer = Buffer.alloc(Math.max(0, info.size - start))
    if (buffer.length > 0) await handle.read(buffer, 0, buffer.length, start)
    return { text: buffer.toString('utf8'), partialStart: start > 0 }
  } finally {
    await handle.close()
  }
}

/**
 * Read and decompress a gzip log segment.
 * @param path - absolute file path.
 * @param signal - caller cancellation.
 * @returns the decompressed text, which always starts at a line boundary.
 * @throws ServiceError with code `log-unreadable` when the segment cannot be read, is not gzip, or exceeds {@link MAX_SEGMENT_BYTES}.
 */
async function readDecompressedText(path, signal) {
  try {
    const encoded = await readFile(path)
    signal?.throwIfAborted()
    const decoded = await gunzipBuffer(encoded, { maxOutputLength: MAX_SEGMENT_BYTES })
    return { text: decoded.toString('utf8'), partialStart: false }
  } catch (error) {
    // Cancellation must reach the caller instead of the unreadable-log report.
    if (signal?.aborted) throw error
    throw new ServiceError('log-unreadable', `${path}: ${error.message}`, 'Rotated segments must be gzip files within the decompression budget.')
  }
}

/**
 * Find the newest `dsh web:` entry URL a log tail carries.
 * @param lines - log tail lines.
 * @returns the URL, or undefined when the log has no entry line.
 */
function newestEntryUrl(lines) {
  let found
  for (const line of lines) {
    const match = /\bdsh web: (https?:\/\/\S+)/.exec(line)
    if (match !== null) found = match[1]
  }
  return found
}

/**
 * Find the newest entry URL the service log carries.
 *
 * The service prints its entry URL once per start while every later line only
 * grows the file, so the tail window that feeds the display cannot be relied on.
 * This search walks backwards from the end in fixed chunks and stops at the
 * first chunk holding a `dsh web:` line or after `urlSearchBytes`.
 * @param settings - resolved deployment settings.
 * @param signal - caller cancellation.
 * @returns the newest URL, or undefined when the budget ends without one.
 * @throws ServiceError with code `log-unreadable` when the path is not a readable regular file.
 */
async function findEntryUrl(settings, signal) {
  let info
  try {
    info = await stat(settings.logPath)
  } catch (error) {
    if (error.code === 'ENOENT') return undefined
    throw new ServiceError('log-unreadable', `${settings.logPath}: ${error.message}`)
  }
  if (!info.isFile()) throw new ServiceError('log-unreadable', `${settings.logPath} is not a regular file`)
  signal?.throwIfAborted()
  const floor = Math.max(0, info.size - settings.urlSearchBytes)
  const handle = await open(settings.logPath, 'r')
  try {
    let end = info.size
    // Fragment of a line whose start lies in the older chunk that is read next.
    let leading = ''
    while (end > floor) {
      const start = Math.max(floor, end - URL_CHUNK_BYTES)
      const buffer = Buffer.alloc(end - start)
      if (buffer.length > 0) await handle.read(buffer, 0, buffer.length, start)
      signal?.throwIfAborted()
      const text = `${buffer.toString('utf8')}${leading}`
      let complete = text
      if (start > 0) {
        const newline = text.indexOf('\n')
        leading = newline < 0 ? text : text.slice(0, newline)
        complete = newline < 0 ? '' : text.slice(newline + 1)
      }
      const found = newestEntryUrl(complete.split('\n'))
      if (found !== undefined) return found
      end = start
    }
    return undefined
  } finally {
    await handle.close()
  }
}

/**
 * Resolve the browser entry URL, taking the log's newest one over the configured fallback.
 * @param settings - resolved deployment settings.
 * @param signal - caller cancellation.
 * @returns the access record.
 */
async function readAccess(settings, signal) {
  return resolveAccess(settings, await findEntryUrl(settings, signal))
}

/**
 * Read the token a URL query carries.
 * @param url - absolute or relative URL text.
 * @returns the token, or undefined.
 */
function tokenOf(url) {
  try {
    return new URL(url).searchParams.get('token') ?? undefined
  } catch {
    return undefined
  }
}

/**
 * Strip a URL's token query for consumers that must not persist it.
 * @param url - absolute URL text.
 * @returns the URL without its token parameter.
 */
function withoutToken(url) {
  try {
    const parsed = new URL(url)
    parsed.searchParams.delete('token')
    return parsed.href
  } catch {
    return url
  }
}

/**
 * Resolve the browser entry URL and its token.
 * @param settings - resolved deployment settings.
 * @param fromLog - newest `dsh web:` URL the service log carries, or undefined.
 * @returns URL, token, and where the URL came from.
 */
function resolveAccess(settings, fromLog) {
  const url = fromLog ?? settings.publicUrl
  if (url === undefined) return { url: undefined, token: undefined, source: undefined }
  return { url, token: tokenOf(url), source: fromLog === undefined ? 'config' : 'log' }
}

/**
 * Read a section header line's name.
 * @param line - trimmed line.
 * @returns the name between the brackets, or undefined when the line is not a header.
 */
function sectionName(line) {
  return line.startsWith('[') && line.endsWith(']') ? line.slice(1, -1).trim() : undefined
}

/**
 * Split unit file text into its sections and `key=value` entries.
 * @param text - unit file text.
 * @returns one entry list per section name; the pre-section preamble is `''`.
 */
function parseUnitEntries(text) {
  const sections = new Map([['', []]])
  let section = ''
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#') || line.startsWith(';')) continue
    const header = sectionName(line)
    if (header !== undefined) {
      section = header
      if (!sections.has(section)) sections.set(section, [])
      continue
    }
    const separator = line.indexOf('=')
    if (separator <= 0) continue
    sections.get(section).push({ key: line.slice(0, separator).trim(), value: line.slice(separator + 1).trim() })
  }
  return sections
}

/**
 * Read the last value one section assigns to a directive.
 * @param sections - parsed unit entries.
 * @param section - section whose entries are read.
 * @param key - directive name, such as `Restart`.
 * @returns the assigned value, or undefined when the section omits the directive.
 */
function unitValue(sections, section, key) {
  let found
  for (const entry of sections.get(section) ?? []) if (entry.key === key) found = entry.value
  return found
}

/**
 * Whether a directive value lists one whitespace-separated unit name.
 * @param value - directive value, possibly undefined.
 * @param name - unit name to look for.
 * @returns true when the value carries the name.
 */
function listsUnit(value, name) {
  return value !== undefined && value.split(/\s+/).includes(name)
}

/** `Restart=` policies that bring a crashed unit back. */
const RESTART_POLICIES = ['always', 'on-failure', 'on-abnormal', 'on-abort', 'on-watchdog']

/** Longest `RestartSec=` the recovery guarantee accepts, in seconds. */
const MAX_RESTART_SECONDS = 60

/** Guarantee ids a repair can restore by editing the unit file and enabling it. */
const FIXABLE_CHECKS = new Set(['boot', 'recovery', 'network', 'log'])

/** Why a guarantee has no repair, keyed by guarantee id. */
const UNFIXABLE_REASONS = {
  detach: 'this deployment is not started from a unit file; ExecStart belongs to the deployment, not to the plugin',
  access: 'the entry URL is printed by the running service, so only the service log and the configured publicUrl carry it',
}

/** Section names a repair may have to create, in the order it appends them. */
const SECTION_ORDER = ['Unit', 'Service', 'Install']

/**
 * Check the guarantees this deployment promises against the unit text and live state.
 *
 * The ids are fixed because they describe the unit's obligations rather than a
 * deployment choice; a retargeted deployment still has to meet the same ones.
 * @param settings - resolved deployment settings.
 * @param state - live facts read from systemd, the unit file, and the service log.
 * @param content - unit file text, or null when the file is absent or unreadable.
 * @returns one record per guarantee, in reporting order, each carrying whether a repair can restore it.
 */
function checkGuarantees(settings, state, content) {
  const sections = content === null ? new Map() : parseUnitEntries(content)
  const unreadable = content === null
    ? (state.unitFileExists ? 'unit file unreadable' : 'unit file not found')
    : undefined
  const restart = unitValue(sections, 'Service', 'Restart')
  const restartSec = unitValue(sections, 'Service', 'RestartSec')
  const restartDelay = restartSec === undefined ? undefined : Number.parseInt(restartSec, 10)
  const after = unitValue(sections, 'Unit', 'After')
  const wants = unitValue(sections, 'Unit', 'Wants')
  const stdout = unitValue(sections, 'Service', 'StandardOutput')
  const stderr = unitValue(sections, 'Service', 'StandardError')
  const wantedBy = unitValue(sections, 'Install', 'WantedBy')
  const checks = [
    {
      id: 'detach',
      ok: state.fragmentPath !== '',
      detail: state.fragmentPath === ''
        ? 'not loaded from a unit file'
        : `systemd owns PID ${state.mainPid ?? 'unknown'}; no terminal is involved`,
    },
    {
      id: 'boot',
      ok: state.unitFileState === 'enabled' || state.unitFileState === 'enabled-runtime',
      detail: `UnitFileState=${state.unitFileState === '' ? 'unknown' : state.unitFileState}${wantedBy === undefined ? '' : `, WantedBy=${wantedBy}`}`,
    },
    {
      id: 'recovery',
      ok: restart !== undefined && RESTART_POLICIES.includes(restart)
        && (restartDelay === undefined || (Number.isFinite(restartDelay) && restartDelay <= MAX_RESTART_SECONDS)),
      detail: unreadable ?? `Restart=${restart ?? 'unset'}${restartSec === undefined ? '' : `, RestartSec=${restartSec}`}`,
    },
    {
      id: 'network',
      ok: listsUnit(after, 'network-online.target') && listsUnit(wants, 'network-online.target'),
      detail: unreadable ?? `After=${after ?? 'unset'}, Wants=${wants ?? 'unset'}`,
    },
    {
      id: 'log',
      ok: stdout === `append:${settings.logPath}` && stderr === `append:${settings.logPath}`,
      detail: unreadable ?? `StandardOutput=${stdout ?? 'unset'}, StandardError=${stderr ?? 'unset'}`,
    },
    {
      id: 'access',
      ok: state.access.url !== undefined,
      detail: state.access.url === undefined
        ? `no entry URL in ${settings.logPath}`
        : `read from ${state.access.source ?? 'unknown'}`,
    },
  ]
  return checks.map(check => ({ ...check, fixable: FIXABLE_CHECKS.has(check.id) }))
}

/**
 * Read the systemd properties that describe the unit's live state.
 * @param settings - resolved deployment settings.
 * @param signal - caller cancellation.
 * @returns the property map; a host without systemd reports `LoadState=not-found`.
 */
async function readUnitProperties(settings, signal) {
  try {
    const { stdout } = await runCommand('systemctl', ['show', settings.unit, '--no-pager', `--property=${SHOW_PROPERTIES.join(',')}`], signal)
    return parseProperties(stdout)
  } catch (error) {
    // A host without systemd is a deployment fact, not a failed request.
    if (error.code !== 'command-missing' && !/could not be found|not found|not-found|Failed to connect to bus|No such file/i.test(error.message)) throw error
    return { LoadState: 'not-found' }
  }
}

/**
 * Build the facts `checkGuarantees` and `repairPlan` decide from.
 * @param properties - `systemctl show` property map.
 * @param unitFile - result of `readUnitFile`, or null when the file could not be read.
 * @param access - resolved access record.
 * @returns the state record the checks read.
 */
function guaranteeState(properties, unitFile, access) {
  return {
    fragmentPath: properties.FragmentPath ?? '',
    mainPid: digitsToNumber(properties.MainPID),
    unitFileState: properties.UnitFileState ?? '',
    unitFileExists: unitFile?.exists === true,
    access,
  }
}

/**
 * Run the guarantee checks and count the met ones.
 * @param settings - resolved deployment settings.
 * @param state - live facts.
 * @param content - unit file text, or null when the file is absent or unreadable.
 * @returns the guarantees record the page and the tools report.
 */
function collectGuarantees(settings, state, content) {
  const checks = checkGuarantees(settings, state, content)
  return {
    ok: checks.filter(check => check.ok).length,
    total: checks.length,
    checks,
  }
}

/**
 * Collect the unit's live state plus the deployment facts the page shows.
 * @param settings - resolved deployment settings.
 * @param signal - caller cancellation.
 * @returns status record.
 */
async function collectStatus(settings, signal) {
  const properties = await readUnitProperties(settings, signal)
  const log = await readLogTail(settings, settings.logTailLines, signal)
  const access = await readAccess(settings, signal)
  const unitFile = await readUnitFile(settings, signal).catch(error => {
    // A unit path this process may not read still leaves the live state reportable.
    if (error instanceof ServiceError) return null
    throw error
  })
  const state = guaranteeState(properties, unitFile, access)
  return {
    unit: settings.unit,
    guarantees: collectGuarantees(settings, state, unitFile?.content ?? null),
    unitPath: settings.unitPath,
    logPath: settings.logPath,
    loadState: properties.LoadState ?? 'unknown',
    activeState: properties.ActiveState ?? 'unknown',
    subState: properties.SubState ?? '',
    unitFileState: properties.UnitFileState ?? '',
    description: properties.Description ?? '',
    fragmentPath: properties.FragmentPath ?? '',
    mainPid: state.mainPid,
    restarts: digitsToNumber(properties.NRestarts),
    startedAt: properties.ExecMainStartTimestamp || properties.ActiveEnterTimestamp || '',
    invocationId: properties.InvocationID ?? '',
    servesThisProcess: state.mainPid === process.pid,
    pluginPid: process.pid,
    logBytes: log.bytes,
    logUpdatedAt: log.updatedAt,
    logSegments: await listLogSegments(settings),
    restartDelaySeconds: settings.restartDelaySeconds,
    logTailLines: settings.logTailLines,
    access: {
      url: access.url,
      token: access.token,
      source: access.source,
    },
  }
}

/**
 * List the live log file and its rotated segments.
 *
 * Rotated files are named `<basename>.<digits>` or `<basename>.<digits>.gz` by
 * logrotate, where `.1` is the most recent rotation. The live file is listed
 * first as `current`, then rotations from newest to oldest, at most
 * `logSegmentLimit` entries. A directory this process cannot read yields an
 * empty list so the rest of a status report stays available.
 * @param settings - resolved deployment settings.
 * @returns one record per segment, each with its size and modification time.
 */
async function listLogSegments(settings) {
  const directory = dirname(settings.logPath)
  const base = basename(settings.logPath)
  let names
  try {
    names = await readdir(directory)
  } catch (error) {
    // A missing or unreadable log directory leaves the rest of the report intact.
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR' || error.code === 'EACCES' || error.code === 'EPERM') return []
    throw new ServiceError('log-unreadable', `${directory}: ${error.message}`)
  }
  const rotated = []
  const rotatedName = new RegExp(`^${escapeRegExp(base)}\\.(\\d+)(\\.gz)?$`)
  for (const name of names) {
    const match = rotatedName.exec(name)
    if (match === null) continue
    rotated.push({ name, path: join(directory, name), rotation: Number(match[1]), compressed: match[2] !== undefined })
  }
  rotated.sort((left, right) => left.rotation - right.rotation)
  const discovered = [
    { name: 'current', path: settings.logPath, compressed: false, current: true },
    ...rotated.map(entry => ({ name: entry.name, path: entry.path, compressed: entry.compressed, current: false })),
  ].slice(0, settings.logSegmentLimit)
  const segments = []
  for (const entry of discovered) {
    let info
    try {
      info = await stat(entry.path)
    } catch (error) {
      // A rotation can remove a segment between the directory read and this stat.
      info = undefined
    }
    segments.push({
      name: entry.name,
      path: entry.path,
      bytes: info === undefined ? 0 : info.size,
      updatedAt: info === undefined ? null : info.mtime.toISOString(),
      compressed: entry.compressed,
      current: entry.current,
    })
  }
  return segments
}

/**
 * Escape text for literal use inside a regular expression.
 * @param text - literal text.
 * @returns the text with regex metacharacters escaped.
 */
function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Read a bounded log tail from one log segment, with an optional substring filter.
 * @param settings - resolved deployment settings.
 * @param lines - requested line count.
 * @param filter - case-insensitive substring every returned line must contain.
 * @param segment - segment name from `listLogSegments`, missing for the live file.
 * @param signal - caller cancellation.
 * @returns the matching lines, the segment read, and every discovered segment.
 * @throws ServiceError with code `invalid-request` when the segment name is not one `listLogSegments` reports.
 */
async function collectLogs(settings, lines, filter, segment, signal) {
  const segments = await listLogSegments(settings)
  const name = segment ?? 'current'
  const chosen = segments.find(entry => entry.name === name)
  if (chosen === undefined) {
    throw new ServiceError('invalid-request', `unknown log segment ${name}`, `Use one of ${segments.map(entry => entry.name).join(', ')}.`)
  }
  const tail = await readTail(chosen.path, Math.min(lines, MAX_LOG_LINES), signal, chosen.compressed)
  const needle = filter?.toLowerCase()
  const matches = needle === undefined ? tail.lines : tail.lines.filter(line => line.toLowerCase().includes(needle))
  return {
    unit: settings.unit,
    segment: chosen.name,
    segments,
    path: chosen.path,
    bytes: tail.bytes,
    updatedAt: tail.updatedAt,
    requestedLines: lines,
    returnedLines: matches.length,
    lines: matches,
  }
}

/**
 * Convert a journal `__REALTIME_TIMESTAMP` to ISO text.
 * @param value - raw field holding microseconds since the epoch.
 * @returns the ISO timestamp, or '' when the field is absent or unusable.
 */
function realtimeToIso(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return ''
  const microseconds = Number(value)
  if (!Number.isFinite(microseconds) || microseconds <= 0) return ''
  return new Date(Math.round(microseconds / 1000)).toISOString()
}

/**
 * Classify one journal message into a history event kind.
 *
 * The order is the classification contract: a start or stop line is that event
 * even when it also carries an error priority, one transition is one event
 * (`Stopping` and `Deactivated successfully` only announce the `Stopped` line
 * that records it), and `Scheduled restart` wins over the error-priority rule
 * because systemd announces it while recovering.
 * @param message - journal `MESSAGE` text.
 * @param priority - journal `PRIORITY` text, where `3` is an error.
 * @returns the kind, or undefined when the message is not a state transition.
 */
function historyEventKind(message, priority) {
  if (/^Started /.test(message)) return 'start'
  // `Stopping` and `Deactivated successfully` merely announce the stop that
  // `Stopped` records, so counting them would triple every transition.
  if (/^Stopped /.test(message)) return 'stop'
  const lowercase = message.toLowerCase()
  if (FAILURE_MARKERS.some(marker => lowercase.includes(marker))) return 'failure'
  if (lowercase.includes('scheduled restart')) return 'restart'
  return priority === PRIORITY_ERROR ? 'failure' : undefined
}

/**
 * Read the restart count systemd keeps for the unit.
 * @param settings - resolved deployment settings.
 * @param signal - caller cancellation.
 * @returns the count, or undefined when systemd cannot report it.
 */
async function readRestartCount(settings, signal) {
  try {
    const { stdout } = await runCommand('systemctl', ['show', settings.unit, '--no-pager', '--property=NRestarts'], signal)
    return digitsToNumber(parseProperties(stdout).NRestarts)
  } catch (error) {
    // Cancellation still aborts the request; a host without systemd reports no count.
    signal?.throwIfAborted()
    return undefined
  }
}

/**
 * Count journal records by event kind.
 * @param settings - resolved deployment settings.
 * @param stdout - `journalctl --output=json` output.
 * @param window - journal lines requested.
 * @param signal - caller cancellation.
 * @returns the history payload, newest event first.
 */
async function summarizeJournal(settings, stdout, window, signal) {
  const events = []
  for (const line of stdout.split('\n')) {
    const text = line.trim()
    if (text === '') continue
    let record
    try {
      record = JSON.parse(text)
    } catch (error) {
      // journalctl emits bare boot markers even with --output=json.
      continue
    }
    const message = typeof record.MESSAGE === 'string' ? record.MESSAGE : ''
    if (message === '') continue
    const kind = historyEventKind(message, record.PRIORITY)
    if (kind === undefined) continue
    events.push({ at: realtimeToIso(record.__REALTIME_TIMESTAMP), kind, detail: message, microseconds: Number(record.__REALTIME_TIMESTAMP) || 0 })
  }
  events.sort((left, right) => right.microseconds - left.microseconds)
  const count = kind => events.filter(event => event.kind === kind).length
  const lastFailure = events.find(event => event.kind === 'failure')
  return {
    unit: settings.unit,
    source: 'journal',
    window,
    starts: count('start'),
    stops: count('stop'),
    failures: count('failure'),
    restarts: (await readRestartCount(settings, signal)) ?? count('restart'),
    lastFailure: lastFailure === undefined ? null : { at: lastFailure.at, detail: lastFailure.detail },
    events: events.slice(0, HISTORY_EVENT_LIMIT).map(event => ({ at: event.at, kind: event.kind, detail: event.detail })),
  }
}

/**
 * Count the start lines a log tail carries, for hosts whose journal is unavailable.
 * @param settings - resolved deployment settings.
 * @param window - log lines requested.
 * @param note - why the journal was not used.
 * @param signal - caller cancellation.
 * @returns the history payload, degraded to `source: 'log'` or `source: 'none'`.
 */
async function summarizeLogHistory(settings, window, note, signal) {
  let tail
  try {
    tail = await readLogTail(settings, window, signal)
  } catch (error) {
    // Cancellation must reach the caller; an unreadable log only empties the report.
    signal?.throwIfAborted()
    return {
      unit: settings.unit,
      source: 'none',
      window,
      starts: 0,
      stops: 0,
      failures: 0,
      restarts: 0,
      lastFailure: null,
      events: [],
      note: `${note}; ${settings.logPath} is unreadable (${error instanceof Error ? error.message : String(error)})`,
    }
  }
  const starts = tail.lines.filter(line => line.includes('dsh web:'))
  return {
    unit: settings.unit,
    source: 'log',
    window,
    starts: starts.length,
    stops: 0,
    failures: 0,
    restarts: (await readRestartCount(settings, signal)) ?? 0,
    lastFailure: null,
    events: [...starts].reverse().slice(0, HISTORY_EVENT_LIMIT).map(line => ({ at: '', kind: 'start', detail: line })),
    note: `${note}; the log has no timestamps, so only dsh web: start lines are counted`,
  }
}

/**
 * Collect restart history and failure counts for the unit.
 *
 * The journal is the only source that carries timestamps and failure details;
 * a host that lacks it degrades to counting start lines in the log file, and a
 * host whose log is unreadable reports zeros with the reason instead of failing.
 * @param settings - resolved deployment settings.
 * @param lines - journal lines to scan, clamped to the accepted range.
 * @param signal - caller cancellation.
 * @returns the history payload.
 */
async function collectHistory(settings, lines, signal) {
  const window = Math.min(Math.max(lines, 1), MAX_LOG_LINES)
  let stdout
  try {
    ({ stdout } = await runCommand('journalctl', ['--unit', settings.unit, '--no-pager', '--output=json', '--lines', String(window)], signal))
  } catch (error) {
    // Cancellation aborts the request; a missing or failed journalctl degrades to the log file.
    signal?.throwIfAborted()
    return summarizeLogHistory(settings, window, `journalctl unavailable (${error.code ?? 'failed'})`, signal)
  }
  return summarizeJournal(settings, stdout, window, signal)
}

/**
 * Copy a unit to its backup path and write the replacement.
 * @param settings - resolved deployment settings.
 * @param content - already verified unit text.
 * @param current - current file text, or null when the file does not exist.
 * @param signal - caller cancellation.
 * @returns backup and unit paths.
 */
async function replaceUnitFile(settings, content, current, signal) {
  signal?.throwIfAborted()
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
  const backupPath = `${settings.unitPath}.bak-${stamp}`
  if (current !== null) await writeFile(backupPath, current, { encoding: 'utf8', mode: 0o644 })
  await writeFile(settings.unitPath, content, { encoding: 'utf8', mode: 0o644 })
  try {
    await runCommand('systemctl', ['daemon-reload'], signal)
  } catch (error) {
    if (current !== null) await writeFile(settings.unitPath, current, { encoding: 'utf8', mode: 0o644 })
    else await rm(settings.unitPath, { force: true })
    throw error
  }
  return {
    backupPath: current === null ? undefined : backupPath,
    wroteNewFile: current === null,
  }
}

/**
 * Validate unit text with `systemd-analyze verify` before it can replace a file.
 * @param settings - resolved deployment settings.
 * @param content - candidate unit text.
 * @param signal - caller cancellation.
 * @returns the verifier's diagnostics.
 */
async function verifyUnitContent(settings, content, signal) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-service-verify-'))
  try {
    const candidate = join(directory, settings.unit)
    await writeFile(candidate, content, 'utf8')
    const { stderr } = await runCommand('systemd-analyze', ['verify', candidate], signal)
    return stderr.trim()
  } catch (error) {
    throw new ServiceError('invalid-unit', `unit file rejected: ${error.message}`, 'Fix the reported line and write a valid unit file.')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

/**
 * Read the unit file the plugin manages.
 * @param settings - resolved deployment settings.
 * @param signal - caller cancellation.
 * @returns path, existence, and current text.
 */
async function readUnitFile(settings, signal) {
  signal?.throwIfAborted()
  let content = null
  try {
    content = await readFile(settings.unitPath, 'utf8')
  } catch (error) {
    if (error.code !== 'ENOENT') throw new ServiceError('unit-unreadable', `${settings.unitPath}: ${error.message}`)
  }
  return {
    path: settings.unitPath,
    unit: settings.unit,
    exists: content !== null,
    content,
    logPath: settings.logPath,
  }
}

/**
 * Replace the unit file after verification, keeping the previous content.
 * @param settings - resolved deployment settings.
 * @param content - candidate unit text.
 * @param signal - caller cancellation.
 * @returns the applied change and its backup.
 */
async function writeUnitFile(settings, content, signal) {
  if (typeof content !== 'string' || content.trim() === '') throw new ServiceError('invalid-unit', 'unit content must be a non-empty string')
  const normalized = content.endsWith('\n') ? content : `${content}\n`
  const current = await readFile(settings.unitPath, 'utf8').catch(error => {
    if (error.code === 'ENOENT') return null
    throw new ServiceError('unit-unreadable', `${settings.unitPath}: ${error.message}`)
  })
  if (current === normalized) {
    return { path: settings.unitPath, changed: false, backupPath: undefined, verification: 'unchanged' }
  }
  const verification = await verifyUnitContent(settings, normalized, signal)
  const written = await replaceUnitFile(settings, normalized, current, signal)
  return {
    path: settings.unitPath,
    changed: true,
    backupPath: written.backupPath,
    wroteNewFile: written.wroteNewFile,
    verification: verification === '' ? 'ok' : verification,
  }
}

/**
 * Merge one systemd unit name into a whitespace-separated directive value.
 * @param value - current directive value, undefined when the directive is absent.
 * @param name - unit name to add.
 * @returns the value with the name present once, keeping the other names.
 */
function mergeUnitName(value, name) {
  const names = value === undefined ? [] : value.split(/\s+/).filter(entry => entry !== '')
  if (!names.includes(name)) names.push(name)
  return [...new Set(names)].join(' ')
}

/**
 * Draft the `[Install]` edit that lets `systemctl enable` find a target.
 * @param settings - resolved deployment settings.
 * @param sections - parsed unit entries.
 * @returns the change to apply, or an empty list when `WantedBy=` already names a target.
 */
function bootChanges(settings, sections) {
  const wantedBy = unitValue(sections, 'Install', 'WantedBy')
  if (wantedBy !== undefined && wantedBy !== '') return []
  return [{ section: 'Install', key: 'WantedBy', before: wantedBy ?? null, after: settings.repairWantedBy }]
}

/**
 * Draft the `Restart=` and `RestartSec=` edits the recovery guarantee needs.
 * @param settings - resolved deployment settings.
 * @param sections - parsed unit entries.
 * @returns the changes to apply; empty when the unit already meets the guarantee.
 */
function recoveryChanges(settings, sections) {
  const changes = []
  const restart = unitValue(sections, 'Service', 'Restart')
  if (restart === undefined || !RESTART_POLICIES.includes(restart)) {
    changes.push({ section: 'Service', key: 'Restart', before: restart ?? null, after: settings.repairRestart })
  }
  const restartSec = unitValue(sections, 'Service', 'RestartSec')
  const seconds = restartSec === undefined ? undefined : Number.parseInt(restartSec, 10)
  if (restartSec === undefined || !Number.isFinite(seconds) || seconds > MAX_RESTART_SECONDS) {
    changes.push({ section: 'Service', key: 'RestartSec', before: restartSec ?? null, after: String(settings.repairRestartSec) })
  }
  return changes
}

/**
 * Draft the `After=` and `Wants=` edits the network guarantee needs.
 * @param sections - parsed unit entries.
 * @returns the changes to apply; empty when both directives already list the target.
 */
function networkChanges(sections) {
  const changes = []
  for (const key of ['After', 'Wants']) {
    const current = unitValue(sections, 'Unit', key)
    if (listsUnit(current, 'network-online.target')) continue
    changes.push({ section: 'Unit', key, before: current ?? null, after: mergeUnitName(current, 'network-online.target') })
  }
  return changes
}

/**
 * Draft the `StandardOutput=` and `StandardError=` edits the log guarantee needs.
 * @param settings - resolved deployment settings.
 * @param sections - parsed unit entries.
 * @returns the changes to apply; empty when both directives already append to the log.
 */
function logChanges(settings, sections) {
  const expected = `append:${settings.logPath}`
  const changes = []
  for (const key of ['StandardOutput', 'StandardError']) {
    const current = unitValue(sections, 'Service', key)
    if (current === expected) continue
    changes.push({ section: 'Service', key, before: current ?? null, after: expected })
  }
  return changes
}

/**
 * Plan the unit file edits that would restore the unmet guarantees.
 *
 * Only the guarantees the plugin can change live in the plan: the deployment's
 * own `ExecStart` and the URL the running service prints are reported as
 * unfixable instead. An item that is already met carries no changes.
 * @param settings - resolved deployment settings.
 * @param state - live facts, as `checkGuarantees` reads them.
 * @param content - unit file text.
 * @returns one plan item per guarantee, in reporting order.
 * @throws ServiceError with code `unit-missing` when no unit file exists to edit.
 */
function repairPlan(settings, state, content) {
  if (content === null) {
    throw new ServiceError('unit-missing', `${settings.unitPath} does not exist`, 'Write the unit file first; a repair only edits an existing one.')
  }
  const sections = parseUnitEntries(content)
  const planned = {
    boot: () => bootChanges(settings, sections),
    recovery: () => recoveryChanges(settings, sections),
    network: () => networkChanges(sections),
    log: () => logChanges(settings, sections),
  }
  return checkGuarantees(settings, state, content).map((check) => {
    const item = { id: check.id, ok: check.ok, fixable: check.fixable, changes: [] }
    if (check.ok) return item
    if (!check.fixable) return { ...item, reason: UNFIXABLE_REASONS[check.id] }
    const changes = planned[check.id]?.() ?? []
    if (changes.length === 0 && check.id === 'boot') {
      return { ...item, changes, reason: 'WantedBy= already names a target, so applying the plan only runs systemctl enable' }
    }
    return { ...item, changes }
  })
}

/**
 * Locate where one directive of a section can be rewritten or appended.
 *
 * A unit may repeat a section name; systemd reads every occurrence, so the last
 * matching directive line across all occurrences is the one that decides the
 * value and the one a repair rewrites.
 * @param lines - unit file lines.
 * @param section - section name, such as `Service`.
 * @param key - directive name, such as `Restart`.
 * @returns the line to rewrite, or the index a new directive is inserted at; undefined when the section is absent.
 */
function locateDirective(lines, section, key) {
  let current = ''
  let header = -1
  let lastContent = -1
  let rewrite
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim()
    const name = sectionName(line)
    if (name !== undefined) {
      current = name
      if (name === section) {
        header = index
        lastContent = -1
      }
      continue
    }
    if (current !== section) continue
    if (line !== '') lastContent = index
    if (line.startsWith(`${key}=`)) rewrite = index
  }
  if (header < 0) return undefined
  if (rewrite !== undefined) return { rewrite }
  return { insert: lastContent < 0 ? header + 1 : lastContent + 1 }
}

/**
 * Append a missing section with the directives queued for it.
 * @param lines - unit file lines, modified in place.
 * @param section - section name to create.
 * @param pending - queued changes by section name, from which this section is removed.
 * @returns nothing; `lines` carries the new section.
 */
function appendSection(lines, section, pending) {
  const queued = pending.get(section)
  if (queued === undefined) return
  pending.delete(section)
  if (lines.length > 0 && lines[lines.length - 1].trim() !== '') lines.push('')
  lines.push(`[${section}]`)
  for (const change of queued) lines.push(`${change.key}=${change.after}`)
}

/**
 * Apply directive changes to unit text.
 *
 * Each change rewrites the last line assigning its key inside its section,
 * appends the directive to the section's end when it has none, or creates the
 * section (in [Unit], [Service], [Install] order) when it does not exist. Every
 * other line, including comments and blank lines, stays untouched.
 * @param text - current unit text.
 * @param changes - directives to write, as `repairPlan` drafts them.
 * @returns the edited text, ending with exactly one newline.
 */
function applyRepairEdits(text, changes) {
  const lines = text.split('\n')
  // A trailing newline splits into a final empty element that is not a line.
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  const pending = new Map()
  for (const change of changes) {
    const placement = locateDirective(lines, change.section, change.key)
    if (placement === undefined) {
      pending.set(change.section, [...(pending.get(change.section) ?? []), change])
      continue
    }
    if (placement.rewrite !== undefined) lines[placement.rewrite] = `${change.key}=${change.after}`
    else lines.splice(placement.insert, 0, `${change.key}=${change.after}`)
  }
  for (const section of SECTION_ORDER) appendSection(lines, section, pending)
  for (const section of [...pending.keys()]) appendSection(lines, section, pending)
  return `${lines.join('\n')}\n`
}

/**
 * Enable the unit at boot, reporting a refusal instead of throwing it.
 *
 * This runs after the unit file edit has landed, so a rejected enable must reach
 * the caller alongside the successful write rather than replace it.
 * @param settings - resolved deployment settings.
 * @param signal - caller cancellation.
 * @returns whether the command ran, whether it succeeded, and its output.
 */
async function enableUnit(settings, signal) {
  try {
    const { stdout, stderr } = await runCommand('systemctl', ['enable', settings.unit], signal)
    return { attempted: true, ok: true, output: stdout.trim() || stderr.trim() }
  } catch (error) {
    // Cancellation still aborts the request; a refused enable is reported.
    signal?.throwIfAborted()
    return { attempted: true, ok: false, output: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Preview or apply the unit edits that restore the unmet guarantees.
 *
 * Applying writes the edited unit through the same verification, backup, and
 * daemon-reload path as a manual edit, then runs `systemctl enable` while boot
 * start is unmet. The response reports the plan that was computed before the
 * write next to the guarantees read afterwards.
 * @param settings - resolved deployment settings.
 * @param apply - false previews the plan; true writes it.
 * @param signal - caller cancellation.
 * @returns the plan, what ran, and the resulting guarantees.
 * @throws ServiceError with code `unit-missing` when the unit file does not exist.
 */
async function repairUnit(settings, apply, signal) {
  const properties = await readUnitProperties(settings, signal)
  const unitFile = await readUnitFile(settings, signal)
  const access = await readAccess(settings, signal)
  const state = guaranteeState(properties, unitFile, access)
  const items = repairPlan(settings, state, unitFile.content)
  const pending = items.flatMap(item => item.changes)
  const preview = {
    unit: settings.unit,
    unitPath: settings.unitPath,
    applied: apply,
    changed: false,
    enable: { attempted: false, ok: false, output: '' },
    items,
    guarantees: collectGuarantees(settings, state, unitFile.content),
  }
  if (!apply) return preview
  const boot = items.find(item => item.id === 'boot')
  const enablePending = boot !== undefined && !boot.ok
  if (pending.length === 0 && !enablePending) return preview
  const written = pending.length === 0 ? undefined : await writeUnitFile(settings, applyRepairEdits(unitFile.content, pending), signal)
  const enable = enablePending ? await enableUnit(settings, signal) : preview.enable
  const status = await collectStatus(settings, signal)
  return {
    ...preview,
    changed: written?.changed === true,
    backupPath: written?.backupPath,
    verification: written?.verification,
    enable,
    guarantees: status.guarantees,
  }
}

/**
 * Ask PID1 to run one systemctl action after a delay, outside this unit's cgroup.
 *
 * A restart or stop runs from inside the unit it targets, so PID1 must own the
 * request: the HTTP response reaches the page before the process is replaced.
 * @param settings - resolved deployment settings.
 * @param action - `restart` or `stop`.
 * @param delaySeconds - wait before PID1 executes the action.
 * @param signal - caller cancellation.
 * @returns which scheduler accepted the request.
 */
async function scheduleUnitAction(settings, action, delaySeconds, signal) {
  const transientUnit = `dsh-service-${action}-${Math.floor(Date.now() / 1000)}-${randomSuffix()}`
  try {
    const { stderr } = await runCommand(
      'systemd-run',
      ['--quiet', '--collect', '--unit', transientUnit, `--on-active=${delaySeconds}`, 'systemctl', action, settings.unit],
      signal,
    )
    return { method: 'systemd-run', transientUnit, output: stderr.trim() }
  } catch (error) {
    const child = spawn('/bin/sh', ['-c', `sleep ${delaySeconds}; exec systemctl ${action} ${settings.unit}`], { detached: true, stdio: 'ignore' })
    child.unref()
    return { method: 'detached', transientUnit: undefined, output: `systemd-run unavailable (${error.code ?? error.message}); fallback scheduled` }
  }
}

/**
 * Random suffix keeping transient unit names unique across restarts.
 * @returns six lowercase ASCII characters.
 */
function randomSuffix() {
  return Math.random().toString(36).slice(2, 8)
}

/**
 * Run or schedule one unit action.
 * @param settings - resolved deployment settings.
 * @param action - one of {@link UNIT_ACTIONS}.
 * @param delaySeconds - delay used by the actions that must not run in-request.
 * @param signal - caller cancellation.
 * @returns what ran and what it printed.
 */
async function controlUnit(settings, action, delaySeconds, signal) {
  if (!UNIT_ACTIONS.includes(action)) throw new ServiceError('invalid-action', `action must be one of ${UNIT_ACTIONS.join(', ')}`)
  const delayed = action === 'restart' || action === 'stop'
  if (!delayed) {
    const { stdout, stderr } = await runCommand('systemctl', [action, settings.unit], signal)
    return { unit: settings.unit, action, method: 'direct', scheduled: false, delaySeconds: 0, output: (stdout.trim() || stderr.trim()) }
  }
  const delay = clampDelay(delaySeconds, settings.restartDelaySeconds)
  const scheduled = await scheduleUnitAction(settings, action, delay, signal)
  return { unit: settings.unit, action, method: scheduled.method, scheduled: true, delaySeconds: delay, transientUnit: scheduled.transientUnit, output: scheduled.output }
}

/**
 * Bound a caller-supplied delay to the configured range.
 * @param requested - delay from the caller, if any.
 * @param fallback - configured default delay.
 * @returns seconds PID1 waits before acting.
 */
function clampDelay(requested, fallback) {
  if (requested === undefined) return fallback
  if (typeof requested !== 'number' || !Number.isInteger(requested) || requested < 1 || requested > 60) {
    throw new ServiceError('invalid-action', 'delaySeconds must be an integer from 1 to 60')
  }
  return requested
}

/**
 * Resolve the entry URL a caller may publish.
 * @param settings - resolved deployment settings.
 * @param includeToken - whether the token query stays on the URL.
 * @param signal - caller cancellation.
 * @returns the URL, its token, and where the URL came from.
 */
async function collectAccess(settings, includeToken, signal) {
  const access = await readAccess(settings, signal)
  if (access.url === undefined) {
    throw new ServiceError('no-entry-url', 'no access URL found in the log or config', `Set publicUrl in the plugin config, or check ${settings.logPath}.`)
  }
  return {
    unit: settings.unit,
    url: includeToken ? access.url : withoutToken(access.url),
    token: includeToken ? access.token : undefined,
    hasToken: access.token !== undefined,
    source: access.source,
  }
}

/**
 * Serve one settings-page request on the registered prefix route.
 *
 * The WebServer hands over the raw Node request because a resource route only
 * answers GET and HEAD; the page also needs two POST endpoints, so the handler
 * form owns the response and parses its own JSON body.
 * @param req - inbound request.
 * @param res - outbound response.
 * @param settings - resolved deployment settings.
 */
async function serveHttpRequest(req, res, settings) {
  const url = new URL(req.url ?? '/', 'http://dsh.invalid')
  const route = url.pathname.slice(ROUTE_PATH.length).replace(/^\/+/, '')
  const controller = new AbortController()
  req.on('aborted', () => controller.abort())
  res.on('close', () => { if (!res.writableEnded) controller.abort() })
  const signal = controller.signal
  try {
    if (req.method === 'GET' && (route === '' || route === 'status')) {
      respondJson(res, 200, { ok: true, status: await collectStatus(settings, signal) })
      return
    }
    if (req.method === 'GET' && route === 'logs') {
      const requested = boundedLines(url.searchParams.get('lines'), settings.logTailLines)
      const filter = url.searchParams.get('filter') ?? undefined
      const segment = url.searchParams.get('segment') ?? undefined
      respondJson(res, 200, { ok: true, logs: await collectLogs(settings, requested, filter, segment, signal) })
      return
    }
    if (req.method === 'GET' && route === 'history') {
      const requested = boundedLines(url.searchParams.get('lines'), settings.historyLines)
      respondJson(res, 200, { ok: true, history: await collectHistory(settings, requested, signal) })
      return
    }
    if (req.method === 'GET' && route === 'unit') {
      respondJson(res, 200, { ok: true, unit: await readUnitFile(settings, signal) })
      return
    }
    if (req.method === 'POST' && route === 'control') {
      const body = await readJsonBody(req)
      respondJson(res, 200, { ok: true, control: await controlUnit(settings, body.action, body.delaySeconds, signal) })
      return
    }
    if (req.method === 'POST' && route === 'unit') {
      const body = await readJsonBody(req)
      respondJson(res, 200, { ok: true, unit: await writeUnitFile(settings, body.content, signal) })
      return
    }
    if (req.method === 'POST' && route === 'repair') {
      const body = await readJsonBody(req)
      respondJson(res, 200, { ok: true, repair: await repairUnit(settings, repairApplyFlag(body.apply), signal) })
      return
    }
    throw new ServiceError('not-found', `unknown endpoint ${req.method ?? 'GET'} ${url.pathname}`)
  } catch (error) {
    const failure = describeFailure(error)
    respondJson(res, failure.status, { ok: false, error: failure })
  }
}

/**
 * Read the `apply` flag shared by the repair route and the repair tool.
 * @param value - raw field, absent when the caller only wants a preview.
 * @returns whether the caller asked to write the plan.
 * @throws ServiceError with code `invalid-request` when the field is present and not a boolean.
 */
function repairApplyFlag(value) {
  if (value === undefined) return false
  if (typeof value !== 'boolean') throw new ServiceError('invalid-request', 'apply must be a boolean')
  return value
}

/**
 * Parse the `lines` query value.
 * @param raw - query value, possibly absent or malformed.
 * @param fallback - configured default line count.
 * @returns a line count within the accepted range.
 */
function boundedLines(raw, fallback) {
  const parsed = Number.parseInt(raw ?? '', 10)
  if (!Number.isInteger(parsed)) return fallback
  return Math.min(Math.max(parsed, 1), MAX_LOG_LINES)
}

/**
 * Read a JSON request body.
 * @param req - inbound request.
 * @returns the parsed object.
 */
async function readJsonBody(req) {
  const text = await new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new ServiceError('invalid-request', 'request body is too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
  let body
  try {
    body = JSON.parse(text)
  } catch {
    throw new ServiceError('invalid-request', 'request body must be JSON')
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new ServiceError('invalid-request', 'request body must be a JSON object')
  return body
}

/**
 * Convert a thrown value into a response payload.
 * @param error - thrown value.
 * @returns code, message, hint, and HTTP status.
 */
function describeFailure(error) {
  if (error instanceof ServiceError) {
    const status = {
      'invalid-config': 500,
      'not-found': 404,
      'invalid-request': 400,
      'invalid-action': 400,
      'invalid-unit': 400,
      'command-missing': 501,
      'command-failed': 500,
      'unit-missing': 404,
      'unit-unreadable': 500,
      'log-unreadable': 500,
      'no-entry-url': 404,
    }[error.code] ?? 500
    return { status, code: error.code, message: error.message, hint: error.hint }
  }
  return { status: 500, code: 'operation-error', message: error instanceof Error ? error.message : String(error) }
}

/**
 * Write one JSON response.
 * @param res - outbound response.
 * @param status - HTTP status.
 * @param payload - response body.
 */
function respondJson(res, status, payload) {
  if (res.destroyed || res.writableEnded) return
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

/**
 * Format one status value for a tool result.
 * @param value - status record.
 * @returns model-facing text.
 */
function formatStatus(value) {
  const state = `${value.unit}: ${value.activeState}${value.subState === '' ? '' : ` (${value.subState})`}${value.unitFileState === '' ? '' : `, ${value.unitFileState} at boot`}`
  const lines = [
    state,
    `PID ${value.mainPid ?? 'unknown'}${value.servesThisProcess ? ' — this DSH process' : ''}`,
    `Started ${value.startedAt === '' ? 'unknown' : value.startedAt}; restarts ${value.restarts ?? 'unknown'}`,
    `Unit file ${value.unitPath}${value.fragmentPath === '' ? '' : ` (loaded from ${value.fragmentPath})`}`,
    `Log ${value.logPath} (${value.logBytes} bytes)`,
  ]
  const unmet = value.guarantees.checks.filter(entry => !entry.ok)
  lines.push(`Guarantees ${value.guarantees.ok}/${value.guarantees.total}${unmet.length === 0 ? '' : `; unmet: ${unmet.map(entry => `${entry.id} (${entry.detail})`).join('; ')}`}`)
  if (value.access.url !== undefined) {
    lines.push(`Access ${withoutToken(value.access.url)}${value.access.token === undefined ? '' : ' (token present; call dsh_service_access_url with includeToken true to read it)'}`)
  }
  const repairable = unmet.filter(entry => entry.fixable).length
  lines.push(`Log segments ${value.logSegments.length}; unmet guarantees dsh_service_repair can fix: ${repairable}`)
  return lines.join('\n')
}

/**
 * Format one history record for a tool result.
 * @param value - history record.
 * @returns model-facing text with counts, the last failure, and recent events.
 */
function formatHistory(value) {
  const lines = [
    `${value.unit}: ${value.starts} start(s), ${value.stops} stop(s), ${value.failures} failure(s), ${value.restarts} restart(s) — source ${value.source}, window ${value.window} line(s)`,
  ]
  if (value.lastFailure !== null) {
    lines.push(`Last failure ${value.lastFailure.at === '' ? 'at an unknown time' : `at ${value.lastFailure.at}`}: ${value.lastFailure.detail}`)
  }
  for (const event of value.events.slice(0, 10)) {
    lines.push(`${event.at === '' ? '-' : event.at} ${event.kind} ${event.detail}`)
  }
  if (value.note !== undefined) lines.push(value.note)
  return lines.join('\n')
}

/**
 * Format one repair record for a tool result.
 * @param value - repair record.
 * @returns model-facing text: planned directives when previewing, what ran when applying, and the resulting guarantee count.
 */
function formatRepair(value) {
  const lines = [`${value.unitPath}: ${value.applied ? (value.changed ? 'repaired' : 'nothing left to write') : 'preview only'}`]
  const changes = value.items.flatMap(item => item.changes.map(change => (
    `${item.id}: ${change.section}: ${change.key}: ${change.before === null ? '(unset)' : change.before} → ${change.after}`
  )))
  if (changes.length === 0) lines.push('No directive changes are planned.')
  else lines.push(...changes)
  for (const item of value.items) {
    if (item.reason !== undefined) lines.push(`${item.id}: ${item.reason}`)
  }
  if (value.applied) {
    const written = [`changed=${value.changed}`]
    if (value.backupPath !== undefined) written.push(`backup ${value.backupPath}`)
    if (value.verification !== undefined) written.push(`verification ${value.verification}`)
    lines.push(written.join(', '))
    lines.push(`enable: ${value.enable.attempted ? (value.enable.ok ? 'ok' : 'failed') : 'not attempted'}${value.enable.output === '' ? '' : ` — ${value.enable.output}`}`)
  }
  lines.push(`Guarantees ${value.guarantees.ok}/${value.guarantees.total}`)
  return lines.join('\n')
}

/**
 * Register the control tools the agent can call.
 * @param ctx - context with the tools service.
 * @param settings - resolved deployment settings.
 */
function registerTools(ctx, settings) {
  const tools = [
    {
      name: 'dsh_service_status',
      description: 'Read the systemd unit that runs this DSH instance: active state, whether it starts at boot, PID, start time, restart count, unit file path, log file and its rotated segments, the access URL without its token, and which supervision guarantees the unit still meets (session independence, boot start, crash recovery, network readiness, log persistence, access URL). Each unmet guarantee reports whether dsh_service_repair can restore it.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: { schema: { type: 'object' }, render: (_args, value) => [{ type: 'text', text: formatStatus(value) }] },
      async execute(_args, exec) {
        return collectStatus(settings, exec.signal)
      },
    },
    {
      name: 'dsh_service_logs',
      description: `Read the tail of this DSH instance's service log (up to ${MAX_LOG_LINES} lines), optionally keeping only lines that contain a substring. Pass segment to read a rotated file that dsh_service_status lists in logSegments; gzip segments are decompressed first.`,
      parameters: {
        type: 'object',
        properties: {
          lines: { type: 'number', description: `Lines to return, 1-${MAX_LOG_LINES}; defaults to the configured tail size.` },
          filter: { type: 'string', description: 'Case-insensitive substring every returned line must contain.' },
          segment: { type: 'string', description: 'Segment name from dsh_service_status logSegments: current for the live file, or a rotated file name such as dsh.log.1.' },
        },
        additionalProperties: false,
      },
      output: { schema: { type: 'object' }, render: (_args, value) => [{
        type: 'text',
        text: `${value.path} (segment ${value.segment}): ${value.returnedLines} of ${value.requestedLines} requested lines (${value.bytes} bytes)\n${value.lines.join('\n')}`,
      }] },
      async execute(rawArgs, exec) {
        const args = argsOf(rawArgs)
        const lines = integerArgument(args.lines, 'lines', 1, MAX_LOG_LINES) ?? settings.logTailLines
        const filter = stringArgument(args.filter, 'filter')
        const segment = stringArgument(args.segment, 'segment')
        return collectLogs(settings, lines, filter, segment, exec.signal)
      },
    },
    {
      name: 'dsh_service_history',
      description: 'Read the start, stop, failure, and restart history of the systemd unit that runs this DSH instance, newest event first, with counts and the last failure detail. Reads journalctl; on a host without it, counts dsh web: start lines in the log file instead and says so in note.',
      parameters: {
        type: 'object',
        properties: { lines: { type: 'number', description: `Journal lines to scan, 1-${MAX_LOG_LINES}; defaults to the configured history size.` } },
        additionalProperties: false,
      },
      output: { schema: { type: 'object' }, render: (_args, value) => [{ type: 'text', text: formatHistory(value) }] },
      async execute(rawArgs, exec) {
        const args = argsOf(rawArgs)
        const lines = integerArgument(args.lines, 'lines', 1, MAX_LOG_LINES) ?? settings.historyLines
        return collectHistory(settings, lines, exec.signal)
      },
    },
    {
      name: 'dsh_service_repair',
      description: 'Preview or apply the unit file edits that restore unmet supervision guarantees. It previews by default; apply true rewrites the unit file (systemd-analyze verify, timestamped backup, then daemon-reload) and runs systemctl enable while boot start is still unmet. The unit is root-owned, so applying changes how DSH starts at the next boot; a refused enable is reported, not thrown.',
      parameters: {
        type: 'object',
        properties: { apply: { type: 'boolean', description: 'Write the planned edits; false (the default) reports them without touching the unit file.' } },
        additionalProperties: false,
      },
      output: { schema: { type: 'object' }, render: (_args, value) => [{ type: 'text', text: formatRepair(value) }] },
      async execute(rawArgs, exec) {
        const args = argsOf(rawArgs)
        return repairUnit(settings, repairApplyFlag(args.apply), exec.signal)
      },
    },
    {
      name: 'dsh_service_control',
      description: 'Start, stop, restart, enable, or disable the systemd unit that runs this DSH instance. Restart and stop are scheduled by PID1 a few seconds later, so the reply arrives before the page and this process go away; the caller must tell the user to reopen the page.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', required: true, enum: UNIT_ACTIONS, description: 'systemctl action to perform.' },
          delaySeconds: { type: 'number', description: 'Wait before PID1 restarts or stops the unit, 1-60; defaults to the configured delay.' },
        },
        additionalProperties: false,
      },
      output: { schema: { type: 'object' }, render: (_args, value) => [{
        type: 'text',
        text: value.scheduled
          ? `Scheduled systemctl ${value.action} ${value.unit} in ${value.delaySeconds}s via ${value.method}${value.transientUnit === undefined ? '' : ` (${value.transientUnit})`}. This process exits when the action runs.`
          : `Ran systemctl ${value.action} ${value.unit}.\n${value.output}`,
      }] },
      async execute(rawArgs, exec) {
        const args = argsOf(rawArgs)
        const action = stringArgument(args.action, 'action', true)
        if (!UNIT_ACTIONS.includes(action)) throw new ServiceError('invalid-action', `action must be one of ${UNIT_ACTIONS.join(', ')}`)
        return controlUnit(settings, action, args.delaySeconds, exec.signal)
      },
    },
    {
      name: 'dsh_service_access_url',
      description: 'Read the browser entry URL of this DSH instance. The token query is a session credential and is withheld unless includeToken is true.',
      parameters: {
        type: 'object',
        properties: { includeToken: { type: 'boolean', description: 'Return the raw URL including its token query.' } },
        additionalProperties: false,
      },
      output: { schema: { type: 'object' }, render: (_args, value) => [{
        type: 'text',
        text: `${value.url}${value.token === undefined ? '' : `\ntoken: ${value.token}`}\n(source: ${value.source})`,
      }] },
      async execute(rawArgs, exec) {
        const args = argsOf(rawArgs)
        if (args.includeToken !== undefined && typeof args.includeToken !== 'boolean') throw new ServiceError('invalid-request', 'includeToken must be a boolean')
        return collectAccess(settings, args.includeToken === true, exec.signal)
      },
    },
    {
      name: 'dsh_service_unit',
      description: 'Read or replace the systemd unit file that runs this DSH instance. Writing verifies the candidate with systemd-analyze, backs up the previous file, writes it, and runs daemon-reload; a reload failure restores the backup. The file is root-owned, so this changes how DSH starts at the next boot.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', required: true, enum: ['read', 'write'], description: 'Read the current file or replace it.' },
          content: { type: 'string', description: 'Complete unit file text; required for write.' },
        },
        additionalProperties: false,
      },
      output: { schema: { type: 'object' }, render: (_args, value) => [{
        type: 'text',
        text: value.changed === undefined
          ? `${value.path}${value.exists ? '' : ' does not exist'}${value.content === '' ? '' : `\n${value.content}`}`
          : `${value.path}: changed=${value.changed}${value.backupPath === undefined ? '' : `, backup ${value.backupPath}`}\n${value.verification}`,
      }] },
      async execute(rawArgs, exec) {
        const args = argsOf(rawArgs)
        const action = stringArgument(args.action, 'action', true)
        if (action === 'read') {
          const unit = await readUnitFile(settings, exec.signal)
          return { ...unit, content: unit.content ?? '' }
        }
        if (action !== 'write') throw new ServiceError('invalid-action', "action must be 'read' or 'write'")
        const content = stringArgument(args.content, 'content', true)
        return writeUnitFile(settings, content, exec.signal)
      },
    },
  ]
  for (const tool of tools) ctx.effect(() => ctx.tools.register(tool), `dsh-service: ${tool.name}`)
}

/**
 * Narrow raw tool arguments to an object.
 * @param value - model-supplied arguments.
 * @returns the argument record.
 */
function argsOf(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new ServiceError('invalid-request', 'tool arguments must be an object')
  return value
}

/**
 * Read one required-or-optional string argument.
 * @param value - raw field.
 * @param field - field name.
 * @param required - whether absence is a failure.
 * @returns the string, or undefined when optional and absent.
 */
function stringArgument(value, field, required = false) {
  if (value === undefined && !required) return undefined
  if (typeof value !== 'string') throw new ServiceError('invalid-request', `${field} must be a string`)
  return value
}

/**
 * Read one bounded integer argument.
 * @param value - raw field.
 * @param field - field name.
 * @param low - smallest accepted value.
 * @param high - largest accepted value.
 * @returns the number, or undefined when absent.
 */
function integerArgument(value, field, low, high) {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value < low || value > high) {
    throw new ServiceError('invalid-request', `${field} must be an integer from ${low} to ${high}`)
  }
  return value
}

/**
 * Register the Host entries this deployment supports.
 * @param ctx - plugin context.
 * @param config - row config, absent when the patch declares none.
 */
export function apply(ctx, config) {
  let settings
  try {
    settings = resolveSettings(config)
  } catch (error) {
    throw new Error(`dsh-service: config rejected: ${error instanceof Error ? error.message : String(error)}`)
  }
  ctx.inject(['tools'], toolCtx => {
    registerTools(toolCtx, settings)
  })
  ctx.inject(['webServer'], webCtx => {
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'prefix',
      path: ROUTE_PATH,
      auth: 'required',
      handler: async (req, res, peer) => {
        if (peer?.principal.kind !== 'owner') {
          respondJson(res, 403, { ok: false, error: { code: 'forbidden', status: 403, message: 'owner access required' } })
          return
        }
        await serveHttpRequest(req, res, settings)
      },
    }), 'dsh-service: settings-page routes')
  })
}
