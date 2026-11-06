/* ============================================================================
 * dsh-mcp-manager — Host 半侧
 * ----------------------------------------------------------------------------
 * 能力：
 *   · 发现当前 profile 里所有 @deepseek-ai/dsh-mcp-client 条目（托管 + 外部）
 *   · 增 / 改 / 删 / 启停：改 loader 条目即时生效，同时写回 cordis.patch.yml
 *   · 掉线检测：fiber 运行态 + HTTP 可达性轮询，状态变化进事件日志
 *   · 事件日志、导入 / 导出、模板
 *
 * 只依赖 Node 内置模块；不导出 default / Config，避免 loader unwrap 歧义。
 * ========================================================================== */

import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  MCP_CLIENT_NAME,
  TEMPLATES,
  blankServer,
  buildExport,
  parseImport,
  validateServer
} from './lib/config.js'
import { probeHttp, stdioCheck } from './lib/health.js'
import { createEventLog } from './lib/log.js'
import { ROW_ID_PREFIX, rowIdFor } from './lib/patch.js'
import {
  PLUGIN_NAME,
  patchStatus,
  pluginVersion,
  readState,
  resolveProfileDir,
  stateFilePath,
  writePatchBlock,
  writeState,
} from './lib/profile.js'

const NS = 'dsh-mcp-manager'
const ROUTE_BASE = '/dsh-mcp-manager'
const API_BASE = ROUTE_BASE + '/api'
const CHECK_INTERVAL_MS = 30_000
const PROBE_TIMEOUT_MS = 4_000

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)))
const VERSION = pluginVersion(PACKAGE_ROOT)

function isObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function errorText(error) {
  return String((error && error.message) || error || '未知错误')
}

/** Cordis FiberState → 可读阶段。 */
function phaseOf(entry) {
  const state = entry?.fiber?.state
  if (state === undefined || state === null) return 'idle'
  switch (state) {
    case 0: return 'pending'
    case 1: return 'loading'
    case 2: return 'active'
    case 3: return 'failed'
    case 4: return 'disposed'
    case 5: return 'unloading'
    default: return 'idle'
  }
}

const name = NS
// webServer / connection 必须先声明 inject：Cordis 不允许在未注入时读取服务属性
const inject = ['loader', 'webServer', 'connection']

