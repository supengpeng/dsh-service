/**
 * Browser half of the DSH service console bundle.
 *
 * Registers one Settings page and its navigation glyph. Every fact comes from
 * the Host route the bundle's Host half registers; the page never reads the
 * unit or the log itself.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-service',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback, useRef } = React

    const NS = 'dsh-service'
    const ROUTE = '/api/dsh-service'
    const POLL_MS = 5_000
    const NOTICE_MS = 6_000
    /** Most restart-history events the card lists; the Host may send up to 20. */
    const HISTORY_EVENTS = 8
    /** Longest command output a repair notice carries, in characters. */
    const ENABLE_OUTPUT_CHARS = 240

    /**
     * Dictionary keys for the guarantee ids the Host reports.
     *
     * The Host ids are lowercase while the dictionary keys capitalize them, so the
     * mapping is explicit instead of derived from the id.
     */
    const GUARANTEE_TITLES = {
      detach: 'gDetach',
      boot: 'gBoot',
      recovery: 'gRecovery',
      network: 'gNetwork',
      log: 'gLog',
      access: 'gAccess',
    }

    /** Dictionary keys for the restart-history event kinds. */
    const EVENT_KINDS = {
      start: 'historyKindStart',
      stop: 'historyKindStop',
      failure: 'historyKindFailure',
      restart: 'historyKindRestart',
    }

    const MESSAGES = {
      zh: {
        nav: '服务',
        running: '运行中',
        inactive: '已停止',
        failed: '已失败',
        unknown: '未知',
        subtitle: '由 systemd 托管的 DSH 实例',
        insideUnit: '本插件运行在该单元内，重启或停止会断开当前页面。',
        refresh: '刷新',
        restart: '重启服务',
        stop: '停止服务',
        start: '启动服务',
        enable: '启用开机自启',
        disable: '禁用开机自启',
        bootLabel: '开机自启',
        accessTitle: '访问地址',
        accessMissing: '日志与配置中都没有访问地址。',
        guaranteesTitle: '保障项',
        guaranteesMet: '已生效 {ok}/{total}',
        guaranteesBroken: '有 {count} 项未满足',
        gDetach: '会话独立',
        gBoot: '开机自启',
        gRecovery: '崩溃自动恢复',
        gNetwork: '网络就绪',
        gLog: '日志持久化',
        gAccess: '访问地址',
        guaranteesFixable: '可自动修复',
        guaranteesManual: '需人工处理',
        repairAction: '一键修复',
        repairing: '修复中…',
        listSeparator: '、',
        repairConfirm: '一键修复将改写单元文件，让这些项重新满足：{items}。继续？',
        repairDone: '已修复 {changed} 条指令{backup}{enable}。保障 {ok}/{total} 已生效。',
        repairNoop: '没有需要改写的指令{backup}{enable}。保障 {ok}/{total} 已生效。',
        repairEnableOk: '，并已启用开机自启',
        repairEnableFailed: '；启用开机自启失败：{output}',
        copy: '复制',
        copied: '已复制访问地址',
        copyFailed: '复制失败，请手动选择地址',
        logsTitle: '日志',
        logsSegment: '日志段',
        segmentLive: '当前文件',
        segmentCompressed: '(已压缩)',
        logsRangeSegment: '{segment} · 最近 {lines} 行',
        logsEmpty: '暂无日志输出。',
        logsLoading: '正在读取日志…',
        logsRange: '最近 {lines} 行',
        historyTitle: '重启历史',
        historySummary: '启动 {starts} · 停止 {stops} · 失败 {failures} · 重启 {restarts}',
        historyLastFailure: '最近失败 {at} · {detail}',
        historyKindStart: '启动',
        historyKindStop: '停止',
        historyKindFailure: '失败',
        historyKindRestart: '重启',
        historyEmpty: '暂无记录的重启事件。',
        historyLoading: '正在读取重启历史…',
        historyError: '读取重启历史失败：{error}',
        requestOffline: '无法连接服务',
        requestHttpFailed: '服务返回 {detail}',
        unitTitle: '单元文件',
        unitHint: '保存前用 systemd-analyze 校验，原文件备份为 .bak-<时间>，随后执行 daemon-reload。',
        unitMissing: '文件尚不存在。',
        edit: '编辑',
        save: '保存并重载',
        saving: '保存中…',
        cancel: '取消',
        restartConfirm: '重启会在约 {seconds} 秒后断开当前页面，服务恢复后页面会自动重连。继续？',
        stopConfirm: '停止会关闭 DSH 服务，当前页面将无法访问，需要在服务器上手动启动。继续？',
        actionDone: '已执行 systemctl {action} {unit}。',
        actionScheduled: '已安排在 {seconds} 秒后执行 systemctl {action} {unit}。',
        unitSaved: '单元文件已保存{backup}。',
        backupLabel: '，原文件备份于 {path}',
        offline: '连接服务失败，正在重试…',
        pidLabel: '进程',
        startedLabel: '启动于',
        restartsLabel: '重启次数',
        unitFileLabel: '单元',
        logFileLabel: '日志',
        loading: '正在读取状态…',
        empty: '—',
      },
      en: {
        nav: 'Service',
        running: 'Running',
        inactive: 'Stopped',
        failed: 'Failed',
        unknown: 'Unknown',
        subtitle: 'The DSH instance systemd supervises',
        insideUnit: 'This plugin runs inside the unit, so restarting or stopping it drops this page.',
        refresh: 'Refresh',
        restart: 'Restart service',
        stop: 'Stop service',
        start: 'Start service',
        enable: 'Enable at boot',
        disable: 'Disable at boot',
        bootLabel: 'At boot',
        accessTitle: 'Access URL',
        accessMissing: 'Neither the log nor the config carries an access URL.',
        guaranteesTitle: 'Guarantees',
        guaranteesMet: '{ok}/{total} met',
        guaranteesBroken: '{count} unmet',
        gDetach: 'Independent of terminals',
        gBoot: 'Starts at boot',
        gRecovery: 'Crash recovery',
        gNetwork: 'Network ready first',
        gLog: 'Persistent log',
        gAccess: 'Access URL',
        guaranteesFixable: 'Auto-fixable',
        guaranteesManual: 'Needs manual fix',
        repairAction: 'Repair',
        repairing: 'Repairing…',
        listSeparator: ', ',
        repairConfirm: 'Repair rewrites the unit file so these hold again: {items}. Continue?',
        repairDone: 'Directives fixed: {changed}{backup}{enable}. {ok}/{total} guarantees met.',
        repairNoop: 'No directives needed changing{backup}{enable}. {ok}/{total} guarantees met.',
        repairEnableOk: ', and enabled the unit at boot',
        repairEnableFailed: '; enabling at boot failed: {output}',
        copy: 'Copy',
        copied: 'Access URL copied',
        copyFailed: 'Copy failed; select the URL manually',
        logsTitle: 'Log',
        logsSegment: 'Log segment',
        segmentLive: 'Current file',
        segmentCompressed: '(compressed)',
        logsRangeSegment: '{segment} · Last {lines} lines',
        logsEmpty: 'No log output yet.',
        logsLoading: 'Reading the log…',
        logsRange: 'Last {lines} lines',
        historyTitle: 'Restart history',
        historySummary: 'Started {starts} · Stopped {stops} · Failed {failures} · Restarted {restarts}',
        historyLastFailure: 'Last failure {at} · {detail}',
        historyKindStart: 'Started',
        historyKindStop: 'Stopped',
        historyKindFailure: 'Failed',
        historyKindRestart: 'Restarted',
        historyEmpty: 'No restart events recorded.',
        historyLoading: 'Reading restart history…',
        historyError: 'Could not read restart history: {error}',
        requestOffline: 'Cannot reach the service',
        requestHttpFailed: 'The service returned {detail}',
        unitTitle: 'Unit file',
        unitHint: 'Saving verifies the text with systemd-analyze, backs up the current file as .bak-<time>, then runs daemon-reload.',
        unitMissing: 'The file does not exist yet.',
        edit: 'Edit',
        save: 'Save and reload',
        saving: 'Saving…',
        cancel: 'Cancel',
        restartConfirm: 'Restarting drops this page in about {seconds} seconds; it reconnects once the service is back. Continue?',
        stopConfirm: 'Stopping shuts DSH down, so this page becomes unreachable until someone starts the service on the server. Continue?',
        actionDone: 'Ran systemctl {action} {unit}.',
        actionScheduled: 'Scheduled systemctl {action} {unit} in {seconds} seconds.',
        unitSaved: 'Unit file saved{backup}.',
        backupLabel: ', previous file backed up to {path}',
        offline: 'Cannot reach the service; retrying…',
        pidLabel: 'PID',
        startedLabel: 'Started',
        restartsLabel: 'Restarts',
        unitFileLabel: 'Unit',
        logFileLabel: 'Log',
        loading: 'Reading status…',
        empty: '—',
      },
    }

    const styles = {
      section: {
        display: 'flex', flexDirection: 'column', gap: '16px', padding: '8px 0',
        fontSize: '13px', lineHeight: '22px', color: 'var(--dsw-alias-label-primary)',
      },
      card: {
        display: 'flex', flexDirection: 'column', gap: '8px', padding: '12px 16px',
        border: '0.5px solid var(--dsw-alias-settings-card-stroke, var(--dsw-alias-border-l1))',
        borderRadius: 'var(--dsw-radius-xl)',
        background: 'var(--dsw-alias-settings-card-fill, var(--dsw-alias-bg-layer-1))',
      },
      statusRow: { display: 'flex', alignItems: 'center', gap: '8px', minWidth: '0' },
      stateText: { fontSize: '14px', fontWeight: '500' },
      unitText: { color: 'var(--dsw-alias-label-secondary)', fontFamily: 'var(--dsw-font-markdown-code-font-family, ui-monospace, monospace)' },
      muted: { color: 'var(--dsw-alias-label-tertiary)' },
      secondary: { color: 'var(--dsw-alias-label-secondary)' },
      cardTitle: { fontSize: '12px', fontWeight: '500', color: 'var(--dsw-alias-label-secondary)' },
      button: {
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center', height: '28px',
        padding: '0 12px', fontSize: '12px', fontFamily: 'inherit', cursor: 'pointer', flex: 'none',
        borderRadius: 'var(--dsw-radius-sm)', borderWidth: '0.5px', borderStyle: 'solid',
        whiteSpace: 'nowrap',
      },
      disabled: { opacity: '0.5', cursor: 'default' },
      actions: { display: 'flex', flexWrap: 'wrap', gap: '8px' },
      valueBox: {
        padding: '8px 10px', fontSize: '12px', lineHeight: '18px', wordBreak: 'break-all', margin: '0',
        borderRadius: 'var(--dsw-radius-sm)', color: 'var(--dsw-alias-label-secondary)',
        background: 'var(--dsw-alias-bg-layer-2)', border: '0.5px solid var(--dsw-alias-border-l1)',
        fontFamily: 'var(--dsw-font-markdown-code-font-family, ui-monospace, monospace)',
      },
      logBox: {
        margin: '0', padding: '10px', maxHeight: '220px', overflow: 'auto',
        fontSize: '11px', lineHeight: '17px', whiteSpace: 'pre-wrap', wordBreak: 'break-all',
        borderRadius: 'var(--dsw-radius-sm)', color: 'var(--dsw-alias-label-secondary)',
        background: 'var(--dsw-alias-bg-layer-2)', border: '0.5px solid var(--dsw-alias-border-l1)',
        fontFamily: 'var(--dsw-font-markdown-code-font-family, ui-monospace, monospace)',
      },
      editor: {
        width: '100%', minHeight: '220px', boxSizing: 'border-box', resize: 'vertical',
        padding: '10px', fontSize: '11px', lineHeight: '17px', font: 'inherit',
        borderRadius: 'var(--dsw-radius-sm)', color: 'var(--dsw-alias-label-primary)',
        background: 'var(--dsw-alias-bg-layer-2)', border: '0.5px solid var(--dsw-alias-border-l1)',
        fontFamily: 'var(--dsw-font-markdown-code-font-family, ui-monospace, monospace)',
      },
      notice: {
        padding: '8px 12px', fontSize: '12px', borderRadius: 'var(--dsw-radius-sm)',
        border: '0.5px solid var(--dsw-alias-border-l1)', background: 'var(--dsw-alias-bg-layer-2)',
      },
      errorNotice: { color: 'var(--dsw-alias-state-error-primary)' },
      warnNotice: { color: 'var(--dsw-alias-state-warn-primary)' },
      titleActions: { display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '8px', flexWrap: 'wrap' },
      checkLabel: { display: 'flex', alignItems: 'center', gap: '8px', flex: 'none' },
      tagFixable: {
        fontSize: '11px', lineHeight: '16px', color: 'var(--dsw-alias-label-secondary)',
        whiteSpace: 'nowrap', flex: 'none',
      },
      tagManual: {
        fontSize: '11px', lineHeight: '16px', color: 'var(--dsw-alias-label-tertiary)',
        whiteSpace: 'nowrap', flex: 'none',
      },
      select: {
        height: '28px', padding: '0 6px', fontSize: '12px', fontFamily: 'inherit', cursor: 'pointer', flex: 'none',
        borderRadius: 'var(--dsw-radius-sm)', borderWidth: '0.5px', borderStyle: 'solid',
      },
    }

    /**
     * Interactive states the inline styles cannot express.
     *
     * Rendered as a React element inside the page, so unmounting the page removes
     * it; every value is a theme token so the rules follow light, dark, and
     * system themes without a second palette.
     */
    const CONTROL_STYLES = `
.dsh-service-root { container-type: inline-size; }
.dsh-service-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; min-height: 28px; }
.dsh-service-detail { display: flex; align-items: baseline; justify-content: flex-end; gap: 8px; flex: 1 1 auto; flex-wrap: wrap; min-width: 0; }
.dsh-service-detail-text { color: var(--dsw-alias-label-tertiary); text-align: right; overflow-wrap: anywhere; min-width: 0; }
.dsh-service-button { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-2); border-color: var(--dsw-alias-border-l1); }
.dsh-service-button:not(:disabled):hover { background: var(--dsw-alias-interactive-bg-hover); border-color: var(--dsw-alias-border-l2); }
.dsh-service-button:not(:disabled):active { background: var(--dsw-alias-bg-layer-1); }
.dsh-service-primary { color: var(--dsw-alias-label-primary-foreground); background: var(--dsw-alias-button-primary-fill); border-color: var(--dsw-alias-button-primary-fill); }
.dsh-service-primary:not(:disabled):hover, .dsh-service-primary:not(:disabled):active {
  background: var(--dsw-alias-button-primary-hover); border-color: var(--dsw-alias-button-primary-hover);
}
.dsh-service-select { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-2); border-color: var(--dsw-alias-border-l1); }
.dsh-service-select:not(:disabled):hover { background: var(--dsw-alias-interactive-bg-hover); border-color: var(--dsw-alias-border-l2); }
.dsh-service-root button:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
.dsh-service-root select:focus-visible, .dsh-service-root textarea:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.dsh-service-root pre { scrollbar-width: thin; }
@container (max-width: 420px) {
  .dsh-service-row { align-items: flex-start; flex-wrap: wrap; gap: 2px 12px; }
  .dsh-service-detail { flex-basis: 100%; justify-content: flex-start; }
  .dsh-service-detail-text { text-align: left; }
}
`

    /**
     * Call one JSON endpoint of the Host half.
     * @param path - endpoint suffix under the route prefix.
     * @param init - optional fetch options.
     * @returns the parsed `ok` payload.
     * @throws RequestError naming why the call failed; the page renders it through its dictionary.
     */
    async function request(path, init) {
      let response
      try {
        response = await fetch(`${ROUTE}${path}`, { headers: { 'content-type': 'application/json' }, ...init })
      } catch (cause) {
        throw new RequestError('offline', cause instanceof Error ? cause.message : String(cause))
      }
      let payload = null
      try {
        payload = await response.json()
      } catch {
        // A non-JSON body carries no reason; the status code is the only fact left.
      }
      if (payload !== null && payload.ok === false) throw new RequestError('host', payload.error.message)
      if (!response.ok) throw new RequestError('http', `HTTP ${response.status}`)
      return payload
    }

    /** A failed route call, tagged with the layer that refused it. */
    class RequestError extends Error {
      /**
       * @param kind - `offline` when the socket failed, `http` for a status code, `host` for a typed Host refusal.
       * @param message - the technical detail, kept for logs and unexpected cases.
       */
      constructor(kind, message) {
        super(message)
        this.name = 'RequestError'
        this.kind = kind
      }
    }

    /**
     * Turn a failed route call into page copy.
     * @param t - dictionary lookup bound to this page.
     * @param error - thrown value from `request`.
     * @returns the localized sentence, falling back to the technical message.
     */
    function failureText(t, error) {
      if (error instanceof RequestError && error.kind === 'offline') return t('requestOffline')
      if (error instanceof RequestError && error.kind === 'http') return t('requestHttpFailed', { detail: error.message })
      return error instanceof Error ? error.message : String(error)
    }

    /**
     * Map the unit's ActiveState to one label key and dot color.
     * @param status - status record.
     * @returns dictionary key and CSS color token.
     */
    function stateOf(status) {
      if (status.activeState === 'active') return { key: 'running', color: 'var(--dsw-alias-state-success-primary)' }
      if (status.activeState === 'failed') return { key: 'failed', color: 'var(--dsw-alias-state-error-primary)' }
      if (status.activeState === 'reloading') return { key: 'running', color: 'var(--dsw-alias-state-warn-primary)' }
      if (status.activeState === 'inactive' || status.activeState === 'activating' || status.activeState === 'deactivating') {
        return { key: 'inactive', color: 'var(--dsw-alias-state-idle-primary)' }
      }
      return { key: 'unknown', color: 'var(--dsw-alias-state-idle-primary)' }
    }

    /**
     * Draw the status dot.
     * @param props - color token.
     * @returns the dot element.
     */
    function StatusDot(props) {
      return h('span', {
        'aria-hidden': true,
        style: { width: '8px', height: '8px', borderRadius: '50%', background: props.color, flex: 'none' },
      })
    }

    /**
     * Render one label/value row of the status card.
     * @param props - label and value.
     * @returns the row element.
     */
    function MetaRow(props) {
      return h('div', { className: 'dsh-service-row' },
        h('span', { style: styles.secondary }, props.label),
        h('span', { style: { ...styles.muted, textAlign: 'right', wordBreak: 'break-all' } }, props.value),
      )
    }

    /**
     * Resolve the display name of one guarantee id.
     * @param t - dictionary lookup bound to this page.
     * @param id - guarantee id from the Host.
     * @returns the localized name, or the raw id for an id this page does not know.
     */
    function guaranteeName(t, id) {
      const key = GUARANTEE_TITLES[id]
      return key === undefined ? String(id) : t(key)
    }

    /**
     * Resolve the label of one restart-history event kind.
     * @param t - dictionary lookup bound to this page.
     * @param kind - event kind from the Host.
     * @returns the localized label, or the raw kind for a kind this page does not know.
     */
    function eventKindLabel(t, kind) {
      const key = EVENT_KINDS[kind]
      return key === undefined ? String(kind) : t(key)
    }

    /** Leading verbs a history message repeats from its own kind label. */
    const REPEATED_VERBS = {
      start: ['Started '],
      stop: ['Stopping ', 'Stopped '],
      failure: [],
      restart: ['Scheduled restart of '],
    }

    /**
     * Drop the verb a history message repeats from the label beside it.
     * @param event - restart-history event from the Host.
     * @returns the detail without the redundant leading verb.
     */
    function historyDetail(event) {
      const prefix = (REPEATED_VERBS[event.kind] ?? []).find(candidate => event.detail.startsWith(candidate))
      return prefix === undefined ? event.detail : event.detail.slice(prefix.length)
    }

    /**
     * Format a Host timestamp for display.
     * @param at - ISO timestamp, possibly an empty string.
     * @param empty - placeholder shown when the timestamp is absent or unreadable.
     * @returns the localized date and time.
     */
    function formatTimestamp(at, empty) {
      if (typeof at !== 'string' || at === '') return empty
      const date = new Date(at)
      if (Number.isNaN(date.getTime())) return empty
      return date.toLocaleString()
    }

    /**
     * Count the directives a repair rewrote.
     *
     * `changed` carries the count when the Host reports one; the per-item changes
     * are the fallback that keeps the notice numeric.
     * @param repair - repair record from the Host route.
     * @returns number of rewritten directives.
     */
    function countChanges(repair) {
      if (typeof repair.changed === 'number' && Number.isFinite(repair.changed)) return repair.changed
      if (!Array.isArray(repair.items)) return 0
      return repair.items.reduce((total, item) => total + (Array.isArray(item.changes) ? item.changes.length : 0), 0)
    }

    /**
     * Fold a command's output into one bounded notice fragment.
     * @param output - raw command output, possibly multi-line or empty.
     * @returns single-line text of at most `ENABLE_OUTPUT_CHARS` characters, without trailing punctuation.
     */
    function compactOutput(output) {
      // The notice supplies its own sentence break, so a command's own trailing
      // punctuation would double it.
      const text = String(output ?? '').replace(/\s+/g, ' ').trim().replace(/[.;:,!?]+$/, '')
      return text.length > ENABLE_OUTPUT_CHARS ? `${text.slice(0, ENABLE_OUTPUT_CHARS)}…` : text
    }

    /**
     * Build one log-segment option label.
     * @param t - dictionary lookup bound to this page.
     * @param segment - segment record from the Host.
     * @returns the segment name, or a localized name for the live file, plus its compressed annotation.
     */
    function segmentOptionLabel(t, segment) {
      if (segment.current === true) return t('segmentLive')
      return segment.compressed === true ? `${segment.name} ${t('segmentCompressed')}` : segment.name
    }

    /**
     * Build the settings page component for one plugin activation.
     * @param ctx - Client plugin context owning the locale service.
     * @returns the page component.
     */
    function createPanel(ctx) {
      const t = ctx.locale.bind(NS)

      return function Panel() {
        const [status, setStatus] = useState(null)
        const [logs, setLogs] = useState(null)
        const [history, setHistory] = useState(null)
        const [historyError, setHistoryError] = useState(null)
        const [segment, setSegment] = useState(null)
        const [unit, setUnit] = useState(null)
        const [draft, setDraft] = useState('')
        const [editing, setEditing] = useState(false)
        const [busy, setBusy] = useState(null)
        const [offline, setOffline] = useState(false)
        const [notice, setNotice] = useState(null)

        /** Whether the previous poll failed, so a later success can refresh stale panels. */
        const offlineRef = useRef(false)
        /** Chosen log segment, readable from the mount effect and the stable loaders. */
        const segmentRef = useRef(null)

        const loadLogs = useCallback(async () => {
          const name = segmentRef.current
          const query = name === null ? '' : `?segment=${encodeURIComponent(name)}`
          try {
            const payload = await request(`/logs${query}`)
            setLogs(payload.logs)
          } catch {
            // A failed log read leaves the status card's offline notice as the visible cause.
          }
        }, [])

        const loadUnit = useCallback(async () => {
          try {
            const payload = await request('/unit')
            setUnit(payload.unit)
          } catch {
            // The unit card still shows the configured path from the status record.
          }
        }, [])

        const loadHistory = useCallback(async () => {
          try {
            const payload = await request('/history')
            setHistory(payload.history)
            setHistoryError(null)
          } catch (error) {
            // Keep the last history; the card reports the failure beside it and retries on demand.
            setHistoryError(failureText(t, error))
          }
        }, [])

        useEffect(() => {
          let cancelled = false
          const loadStatus = async () => {
            try {
              const payload = await request('/status')
              if (cancelled) return
              const recovered = offlineRef.current
              offlineRef.current = false
              setStatus(payload.status)
              setOffline(false)
              // The poll covers the unit state only, so a recovered connection would
              // otherwise leave the log, unit, and history cards showing pre-restart
              // content. Those reads are too heavy to poll; refresh them once here.
              if (recovered) {
                void loadLogs()
                void loadUnit()
                void loadHistory()
              }
            } catch {
              // Restarting replaces this process; keep the last known state and
              // let the next poll re-establish the fact.
              if (!cancelled) {
                offlineRef.current = true
                setOffline(true)
              }
            }
          }
          void loadStatus()
          void loadLogs()
          void loadUnit()
          void loadHistory()
          const timer = setInterval(loadStatus, POLL_MS)
          return () => { cancelled = true; clearInterval(timer) }
        }, [loadLogs, loadUnit, loadHistory])

        useEffect(() => {
          if (notice === null) return undefined
          const timer = setTimeout(() => setNotice(null), NOTICE_MS)
          return () => clearTimeout(timer)
        }, [notice])

        const refreshAll = async () => {
          setBusy('refresh')
          try {
            const payload = await request('/status')
            setStatus(payload.status)
            offlineRef.current = false
            setOffline(false)
            await loadLogs()
            await loadUnit()
            await loadHistory()
          } catch (error) {
            setNotice({ kind: 'error', text: failureText(t, error) })
          } finally {
            setBusy(null)
          }
        }

        const runAction = async (action) => {
          const seconds = status?.restartDelaySeconds ?? 3
          if (action === 'restart' && !window.confirm(t('restartConfirm', { seconds }))) return
          if (action === 'stop' && !window.confirm(t('stopConfirm'))) return
          setBusy(action)
          try {
            const payload = await request('/control', { method: 'POST', body: JSON.stringify({ action }) })
            const control = payload.control
            setNotice({
              kind: 'info',
              text: t(control.scheduled ? 'actionScheduled' : 'actionDone', {
                action, unit: control.unit, seconds: control.delaySeconds,
              }),
            })
          } catch (error) {
            setNotice({ kind: 'error', text: failureText(t, error) })
          } finally {
            setBusy(null)
          }
        }

        /**
         * Rewrite the unit so the unmet, fixable guarantees hold again.
         *
         * The Host applies every fixable check in one pass, so the confirmation names
         * the whole set before anything is written.
         */
        const runRepair = async () => {
          const fixable = (status?.guarantees?.checks ?? []).filter(entry => !entry.ok && entry.fixable === true)
          if (fixable.length === 0) return
          const items = fixable.map(entry => guaranteeName(t, entry.id)).join(t('listSeparator'))
          if (!window.confirm(t('repairConfirm', { items }))) return
          setBusy('repair')
          try {
            const payload = await request('/repair', { method: 'POST', body: JSON.stringify({ apply: true }) })
            const repair = payload.repair
            const changed = countChanges(repair)
            const backup = repair.backupPath === undefined || repair.backupPath === null
              ? ''
              : t('backupLabel', { path: repair.backupPath })
            const enableFailed = repair.enable?.attempted === true && repair.enable.ok !== true
            const enable = repair.enable?.attempted !== true
              ? ''
              : enableFailed
                ? t('repairEnableFailed', { output: compactOutput(repair.enable.output) || t('empty') })
                : t('repairEnableOk')
            // Refresh before reporting: an auxiliary refresh failure must not replace
            // the repair summary, and the cards behind it read the new unit text.
            await refreshAll()
            setNotice({
              kind: enableFailed ? 'warn' : 'info',
              text: t(changed === 0 ? 'repairNoop' : 'repairDone', {
                changed, backup, enable,
                ok: repair.guarantees.ok, total: repair.guarantees.total,
              }),
            })
          } catch (error) {
            setNotice({ kind: 'error', text: failureText(t, error) })
          } finally {
            setBusy(null)
          }
        }

        const openEditor = async () => {
          setBusy('edit')
          try {
            const payload = await request('/unit')
            setUnit(payload.unit)
            setDraft(payload.unit.content ?? '')
            setEditing(true)
          } catch (error) {
            setNotice({ kind: 'error', text: failureText(t, error) })
          } finally {
            setBusy(null)
          }
        }

        const saveUnit = async () => {
          setBusy('save')
          try {
            const payload = await request('/unit', { method: 'POST', body: JSON.stringify({ content: draft }) })
            const written = payload.unit
            setUnit({ path: written.path, unit: written.unit, exists: true, content: draft })
            setEditing(false)
            setNotice({
              kind: 'info',
              text: t('unitSaved', { backup: written.backupPath === undefined ? '' : t('backupLabel', { path: written.backupPath }) }),
            })
          } catch (error) {
            setNotice({ kind: 'error', text: failureText(t, error) })
          } finally {
            setBusy(null)
          }
        }

        const copyAccess = async () => {
          const url = status.access.url
          try {
            await navigator.clipboard.writeText(url)
            setNotice({ kind: 'info', text: t('copied') })
          } catch {
            setNotice({ kind: 'error', text: t('copyFailed') })
          }
        }

        const state = status === null ? null : stateOf(status)
        const active = status?.activeState === 'active'
        // The boot guarantee accepts both states, so the button must agree with it.
        const bootEnabled = status?.unitFileState === 'enabled' || status?.unitFileState === 'enabled-runtime'
        const disabled = busy === null ? {} : styles.disabled
        const accessUrl = status?.access?.url
        const guaranteeChecks = status?.guarantees?.checks ?? []
        const fixableChecks = guaranteeChecks.filter(entry => !entry.ok && entry.fixable === true)
        const segments = logs?.segments ?? []
        // The card reports what the Host actually returned, not what the page asked for.
        // A failed first read has no count to report, so the title stays bare.
        const rangeLines = logs === null ? 0 : logs.lines.length
        // The live file needs no label; a rotated segment does, or the count would look wrong.
        const rotated = typeof logs?.segment === 'string' && logs.segment !== '' && logs.segment !== 'current'
        const rangeText = logs === null
          ? null
          : rotated
            ? t('logsRangeSegment', { segment: logs.segment, lines: rangeLines })
            : t('logsRange', { lines: rangeLines })
        // A failed first read leaves `history` null; the error line then carries the state.
        const historyBody = history === null
          ? (historyError === null ? h('div', { key: 'loading', style: styles.muted }, t('historyLoading')) : null)
          : [
            h('div', { key: 'summary', style: styles.secondary }, t('historySummary', {
              starts: history.starts, stops: history.stops, failures: history.failures, restarts: history.restarts,
            })),
            history.lastFailure === null || history.lastFailure === undefined ? null : h('div', { key: 'lastFailure', style: styles.secondary },
              t('historyLastFailure', {
                at: formatTimestamp(history.lastFailure.at, t('empty')),
                detail: history.lastFailure.detail,
              })),
            history.events.length === 0
              ? h('div', { key: 'events', style: styles.muted }, t('historyEmpty'))
              : h('pre', { key: 'events', style: styles.logBox, 'aria-label': t('historyTitle') },
                history.events.slice(0, HISTORY_EVENTS).map(event => [
                  formatTimestamp(event.at, t('empty')),
                  eventKindLabel(t, event.kind),
                  historyDetail(event),
                ].join('  ')).join('\n')),
            history.note === undefined || history.note === '' ? null : h('div', { key: 'note', style: styles.muted }, history.note),
          ]

        return h('section', { 'aria-label': t('nav'), className: 'dsh-service-root', style: styles.section },
          h('style', { key: 'control-states' }, CONTROL_STYLES),
          notice === null ? null : h('div', {
            role: 'status',
            style: {
              ...styles.notice,
              ...(notice.kind === 'error' ? styles.errorNotice : notice.kind === 'warn' ? styles.warnNotice : {}),
            },
          }, notice.text),
          offline ? h('div', { role: 'status', style: { ...styles.notice, ...styles.warnNotice } }, t('offline')) : null,

          h('div', { style: styles.card },
            h('div', { className: 'dsh-service-row' },
              h('div', { style: styles.statusRow },
                h(StatusDot, { color: state?.color ?? 'var(--dsw-alias-state-idle-primary)' }),
                h('span', { style: styles.stateText }, state === null ? t('loading') : t(state.key)),
                h('span', { style: styles.unitText }, status?.unit ?? ''),
              ),
              h('button', { type: 'button', className: 'dsh-service-button', style: { ...styles.button, ...disabled }, disabled: busy !== null, onClick: () => { void refreshAll() } }, t('refresh')),
            ),
            h('div', { style: styles.muted }, t('subtitle')),
            status?.servesThisProcess ? h('div', { style: styles.muted }, t('insideUnit')) : null,
            h(MetaRow, { label: t('pidLabel'), value: status?.mainPid === undefined || status?.mainPid === null ? t('empty') : String(status.mainPid) }),
            h(MetaRow, { label: t('startedLabel'), value: status?.startedAt === undefined || status.startedAt === '' ? t('empty') : status.startedAt }),
            h(MetaRow, { label: t('restartsLabel'), value: status?.restarts === undefined || status?.restarts === null ? t('empty') : String(status.restarts) }),
            h(MetaRow, { label: t('unitFileLabel'), value: status?.unitPath ?? '' }),
            h(MetaRow, { label: t('logFileLabel'), value: status?.logPath ?? '' }),
            h(MetaRow, { label: t('bootLabel'), value: status?.unitFileState === undefined || status.unitFileState === '' ? t('empty') : status.unitFileState }),
          ),

          status?.guarantees === undefined ? null : h('div', { style: styles.card },
            h('div', { className: 'dsh-service-row' },
              h('span', { style: styles.cardTitle }, t('guaranteesTitle')),
              h('div', { style: styles.titleActions },
                h('span', { style: styles.muted }, t(
                  status.guarantees.ok === status.guarantees.total ? 'guaranteesMet' : 'guaranteesBroken',
                  {
                    ok: status.guarantees.ok,
                    total: status.guarantees.total,
                    count: status.guarantees.total - status.guarantees.ok,
                  },
                )),
                fixableChecks.length === 0 ? null : h('button', {
                  type: 'button', className: 'dsh-service-button', style: { ...styles.button, ...disabled }, disabled: busy !== null,
                  onClick: () => { void runRepair() },
                }, busy === 'repair' ? t('repairing') : t('repairAction')),
              ),
            ),
            ...guaranteeChecks.map(entry => h('div', { key: entry.id, className: 'dsh-service-row' },
              h('div', { style: styles.checkLabel },
                h(StatusDot, { color: entry.ok ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-state-error-primary)' }),
                h('span', {}, guaranteeName(t, entry.id)),
              ),
              h('div', { className: 'dsh-service-detail' },
                h('span', { className: 'dsh-service-detail-text' }, entry.detail),
                entry.ok || (entry.fixable !== true && entry.fixable !== false)
                  ? null
                  : h('span', { style: entry.fixable === true ? styles.tagFixable : styles.tagManual },
                    t(entry.fixable === true ? 'guaranteesFixable' : 'guaranteesManual')),
              ),
            )),
          ),

          h('div', { style: styles.card },
            h('div', { className: 'dsh-service-row' },
              h('span', { style: styles.cardTitle }, t('accessTitle')),
              accessUrl === undefined || accessUrl === null
                ? null
                : h('button', { type: 'button', className: 'dsh-service-button', style: styles.button, onClick: () => { void copyAccess() } }, t('copy')),
            ),
            accessUrl === undefined || accessUrl === null
              ? h('div', { style: styles.muted }, t('accessMissing'))
              : h('pre', { style: styles.valueBox, 'aria-label': t('accessTitle') }, accessUrl),
          ),

          h('div', { style: styles.actions },
            h('button', { type: 'button', className: 'dsh-service-button dsh-service-primary', style: { ...styles.button, ...disabled }, disabled: busy !== null, onClick: () => { void runAction('restart') } }, t('restart')),
            active
              ? h('button', { type: 'button', className: 'dsh-service-button', style: { ...styles.button, ...disabled }, disabled: busy !== null, onClick: () => { void runAction('stop') } }, t('stop'))
              : h('button', { type: 'button', className: 'dsh-service-button', style: { ...styles.button, ...disabled }, disabled: busy !== null, onClick: () => { void runAction('start') } }, t('start')),
            h('button', {
              type: 'button', className: 'dsh-service-button', style: { ...styles.button, ...disabled }, disabled: busy !== null,
              onClick: () => { void runAction(bootEnabled ? 'disable' : 'enable') },
            }, bootEnabled ? t('disable') : t('enable')),
          ),

          h('div', { style: styles.card },
            h('div', { className: 'dsh-service-row' },
              h('span', { style: styles.cardTitle }, rangeText === null ? t('logsTitle') : `${t('logsTitle')} · ${rangeText}`),
              h('div', { style: styles.titleActions },
                segments.length > 1 ? h('select', {
                  className: 'dsh-service-select', style: { ...styles.select, ...disabled }, disabled: busy !== null,
                  value: segment ?? logs?.segment ?? '', 'aria-label': t('logsSegment'),
                  onChange: event => {
                    segmentRef.current = event.target.value
                    setSegment(event.target.value)
                    void loadLogs()
                  },
                }, segments.map(entry => h('option', { key: entry.name, value: entry.name }, segmentOptionLabel(t, entry)))) : null,
                h('button', { type: 'button', className: 'dsh-service-button', style: { ...styles.button, ...disabled }, disabled: busy !== null, onClick: () => { void loadLogs() } }, t('refresh')),
              ),
            ),
            logs === null
              ? h('div', { style: styles.muted }, t('logsLoading'))
              : logs.lines.length === 0
                ? h('div', { style: styles.muted }, t('logsEmpty'))
                : h('pre', { style: styles.logBox, 'aria-label': t('logsTitle') }, logs.lines.join('\n')),
          ),

          h('div', { style: styles.card },
            h('div', { className: 'dsh-service-row' },
              h('span', { style: styles.cardTitle }, t('historyTitle')),
              h('button', { type: 'button', className: 'dsh-service-button', style: { ...styles.button, ...disabled }, disabled: busy !== null, onClick: () => { void loadHistory() } }, t('refresh')),
            ),
            historyError === null ? null : h('div', {
              role: 'status',
              style: { ...styles.muted, ...styles.errorNotice },
            }, t('historyError', { error: historyError })),
            historyBody,
          ),

          h('div', { style: styles.card },
            h('div', { className: 'dsh-service-row' },
              h('span', { style: styles.cardTitle }, `${t('unitTitle')} · ${unit?.path ?? status?.unitPath ?? ''}`),
              editing
                ? h('div', { style: styles.actions },
                  h('button', { type: 'button', className: 'dsh-service-button', style: { ...styles.button, ...disabled }, disabled: busy !== null, onClick: () => { setEditing(false) } }, t('cancel')),
                  h('button', { type: 'button', className: 'dsh-service-button dsh-service-primary', style: { ...styles.button, ...disabled }, disabled: busy !== null, onClick: () => { void saveUnit() } }, busy === 'save' ? t('saving') : t('save')),
                )
                : h('button', { type: 'button', className: 'dsh-service-button', style: { ...styles.button, ...disabled }, disabled: busy !== null, onClick: () => { void openEditor() } }, t('edit')),
            ),
            editing
              ? null
              : h('div', { style: styles.muted }, t('unitHint')),
            editing
              ? h('textarea', {
                style: styles.editor, value: draft, spellCheck: false,
                onChange: event => setDraft(event.target.value), 'aria-label': t('unitTitle'),
              })
              : unit === null
                ? null
                : h('pre', { style: styles.valueBox, 'aria-label': t('unitTitle') }, unit.exists ? unit.content : t('unitMissing')),
          ),
        )
      }
    }

    /**
     * Draw the settings navigation glyph for this section.
     * @param props - requested size and selection state.
     * @returns the glyph element.
     */
    function SectionIcon(props) {
      const size = props.size ?? 16
      return h('svg', {
        width: size, height: size, viewBox: '0 0 16 16', 'aria-hidden': true,
        style: { display: 'block', color: props.active ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-label-secondary)' },
      },
      h('rect', { x: 1.6, y: 2.8, width: 12.8, height: 10.4, rx: 2.8, fill: 'none', stroke: 'currentColor', strokeWidth: 1.3 }),
      h('path', { d: 'M4.9 6.4 L6.9 8 L4.9 9.6', fill: 'none', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round' }),
      h('rect', { x: 8.4, y: 9, width: 3.4, height: 1.2, rx: 0.6, fill: 'currentColor' }),
      )
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh: MESSAGES.zh, en: MESSAGES.en }), 'dsh-service: dictionaries')
        const t = ctx.locale.bind(NS)
        const Panel = createPanel(ctx)
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: NS,
          order: 40,
          label: () => t('nav'),
        }, Panel))
        ctx.slots.inject('settings.section.icon', () => ctx.slots.register({
          name: 'settings.section.icon',
          id: NS,
        }, SectionIcon))
      },
    }
  },
})
