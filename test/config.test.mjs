import assert from 'node:assert/strict'
import test from 'node:test'

import { buildExport, parseImport, redactServer, validateServer } from '../lib/config.js'

test('校验 stdio 服务并补齐默认值', () => {
  const result = validateServer({ serverName: 'github', transport: 'stdio', command: 'npx', args: ['-y', 'pkg'] })
  assert.equal(result.ok, true)
  assert.equal(result.server.transport, 'stdio')
  assert.equal(result.server.toolCallTimeoutMs, 60000)
  assert.deepEqual(result.server.args, ['-y', 'pkg'])
  assert.equal(result.server.failOnStartupError, false)
})

test('URL 推断 transport 并拒绝非法协议', () => {
  const http = validateServer({ serverName: 'remote', url: 'https://example.com/mcp' })
  assert.equal(http.ok, true)
  assert.equal(http.server.transport, 'streamable-http')

  const bad = validateServer({ serverName: 'remote', transport: 'streamable-http', url: 'ftp://example.com' })
  assert.equal(bad.ok, false)
  assert.match(bad.errors.join(' '), /http/)
})

test('拒绝非法名称与重名，允许原名重存', () => {
  const badName = validateServer({ serverName: '中文 服务', command: 'node' }, { existingNames: [] })
  assert.equal(badName.ok, false)

  const duplicate = validateServer({ serverName: 'github', command: 'npx' }, { existingNames: ['github'] })
  assert.equal(duplicate.ok, false)

  const rename = validateServer({ serverName: 'github2', command: 'npx' }, { existingNames: ['github'], originalName: 'github' })
  assert.equal(rename.ok, true)

  const same = validateServer({ serverName: 'github', command: 'npx' }, { existingNames: ['github'], originalName: 'github' })
  assert.equal(same.ok, true)
})

test('时间戳与超时范围校验', () => {
  const tooSmall = validateServer({ serverName: 'x', command: 'node', toolCallTimeoutMs: 10 })
  assert.equal(tooSmall.ok, false)

  const notNumber = validateServer({ serverName: 'x', command: 'node', toolCallTimeoutMs: 'abc' })
  assert.equal(notNumber.ok, false)
})

test('脱敏 env 与 headers 中的敏感键', () => {
  const server = {
    serverName: 'x',
    transport: 'stdio',
    command: 'node',
    env: { GITHUB_TOKEN: 'ghp_1', NODE_ENV: 'production' },
    headers: { Authorization: 'Bearer a', 'X-Trace': '1' }
  }
  const redacted = redactServer(server)
  assert.equal(redacted.env.GITHUB_TOKEN, '***')
  assert.equal(redacted.env.NODE_ENV, 'production')
  assert.equal(redacted.headers.Authorization, '***')
  assert.equal(redacted.headers['X-Trace'], '1')
  assert.equal(server.env.GITHUB_TOKEN, 'ghp_1', '不得修改原对象')
})

test('导出格式可被自己解析回来', () => {
  const servers = [{ server: { serverName: 'a', transport: 'stdio', command: 'node' } }]
  const payload = buildExport(servers, { redact: false })
  assert.equal(payload.format, 'dsh-mcp-manager/export')
  assert.equal(payload.count, 1)
  const parsed = parseImport(payload)
  assert.equal(parsed.errors.length, 0)
  assert.equal(parsed.servers[0].serverName, 'a')
})

test('兼容 Claude Desktop mcpServers 格式', () => {
  const parsed = parseImport({
    mcpServers: {
      filesystem: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'] },
      remote: { type: 'http', url: 'https://example.com/mcp', headers: { Authorization: 'Bearer x' } }
    }
  })
  assert.equal(parsed.errors.length, 0)
  assert.equal(parsed.servers.length, 2)
  assert.equal(parsed.servers.find((s) => s.serverName === 'remote').transport, 'streamable-http')
})

test('导入时逐个报告错误但不中断其它项', () => {
  const parsed = parseImport({
    servers: [
      { serverName: 'good', command: 'node' },
      { serverName: 'bad name!', command: 'node' },
      { serverName: 'no-command', transport: 'stdio' }
    ]
  })
  assert.equal(parsed.servers.length, 1)
  assert.equal(parsed.errors.length, 2)
})

test('拒绝无法识别的导入结构', () => {
  const parsed = parseImport({ hello: 'world' })
  assert.equal(parsed.servers.length, 0)
  assert.equal(parsed.errors.length, 1)
})