export function apply(ctx) {
  const log = createEventLog(800)
  const lastChecks = new Map()
  const lastStatuses = new Map()
  let checkTimer = null
  let checking = false
  let adopted = false

  ctx.effect(() => () => {
    if (checkTimer) clearInterval(checkTimer)
    checkTimer = null
  })

  function getLoader() {
    try {
      return typeof ctx.get === 'function' ? ctx.get('loader') : ctx.loader
    } catch {
      return null
    }
  }

  function getWebServer() {
    try {
      const viaGet = typeof ctx.get === 'function' ? ctx.get('webServer') : undefined
      if (viaGet) return viaGet
    } catch {
      /* ignore */
    }
    return ctx.webServer
  }

  function profile() {
    const resolved = resolveProfileDir(ctx, PLUGIN_NAME)
    if (!resolved.dir) {
      throw new Error('无法定位 DSH profile 目录：请确认 ~/.dsh/profiles 存在，或设置 DSH_MCP_MANAGER_PROFILE_DIR')
    }
    return resolved
  }

  /** 收集所有 mcp-client 条目。 */
  function liveRows() {
    const loader = getLoader()
    if (!loader || typeof loader.entries !== 'function') return []
    const rows = []
    for (const entry of loader.entries()) {
      const options = entry.options || {}
      if (options.name !== MCP_CLIENT_NAME) continue
      const config = isObject(options.config) ? options.config : {}
      const entryId = options.id
      rows.push({
        entry,
        entryId,
        serverName: String(config.serverName || entryId),
        config,
        disabled: entry.disabled === true,
        phase: phaseOf(entry)
      })
    }
    return rows
  }

  function findEntry(id) {
    const loader = getLoader()
    if (!loader || !id) return null
    try {
      return loader.resolve(id)
    } catch {
      return null
    }
  }

  /**
   * 状态推导。
   * 在线 = 插件运行中 +（HTTP 服务）最近一次探测可达；stdio 只看运行态。
   */
  function statusOf(view) {
    if (view.disabled) return 'paused'
    if (!view.live || view.phase === 'missing' || view.phase === 'disposed') return 'missing'
    if (view.phase === 'failed') return 'offline'
    if (view.phase === 'pending' || view.phase === 'loading') return 'connecting'
    if (view.phase === 'unloading') return 'connecting'
    const probe = lastChecks.get(view.serverName)
    if (view.transport === 'streamable-http' && probe && probe.skipped !== true && probe.reachable === false) {
      return 'offline'
    }
    return 'online'
  }

  /** 把 state + live 合并成稳定的视图。 */
  function computeViews() {
    const { dir, source } = profile()
    const state = readState(dir)
    const rows = liveRows()
    const managed = new Set(state.servers.map((item) => item.serverName))
    const views = []

    for (const item of state.servers) {
      const row = rows.find((candidate) => candidate.entryId === rowIdFor(item.serverName))
        || rows.find((candidate) => candidate.serverName === item.serverName)
      const config = row && isObject(row.config) && Object.keys(row.config).length ? row.config : item.config
      const view = {
        serverName: item.serverName,
        transport: String(config.transport || 'stdio'),
        managed: true,
        external: false,
        live: !!row,
        entryId: row?.entryId || null,
        phase: row?.phase || 'missing',
        disabled: row ? row.disabled : item.disabled === true,
        config,
        createdAt: item.createdAt,
        lastCheck: lastChecks.get(item.serverName) || null
      }
      view.enabled = !view.disabled
      view.status = statusOf(view)
      views.push(view)
    }

    for (const row of rows) {
      if (row.entryId && row.entryId.startsWith(ROW_ID_PREFIX)) continue
      if (managed.has(row.serverName)) continue
      const config = row.config
      const view = {
        serverName: row.serverName,
        transport: String(config.transport || 'stdio'),
        managed: false,
        external: true,
        live: true,
        entryId: row.entryId,
        phase: row.phase,
        disabled: row.disabled,
        config,
        createdAt: null,
        lastCheck: lastChecks.get(row.serverName) || null
      }
      view.enabled = !view.disabled
      view.status = statusOf(view)
      views.push(view)
    }

    views.sort((a, b) => {
      const rank = { offline: 0, missing: 1, connecting: 2, paused: 3, online: 4 }
      const diff = (rank[a.status] ?? 5) - (rank[b.status] ?? 5)
      return diff || a.serverName.localeCompare(b.serverName)
    })

    const summary = {
      total: views.length,
      online: views.filter((view) => view.status === 'online').length,
      offline: views.filter((view) => view.status === 'offline' || view.status === 'missing').length,
      paused: views.filter((view) => view.status === 'paused').length,
      connecting: views.filter((view) => view.status === 'connecting').length,
      external: views.filter((view) => view.external).length
    }

    return { dir, source, state, views, summary }
  }

  /** 记录状态迁移，避免每次轮询重复刷日志。 */
  function syncStatuses(views, options = {}) {
    for (const view of views) {
      const previous = lastStatuses.get(view.serverName)
      if (previous === view.status) continue
      lastStatuses.set(view.serverName, view.status)
      if (options.silent || previous === undefined) continue
      const level = view.status === 'offline' || view.status === 'missing' ? 'warn' : 'info'
      log.push({
        level,
        serverName: view.serverName,
        kind: 'status',
        message: `${previous} → ${view.status}`
      })
    }
  }

  /** 首次安装时若已有托管行，把它们收编进状态文件。 */
  function maybeAdopt(dir, state, rows) {
    if (adopted || state.servers.length) return state
    const owned = rows.filter((row) => row.entryId && row.entryId.startsWith(ROW_ID_PREFIX))
    if (!owned.length) return state
    const next = {
      ...state,
      servers: owned.map((row) => ({
        serverName: row.serverName,
        config: row.config,
        disabled: row.disabled,
        createdAt: new Date().toISOString()
      }))
    }
    writeState(dir, next)
    adopted = true
    log.push({ kind: 'state', message: `从现有 patch 行收编 ${owned.length} 个托管服务` })
    return next
  }

  async function runOp(loader, op) {
    if (!loader) throw new Error('loader 服务不可用')
    if (op.type === 'create') {
      await loader.create({ id: op.id, name: MCP_CLIENT_NAME, config: op.config, disabled: op.disabled === true })
      return
    }
    if (op.type === 'update') {
      const entry = findEntry(op.id)
      if (!entry) {
        await loader.create({ id: op.id, name: MCP_CLIENT_NAME, config: op.config, disabled: op.disabled === true })
        return
      }
      const patch = {}
      if (op.config) patch.config = op.config
      if (typeof op.disabled === 'boolean') patch.disabled = op.disabled
      await loader.update(op.id, patch)
      return
    }
    if (op.type === 'remove') {
      const entry = findEntry(op.id)
      if (!entry) {
        if (op.optional) return
        throw new Error(`条目 ${op.id} 不存在`)
      }
      await loader.remove(op.id)
      return
    }
    throw new Error(`未知操作 ${op.type}`)
  }

  /**
   * 持久化 + 应用变更。
   * 先写 patch / state（保证重启后仍然正确），再改 loader（失败只影响本次运行态）。
   */
  async function commit(dir, nextState, ops) {
    const patch = writePatchBlock(dir, nextState)
    writeState(dir, nextState)
    adopted = true
    const loader = getLoader()
    const failures = []
    for (const op of ops) {
      try {
        await runOp(loader, op)
      } catch (error) {
        failures.push({ op: op.type, id: op.id, error: errorText(error) })
      }
    }
    return { patch, failures }
  }

  function nameTaken(serverName, exceptName) {
    return liveRows().some((row) => row.serverName === serverName && row.serverName !== exceptName)
  }

  async function upsert(input, originalName) {
    const { dir, state } = computeViews()
    if (originalName && !state.servers.some((item) => item.serverName === originalName)) {
      const external = liveRows().find((row) => row.serverName === originalName)
      if (external) {
        throw new Error('这是外部（非本管理器创建）的 MCP 条目；请直接修改原 patch 行，或删除后用本面板新建')
      }
    }
    const result = validateServer(input, {
      existingNames: liveRows().map((row) => row.serverName),
      originalName: originalName || ''
    })
    if (!result.ok) {
      const error = new Error(result.errors.join('；'))
      error.details = result.errors
      throw error
    }
    const server = result.server
    const keepDisabled = isObject(input) && typeof input.disabled === 'boolean' ? input.disabled : undefined
    const previous = state.servers.find((item) => item.serverName === originalName)
    const disabled = keepDisabled !== undefined ? keepDisabled : previous ? previous.disabled === true : false

    const nextServers = state.servers.filter((item) => item.serverName !== originalName && item.serverName !== server.serverName)
    nextServers.push({
      serverName: server.serverName,
      config: server,
      disabled,
      createdAt: previous?.createdAt || new Date().toISOString()
    })
    const nextState = { ...state, servers: nextServers }
    const ops = []
    if (originalName && originalName !== server.serverName) {
      ops.push({ type: 'remove', id: rowIdFor(originalName), optional: true })
    }
    ops.push({
      type: findEntry(rowIdFor(server.serverName)) ? 'update' : 'create',
      id: rowIdFor(server.serverName),
      config: server,
      disabled
    })

    const { patch, failures } = await commit(dir, nextState, ops)
    log.push({
      level: failures.length ? 'warn' : 'info',
      serverName: server.serverName,
      kind: 'config',
      message: `${originalName && originalName !== server.serverName ? `重命名 ${originalName} → ${server.serverName}` : previous ? '更新配置' : '新增服务'}${disabled ? '（已停用）' : ''}`
    })
    if (failures.length) {
      log.push({ level: 'error', serverName: server.serverName, kind: 'loader', message: `热加载失败：${failures.map((item) => item.error).join('；')}` })
    }
    syncStatuses(computeViews().views, { silent: true })
    return { server, warnings: result.warnings, failures, patch }
  }

  async function toggle(serverName, enabled) {
    const { dir, state } = computeViews()
    const row = liveRows().find((item) => item.serverName === serverName)
    const managedItem = state.servers.find((item) => item.serverName === serverName)

    if (managedItem) {
      const nextServers = state.servers.map((item) => (
        item.serverName === serverName ? { ...item, disabled: !enabled } : item
      ))
      const ops = [{ type: 'update', id: rowIdFor(serverName), config: managedItem.config, disabled: !enabled }]
      const { failures } = await commit(dir, { ...state, servers: nextServers }, ops)
      log.push({
        level: failures.length ? 'warn' : 'info',
        serverName,
        kind: 'toggle',
        message: enabled ? '已启用' : '已停用'
      })
      syncStatuses(computeViews().views, { silent: true })
      return { failures }
    }

    if (!row) throw new Error(`找不到服务 ${serverName}`)
    const overrides = state.overrides.filter((item) => item.entryId !== row.entryId)
    if (!enabled) overrides.push({ entryId: row.entryId, serverName, disabled: true })
    const loader = getLoader()
    await loader.update(row.entryId, { disabled: !enabled })
    writePatchBlock(dir, { ...state, overrides })
    writeState(dir, { ...state, overrides })
    log.push({ level: 'info', serverName, kind: 'toggle', message: enabled ? '已启用（外部条目）' : '已停用（外部条目，写入覆盖行）' })
    syncStatuses(computeViews().views, { silent: true })
    return { failures: [] }
  }

  async function removeServer(serverName) {
    const { dir, state } = computeViews()
    const managedItem = state.servers.find((item) => item.serverName === serverName)
    if (!managedItem) throw new Error('外部条目不能在这里删除；请修改它所在的 patch 行')
    const loader = getLoader()
    const entry = findEntry(rowIdFor(serverName))
    if (entry && loader) await loader.remove(rowIdFor(serverName))
    const nextState = { ...state, servers: state.servers.filter((item) => item.serverName !== serverName) }
    writePatchBlock(dir, nextState)
    writeState(dir, nextState)
    log.push({ level: 'warn', serverName, kind: 'delete', message: '已删除服务' })
    syncStatuses(computeViews().views, { silent: true })
  }

  async function reconnect(serverName) {
    const row = liveRows().find((item) => item.serverName === serverName)
    if (!row) throw new Error(`找不到在线条目 ${serverName}`)
    const fiber = row.entry?.fiber
    if (!fiber || typeof fiber.restart !== 'function') throw new Error('当前 DSH 版本不支持单独重启条目')
    await fiber.restart()
    log.push({ level: 'info', serverName, kind: 'reconnect', message: '手动重启 MCP 条目' })
  }

  async function checkServers(onlyName) {
    if (checking) return { skipped: true }
    checking = true
    const results = []
    try {
      for (const row of liveRows()) {
        if (row.disabled) continue
        if (onlyName && row.serverName !== onlyName) continue
        if (row.phase !== 'active') continue
        const transport = String(row.config.transport || 'stdio')
        if (transport !== 'streamable-http' || !row.config.url) continue
        const probe = await probeHttp(row.config, { timeoutMs: PROBE_TIMEOUT_MS })
        lastChecks.set(row.serverName, probe)
        results.push({ serverName: row.serverName, ...probe })
      }
      const { views } = computeViews()
      syncStatuses(views)
      return { results, views }
    } finally {
      checking = false
    }
  }

  async function exportConfig(redact) {
    const { views } = computeViews()
    const servers = views.map((view) => ({
      server: {
        serverName: view.serverName,
        transport: view.transport,
        ...(view.transport === 'stdio'
          ? {
              command: view.config.command,
              args: view.config.args || [],
              ...(view.config.env ? { env: view.config.env } : {}),
              ...(view.config.cwd ? { cwd: view.config.cwd } : {})
            }
          : {
              url: view.config.url,
              ...(view.config.headers ? { headers: view.config.headers } : {})
            }),
        toolCallTimeoutMs: view.config.toolCallTimeoutMs,
        failOnStartupError: view.config.failOnStartupError === true
      },
      external: view.external
    }))
    return buildExport(servers, { redact })
  }

  async function importConfig(payload, mode) {
    const parsed = parseImport(payload)
    if (!parsed.servers.length && parsed.errors.length) {
      const error = new Error(parsed.errors.join('；'))
      error.details = parsed.errors
      throw error
    }
    const { dir, state, views } = computeViews()
    const replace = mode === 'replace'
    const importedNames = new Set(parsed.servers.map((server) => server.serverName))
    const externalNames = new Set(views.filter((view) => view.external).map((view) => view.serverName))
    const skipped = []

    const nextServers = replace
      ? state.servers.filter((item) => importedNames.has(item.serverName))
      : [...state.servers]
    const byName = new Map(nextServers.map((item) => [item.serverName, item]))
    const ops = []

    for (const server of parsed.servers) {
      if (externalNames.has(server.serverName)) {
        skipped.push({ serverName: server.serverName, reason: '同名外部条目，已跳过' })
        continue
      }
      const previous = byName.get(server.serverName)
      byName.set(server.serverName, {
        serverName: server.serverName,
        config: server,
        disabled: previous ? previous.disabled === true : false,
        createdAt: previous?.createdAt || new Date().toISOString()
      })
      const id = rowIdFor(server.serverName)
      ops.push({ type: findEntry(id) ? 'update' : 'create', id, config: server, disabled: previous ? previous.disabled === true : false })
    }

    const finalServers = [...byName.values()]
    const removed = state.servers.filter((item) => !byName.has(item.serverName))
    for (const item of removed) {
      ops.push({ type: 'remove', id: rowIdFor(item.serverName), optional: true })
    }

    const { failures } = await commit(dir, { ...state, servers: finalServers }, ops)
    log.push({
      level: failures.length ? 'warn' : 'info',
      kind: 'import',
      message: `导入完成：新增/更新 ${parsed.servers.length} 个，移除 ${removed.length} 个，跳过 ${skipped.length} 个`
    })
    syncStatuses(computeViews().views, { silent: true })
    return { importErrors: parsed.errors, skipped, failures, removed: removed.map((item) => item.serverName) }
  }

  // ---------------------------------------------------------------- HTTP 层
  const webServer = getWebServer()
  const hasRoutes = !!webServer && typeof webServer.register === 'function'

  function rejected(req, res) {
    try {
      const connection = typeof ctx.get === 'function' ? ctx.get('connection') : undefined
      if (!connection || typeof connection.requestRejection !== 'function') return false
      const code = connection.requestRejection(req)
      if (code === undefined || code === null || code === false) return false
      res.statusCode = typeof code === 'number' ? code : 403
      res.end()
      return true
    } catch {
      return false
    }
  }

  function sendJson(res, code, payload) {
    const body = Buffer.from(JSON.stringify(payload), 'utf8')
    res.writeHead(code, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': String(body.length)
    })
    res.end(body)
  }

  function readBody(req, limit = 1_000_000) {
    return new Promise((resolve) => {
      let size = 0
      const chunks = []
      req.on('data', (chunk) => {
        size += chunk.length
        if (size > limit) {
          req.destroy()
          resolve('')
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      req.on('error', () => resolve(''))
    })
  }

  function method(req) {
    return String(req.method || 'GET').toUpperCase()
  }

  async function route(req, res, pathname, query) {
    if (pathname === `${API_BASE}/meta`) {
      const { dir, source } = profile()
      sendJson(res, 200, {
        ok: true,
        version: VERSION,
        plugin: PLUGIN_NAME,
        profileDir: dir,
        profileSource: source,
        patch: patchStatus(dir),
        stateFile: stateFilePath(dir),
        checkIntervalMs: CHECK_INTERVAL_MS,
        logSize: log.size(),
        templates: TEMPLATES,
        blank: { stdio: blankServer('stdio'), http: blankServer('streamable-http') }
      })
      return
    }

    if (pathname === `${API_BASE}/servers` && method(req) === 'GET') {
      const { dir, source, state, views, summary } = computeViews()
      syncStatuses(views, { silent: true })
      sendJson(res, 200, {
        ok: true,
        profileDir: dir,
        profileSource: source,
        patch: patchStatus(dir),
        summary,
        servers: views,
        stateFile: stateFilePath(dir),
        overrides: state.overrides,
        version: VERSION,
        checkIntervalMs: CHECK_INTERVAL_MS
      })
      return
    }

    if (pathname === `${API_BASE}/servers` && method(req) === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}')
      const result = await upsert(body.server, body.originalName)
      sendJson(res, 200, { ok: true, server: result.server, warnings: result.warnings, failures: result.failures })
      return
    }

    if (pathname === `${API_BASE}/servers/toggle` && method(req) === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}')
      const result = await toggle(String(body.serverName || ''), body.enabled === true)
      sendJson(res, 200, { ok: true, failures: result.failures })
      return
    }

    if (pathname === `${API_BASE}/servers/delete` && method(req) === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}')
      await removeServer(String(body.serverName || ''))
      sendJson(res, 200, { ok: true })
      return
    }

    if (pathname === `${API_BASE}/servers/reconnect` && method(req) === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}')
      await reconnect(String(body.serverName || ''))
      sendJson(res, 200, { ok: true })
      return
    }

    if (pathname === `${API_BASE}/servers/check` && method(req) === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}')
      const result = await checkServers(body.serverName ? String(body.serverName) : null)
      sendJson(res, 200, {
        ok: true,
        skipped: result.skipped === true,
        results: result.results || [],
        servers: result.views ? result.views.map((view) => ({ serverName: view.serverName, status: view.status, lastCheck: view.lastCheck })) : []
      })
      return
    }

    if (pathname === `${API_BASE}/logs` && method(req) === 'GET') {
      sendJson(res, 200, {
        ok: true,
        events: log.list({
          serverName: query.get('serverName') || null,
          since: query.get('since') || null,
          limit: query.get('limit') || 300
        })
      })
      return
    }

    if (pathname === `${API_BASE}/export` && method(req) === 'GET') {
      const redacted = query.get('redact') !== '0'
      const payload = await exportConfig(redacted)
      const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 13)
      const body = Buffer.from(JSON.stringify(payload, null, 2), 'utf8')
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'content-disposition': `attachment; filename="dsh-mcp-servers-${stamp}.json"`,
        'cache-control': 'no-store',
        'content-length': String(body.length)
      })
      res.end(body)
      return
    }

    if (pathname === `${API_BASE}/import` && method(req) === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}')
      const result = await importConfig(body.payload, body.mode === 'replace' ? 'replace' : 'merge')
      sendJson(res, 200, { ok: true, ...result })
      return
    }

    sendJson(res, 404, { ok: false, error: `未知接口 ${pathname}` })
  }

  if (!hasRoutes) {
    try {
      ctx.logger?.warn?.(`[${NS}] 当前 profile 没有可用的 webServer，设置页将无法连接本插件`)
    } catch {
      /* ignore */
    }
    return
  }

  const disposeRoute = webServer.register({
    kind: 'prefix',
    path: ROUTE_BASE,
    handler: async (req, res) => {
      if (rejected(req, res)) return
      try {
        const parsed = new URL(req.url || '/', 'http://localhost')
        if (!parsed.pathname.startsWith(API_BASE + '/')) {
          sendJson(res, 404, { ok: false, error: 'not found' })
          return
        }
        await route(req, res, parsed.pathname, parsed.searchParams)
      } catch (error) {
        const code = error && error.status ? error.status : 500
        sendJson(res, code, { ok: false, error: errorText(error), details: error?.details })
      }
    }
  })

  ctx.effect(() => () => {
    try {
      disposeRoute?.()
    } catch {
      /* ignore */
    }
  })

  // ---------------------------------------------------------------- 看门狗
  async function tick() {
    try {
      const { views } = computeViews()
      syncStatuses(views, { silent: true })
      await checkServers(null)
    } catch (error) {
      log.push({ level: 'error', kind: 'watchdog', message: errorText(error) })
    }
  }

  checkTimer = setInterval(() => { void tick() }, CHECK_INTERVAL_MS)
  if (typeof checkTimer.unref === 'function') checkTimer.unref()
  setTimeout(() => { void tick() }, 1_500).unref?.()

  log.push({ kind: 'boot', message: `MCP 管理器已加载（v${VERSION}）` })
  ctx.effect(() => () => log.push({ kind: 'boot', message: 'MCP 管理器已卸载' }))
}

export { name, inject }
