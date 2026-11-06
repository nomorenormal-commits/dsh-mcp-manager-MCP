import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'

import * as plugin from '../index.js'

function fakeLoader() {
  const store = {}

  function entryFrom(options) {
    return {
      options,
      id: options.id,
      disabled: options.disabled === true,
      fiber: { state: 2, restart: async () => {} }
    }
  }

  return {
    store,
    config: {},
    *entries() {
      for (const entry of Object.values(store)) yield entry
    },
    resolve(id) {
      if (!store[id]) throw new Error(`cannot resolve entry ${id}`)
      return store[id]
    },
    async create(options) {
      const id = options.id || `auto-${Object.keys(store).length}`
      store[id] = entryFrom({ ...options, id })
      return id
    },
    async update(id, options) {
      const entry = this.resolve(id)
      if (options.config) entry.options.config = options.config
      if (typeof options.disabled === 'boolean') entry.disabled = options.disabled
    },
    async remove(id) {
      delete store[id]
    }
  }
}

function fakeContext({ loader, webServer, connection }) {
  const disposers = []
  return {
    baseUrl: undefined,
    get(name) {
      return { loader, webServer, connection }[name]
    },
    effect(fn) {
      const disposer = fn()
      if (typeof disposer === 'function') disposers.push(disposer)
    },
    logger: { warn() {}, info() {} },
    disposers
  }
}

function makeRequest(handler, method, url, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined
      ? []
      : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]
    const req = Readable.from(payload)
    req.method = method
    req.url = url
    req.headers = { 'content-type': 'application/json' }
    const chunks = []
    const res = {
      statusCode: 200,
      headers: {},
      writeHead(code, headers) {
        this.statusCode = code
        this.headers = headers || {}
      },
      end(buffer) {
        if (buffer) chunks.push(Buffer.from(buffer))
        const text = Buffer.concat(chunks).toString('utf8')
        let json = null
        try {
          json = text ? JSON.parse(text) : null
        } catch {
          json = null
        }
        resolve({ status: this.statusCode, headers: this.headers, text, json })
      }
    }
    try {
      Promise.resolve(handler(req, res)).catch(reject)
    } catch (error) {
      reject(error)
    }
  })
}

async function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mcp-manager-'))
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'dsh-profile-test', dependencies: { 'dsh-mcp-manager': 'link:.' } }), 'utf8')
  const loader = fakeLoader()
  let route = null
  const webServer = {
    register(options) {
      route = options
      return () => {
        route = null
      }
    }
  }
  const connection = { requestRejection: () => false }
  const ctx = fakeContext({ loader, webServer, connection })
  process.env.DSH_MCP_MANAGER_PROFILE_DIR = dir
  plugin.apply(ctx)
  const call = (method, url, body) => makeRequest(route.handler, method, 'http://local' + url, body)
  return { dir, loader, ctx, call }
}

test('插件导出形状与 manifest 一致', () => {
  assert.equal(plugin.name, 'dsh-mcp-manager')
  assert.deepEqual(plugin.inject, ['loader', 'webServer', 'connection'])
  assert.equal(typeof plugin.apply, 'function')
  assert.equal(plugin.default, undefined, '不能导出 default，避免 loader unwrap 歧义')
})

test('GET /meta 返回 profile 与模板', async (t) => {
  const { dir, call, ctx } = await setup()
  t.after(() => {
    for (const dispose of ctx.disposers) dispose()
    fs.rmSync(dir, { recursive: true, force: true })
    delete process.env.DSH_MCP_MANAGER_PROFILE_DIR
  })

  const res = await call('GET', '/dsh-mcp-manager/api/meta')
  assert.equal(res.status, 200)
  assert.equal(res.json.ok, true)
  assert.equal(res.json.profileDir, dir)
  assert.equal(res.json.version.length > 0, true)
  assert.equal(res.json.templates.length > 0, true)
})

