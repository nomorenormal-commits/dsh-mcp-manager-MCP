/* ============================================================================
 * dsh-mcp-manager — 配置模型（纯函数，无 IO）
 * ----------------------------------------------------------------------------
 * 负责：MCP 服务对象的规范化 / 校验 / 脱敏 / 导入导出格式转换。
 * 这里不碰文件、不碰 ctx，方便 node:test 直接覆盖。
 * ========================================================================== */

export const MCP_CLIENT_NAME = '@deepseek-ai/dsh-mcp-client'
export const TRANSPORTS = ['stdio', 'streamable-http']
export const IMPORT_FORMAT = 'dsh-mcp-manager/export'

/** serverName 会进入工具名前缀（mcp__<name>__tool），限制为安全字符集。 */
export const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/

export const DEFAULT_TIMEOUT_MS = 60_000
export const MIN_TIMEOUT_MS = 1_000
export const MAX_TIMEOUT_MS = 600_000

const SECRET_KEY_RE = /(token|secret|password|passwd|api[-_]?key|authorization|cookie|credential)/i

function isObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function asString(value) {
  return typeof value === 'string' ? value : ''
}

/** 环境变量 / 请求头：只接受字符串键值，去空键。 */
function normalizeStringMap(input, label, errors) {
  const out = {}
  if (input === undefined || input === null) return out
  if (!isObject(input)) {
    errors.push(`${label} 必须是对象（键值对）`)
    return out
  }
  for (const [key, value] of Object.entries(input)) {
    const k = asString(key).trim()
    if (!k) {
      errors.push(`${label} 存在空键名`)
      continue
    }
    if (value === null || value === undefined) continue
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
      errors.push(`${label}.${k} 必须是字符串`)
      continue
    }
    out[k] = String(value)
  }
  return out
}

function normalizeArgs(input, errors) {
  if (input === undefined || input === null) return []
  if (!Array.isArray(input)) {
    errors.push('args 必须是字符串数组')
    return []
  }
  const out = []
  for (const item of input) {
    if (item === null || item === undefined) continue
    if (typeof item !== 'string' && typeof item !== 'number') {
      errors.push('args 只能是字符串')
      continue
    }
    out.push(String(item))
  }
  return out
}

function normalizeTimeout(value, errors) {
  if (value === undefined || value === null || value === '') return DEFAULT_TIMEOUT_MS
  const n = Number(value)
  if (!Number.isFinite(n)) {
    errors.push('toolCallTimeoutMs 必须是数字')
    return DEFAULT_TIMEOUT_MS
  }
  if (n < MIN_TIMEOUT_MS || n > MAX_TIMEOUT_MS) {
    errors.push(`toolCallTimeoutMs 需在 ${MIN_TIMEOUT_MS}–${MAX_TIMEOUT_MS} 之间`)
    return DEFAULT_TIMEOUT_MS
  }
  return Math.round(n)
}

/**
 * 校验并规范化一个服务配置。
 * @param {any} input 用户输入
 * @param {{ existingNames?: string[], originalName?: string }} options
 * @returns {{ ok: boolean, server: object, errors: string[], warnings: string[] }}
 */
export function validateServer(input, options = {}) {
  const errors = []
  const warnings = []
  const existingNames = options.existingNames || []
  const originalName = options.originalName || ''

  if (!isObject(input)) {
    return { ok: false, server: null, errors: ['配置必须是对象'], warnings }
  }

  const serverName = asString(input.serverName ?? input.name).trim()
  if (!serverName) errors.push('服务名称不能为空')
  else if (!NAME_RE.test(serverName)) errors.push('服务名称只能用字母、数字、下划线、连字符，长度 1–32，且以字母或数字开头')
  else if (serverName !== originalName && existingNames.includes(serverName)) errors.push(`服务名称 "${serverName}" 已存在`)

  let transport = asString(input.transport).trim()
  if (!transport) transport = asString(input.command).trim() ? 'stdio' : 'streamable-http'
  if (transport === 'sse' || transport === 'http') transport = 'streamable-http'
  if (transport === 'streamable_http') transport = 'streamable-http'
  if (!TRANSPORTS.includes(transport)) errors.push(`transport 必须是 ${TRANSPORTS.join(' / ')}`)

  const timeout = normalizeTimeout(input.toolCallTimeoutMs, errors)
  const failOnStartupError = input.failOnStartupError === true || input.failOnStartupError === 'true'
  const server = {
    serverName,
    transport,
    toolCallTimeoutMs: timeout,
    failOnStartupError
  }

  if (transport === 'stdio') {
    const command = asString(input.command).trim()
    if (!command) errors.push('stdio 服务必须填写启动命令 command')
    server.command = command
    server.args = normalizeArgs(input.args, errors)
    const env = normalizeStringMap(input.env, 'env', errors)
    if (Object.keys(env).length) server.env = env
    const cwd = asString(input.cwd).trim()
    if (cwd) server.cwd = cwd
  } else {
    const url = asString(input.url).trim()
    if (!url) errors.push('HTTP 服务必须填写 url')
    else {
      try {
        const parsed = new URL(url)
        if (!/^https?:$/.test(parsed.protocol)) errors.push('url 只支持 http / https 协议')
      } catch {
        errors.push('url 不是合法的 URL')
      }
    }
    server.url = url
    const headers = normalizeStringMap(input.headers, 'headers', errors)
    if (Object.keys(headers).length) server.headers = headers
  }

  if (!errors.length && server.command && /^(npx|uvx)$/i.test(server.command) && !server.args.length) {
    warnings.push(`${server.command} 通常需要参数，请确认命令可启动`)
  }

  return { ok: errors.length === 0, server: errors.length ? null : server, errors, warnings }
}

