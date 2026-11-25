# Service console

A DeepSeek Harness (DSH) bundle that puts the systemd unit running this DSH instance on a Settings page and behind seven agent tools. It reads the unit (`dsh.service` by default) and controls it: live state, boot enablement, restart history, rotated log segments, the access URL, an editable unit file, and six supervision checks with a repair path.

## Install

```sh
dsh plugin --profile web add dsh-service-console
```

The command installs the package and adds its bundle to the profile's `dsh.profile.bundles` list, so **Service console** (`服务控制台` in Chinese) is listed under **Plugins** with its switch on; refresh the Plugins page if it is not visible yet. **Add plugin** on that page offers the same install followed by **Enable now**, and the switch turns the bundle on if it is off.

Host code is loaded with the DSH process: the Settings page reads the JSON route the Host half registers at startup, and the seven tools register then too. A browser refresh does not reload Host code. On a profile with HMR (the shipped `web` profile mounts it), enabling the bundle recomposes the profile in place, so the page and tools come up without restarting DSH. On a profile without HMR, such as `headless`, `sdk`, or `acp`, the saved selection applies at the next DSH start, and Plugin Manager reports that a restart is required. If the page stays absent, restart the DSH service.

Open the page at **Settings → Service** (`设置 → 服务`) in the Web GUI.

## What the Settings page shows

The page polls the unit status every 5 seconds. The log, unit file, and restart-history cards load on mount and on **Refresh**, and are re-read once after a poll succeeds again following a restart. A failed poll keeps the last known status and shows an offline notice.

- **Status card** — state dot and label (`Running` for `active` or `reloading`, `Stopped` for `inactive`, `activating`, or `deactivating`, `Failed` for `failed`, otherwise `Unknown`), the unit name, **Refresh**, main PID, start timestamp, restart count, unit file path, log path, and the raw `UnitFileState` in the **At boot** row. A note appears when this DSH process is the unit's main process, because a restart or stop then drops the page.
- **Guarantees card** — `x/6 met` or `n unmet`, one row per check with the directive that decided it, and `Auto-fixable` / `Needs manual fix` on unmet rows. A **Repair** button appears when at least one unmet check is auto-fixable; it asks for confirmation naming the affected guarantees, then applies the repair.
- **Access URL card** — the entry URL as found, token included, with a **Copy** button; it says when neither the log nor the config carries one.
- **Actions** — **Restart service**; **Stop service** while the unit is active or **Start service** while it is not; **Disable at boot** while `UnitFileState` is `enabled`, otherwise **Enable at boot**. Restart and stop confirm first: restart says the page drops and reconnects, stop says the page becomes unreachable until the service is started on the server. The page sends no delay, so the configured `restartDelaySeconds` (3 seconds by default) applies.
- **Log card** — the tail at the configured line count, with the title naming the segment and line count once loaded, a **Refresh** button, and a segment selector whenever more than one segment exists. The live file is labeled **Current file**, and a gzip segment carries `(compressed)`. The page has no filter field.
- **Restart history card** — start, stop, failure, and restart counts, the last failure, the 8 newest events, and the degradation `note` when the journal is unavailable.
- **Unit file card** — the current text, or a note that the file does not exist yet; **Edit** opens a textarea with **Cancel** and **Save and reload**. Saving runs `systemd-analyze verify`, backs the previous file up as `<unit>.bak-<timestamp>`, writes it, and runs `daemon-reload`; an unchanged file is not rewritten and has no new backup.

## Supervision guarantees

`dsh_service_status` and the page's guarantees card decide these six checks from the unit file text and the live `systemctl show` state. Each row carries the directive that decided it, and each record carries `fixable`.

