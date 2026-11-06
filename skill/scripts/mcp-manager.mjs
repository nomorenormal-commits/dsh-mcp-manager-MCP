#!/usr/bin/env node
/* ============================================================================
 * dsh-mcp-manager CLI — 零依赖命令行封装（供 agent / 人类驱动插件 HTTP API）
 *
 * 认证：DSH 启动时打印带 ?token= 的 URL；本脚本先用它换取会话 cookie，
 * 之后的 API 请求都携带该 cookie（与浏览器行为一致）。
 *
 * 用法：
 *   node mcp-manager.mjs --base "http://127.0.0.1:3199/?token=XXXX" <command>
 * 也可用环境变量 DSH_URL / DSH_TOKEN 代替 --base。
 * ========================================================================== */

import http from 'node:http'
import https from 'node:https'
import fs from 'node:fs'
import path from 'node:path'

const API = '/dsh-mcp-manager/api'

const HELP = `dsh-mcp-manager CLI

用法:
  node mcp-manager.mjs --base "http://127.0.0.1:3199/?token=XXXX" <command> [options]

命令:
  meta                              插件版本 / profile / patch 状态 / 模板
  list                              列出全部 MCP 服务与实时状态
  add <name> --type stdio --command <cmd> [--arg x]... [--env K=V]...
             [--cwd dir] [--timeout ms] [--fail-on-startup-error] [--disabled]
  add <name> --type http --url <url> [--header K=V]...
  set <name> [同 add 的选项]         合并修改已存在的服务
  enable <name> | disable <name>    启停（配置保留）
  remove <name>                     删除（仅托管条目）
  check [name]                      健康检查（省略名称 = 全部）
  reconnect <name>                  重启该条目的 loader fiber
  logs [--server name] [--since ISO] [--limit n]
  export [--no-redact] [--out file] 导出（默认脱敏）
  import <file> [--mode merge|replace]

全局选项:
  --base <url>    DSH 地址（可含 ?token=），也可用 DSH_URL / DSH_TOKEN
  --token <tok>   单独传 token
  -h, --help      显示本帮助
`

// ------------------------------------------------------------------ 参数解析
function parseArgs(argv) {
  const flags = {}
  const multi = { arg: [], env: [], header: [] }
  const positional = []
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (token === '-h' || token === '--help') {
      flags.help = true
      continue
    }
    if (token.startsWith('--')) {
      const eq = token.indexOf('=')
      const key = token.slice(2, eq === -1 ? undefined : eq)
      if (key in multi) {
        const value = eq === -1 ? argv[++i] : token.slice(eq + 1)
        multi[key].push(value)
        continue
      }
      if (eq !== -1) {
        flags[key] = token.slice(eq + 1)
        continue
      }
      const next = argv[i + 1]
      if (next === undefined || next.startsWith('--')) {
        flags[key] = true
      } else {
        flags[key] = next
        i += 1
      }
      continue
    }
    positional.push(token)
  }
  return { flags, multi, positional }
}

function fail(message) {
  process.stderr.write(`error: ${message}\n`)
  process.exit(1)
}

function kvListToMap(list, label) {
  const map = {}
  for (const item of list) {
    const eq = String(item).indexOf('=')
    if (eq === -1) fail(`--${label} 需要 K=V 形式，收到 "${item}"`)
    map[String(item).slice(0, eq)] = String(item).slice(eq + 1)
  }
  return map
}

// ------------------------------------------------------------------ HTTP 层
function rawRequest(method, urlString, { cookie, body } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString)
    const transport = url.protocol === 'https:' ? https : http
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8')
    const req = transport.request(
      {
        method,
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        headers: {
          accept: 'application/json',
          ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}),
          ...(cookie ? { cookie } : {})
        },
        timeout: 30000
      },
      (res) => {
        const chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          let json = null
          try { json = text ? JSON.parse(text) : null } catch { json = null }
          resolve({ status: res.statusCode, headers: res.headers, json, text })
        })
      }
    )
    req.on('timeout', () => req.destroy(new Error('请求超时')))
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

function cookieFrom(setCookie) {
  if (!setCookie) return ''
  const list = Array.isArray(setCookie) ? setCookie : [setCookie]
  return list.map((line) => String(line).split(';')[0]).filter(Boolean).join('; ')
}

// ---------------------------------------------------------------- 会话与调用
async function createSession(baseInput, tokenInput) {
  const raw = baseInput || process.env.DSH_URL
  if (!raw) fail('缺少 --base（或 DSH_URL），需要 DSH 启动时打印的带 token 地址')
  let url
  try {
    url = new URL(raw)
  } catch {
    fail(`无法解析地址：${raw}`)
  }
  const token = tokenInput || process.env.DSH_TOKEN || url.searchParams.get('token')
  const origin = url.origin
  let cookie = ''
  if (token) {
    const res = await rawRequest('GET', `${origin}/?token=${encodeURIComponent(token)}`)
    cookie = cookieFrom(res.headers['set-cookie'])
  }
  async function api(method, apiPath, body) {
    const res = await rawRequest(method, origin + API + apiPath, { cookie, body })
    if (res.json === null) fail(`接口返回非 JSON（HTTP ${res.status}）：${res.text.slice(0, 200)}`)
    if (res.status >= 400 || res.json.ok === false) {
      const detail = Array.isArray(res.json.details) && res.json.details.length
        ? `：${res.json.details.join('；')}`
        : ''
      fail(`${res.json.error || `HTTP ${res.status}`}${detail}`)
    }
    return res.json
  }
  return { api, origin }
}

