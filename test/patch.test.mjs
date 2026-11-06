import assert from 'node:assert/strict'
import test from 'node:test'

import { applyManagedBlock, hasManagedBlock, renderManagedBlock, rowIdFor, MARK_START, MARK_END } from '../lib/patch.js'

test('渲染托管块：insert 行 + 停用覆盖行', () => {
  const block = renderManagedBlock(
    [
      {
        serverName: 'github',
        config: { serverName: 'github', transport: 'stdio', command: 'npx', args: ['-y', 'pkg'], env: { TOKEN: 'a"b' } }
      },
      { serverName: 'docs', disabled: true, config: { serverName: 'docs', transport: 'streamable-http', url: 'https://x/mcp' } }
    ],
    [{ entryId: 'manual-github', disabled: true }]
  )

  assert.match(block, /- insert:/)
  assert.match(block, /- id: "dsh-mcp-manager-github"/)
  assert.match(block, /disabled: true/)
  assert.match(block, /- id: "manual-github"/)
  assert.equal(block.includes('a\\"b'), true, '引号必须被 JSON 转义')
  assert.equal(block.split('\n').length > 5, true)
  assert.equal(block.trimEnd().endsWith(MARK_END), true)
})

test('首次写入：保留已有内容并追加在末尾', () => {
  const original = '# user patch\n- insert:\n    - id: user-row\n      name: some-plugin\n'
  const block = renderManagedBlock([{ serverName: 'fs', config: { serverName: 'fs' } }])
  const next = applyManagedBlock(original, block)
  assert.match(next, /user-row/)
  assert.equal(next.includes(MARK_START), true)
  assert.equal(next.includes(MARK_END), true)
  assert.equal(original, '# user patch\n- insert:\n    - id: user-row\n      name: some-plugin\n', '不得修改入参字符串')
})

test('重复写入：整块替换而不是堆叠', () => {
  const blockA = renderManagedBlock([{ serverName: 'a', config: { serverName: 'a' } }])
  const first = applyManagedBlock('', blockA)
  const blockB = renderManagedBlock([{ serverName: 'b', config: { serverName: 'b' } }])
  const second = applyManagedBlock(first, blockB)
  assert.equal(second.includes('dsh-mcp-manager-a'), false)
  assert.equal(second.includes('dsh-mcp-manager-b'), true)
  assert.equal(second.split(MARK_START).length, 2, '托管块只应出现一次')
})

test('块外内容在替换时原样保留（含 !!js 表达式）', () => {
  const head = '- id: manual\n  name: third-party\n  config: !!js process.env.DSH_DEBUG\n'
  const tail = '- id: tail-row\n  disabled: true\n'
  const block = renderManagedBlock([{ serverName: 'x', config: { serverName: 'x' } }])
  const first = applyManagedBlock(head + '\n', block)
  const second = applyManagedBlock(head + '\n' + first.split('\n').slice(head.split('\n').length - 1).join('\n') + tail, renderManagedBlock([{ serverName: 'y', config: { serverName: 'y' } }]))
  assert.match(second, /!!js process\.env\.DSH_DEBUG/)
  assert.match(second, /tail-row/)
  assert.equal(hasManagedBlock(second), true)
})

test('标记不完整时拒绝写入', () => {
  assert.throws(
    () => applyManagedBlock(MARK_START + '\n- id: x\n', renderManagedBlock([])),
    /标记不完整/
  )
})

test('空服务列表仍生成合法托管块', () => {
  const block = renderManagedBlock([], [])
  assert.equal(block, `${MARK_START}\n${MARK_END}\n`)
})

test('rowId 使用稳定前缀', () => {
  assert.equal(rowIdFor('github'), 'dsh-mcp-manager-github')
})