| Id | Met when | Repair |
|---|---|---|
| `detach` | `FragmentPath` is non-empty, so systemd loaded the unit from a unit file and owns the process | No: `ExecStart` belongs to the deployment. |
| `boot` | `UnitFileState` is `enabled` or `enabled-runtime` | Yes: adds `WantedBy=` when `[Install]` names no target, then runs `systemctl enable`. |
| `recovery` | `Restart=` is `always`, `on-failure`, `on-abnormal`, `on-abort`, or `on-watchdog`, and `RestartSec=` is absent or at most 60 seconds | Yes: rewrites `Restart=` and `RestartSec=` to the configured values (`on-failure` and `10` by default). |
| `network` | `After=` and `Wants=` in `[Unit]` both list `network-online.target` | Yes: merges `network-online.target` into both directives. |
| `log` | `StandardOutput=` and `StandardError=` both equal `append:<logPath>` | Yes: points both at the configured log path. |
| `access` | The newest `dsh web:` entry URL is available from the log or `publicUrl` | No: only the running service prints it. |

`detach` describes how the deployment was started; `access` needs a running service, so neither can be restored by editing the unit file.

## Repairing unmet guarantees

`dsh_service_repair` previews by default and writes only with `apply: true`; `POST /api/dsh-service/repair` follows the same rule. A preview lists the check ids, the directive changes it would make (`before → after`), a reason for the checks it cannot fix, and the current guarantee count. It writes nothing.

Applying runs these steps:

1. Edits the unit text: it rewrites the last assignment of each directive inside its section, appends the directive when the section exists without it, and creates a missing section with the directives queued for it. New sections are appended in `[Unit]`, `[Service]`, `[Install]` order. Comments, blank lines, and unrelated directives stay untouched.
2. Runs `systemd-analyze verify` on the edited text in a temporary directory; a rejected unit fails with `invalid-unit` and the current file stays as it was.
3. Copies the current file to `<unitPath>.bak-<YYYYMMDDTHHMMSSZ>`, writes the new text, and runs `systemctl daemon-reload`; a failed reload restores the backup.
4. When boot start is still unmet, runs `systemctl enable <unit>`. A refused enable is reported as `enable: { attempted: true, ok: false, output }` instead of failing the call, because the write already landed. A unit whose `WantedBy=` already names a target skips the edit and only runs the enable.

Applying with nothing left to write and boot start already met reports `changed: false` and touches nothing. In the default deployment the unit is root-owned, and an apply that enables boot start changes how DSH starts at the next boot. Repair does not restart the service: `daemon-reload` makes systemd re-read the unit, so new `Restart=`, `RestartSec=`, `StandardOutput=`, and `StandardError=` values take effect on the next start or restart.

## Access URL and token

The URL comes from the newest `dsh web: <http(s)://…>` line in the service log. The search walks backwards from the end of the file in 64 KiB chunks until it finds a line or spends `urlSearchBytes` (4 MiB by default), so the entry line stays findable after the displayed tail has scrolled past it. When the log carries no entry line, the configured `publicUrl` is used; the `source` field says `log` or `config`.

- The Settings page shows the URL as found, token included. The route behind it requires an authenticated owner session and answers `403` for other principals.
- `dsh_service_status` masks the token in its text. `dsh_service_access_url` removes the `token` query parameter by default and reports `hasToken`; `includeToken: true` returns the raw URL and token. The query is a session credential, and rendered tool results are persisted in the session log, so reading it takes an explicit opt-in.
- With neither source carrying a URL, `dsh_service_access_url` fails with `no-entry-url`, and the page says that neither the log nor the config carries an access URL.

## Restart history

The journal is the primary source: `dsh_service_history` runs `journalctl --unit <unit> --no-pager --output=json --lines <window>` on demand, not on the page's status poll. Counts and events:

- `Started` lines count starts; `Stopped` lines count stops.
- Failure markers (`failed with result`, `main process exited, code=`, `start request repeated too quickly`, `killed`) count failures, and so do messages at error priority unless they already matched a start, stop, or scheduled-restart line.
- `Scheduled restart` messages count restarts, and the reported `restarts` prefers systemd's `NRestarts` over that counted figure.
- `Stopping` and `Deactivated successfully` only announce a stop that the `Stopped` line records, so one start/stop transition counts once.
- At most 20 events are returned, newest first; the tool text prints the 10 newest and the page card shows 8.

`lines` defaults to `historyLines` (200) and accepts 1–2000.

