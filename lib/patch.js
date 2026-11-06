/* ============================================================================
 * dsh-mcp-manager — cordis.patch.yml 托管区块
 * ----------------------------------------------------------------------------
 * 用户的 MCP 服务以 patch 行的形式落盘，跨重启保留：
 *
 *   - insert:
 *       - id: "dsh-mcp-manager-github"
 *         name: "@deepseek-ai/dsh-mcp-client"
 *         config: {"serverName":"github", ...}
 *         disabled: true            # 仅在停用时出现
 *
 * 只改这组标记之间的内容，块外的一切（含用户手写的 !!js 表达式）原样保留。
 * 值统一用 JSON 文本（JSON 是合法的 YAML 1.2 flow 语法），不需要 YAML 依赖。
 * ========================================================================== */

export const MARK_START = '# >>> dsh-mcp-manager managed block — 自动生成，块内手改会被覆盖'
export const MARK_END = '# <<< dsh-mcp-manager managed block'

export const ROW_ID_PREFIX = 'dsh-mcp-manager-'

export function rowIdFor(serverName) {
  return ROW_ID_PREFIX + serverName
}

function quote(value) {
  return JSON.stringify(value)
}

function renderConfig(config) {
  return JSON.stringify(config)
}

/**
 * 生成整个托管块。
 * @param {Array<{serverName: string, config: object, disabled?: boolean}>} servers
 * @param {Array<{entryId: string, disabled?: boolean}>} overrides 针对「非托管」条目的覆盖行
 */
export function renderManagedBlock(servers, overrides = []) {
  const lines = [MARK_START]
  const inserts = []
  for (const item of servers) {
    inserts.push({
      id: rowIdFor(item.serverName),
      name: item.config?.name || '@deepseek-ai/dsh-mcp-client',
      config: item.config,
      disabled: item.disabled === true
    })
  }
  if (inserts.length) {
    lines.push('- insert:')
    for (const row of inserts) {
      lines.push(`    - id: ${quote(row.id)}`)
      lines.push(`      name: ${quote(row.name)}`)
      lines.push(`      config: ${renderConfig(row.config)}`)
      if (row.disabled) lines.push('      disabled: true')
    }
  }
  for (const override of overrides) {
    if (!override || !override.entryId || override.disabled !== true) continue
    lines.push(`- id: ${quote(override.entryId)}`)
    lines.push('  disabled: true')
  }
  lines.push(MARK_END)
  return lines.join('\n') + '\n'
}

/** 是否已经存在托管块。 */
export function hasManagedBlock(text) {
  return text.includes(MARK_START) && text.includes(MARK_END)
}

/**
 * 把托管块写入 patch 文件文本。块外内容保持不动。
 * @throws 标记只出现一半时，宁可报错也不破坏用户文件。
 */
export function applyManagedBlock(text, block) {
  const source = typeof text === 'string' ? text : ''
  const start = source.indexOf(MARK_START)
  const end = source.indexOf(MARK_END)

  if (start !== -1 && end !== -1 && end > start) {
    const tail = source.slice(end + MARK_END.length).replace(/^\r?\n/, '')
    const next = source.slice(0, start) + block + tail
    return next.replace(/\r?\n?$/, '\n')
  }
  if (start !== -1 || end !== -1) {
    throw new Error('cordis.patch.yml 中的 dsh-mcp-manager 标记不完整，已中止写入以免损坏文件')
  }

  const base = source.replace(/\s*$/, '')
  return (base ? base + '\n\n' : '') + block
}