function print(data) {
  process.stdout.write(`${JSON.stringify(data, null, 2)}\n`)
}

// ------------------------------------------------------------------ 服务构造
function buildServer(name, flags, multi, existing) {
  const server = existing ? { ...existing } : { serverName: name, transport: 'stdio' }
  if (flags.type) {
    if (!['stdio', 'http'].includes(flags.type)) fail('--type 只能是 stdio 或 http')
    server.transport = flags.type === 'http' ? 'streamable-http' : 'stdio'
  }
  if (flags.command !== undefined) server.command = flags.command
  if (multi.arg.length) server.args = multi.arg
  if (multi.env.length) server.env = { ...(server.env || {}), ...kvListToMap(multi.env, 'env') }
  if (flags.cwd !== undefined) server.cwd = flags.cwd
  if (flags.url !== undefined) server.url = flags.url
  if (multi.header.length) server.headers = { ...(server.headers || {}), ...kvListToMap(multi.header, 'header') }
  if (flags.timeout !== undefined) {
    const ms = Number(flags.timeout)
    if (!Number.isFinite(ms) || ms <= 0) fail('--timeout 需要正整数（毫秒）')
    server.toolCallTimeoutMs = ms
  }
  if (flags['fail-on-startup-error']) server.failOnStartupError = true
  if (flags.disabled) server.disabled = true

  if (server.transport === 'stdio') {
    delete server.url
    delete server.headers
    if (!server.command) fail('stdio 服务必须提供 --command')
  } else {
    delete server.command
    delete server.args
    delete server.env
    delete server.cwd
    if (!server.url) fail('http 服务必须提供 --url')
  }
  return server
}

// ------------------------------------------------------------------ 主流程
async function main() {
  const { flags, multi, positional } = parseArgs(process.argv.slice(2))
  if (flags.help || positional.length === 0) {
    process.stdout.write(HELP)
    process.exit(positional.length === 0 && !flags.help ? 1 : 0)
  }
  const [command, ...rest] = positional
  const { api } = await createSession(flags.base, flags.token)

  switch (command) {
    case 'meta':
      print(await api('GET', '/meta'))
      break

    case 'list':
      print(await api('GET', '/servers'))
      break

    case 'add': {
      const name = rest[0]
      if (!name) fail('add 需要服务名称')
      const server = buildServer(name, flags, multi, null)
      print(await api('POST', '/servers', { server }))
      break
    }

    case 'set': {
      const name = rest[0]
      if (!name) fail('set 需要服务名称')
      const list = await api('GET', '/servers')
      const view = (list.servers || []).find((item) => item.serverName === name)
      if (!view) fail(`找不到服务 ${name}`)
      if (view.external) fail(`${name} 是外部条目，不能通过本插件编辑`)
      const server = buildServer(name, flags, multi, { ...view.config, serverName: name, disabled: !view.enabled })
      print(await api('POST', '/servers', { server, originalName: name }))
      break
    }

    case 'enable':
    case 'disable': {
      const name = rest[0]
      if (!name) fail(`${command} 需要服务名称`)
      print(await api('POST', '/servers/toggle', { serverName: name, enabled: command === 'enable' }))
      break
    }

    case 'remove': {
      const name = rest[0]
      if (!name) fail('remove 需要服务名称')
      print(await api('POST', '/servers/delete', { serverName: name }))
      break
    }

    case 'check': {
      const name = rest[0]
      print(await api('POST', '/servers/check', name ? { serverName: name } : {}))
      break
    }

    case 'reconnect': {
      const name = rest[0]
      if (!name) fail('reconnect 需要服务名称')
      print(await api('POST', '/servers/reconnect', { serverName: name }))
      break
    }

    case 'logs': {
      const params = new URLSearchParams()
      if (flags.server) params.set('serverName', flags.server)
      if (flags.since) params.set('since', flags.since)
      if (flags.limit) params.set('limit', flags.limit)
      const qs = params.toString()
      print(await api('GET', `/logs${qs ? `?${qs}` : ''}`))
      break
    }

    case 'export': {
      const redact = flags.redact === false || flags['no-redact'] ? '0' : '1'
      const data = await api('GET', `/export?redact=${redact}`)
      if (flags.out) {
        const file = path.resolve(String(flags.out))
        fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
        print({ ok: true, file, count: Array.isArray(data.servers) ? data.servers.length : 0 })
      } else {
        print(data)
      }
      break
    }

    case 'import': {
      const file = rest[0]
      if (!file) fail('import 需要 JSON 文件路径')
      let payload
      try {
        payload = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'))
      } catch (error) {
        fail(`读取 / 解析 ${file} 失败：${error.message}`)
      }
      const mode = flags.mode === 'replace' ? 'replace' : 'merge'
      print(await api('POST', '/import', { payload, mode }))
      break
    }

    default:
      fail(`未知命令 "${command}"，用 --help 查看用法`)
  }
}

main().catch((error) => fail(error.message))