When `journalctl` is missing or the call fails, the report counts `dsh web:` start lines in the log tail, sets `source: "log"`, and adds a `note` that the log has no timestamps, so event times are empty and only starts are counted. A log that cannot be read yields `source: "none"`, zero counts, and the reason in `note`, instead of a failed request.

## Log segments

Rotated logs are discovered as `<logPath basename>.<rotation>` or `<logPath basename>.<rotation>.gz` in the log's directory, where `.1` is the newest rotation. The live file is listed first as `current`.

- `dsh_service_status` lists `current` and then the rotations from `.1` upward, at most `logSegmentLimit` entries in total (5 by default). The live file counts toward the cap.
- A plain file's tail is read from a 96 KiB window at its end. A `.gz` segment is decompressed whole before the tail is taken, up to 32 MiB decompressed. A missing log reads as empty; a path that is not a regular readable file fails with `log-unreadable`.
- `dsh_service_logs` accepts `segment` (a listed name or `current`), `lines` (1–2000, default `logTailLines`), and `filter` (a case-insensitive substring every returned line must contain). A segment name that is not listed fails with `invalid-request`, and `current`/rotated names are the only accepted values.
- The page shows the segment selector only when more than one segment exists.

## Agent tools

All seven tools use the same implementation as the page. An argument outside its bounds fails with `invalid-request`, except an action or `delaySeconds` outside its accepted set, which fails with `invalid-action`; an unknown `segment` fails with `invalid-request`.

| Tool | What it does | Key parameters |
|---|---|---|
| `dsh_service_status` | Reads unit state, boot enablement, PID, start time, restart count, unit and log paths, log segments, the token-masked access URL, and the six guarantees with their `fixable` flags. | None. |
| `dsh_service_logs` | Reads the log tail, optionally filtered, from the live file or a rotated segment. | `lines` 1–2000 (default `logTailLines`); `filter` case-insensitive substring; `segment` a listed name or `current`. |
| `dsh_service_history` | Reads start, stop, failure, and restart history with counts, the last failure, and the newest events. | `lines` 1–2000 journal lines (default `historyLines`). |
| `dsh_service_repair` | Previews or applies the unit edits that restore unmet guarantees. | `apply` boolean; `false` (default) previews, `true` writes. |
| `dsh_service_control` | Starts, stops, restarts, enables, or disables the unit. Restart and stop are scheduled after the delay (through `systemd-run`, or a detached child when it is unavailable), so the reply arrives before the process goes away. | `action` required: `start`, `stop`, `restart`, `enable`, `disable`; `delaySeconds` 1–60 for restart and stop (default `restartDelaySeconds`). |
| `dsh_service_access_url` | Reads the browser entry URL. | `includeToken` boolean; the token query is withheld unless it is `true`. |
| `dsh_service_unit` | Reads or replaces the unit file; a write verifies, backs up, writes, and reloads systemd, and a failed reload restores the previous file. | `action` required: `read` or `write`; `content` complete unit text, required for `write`. |

A restart or stop of the unit running this DSH process ends it when the scheduled action runs; the tool description asks the caller to have the user reopen the page, and the page reconnects on its own after a restart.

## Configuration

The bundle inserts one row, `id: dsh-service`. Its `config` is validated at load, and an invalid value refuses the load with a `dsh-service: config rejected: …` error. `unitPath` is derived as `<unitDir>/<unit>` and is not a config field.