test('新增 / 启停 / 删除：loader 与 patch 文件同步', async (t) => {
  const { dir, call, loader, ctx } = await setup()
  t.after(() => {
    for (const dispose of ctx.disposers) dispose()
    fs.rmSync(dir, { recursive: true, force: true })
    delete process.env.DSH_MCP_MANAGER_PROFILE_DIR
  })

  const created = await call('POST', '/dsh-mcp-manager/api/servers', {
    server: { serverName: 'github', transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], env: { GITHUB_TOKEN: 'secret' } }
  })
  assert.equal(created.status, 200)
  assert.equal(created.json.ok, true)
  assert.equal(loader.store['dsh-mcp-manager-github'].options.config.serverName, 'github')
  assert.equal(loader.store['dsh-mcp-manager-github'].fiber.state, 2)

  const list = await call('GET', '/dsh-mcp-manager/api/servers')
  assert.equal(list.json.ok, true)
  assert.equal(list.json.summary.total, 1)
  assert.equal(list.json.servers[0].status, 'online')
  assert.equal(list.json.servers[0].managed, true)

  const patch = fs.readFileSync(path.join(dir, 'cordis.patch.yml'), 'utf8')
  assert.match(patch, /dsh-mcp-manager managed block/)
  assert.match(patch, /dsh-mcp-manager-github/)
  assert.match(patch, /"GITHUB_TOKEN":"secret"/)

  const state = JSON.parse(fs.readFileSync(path.join(dir, '.dsh-mcp-manager', 'state.json'), 'utf8'))
  assert.equal(state.servers.length, 1)
  assert.equal(state.servers[0].serverName, 'github')

  const disabled = await call('POST', '/dsh-mcp-manager/api/servers/toggle', { serverName: 'github', enabled: false })
  assert.equal(disabled.json.ok, true)
  assert.equal(loader.store['dsh-mcp-manager-github'].disabled, true)
  const patchAfterDisable = fs.readFileSync(path.join(dir, 'cordis.patch.yml'), 'utf8')
  assert.match(patchAfterDisable, /disabled: true/)

  const removed = await call('POST', '/dsh-mcp-manager/api/servers/delete', { serverName: 'github' })
  assert.equal(removed.json.ok, true)
  assert.equal(loader.store['dsh-mcp-manager-github'], undefined)
  const patchAfterDelete = fs.readFileSync(path.join(dir, 'cordis.patch.yml'), 'utf8')
  assert.equal(patchAfterDelete.includes('dsh-mcp-manager-github'), false)
  assert.match(patchAfterDelete, /managed block/, '空托管块仍然保留，便于下次写入')
})

test('重名校验与外部条目保护', async (t) => {
  const { dir, call, loader, ctx } = await setup()
  t.after(() => {
    for (const dispose of ctx.disposers) dispose()
    fs.rmSync(dir, { recursive: true, force: true })
    delete process.env.DSH_MCP_MANAGER_PROFILE_DIR
  })

  await call('POST', '/dsh-mcp-manager/api/servers', {
    server: { serverName: 'demo', transport: 'stdio', command: 'node' }
  })
  const duplicate = await call('POST', '/dsh-mcp-manager/api/servers', {
    server: { serverName: 'demo', transport: 'stdio', command: 'node' }
  })
  assert.equal(duplicate.json.ok, false)
  assert.match(duplicate.json.error, /已存在/)

  // 模拟用户手写的外部 mcp-client 行
  loader.store['manual-row'] = {
    options: { id: 'manual-row', name: '@deepseek-ai/dsh-mcp-client', config: { serverName: 'manual', transport: 'stdio', command: 'node' } },
    id: 'manual-row',
    disabled: false,
    fiber: { state: 2, restart: async () => {} }
  }
  const externalDelete = await call('POST', '/dsh-mcp-manager/api/servers/delete', { serverName: 'manual' })
  assert.equal(externalDelete.json.ok, false)
  assert.match(externalDelete.json.error, /外部/)

  const externalToggle = await call('POST', '/dsh-mcp-manager/api/servers/toggle', { serverName: 'manual', enabled: false })
  assert.equal(externalToggle.json.ok, true)
  assert.equal(loader.store['manual-row'].disabled, true)
  const patch = fs.readFileSync(path.join(dir, 'cordis.patch.yml'), 'utf8')
  assert.match(patch, /- id: "manual-row"/, '外部条目停用要写覆盖行才能跨重启保留')
})

test('导入 Claude Desktop 配置 + 导出可脱敏', async (t) => {
  const { dir, call, loader, ctx } = await setup()
  t.after(() => {
    for (const dispose of ctx.disposers) dispose()
    fs.rmSync(dir, { recursive: true, force: true })
    delete process.env.DSH_MCP_MANAGER_PROFILE_DIR
  })

  const imported = await call('POST', '/dsh-mcp-manager/api/import', {
    mode: 'replace',
    payload: {
      mcpServers: {
        fs: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'], env: { API_KEY: 'k' } },
        web: { type: 'http', url: 'https://example.com/mcp' }
      }
    }
  })
  assert.equal(imported.json.ok, true)
  assert.equal(imported.json.failures.length, 0)
  assert.equal(Object.keys(loader.store).length, 2)

  const exported = await call('GET', '/dsh-mcp-manager/api/export?redact=1')
  assert.equal(exported.status, 200)
  assert.equal(exported.json.count, 2)
  const fsServer = exported.json.servers.find((server) => server.serverName === 'fs')
  assert.equal(fsServer.env.API_KEY, '***')
})

test('非法 JSON / 未知接口返回可读错误', async (t) => {
  const { dir, call, ctx } = await setup()
  t.after(() => {
    for (const dispose of ctx.disposers) dispose()
    fs.rmSync(dir, { recursive: true, force: true })
    delete process.env.DSH_MCP_MANAGER_PROFILE_DIR
  })

  const missing = await call('GET', '/dsh-mcp-manager/api/nope')
  assert.equal(missing.status, 404)
  assert.equal(missing.json.ok, false)

  const broken = await call('POST', '/dsh-mcp-manager/api/servers', '{oops')
  assert.equal(broken.status, 500)
  assert.equal(broken.json.ok, false)
  assert.match(broken.json.error, /JSON/)
})
