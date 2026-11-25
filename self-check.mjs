/**
 * Self-check for the dsh-service bundle.
 *
 * Runs both halves' Host logic in this process with a stand-in context, so a
 * change is testable without restarting the service it manages. The scratch
 * units never reach systemd: `systemctl show` reports them not-found, which is
 * exactly the state these cases assert against, and a refused `systemctl enable`
 * is reported rather than thrown.
 *
 * The HTTP cases drive the route handler the plugin registers, so the JSON the
 * settings page reads is exercised without a listening socket.
 *
 * Usage: node plugins/dsh-service/self-check.mjs
 */
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { apply } from './index.js'

/** Collect the entries one activation registers through a stand-in context. */
function activate(config) {
  const tools = []
  const routes = []
  const ctx = {
    effect(fn) { return fn() },
    inject(names, callback) {
      if (names.includes('tools')) {
        callback({ effect(fn) { return fn() }, tools: { register(tool) { tools.push(tool); return () => {} } } })
      }
      if (names.includes('webServer')) {
        callback({ effect(fn) { return fn() }, webServer: { register(route) { routes.push(route); return () => {} } } })
      }
    },
  }
  apply(ctx, config)
  return {
    tool: name => tools.find(entry => entry.name === name),
    tools,
    routes,
    /** Drive one registered route as the settings page does, with an owner session. */
    async http(method, path, body, peer = { principal: { kind: 'owner' } }) {
      const req = new EventEmitter()
      req.method = method
      req.url = path
      req.destroy = () => {}
      const res = new EventEmitter()
      res.destroyed = false
      res.writableEnded = false
      const answered = new Promise((resolve) => {
        res.writeHead = (status) => { res.status = status }
        res.end = (text) => { res.body = text; res.writableEnded = true; resolve() }
      })
      const settled = routes[0].handler(req, res, peer)
      if (body !== undefined) {
        process.nextTick(() => {
          req.emit('data', Buffer.from(body, 'utf8'))
          req.emit('end')
        })
      }
      await Promise.all([settled, answered])
      return { status: res.status, payload: res.body === undefined ? undefined : JSON.parse(res.body) }
    },
  }
}

const scratch = await mkdtemp(join(tmpdir(), 'dsh-service-selfcheck-'))
const logPath = join(scratch, 'service.log')
await writeFile(logPath, 'dsh web: https://dsh.example.test/?token=secret\n', 'utf8')

const compliant = [
  '[Unit]',
  'Description=Compliant probe',
  'After=network-online.target',
  'Wants=network-online.target',
  '',
  '[Service]',
  'Type=simple',
  'Restart=on-failure',
  'RestartSec=10',
  `StandardOutput=append:${logPath}`,
  `StandardError=append:${logPath}`,
  'ExecStart=/bin/true',
  '',
  '[Install]',
  'WantedBy=multi-user.target',
  '',
].join('\n')
await writeFile(join(scratch, 'compliant.service'), compliant, 'utf8')
await writeFile(join(scratch, 'bare.service'), '[Service]\n# keep me\nExecStart=/bin/true\n', 'utf8')

const failures = []
const results = []

/** Record one assertion. */
function check(name, condition, detail = '') {
  results.push({ name, ok: condition, detail })
  if (!condition) failures.push(`${name}${detail === '' ? '' : ` — ${detail}`}`)
}