| Field | Default | Meaning |
|---|---|---|
| `unit` | `dsh.service` | Service unit name that is read and controlled; must match `[A-Za-z0-9@._:-]+\.service`. |
| `unitDir` | `/etc/systemd/system` | Absolute directory holding the unit file. |
| `logPath` | `/root/dsh.log` | Log file whose tail and entry URL are read. |
| `publicUrl` | — | Fallback access URL, an `http(s)` URL, used when the log carries none. |
| `restartDelaySeconds` | `3` | Default wait before a scheduled restart or stop, 1–60 seconds. |
| `logTailLines` | `200` | Default log tail size, 1–2000 lines. |
| `historyLines` | `200` | Default journal window for restart history, 10–2000 lines. |
| `logSegmentLimit` | `5` | Segment entries listed, including `current`, 1–20. |
| `urlSearchBytes` | `4194304` | Bytes searched backwards for the newest entry URL, 65536–67108864. |
| `repairRestart` | `on-failure` | `Restart=` value a repair writes; one of the five crash policies. |
| `repairRestartSec` | `10` | `RestartSec=` value a repair writes, 1–60 seconds. |
| `repairWantedBy` | `multi-user.target` | `WantedBy=` target a repair adds when `[Install]` names none. |

Retarget another deployment from the profile's `cordis.patch.yml`. A later layer replaces the row's `config` wholesale, not key by key, so restate every value you want to change; unset fields fall back to the defaults above.

```yaml
# $DSH_HOME/profiles/web/cordis.patch.yml
- id: dsh-service
  config:
    unit: dsh-staging.service
    unitDir: /etc/systemd/system
    logPath: /root/dsh-staging.log
    publicUrl: https://dsh.example.test/
```

## Requirements and limits

- Linux with systemd, and a DSH process allowed to run `systemctl` for the managed unit and write its unit file. In the default deployment DSH runs as root. Without a reachable systemd, state reads report `LoadState=not-found`; a write still verifies the text but fails at `daemon-reload` (`command-failed`, or `command-missing` when `systemctl` is absent), and with `invalid-unit` when `systemd-analyze` is missing.
- The plugin runs inside the unit it manages, and the page is served by that process. A restart drops the page and it reconnects after the service returns; a stop makes the page unreachable until someone starts the service on the server, and the plugin cannot do that itself.
- Repair edits one existing unit file and reloads systemd; it never restarts the service, so new directives apply on the next start or restart. A deployment without a unit file keeps `detach` unmet, and a repair fails with `unit-missing` because it has nothing to edit.
- Only `boot`, `recovery`, `network`, and `log` are repairable. `detach` depends on how the deployment is started, and `access` needs the running service's log line.
- Unit writes need write permission to `unitDir`; each write keeps the previous content beside the unit as `<unitPath>.bak-<YYYYMMDDTHHMMSSZ>`, and a write that creates a missing file has no previous content to back up.
- Log output is bounded: a plain file is read from its last 96 KiB, a gzip segment is decompressed whole up to 32 MiB, and `lines` is capped at 2000. A very large plain log therefore shows only the window near its end, though the entry-URL search has its own `urlSearchBytes` budget.
- The restart-history fallback has no timestamps and counts only `dsh web:` start lines. The access guarantee likewise depends on the service printing its entry URL; set `publicUrl` when it does not.
- The Settings page is part of the Web client. The agent tools work in any profile that loads the bundle, including profiles without a web server, where the page route is not registered.

## Error codes

Tools throw these typed codes; the page route maps them to the status shown. A code keeps its meaning across both callers.

| Code | Route status | Meaning |
|---|---|---|
| `invalid-config` | 500 | The row's `config` is rejected; the plugin refuses to load, so a request never reaches this status. |
| `invalid-request` | 400 | A body or argument is malformed, `apply` is not a boolean, or the requested log segment is not listed. |
| `invalid-action` | 400 | The action is not accepted, or `delaySeconds` is outside 1–60. |
| `invalid-unit` | 400 | The unit text failed `systemd-analyze verify`. |
| `unit-missing` | 404 | A repair was asked for, but no unit file exists at `unitPath`. |
| `unit-unreadable` | 500 | The unit file exists but cannot be read. |
| `log-unreadable` | 500 | The log path is not a regular readable file, or a gzip segment exceeds the decompression budget. |
| `command-missing` | 501 | A required executable is absent. A missing `systemctl` surfaces here for unit actions and `daemon-reload`; missing `journalctl` and `systemd-run` fall back instead. |
| `command-failed` | 500 | A systemd command exited nonzero. |
| `no-entry-url` | 404 | `dsh_service_access_url` found neither a log entry URL nor `publicUrl`. |
| `not-found` | 404 | The page route is unknown. |
| `forbidden` | 403 | The page route refused a non-owner session. |
| `operation-error` | 500 | Any other failure. |