/** 导出时按需打码 env / headers 中的敏感值。 */
export function redactServer(server, redact = true) {
  if (!redact) return JSON.parse(JSON.stringify(server))
  const copy = JSON.parse(JSON.stringify(server))
  for (const mapKey of ['env', 'headers']) {
    const map = copy[mapKey]
    if (!isObject(map)) continue
    for (const key of Object.keys(map)) {
      if (SECRET_KEY_RE.test(key)) map[key] = '***'
    }
  }
  return copy
}

/** 组装导出文件内容。external 标记只用于阅读，导入时会被忽略。 */
export function buildExport(servers, options = {}) {
  const redact = options.redact !== false
  return {
    format: IMPORT_FORMAT,
    version: 1,
    exportedAt: new Date().toISOString(),
    source: options.source || '',
    count: servers.length,
    servers: servers.map((item) => {
      const server = redactServer(item.server, redact)
      return { ...server, external: item.external === true }
    })
  }
}

function fromClaudeEntry(name, entry, errors) {
  if (!isObject(entry)) {
    errors.push(`${name}: 配置必须是对象`)
    return null
  }
  const type = asString(entry.type).toLowerCase()
  if (asString(entry.url).trim() || type === 'http' || type === 'streamable-http') {
    return { serverName: name, transport: 'streamable-http', url: entry.url, headers: entry.headers }
  }
  return { serverName: name, transport: 'stdio', command: entry.command, args: entry.args, env: entry.env, cwd: entry.cwd }
}

/**
 * 解析导入文件。支持本插件导出格式，以及 Claude Desktop / 通用 mcpServers 映射格式。
 * @returns {{ servers: object[], errors: string[], skipped: string[] }}
 */
export function parseImport(payload) {
  const errors = []
  const skipped = []
  const servers = []

  let list = []
  if (isObject(payload) && Array.isArray(payload.servers)) {
    list = payload.servers
  } else if (isObject(payload) && isObject(payload.mcpServers)) {
    list = Object.entries(payload.mcpServers).map(([name, entry]) => {
      const server = fromClaudeEntry(name, entry, errors)
      return server
    })
  } else if (Array.isArray(payload)) {
    list = payload
  } else {
    errors.push('无法识别的文件格式：需要 {"servers":[...]} 或 {"mcpServers":{...}}')
  }

  for (const raw of list) {
    if (!raw) continue
    const result = validateServer(raw)
    if (!result.ok) {
      const label = isObject(raw) ? String(raw.serverName ?? raw.name ?? '?') : '?'
      for (const message of result.errors) errors.push(`${label}: ${message}`)
      continue
    }
    if (isObject(raw) && raw.external === true) skipped.push(result.server.serverName)
    servers.push(result.server)
  }

  return { servers, errors, skipped }
}

/** 空配置（新建表单初值）。 */
export function blankServer(transport = 'stdio') {
  return transport === 'stdio'
    ? { serverName: '', transport: 'stdio', command: 'npx', args: [], env: {}, toolCallTimeoutMs: DEFAULT_TIMEOUT_MS, failOnStartupError: false }
    : { serverName: '', transport: 'streamable-http', url: '', headers: {}, toolCallTimeoutMs: DEFAULT_TIMEOUT_MS, failOnStartupError: false }
}

/** 常见 MCP 服务模板，设置页「从模板新建」用。 */
export const TEMPLATES = [
  {
    id: 'filesystem',
    label: 'Filesystem 本地文件',
    server: {
      serverName: 'filesystem',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', 'C:\\Users'],
      toolCallTimeoutMs: 60_000,
      failOnStartupError: false
    }
  },
  {
    id: 'github',
    label: 'GitHub 仓库',
    server: {
      serverName: 'github',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-github'],
      env: { GITHUB_PERSONAL_ACCESS_TOKEN: '' },
      toolCallTimeoutMs: 60_000,
      failOnStartupError: false
    }
  },
  {
    id: 'fetch',
    label: 'Fetch 网页抓取',
    server: {
      serverName: 'fetch',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-fetch'],
      toolCallTimeoutMs: 60_000,
      failOnStartupError: false
    }
  }
]