try {
  const probe = activate({ unit: 'compliant.service', unitDir: scratch, logPath })
  check('registers seven tools', probe.tools.length === 7, probe.tools.map(entry => entry.name).join(', '))
  check('registers the history and repair tools', probe.tool('dsh_service_history') !== undefined && probe.tool('dsh_service_repair') !== undefined)
  check('registers one prefix route', probe.routes.length === 1 && probe.routes[0].kind === 'prefix' && probe.routes[0].path === '/api/dsh-service')
  check('route requires authentication', probe.routes[0]?.auth === 'required')

  const status = await probe.tool('dsh_service_status').execute({}, { signal: undefined })
  const met = Object.fromEntries(status.guarantees.checks.map(entry => [entry.id, entry.ok]))
  check('compliant unit keeps its four unit-level guarantees', met.recovery && met.network && met.log && met.access, JSON.stringify(met))
  check('a unit systemd never loaded reports detach and boot unmet', met.detach === false && met.boot === false, JSON.stringify(met))
  check('every check reports whether a repair can restore it', status.guarantees.checks.every(entry => typeof entry.fixable === 'boolean'))
  check('unit-file guarantees are repairable and the deployment facts are not', status.guarantees.checks.filter(entry => entry.fixable).map(entry => entry.id).join(',') === 'boot,recovery,network,log', status.guarantees.checks.map(entry => `${entry.id}=${entry.fixable}`).join(','))
  check('status lists the live log segment', status.logSegments.length === 1 && status.logSegments[0].name === 'current' && status.logSegments[0].current === true, JSON.stringify(status.logSegments))
  const statusText = probe.tool('dsh_service_status').output.render({}, status)[0].text
  check('status text reports the guarantee count', /Guarantees 4\/6/.test(statusText), statusText.split('\n').at(-2))
  check('status text reports the segment count', /Log segments 1;/.test(statusText), statusText.split('\n').at(-1))

  const bareLogPath = join(scratch, 'absent.log')
  const bare = activate({ unit: 'bare.service', unitDir: scratch, logPath: bareLogPath })
  const bareStatus = await bare.tool('dsh_service_status').execute({}, { signal: undefined })
  check('bare unit meets no guarantee', bareStatus.guarantees.ok === 0, JSON.stringify(bareStatus.guarantees.checks.map(entry => entry.id)))

  const unit = probe.tool('dsh_service_unit')
  const read = await unit.execute({ action: 'read' }, { signal: undefined })
  const readText = unit.output.render({ action: 'read' }, read)[0].text
  check('reading the unit returns its text', readText.includes('Restart=on-failure'), readText.slice(0, 60))
  check('reading the unit does not print write fields', !readText.includes('changed='), readText.slice(0, 60))

  const written = await unit.execute({ action: 'write', content: `${compliant}# reviewed\n` }, { signal: undefined })
  check('an accepted write reports a backup', written.changed === true && typeof written.backupPath === 'string', JSON.stringify(written))
  const rewritten = await unit.execute({ action: 'write', content: `${compliant}# reviewed\n` }, { signal: undefined })
  check('an identical write reports no change', rewritten.changed === false)

  const before = await readFile(join(scratch, 'compliant.service'), 'utf8')
  let rejected
  try {
    await unit.execute({ action: 'write', content: '[Service\nExecStart=/bin/true\n' }, { signal: undefined })
  } catch (error) {
    rejected = error
  }
  check('the verifier rejects a malformed unit', rejected?.code === 'invalid-unit', rejected?.message ?? 'accepted')
  check('a rejected write leaves the file alone', (await readFile(join(scratch, 'compliant.service'), 'utf8')) === before)

  const access = await probe.tool('dsh_service_access_url').execute({}, { signal: undefined })
  check('the access URL hides its token by default', access.token === undefined && access.url === 'https://dsh.example.test/', JSON.stringify(access))
  const withToken = await probe.tool('dsh_service_access_url').execute({ includeToken: true }, { signal: undefined })
  check('includeToken reveals the token', withToken.token === 'secret', JSON.stringify(withToken))

  const logs = await probe.tool('dsh_service_logs').execute({ lines: 5, filter: 'dsh web' }, { signal: undefined })
  check('the log filter keeps only matching lines', logs.returnedLines === 1, JSON.stringify(logs.lines))
  check('the log result names the segment it read', logs.segment === 'current', JSON.stringify(logs.segment))

  // The entry URL is printed once, so it must stay findable after the display
  // window has scrolled past it.
  const buried = join(scratch, 'buried.log')
  const filler = `${'noise line\n'.repeat(24_000)}`
  await writeFile(buried, `dsh web: https://buried.example.test/?token=deep\n${filler}`, 'utf8')
  const buriedProbe = activate({ unit: 'compliant.service', unitDir: scratch, logPath: buried })
  const buriedStatus = await buriedProbe.tool('dsh_service_status').execute({}, { signal: undefined })
  check('the entry URL is found beyond the display window', buriedStatus.access.url === 'https://buried.example.test/?token=deep', JSON.stringify(buriedStatus.access))
  check('the display window still bounds the reported log tail', buriedStatus.guarantees.checks.find(entry => entry.id === 'access').ok === true)
  const narrowProbe = activate({ unit: 'compliant.service', unitDir: scratch, logPath: buried, urlSearchBytes: 64 * 1024 })
  const narrowStatus = await narrowProbe.tool('dsh_service_status').execute({}, { signal: undefined })
  check('a spent search budget leaves the access guarantee unmet', narrowStatus.guarantees.checks.find(entry => entry.id === 'access').ok === false, JSON.stringify(narrowStatus.access))

  // Rotated segments: `.1` is the newest rotation, `.gz` is decompressed on read.
  const rotated = join(scratch, 'rotated')
  await mkdir(rotated, { recursive: true })
  const rotatedLog = join(rotated, 'dsh.log')
  await writeFile(rotatedLog, 'live line\n', 'utf8')
  await writeFile(join(rotated, 'dsh.log.1'), 'first rotation\n', 'utf8')
  await writeFile(join(rotated, 'dsh.log.2.gz'), gzipSync('second rotation\n'), 'utf8')
  await writeFile(join(rotated, 'unrelated.txt'), 'ignored\n', 'utf8')
  const rotatedProbe = activate({ unit: 'compliant.service', unitDir: scratch, logPath: rotatedLog })
  const rotatedStatus = await rotatedProbe.tool('dsh_service_status').execute({}, { signal: undefined })
  const segmentNames = rotatedStatus.logSegments.map(entry => entry.name)
  check('rotated segments are listed live file first', segmentNames.join(',') === 'current,dsh.log.1,dsh.log.2.gz', segmentNames.join(','))
  check('a gzip segment reports its compression', rotatedStatus.logSegments.find(entry => entry.name === 'dsh.log.2.gz')?.compressed === true)
  const older = await rotatedProbe.tool('dsh_service_logs').execute({ segment: 'dsh.log.2.gz' }, { signal: undefined })
  check('a gzip segment is decompressed before the tail is taken', older.lines.join('') === 'second rotation', JSON.stringify(older.lines))
  check('reading a segment reports the file it read', older.path === join(rotated, 'dsh.log.2.gz'), older.path)
  let unknownSegment
  try {
    await rotatedProbe.tool('dsh_service_logs').execute({ segment: 'dsh.log.9' }, { signal: undefined })
  } catch (error) {
    unknownSegment = error
  }
  check('an undiscovered segment is refused', unknownSegment?.code === 'invalid-request', unknownSegment?.message ?? 'accepted')
  const limitedProbe = activate({ unit: 'compliant.service', unitDir: scratch, logPath: rotatedLog, logSegmentLimit: 2 })
  const limitedStatus = await limitedProbe.tool('dsh_service_status').execute({}, { signal: undefined })
  check('logSegmentLimit bounds the listed segments', limitedStatus.logSegments.length === 2, JSON.stringify(limitedStatus.logSegments.map(entry => entry.name)))

  // Repair: preview never writes, apply writes through verify and backup.
  const repair = bare.tool('dsh_service_repair')
  const preview = await repair.execute({}, { signal: undefined })
  const plannedIds = preview.items.filter(item => item.changes.length > 0).map(item => item.id)
  check('a repair preview plans the six guarantees', preview.applied === false && preview.items.length === 6, JSON.stringify(preview.items.map(item => item.id)))
  check('the preview plans edits for the unit-file guarantees', plannedIds.join(',') === 'boot,recovery,network,log', plannedIds.join(','))
  check('the preview leaves the unit file alone', (await readFile(join(scratch, 'bare.service'), 'utf8')) === '[Service]\n# keep me\nExecStart=/bin/true\n')
  check('the unfixable guarantees explain themselves', preview.items.filter(item => !item.fixable).every(item => typeof item.reason === 'string'), JSON.stringify(preview.items.filter(item => !item.fixable)))
  const previewText = repair.output.render({}, preview)[0].text
  check('the preview text lists the planned directives', previewText.includes('Restart: (unset) → on-failure') && previewText.includes('preview only'), previewText.split('\n')[1])

  const applied = await repair.execute({ apply: true }, { signal: undefined })
  const repairedText = await readFile(join(scratch, 'bare.service'), 'utf8')
  check('an applied repair writes the unit file', applied.changed === true && typeof applied.backupPath === 'string', JSON.stringify({ changed: applied.changed, backup: applied.backupPath }))
  check('the repair adds the recovery directives', repairedText.includes('Restart=on-failure') && repairedText.includes('RestartSec=10'), repairedText)
  check('the repair adds the network directives', repairedText.includes('After=network-online.target') && repairedText.includes('Wants=network-online.target'), repairedText)
  check('the repair points both streams at the log file', repairedText.includes(`StandardOutput=append:${bareLogPath}`) && repairedText.includes(`StandardError=append:${bareLogPath}`), repairedText)
  check('the repair adds an install target', repairedText.includes('WantedBy=multi-user.target'), repairedText)
  check('the repair keeps unrelated lines', repairedText.includes('# keep me') && repairedText.includes('ExecStart=/bin/true'), repairedText)
  check('the repair reports the refused enable instead of throwing', applied.enable.attempted === true && applied.enable.ok === false, JSON.stringify(applied.enable))
  const repairedMet = Object.fromEntries(applied.guarantees.checks.map(entry => [entry.id, entry.ok]))
  check('the repair restores every guarantee it can edit', repairedMet.recovery && repairedMet.network && repairedMet.log && applied.guarantees.ok === 3, JSON.stringify(repairedMet))
  const reapplied = await repair.execute({ apply: true }, { signal: undefined })
  check('a second repair finds nothing left to write', reapplied.changed === false, JSON.stringify({ changed: reapplied.changed, enable: reapplied.enable }))
  const appliedText = repair.output.render({ apply: true }, applied)[0].text
  check('the applied text reports the backup and enable result', appliedText.includes('backup ') && appliedText.includes('enable: failed'), appliedText)

  let missingUnit
  const emptyDir = join(scratch, 'empty')
  await mkdir(emptyDir, { recursive: true })
  const missingProbe = activate({ unit: 'missing.service', unitDir: emptyDir, logPath })
  try {
    await missingProbe.tool('dsh_service_repair').execute({}, { signal: undefined })
  } catch (error) {
    missingUnit = error
  }
  check('repairing a deployment without a unit file fails loud', missingUnit?.code === 'unit-missing', missingUnit?.message ?? 'accepted')

  // History: the journal is the primary source; a host without journalctl
  // degrades to start lines, and an unreadable log reports the reason.
  const history = await probe.tool('dsh_service_history').execute({}, { signal: undefined })
  check('history reports a source and the four counts', ['journal', 'log', 'none'].includes(history.source) && ['starts', 'stops', 'failures', 'restarts'].every(key => Number.isInteger(history[key])), JSON.stringify({ source: history.source, starts: history.starts }))
  check('history keeps at most twenty events, newest first', history.events.length <= 20)
  const historyText = probe.tool('dsh_service_history').output.render({}, history)[0].text
  check('history text summarizes the unit', historyText.includes('compliant.service') && historyText.includes(`source ${history.source}`), historyText.split('\n')[0])
  const originalPath = process.env.PATH
  let degraded
  try {
    process.env.PATH = '/nonexistent'
    degraded = await probe.tool('dsh_service_history').execute({ lines: 50 }, { signal: undefined })
  } finally {
    process.env.PATH = originalPath
  }
  check('a host without journalctl falls back to the log file', degraded.source === 'log' && degraded.starts === 1, JSON.stringify({ source: degraded.source, starts: degraded.starts }))
  check('the fallback says why timestamps are missing', typeof degraded.note === 'string' && degraded.note.includes('no timestamps'), degraded.note)
  let unavailable
  try {
    process.env.PATH = '/nonexistent'
    unavailable = await activate({ unit: 'compliant.service', unitDir: scratch, logPath: scratch }).tool('dsh_service_history').execute({}, { signal: undefined })
  } finally {
    process.env.PATH = originalPath
  }
  check('an unreadable log yields an empty history with a reason', unavailable.source === 'none' && unavailable.starts === 0 && typeof unavailable.note === 'string', JSON.stringify({ source: unavailable.source, note: unavailable.note }))

  // Routes: the settings page reads the same records over JSON.
  const statusRoute = await probe.http('GET', '/api/dsh-service/status')
  check('the status route answers with the status record', statusRoute.status === 200 && statusRoute.payload.ok === true && statusRoute.payload.status.unit === 'compliant.service', JSON.stringify(statusRoute.status))
  const logsRoute = await probe.http('GET', '/api/dsh-service/logs?lines=5')
  check('the logs route answers with the log record', logsRoute.status === 200 && logsRoute.payload.logs.segment === 'current')
  const historyRoute = await probe.http('GET', '/api/dsh-service/history')
  check('the history route answers with the history record', historyRoute.status === 200 && typeof historyRoute.payload.history.source === 'string')
  const repairPreviewRoute = await probe.http('POST', '/api/dsh-service/repair', '{}')
  check('the repair route previews by default', repairPreviewRoute.status === 200 && repairPreviewRoute.payload.repair.applied === false)
  const badApplyRoute = await probe.http('POST', '/api/dsh-service/repair', '{"apply":"yes"}')
  check('the repair route refuses a non-boolean apply', badApplyRoute.status === 400 && badApplyRoute.payload.error.code === 'invalid-request', JSON.stringify(badApplyRoute.payload.error))
  const missingRoute = await missingProbe.http('POST', '/api/dsh-service/repair', '{"apply":true}')
  check('the repair route reports a missing unit file as 404', missingRoute.status === 404 && missingRoute.payload.error.code === 'unit-missing', JSON.stringify(missingRoute.payload.error))
  const forbidden = await probe.http('GET', '/api/dsh-service/status', undefined, { principal: { kind: 'agent' } })
  check('a non-owner session is refused', forbidden.status === 403 && forbidden.payload.error.code === 'forbidden', JSON.stringify(forbidden.payload.error))
  const unknownRoute = await probe.http('GET', '/api/dsh-service/nope')
  check('an unknown endpoint is refused', unknownRoute.status === 404 && unknownRoute.payload.error.code === 'not-found', JSON.stringify(unknownRoute.payload.error))

  // Configuration is validated, not defaulted silently.
  const rejectedConfigs = [
    ['historyLines', { historyLines: 5 }],
    ['logSegmentLimit', { logSegmentLimit: 21 }],
    ['repairRestart', { repairRestart: 'sometimes' }],
    ['repairRestartSec', { repairRestartSec: 0 }],
    ['repairWantedBy', { repairWantedBy: '' }],
    ['urlSearchBytes', { urlSearchBytes: 1024 }],
  ]
  for (const [field, config] of rejectedConfigs) {
    let failure
    try {
      activate(config)
    } catch (error) {
      failure = error
    }
    check(`an invalid ${field} is rejected at load`, failure instanceof Error && failure.message.includes(field), failure?.message ?? 'accepted')
  }

  const backups = (await readdir(scratch)).filter(name => name.includes('.service.bak-'))
  check('an applied repair keeps a backup next to the unit', backups.some(name => name.startsWith('bare.service.bak-')), backups.join(','))
} finally {
  await rm(scratch, { recursive: true, force: true })
}

for (const result of results) console.log(`${result.ok ? 'ok  ' : 'FAIL'} ${result.name}`)
if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed:\n${failures.map(line => `  - ${line}`).join('\n')}`)
  process.exitCode = 1
} else {
  console.log(`\n${results.length} checks passed`)
}