`journalctl` being missing is not an error: restart history falls back to the log. A missing `systemd-run` is not an error either: restart and stop fall back to a detached `sleep; systemctl` child, and the result names `method: "detached"`.

## Development

Host code and the page live in one package: `index.js` registers the tools and the `/api/dsh-service` route, and `client.js` registers the Settings page and its navigation glyph.

From the repository checkout, `node plugins/dsh-service/self-check.mjs` — or `node self-check.mjs` inside the package directory — runs the Host half in one process against scratch units, rotated scratch logs, and stub HTTP requests with a stand-in context. It covers the seven tool registrations, the guarantee decisions and `fixable` flags, the repair preview and apply paths (including a refused enable), log-segment discovery and gzip reads, the history journal/fallback/none sources, configuration rejection, and the page route responses (owner-only access included). The deployed unit is never read or written. The write-path cases do invoke the host's `systemd-analyze verify`, `systemctl daemon-reload`, and a scratch-unit `systemctl enable`, so run it on a Linux host with systemd.

`node scripts/stage-npm.mjs <package-name> <version> [output-directory]`, run from `plugins/dsh-service`, stages a publishable copy under another name: `node scripts/stage-npm.mjs dsh-service-console 0.2.0 dist/npm`. It copies `index.js`, `client.js`, `cordis.patch.yml`, `icon.svg`, `README.md`, `LICENSE`, `docs`, and `locale`, then rewrites the package name in the staged manifest, `cordis.patch.yml`, and the client module id. The staged manifest gets the given version, a package description, keywords, `license: MIT`, the `author`, `engines.dsh`, and public npm access. The default output directory is `dist/npm` under the package; publishing the staged directory is a separate `npm publish` step. `self-check.mjs` and the `scripts` directory are development files and are not part of the published package.

For a source change, the running process keeps the old Host code until the bundle is reloaded by HMR or the service restarts; a browser refresh alone does not pick up a new `index.js`.

## 中文摘要

- 做什么：把托管本 DSH 实例的 systemd 单元放进设置页和七个 Agent 工具，可直接读取并控制 `dsh.service`。
- 装哪里：执行 `dsh plugin --profile web add dsh-service-console`，安装后在 **Plugins**（插件）页确认 **服务控制台** 已打开；宿主代码随 DSH 进程加载，启用后由 HMR 重组或下次启动生效。
- 页面：单元状态、六项保障、访问地址（含 token，仅 owner 会话可见）、重启历史、按轮转分段的日志、可编辑的单元文件，以及重启/停止/开机自启按钮。
- 保障项：会话独立、开机自启、崩溃恢复、网络就绪、日志持久化、访问地址；其中开机自启、崩溃恢复、网络就绪、日志持久化可一键修复，会话独立和访问地址需人工处理。
- 修复安全：工具和路由默认只预览，传 `apply: true` 才写入；先 `systemd-analyze` 校验，再备份为 `<单元>.bak-<时间>`，写入后执行 `daemon-reload`；开机自启未满足时再 `systemctl enable`，被拒绝只上报。
- 访问地址：从日志里最新的 `dsh web:` 行解析，找不到时用配置的 `publicUrl`；工具默认隐藏 token，`includeToken: true` 才返回。
- 历史与日志：重启历史以 journalctl 为主，没有 journalctl 或调用失败时改为统计日志里的启动行；日志支持 `.1…N[.gz]` 分段，gzip 先解压再取尾部。
- 限制：需要 Linux + systemd，并允许 DSH 进程执行 `systemctl` 和写入单元文件；停止服务后页面不可访问，重启会断开页面；插件本身运行在被管理的单元内。
- 配置：默认单元 `dsh.service`、目录 `/etc/systemd/system`、日志 `/root/dsh.log`；可在 profile 的 `cordis.patch.yml` 用行 id `dsh-service` 覆盖 `config`。
