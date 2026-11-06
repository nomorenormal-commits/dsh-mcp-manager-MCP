/* ============================================================================
 * dsh-mcp-manager — 浏览器半侧（设置页「MCP 服务」）
 * ----------------------------------------------------------------------------
 * 手写 ModuleLoader bundle，无需构建。数据全部走 Host 的 HTTP API：
 *   GET  /dsh-mcp-manager/api/servers
 *   POST /dsh-mcp-manager/api/servers           新增 / 更新
 *   POST .../servers/toggle|delete|check|reconnect
 *   GET  .../logs   GET .../export   POST .../import
 *   GET  .../meta
 * 注册 id 必须等于 loader entry 名（dsh-mcp-manager）。
 * ========================================================================== */

window.__ModuleLoader__.load({
  id: 'dsh-mcp-manager',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback, useMemo, useRef } = React

    const API = '/dsh-mcp-manager/api'
    const STYLE_ID = 'mcm-style'

    async function api(path, options) {
      const response = await fetch(API + path, {
        cache: 'no-store',
        headers: { 'content-type': 'application/json' },
        ...options
      })
      let data = {}
      try {
        data = await response.json()
      } catch {
        data = {}
      }
      if (!response.ok || data.ok === false) {
        const error = new Error(data.error || `请求失败（HTTP ${response.status}）`)
        error.details = data.details
        throw error
      }
      return data
    }

    function kvToText(map) {
      return Object.entries(map || {}).map(([key, value]) => `${key}=${value}`).join('\n')
    }

    function textToKv(text) {
      const map = {}
      for (const raw of String(text || '').split(/\r?\n/)) {
        const line = raw.trim()
        if (!line || line.startsWith('#')) continue
        const index = line.indexOf('=')
        if (index === -1) map[line] = ''
        else map[line.slice(0, index).trim()] = line.slice(index + 1).trim()
      }
      return map
    }

    function argsToText(args) {
      return Array.isArray(args) ? args.join('\n') : ''
    }

    function textToArgs(text) {
      const out = []
      for (const raw of String(text || '').split(/\r?\n/)) {
        const line = raw.replace(/\s+$/, '')
        if (!line.trim()) continue
        out.push(line)
      }
      return out
    }

    const STATUS = {
      online: { label: '在线', tone: 'ok' },
      offline: { label: '掉线', tone: 'bad' },
      missing: { label: '未加载', tone: 'warn' },
      connecting: { label: '连接中', tone: 'info' },
      paused: { label: '已停用', tone: 'muted' },
      idle: { label: '待启动', tone: 'muted' }
    }

    const FILTERS = [
      { id: 'all', label: '全部' },
      { id: 'attention', label: '需要关注' },
      { id: 'online', label: '在线' },
      { id: 'paused', label: '已停用' },
      { id: 'external', label: '外部条目' }
    ]

    function StatusPill({ status, lastCheck }) {
      const info = STATUS[status] || STATUS.idle
      return h('span', { className: `mcm-pill mcm-pill-${info.tone}` },
        h('span', { className: 'mcm-dot' }),
        info.label,
        lastCheck && lastCheck.ms !== undefined
          ? h('span', { className: 'mcm-pill-sub' }, `${lastCheck.ms}ms`)
          : null
      )
    }

    function Toggle({ checked, disabled, onChange, label }) {
      return h('button', {
        type: 'button',
        className: `mcm-switch${checked ? ' is-on' : ''}`,
        role: 'switch',
        'aria-checked': checked,
        'aria-label': label || '启用 / 停用',
        disabled,
        onClick: onChange
      }, h('span', { className: 'mcm-switch-knob' }))
    }

    function Modal({ title, subtitle, onClose, children, footer }) {
      useEffect(() => {
        function onKey(event) {
          if (event.key === 'Escape') onClose()
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [onClose])
      return h('div', { className: 'mcm-modal-mask', onMouseDown: (event) => { if (event.target === event.currentTarget) onClose() } },
        h('div', { className: 'mcm-modal', role: 'dialog', 'aria-modal': 'true' },
          h('div', { className: 'mcm-modal-head' },
            h('div', {},
              h('h3', {}, title),
              subtitle ? h('p', {}, subtitle) : null
            ),
            h('button', { type: 'button', className: 'mcm-icon-btn', onClick: onClose, 'aria-label': '关闭' }, '✕')
          ),
          h('div', { className: 'mcm-modal-body' }, children),
          footer ? h('div', { className: 'mcm-modal-foot' }, footer) : null
        )
      )
    }

    function Field({ label, hint, children, wide }) {
      return h('label', { className: `mcm-field${wide ? ' mcm-field-wide' : ''}` },
        h('span', { className: 'mcm-field-label' },
          label,
          hint ? h('span', { className: 'mcm-field-hint' }, hint) : null
        ),
        children
      )
    }

    function Editor({ meta, initial, initialEnabled, originalName, onClose, onSaved, toast }) {
      const start = initial || meta.blank.stdio
      const [draft, setDraft] = useState(() => ({
        serverName: start.serverName || '',
        transport: start.transport || 'stdio',
        command: start.command || '',
        argsText: argsToText(start.args),
        cwd: start.cwd || '',
        envText: kvToText(start.env),
        url: start.url || '',
        headersText: kvToText(start.headers),
        toolCallTimeoutMs: start.toolCallTimeoutMs || 60000,
        failOnStartupError: start.failOnStartupError === true,
        enabled: initialEnabled !== false
      }))
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState(null)

      function patch(key, value) {
        setDraft((current) => ({ ...current, [key]: value }))
      }

      function useTemplate(templateId) {
        const template = (meta.templates || []).find((item) => item.id === templateId)
        if (!template) return
        const server = template.server
        setDraft({
          serverName: server.serverName,
          transport: server.transport,
          command: server.command || '',
          argsText: argsToText(server.args),
          cwd: server.cwd || '',
          envText: kvToText(server.env),
          url: server.url || '',
          headersText: kvToText(server.headers),
          toolCallTimeoutMs: server.toolCallTimeoutMs || 60000,
          failOnStartupError: false,
          enabled: true
        })
      }

      async function save() {
        setBusy(true)
        setError(null)
        const server = {
          serverName: draft.serverName.trim(),
          transport: draft.transport,
          toolCallTimeoutMs: Number(draft.toolCallTimeoutMs),
          failOnStartupError: draft.failOnStartupError,
          disabled: !draft.enabled
        }
        if (draft.transport === 'stdio') {
          server.command = draft.command.trim()
          server.args = textToArgs(draft.argsText)
          const env = textToKv(draft.envText)
          if (Object.keys(env).length) server.env = env
          if (draft.cwd.trim()) server.cwd = draft.cwd.trim()
        } else {
          server.url = draft.url.trim()
          const headers = textToKv(draft.headersText)
          if (Object.keys(headers).length) server.headers = headers
        }
        try {
          const result = await api('/servers', {
            method: 'POST',
            body: JSON.stringify({ server, originalName: originalName || null })
          })
          const warnings = [...(result.warnings || [])]
          for (const failure of result.failures || []) warnings.push(`热加载失败：${failure.error}`)
          toast(warnings.length ? 'warn' : 'ok', warnings.length ? warnings.join('；') : '已保存并生效')
          onSaved()
          onClose()
        } catch (err) {
          setError(err.details?.length ? err.details.join('；') : err.message)
        } finally {
          setBusy(false)
        }
      }

      const isStdio = draft.transport === 'stdio'

      return h(Modal, {
        title: originalName ? `编辑 ${originalName}` : '添加 MCP 服务',
        subtitle: '保存后立即写入 profile 的 cordis.patch.yml，并热挂载到当前会话。',
        onClose,
        footer: h('div', { className: 'mcm-modal-actions' },
          h('button', { type: 'button', className: 'mcm-btn', onClick: onClose, disabled: busy }, '取消'),
          h('button', { type: 'button', className: 'mcm-btn mcm-btn-primary', onClick: save, disabled: busy }, busy ? '保存中…' : '保存')
        )
      },
        h('div', { className: 'mcm-form' },
          h('div', { className: 'mcm-form-row' },
            h(Field, { label: '服务名称', hint: '工具名前缀 mcp__<名称>__，仅字母数字 _ -' },
              h('input', {
                className: 'mcm-input',
                value: draft.serverName,
                placeholder: '例如 github',
                spellCheck: false,
                onChange: (event) => patch('serverName', event.target.value)
              })
            ),
            h(Field, { label: '接入方式' },
              h('div', { className: 'mcm-seg' },
                h('button', {
                  type: 'button',
                  className: `mcm-seg-item${isStdio ? ' is-active' : ''}`,
                  onClick: () => patch('transport', 'stdio')
                }, 'stdio 本地进程'),
                h('button', {
                  type: 'button',
                  className: `mcm-seg-item${!isStdio ? ' is-active' : ''}`,
                  onClick: () => patch('transport', 'streamable-http')
                }, 'HTTP 远程')
              )
            )
          ),

          meta.templates && meta.templates.length
            ? h('div', { className: 'mcm-templates' },
                h('span', { className: 'mcm-templates-label' }, '从模板开始'),
                meta.templates.map((template) => h('button', {
                  key: template.id,
                  type: 'button',
                  className: 'mcm-chip',
                  onClick: () => useTemplate(template.id)
                }, template.label))
              )
            : null,

          isStdio
            ? h('div', {},
                h(Field, { label: '启动命令', hint: '可执行文件或 npx / uvx', wide: true },
                  h('input', {
                    className: 'mcm-input mcm-mono',
                    value: draft.command,
                    placeholder: 'npx',
                    spellCheck: false,
                    onChange: (event) => patch('command', event.target.value)
                  })
                ),
                h(Field, { label: '参数', hint: '一行一个参数', wide: true },
                  h('textarea', {
                    className: 'mcm-input mcm-mono',
                    rows: 4,
                    value: draft.argsText,
                    placeholder: '-y\n@modelcontextprotocol/server-github',
                    spellCheck: false,
                    onChange: (event) => patch('argsText', event.target.value)
                  })
                ),
                h('div', { className: 'mcm-form-row' },
                  h(Field, { label: '工作目录', hint: '可选，默认继承 DSH' },
                    h('input', {
                      className: 'mcm-input mcm-mono',
                      value: draft.cwd,
                      placeholder: 'C:\\project',
                      spellCheck: false,
                      onChange: (event) => patch('cwd', event.target.value)
                    })
                  ),
                  h(Field, { label: '环境变量', hint: 'KEY=VALUE，一行一个' },
                    h('textarea', {
                      className: 'mcm-input mcm-mono',
                      rows: 3,
                      value: draft.envText,
                      placeholder: 'GITHUB_TOKEN=ghp_xxx',
                      spellCheck: false,
                      onChange: (event) => patch('envText', event.target.value)
                    })
                  )
                )
              )
            : h('div', {},
                h(Field, { label: '服务 URL', hint: 'Streamable HTTP 端点', wide: true },
                  h('input', {
                    className: 'mcm-input mcm-mono',
                    value: draft.url,
                    placeholder: 'https://example.com/mcp',
                    spellCheck: false,
                    onChange: (event) => patch('url', event.target.value)
                  })
                ),
                h(Field, { label: '请求头', hint: 'KEY=VALUE，一行一个（Authorization 等）', wide: true },
                  h('textarea', {
                    className: 'mcm-input mcm-mono',
                    rows: 3,
                    value: draft.headersText,
                    placeholder: 'Authorization=Bearer xxx',
                    spellCheck: false,
                    onChange: (event) => patch('headersText', event.target.value)
                  })
                )
              ),

          h('div', { className: 'mcm-form-row' },
            h(Field, { label: '工具调用超时（毫秒）', hint: '1000 – 600000' },
              h('input', {
                className: 'mcm-input mcm-mono',
                type: 'number',
                min: 1000,
                max: 600000,
                step: 1000,
                value: draft.toolCallTimeoutMs,
                onChange: (event) => patch('toolCallTimeoutMs', event.target.value)
              })
            ),
            h(Field, { label: '启动失败是否阻断会话' },
              h('div', { className: 'mcm-inline' },
                h(Toggle, {
                  checked: draft.failOnStartupError,
                  onChange: () => patch('failOnStartupError', !draft.failOnStartupError),
                  label: 'failOnStartupError'
                }),
                h('span', { className: 'mcm-inline-note' }, draft.failOnStartupError ? '阻断' : '仅记录并继续')
              )
            )
          ),

          h('div', { className: 'mcm-form-row' },
            h(Field, { label: '保存后状态' },
              h('div', { className: 'mcm-inline' },
                h(Toggle, { checked: draft.enabled, onChange: () => patch('enabled', !draft.enabled), label: '启用服务' }),
                h('span', { className: 'mcm-inline-note' }, draft.enabled ? '立即启用' : '先停用，稍后再开')
              )
            )
          ),

          error ? h('div', { className: 'mcm-alert mcm-alert-bad' }, error) : null
        )
      )
    }

    function ImportDialog({ onClose, onImported, toast }) {
      const [text, setText] = useState('')
      const [mode, setMode] = useState('merge')
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState(null)
      const [report, setReport] = useState(null)

      async function pickFile(event) {
        const file = event.target.files?.[0]
        if (!file) return
        try {
          setText(await file.text())
          setError(null)
        } catch (err) {
          setError(String(err.message || err))
        }
      }

      async function run() {
        setBusy(true)
        setError(null)
        setReport(null)
        let payload
        try {
          payload = JSON.parse(text)
        } catch {
          setBusy(false)
          setError('不是合法的 JSON')
          return
        }
        try {
          const result = await api('/import', {
            method: 'POST',
            body: JSON.stringify({ payload, mode })
          })
          setReport(result)
          toast('ok', `导入完成：${result.failures?.length ? '有热加载失败，详见下方' : '配置已生效'}`)
          onImported()
        } catch (err) {
          setError(err.details?.length ? err.details.join('；') : err.message)
        } finally {
          setBusy(false)
        }
      }

      return h(Modal, {
        title: '导入 MCP 配置',
        subtitle: '支持本插件导出格式，也支持 Claude Desktop 的 {"mcpServers":{…}} 格式。',
        onClose,
        footer: h('div', { className: 'mcm-modal-actions' },
          h('button', { type: 'button', className: 'mcm-btn', onClick: onClose, disabled: busy }, '关闭'),
          h('button', { type: 'button', className: 'mcm-btn mcm-btn-primary', onClick: run, disabled: busy || !text.trim() }, busy ? '导入中…' : '开始导入')
        )
      },
        h('div', { className: 'mcm-form' },
          h(Field, { label: '导入方式', wide: true },
            h('div', { className: 'mcm-seg' },
              h('button', {
                type: 'button',
                className: `mcm-seg-item${mode === 'merge' ? ' is-active' : ''}`,
                onClick: () => setMode('merge')
              }, '合并（同名覆盖）'),
              h('button', {
                type: 'button',
                className: `mcm-seg-item${mode === 'replace' ? ' is-active' : ''}`,
                onClick: () => setMode('replace')
              }, '替换全部托管服务')
            )
          ),
          h(Field, { label: '配置文件', hint: '选择 .json，或直接粘贴内容', wide: true },
            h('input', { className: 'mcm-file', type: 'file', accept: '.json,application/json', onChange: pickFile })
          ),
          h(Field, { label: 'JSON 内容', wide: true },
            h('textarea', {
              className: 'mcm-input mcm-mono',
              rows: 12,
              value: text,
              placeholder: '{\n  "servers": [\n    { "serverName": "github", "transport": "stdio", "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"] }\n  ]\n}',
              spellCheck: false,
              onChange: (event) => setText(event.target.value)
            })
          ),
          report
            ? h('div', { className: 'mcm-alert mcm-alert-ok' },
                `已处理 ${report.removed?.length ? `移除 ${report.removed.length} 个，` : ''}导入 ${report.importErrors?.length ? '（部分失败）' : '成功'}`,
                report.skipped?.length ? h('div', {}, `跳过：${report.skipped.map((item) => item.serverName).join('、')}`) : null,
                report.failures?.length ? h('div', {}, `热加载失败：${report.failures.map((item) => item.error).join('；')}`) : null,
                report.importErrors?.length ? h('div', {}, report.importErrors.join('；')) : null
              )
            : null,
          error ? h('div', { className: 'mcm-alert mcm-alert-bad' }, error) : null
        )
      )
    }

    function ServerRow({ server, busy, onToggle, onEdit, onDelete, onCheck, onReconnect, onLogs }) {
      const [expanded, setExpanded] = useState(false)
      const [events, setEvents] = useState(null)
      const info = STATUS[server.status] || STATUS.idle
      const summary = server.transport === 'stdio'
        ? [server.config.command, ...(server.config.args || [])].filter(Boolean).join(' ')
        : server.config.url

      async function toggleLogs() {
        const next = !expanded
        setExpanded(next)
        if (next) {
          try {
            const result = await onLogs(server.serverName)
            setEvents(result)
          } catch (err) {
            setEvents([{ at: new Date().toISOString(), level: 'error', message: err.message }])
          }
        }
      }

      return h('div', { className: `mcm-card mcm-card-${info.tone}` },
        h('div', { className: 'mcm-card-main' },
          h('div', { className: 'mcm-card-title' },
            h('span', { className: `mcm-dot mcm-dot-${info.tone}` }),
            h('span', { className: 'mcm-name' }, server.serverName),
            h('span', { className: 'mcm-tag' }, server.transport === 'stdio' ? 'stdio' : 'http'),
            server.external ? h('span', { className: 'mcm-tag mcm-tag-quiet', title: '来自其它 patch 行，管理器只做只读展示与启停' }, '外部') : null,
            !server.managed ? null : server.live ? null : h('span', { className: 'mcm-tag mcm-tag-warn' }, '待重启生效')
          ),
          h('div', { className: 'mcm-card-sub' },
            h('span', { className: 'mcm-mono mcm-ellipsis', title: summary }, summary || '（未填写命令 / URL）'),
            server.lastCheck?.checkedAt
              ? h('span', { className: 'mcm-sub-note' }, `检测 ${new Date(server.lastCheck.checkedAt).toLocaleTimeString()}${server.lastCheck.error ? ` · ${server.lastCheck.error}` : ''}`)
              : null
          )
        ),
        h('div', { className: 'mcm-card-side' },
          h(StatusPill, { status: server.status, lastCheck: server.lastCheck }),
          h(Toggle, {
            checked: server.enabled,
            disabled: busy,
            onChange: () => onToggle(server, !server.enabled),
            label: `${server.enabled ? '停用' : '启用'} ${server.serverName}`
          }),
          h('div', { className: 'mcm-actions' },
            h('button', {
              type: 'button',
              className: 'mcm-link',
              disabled: busy || !server.live || server.disabled,
              onClick: () => onCheck(server)
            }, '检测'),
            h('button', {
              type: 'button',
              className: 'mcm-link',
              disabled: busy || !server.live,
              onClick: () => onReconnect(server),
              title: '重启该 MCP 条目（会重新建立连接）'
            }, '重连'),
            h('button', { type: 'button', className: 'mcm-link', onClick: toggleLogs }, expanded ? '收起日志' : '日志'),
            server.managed
              ? h('button', { type: 'button', className: 'mcm-link', disabled: busy, onClick: () => onEdit(server) }, '编辑')
              : null,
            server.managed
              ? h('button', { type: 'button', className: 'mcm-link mcm-link-danger', disabled: busy, onClick: () => onDelete(server) }, '删除')
              : null
          )
        ),
        expanded
          ? h('div', { className: 'mcm-card-detail' },
              h('div', { className: 'mcm-kv' },
                h('div', {}, h('span', {}, '条目 ID'), h('code', {}, server.entryId || '—')),
                h('div', {}, h('span', {}, '运行阶段'), h('code', {}, server.phase)),
                h('div', {}, h('span', {}, '创建时间'), h('code', {}, server.createdAt ? server.createdAt.slice(0, 19).replace('T', ' ') : '—')),
                h('div', {}, h('span', {}, '工具调用超时'), h('code', {}, String(server.config.toolCallTimeoutMs ?? '默认')))
              ),
              h('div', { className: 'mcm-log-head' }, '管理器事件日志'),
              h('div', { className: 'mcm-logs' },
                events === null
                  ? h('div', { className: 'mcm-empty-line' }, '读取中…')
                  : events.length === 0
                    ? h('div', { className: 'mcm-empty-line' }, '暂无事件')
                    : events.slice().reverse().map((event) => h('div', { key: event.seq, className: `mcm-log mcm-log-${event.level}` },
                        h('span', { className: 'mcm-log-time' }, new Date(event.at).toLocaleTimeString()),
                        h('span', { className: 'mcm-log-kind' }, event.kind),
                        h('span', { className: 'mcm-log-msg' }, event.message)
                      ))
              ),
              h('div', { className: 'mcm-detail-note' },
                '说明：stdio 服务的子进程由官方 MCP 客户端托管，管理器无法截获其 stderr；这里记录连接状态变化、探测结果与配置操作。'
              )
            )
          : null
      )
    }

    function Panel() {
      const [data, setData] = useState(null)
      const [meta, setMeta] = useState(null)
      const [loading, setLoading] = useState(true)
      const [error, setError] = useState(null)
      const [query, setQuery] = useState('')
      const [filter, setFilter] = useState('all')
      const [editor, setEditor] = useState(null)
      const [importing, setImporting] = useState(false)
      const [busyName, setBusyName] = useState(null)
      const [toastState, setToastState] = useState(null)
      const [redact, setRedact] = useState(true)
      const timer = useRef(0)

      function toast(kind, text) {
        setToastState({ kind, text })
        window.clearTimeout(timer.current)
        timer.current = window.setTimeout(() => setToastState(null), 4200)
      }

      const refresh = useCallback(async (quiet) => {
        if (!quiet) setLoading(true)
        try {
          const result = await api('/servers')
          setData(result)
          setError(null)
        } catch (err) {
          setError(err.message)
        } finally {
          setLoading(false)
        }
      }, [])

      useEffect(() => {
        let alive = true
        api('/meta').then((result) => { if (alive) setMeta(result) }).catch(() => {})
        refresh()
        const id = window.setInterval(() => { refresh(true) }, 20000)
        return () => {
          alive = false
          window.clearInterval(id)
          window.clearTimeout(timer.current)
        }
      }, [refresh])

      async function act(name, fn, okText) {
        setBusyName(name)
        try {
          await fn()
          if (okText) toast('ok', okText)
          await refresh(true)
        } catch (err) {
          toast('bad', err.message)
        } finally {
          setBusyName(null)
        }
      }

      async function checkAll() {
        setBusyName('__all__')
        try {
          const result = await api('/servers/check', { method: 'POST', body: '{}' })
          await refresh(true)
          toast('ok', result.results?.length ? `已检测 ${result.results.length} 个 HTTP 服务` : '没有需要探测的 HTTP 服务')
        } catch (err) {
          toast('bad', err.message)
        } finally {
          setBusyName(null)
        }
      }

      async function exportJson() {
        try {
          const response = await fetch(`${API}/export?redact=${redact ? 1 : 0}`, { cache: 'no-store' })
          if (!response.ok) throw new Error(`导出失败（HTTP ${response.status}）`)
          const blob = await response.blob()
          const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 13)
          const url = URL.createObjectURL(blob)
          const anchor = document.createElement('a')
          anchor.href = url
          anchor.download = `dsh-mcp-servers-${stamp}.json`
          anchor.click()
          URL.revokeObjectURL(url)
          toast('ok', redact ? '已导出（敏感值已打码）' : '已导出（含完整密钥）')
        } catch (err) {
          toast('bad', err.message)
        }
      }

      const servers = data?.servers || []
      const filtered = useMemo(() => {
        const keyword = query.trim().toLowerCase()
        return servers.filter((server) => {
          if (keyword) {
            const haystack = `${server.serverName} ${server.config.command || ''} ${server.config.url || ''}`.toLowerCase()
            if (!haystack.includes(keyword)) return false
          }
          if (filter === 'online') return server.status === 'online'
          if (filter === 'paused') return server.disabled
          if (filter === 'external') return server.external
          if (filter === 'attention') return ['offline', 'missing', 'connecting'].includes(server.status)
          return true
        })
      }, [servers, query, filter])

      return h('div', { className: 'mcm' },
        h('div', { className: 'mcm-head' },
          h('div', { className: 'mcm-head-text' },
            h('h2', {}, 'MCP 服务'),
            h('p', {}, '集中添加、启停与诊断 MCP 服务。未接入的调用会在这里亮红灯；配置改动即时热生效，并写回 profile。')
          ),
          h('div', { className: 'mcm-head-actions' },
            h('button', { type: 'button', className: 'mcm-btn', onClick: () => refresh() }, '刷新'),
            h('button', { type: 'button', className: 'mcm-btn', onClick: checkAll, disabled: busyName === '__all__' }, busyName === '__all__' ? '检测中…' : '全部检测'),
            h('button', { type: 'button', className: 'mcm-btn', onClick: () => setImporting(true) }, '导入'),
            h('button', { type: 'button', className: 'mcm-btn', onClick: exportJson }, '导出'),
            h('button', { type: 'button', className: 'mcm-btn mcm-btn-primary', onClick: () => setEditor({ mode: 'new' }) }, '＋ 添加服务')
          )
        ),

        data
          ? h('div', { className: 'mcm-stats' },
              h('div', { className: 'mcm-stat' }, h('strong', {}, data.summary.total), h('span', {}, '服务总数')),
              h('div', { className: 'mcm-stat mcm-stat-ok' }, h('strong', {}, data.summary.online), h('span', {}, '在线')),
              h('div', { className: 'mcm-stat mcm-stat-bad' }, h('strong', {}, data.summary.offline), h('span', {}, '掉线 / 未加载')),
              h('div', { className: 'mcm-stat' }, h('strong', {}, data.summary.paused), h('span', {}, '已停用')),
              h('div', { className: 'mcm-stat mcm-stat-quiet' }, h('strong', {}, data.summary.external), h('span', {}, '外部条目'))
            )
          : null,

        meta
          ? h('div', { className: 'mcm-meta' },
              h('span', {}, h('b', {}, 'profile '), meta.profileDir),
              h('span', {}, h('b', {}, 'patch '), meta.patch.exists ? `${meta.patch.file}${meta.patch.hasManagedBlock ? '' : '（尚无托管块）'}` : `${meta.patch.file}（尚未创建）`),
              h('span', {}, h('b', {}, '轮询 '), `${Math.round(meta.checkIntervalMs / 1000)}s`),
              h('span', {}, h('b', {}, 'v'), meta.version)
            )
          : null,

        h('div', { className: 'mcm-toolbar' },
          h('div', { className: 'mcm-filters' },
            FILTERS.map((item) => h('button', {
              key: item.id,
              type: 'button',
              className: `mcm-filter${filter === item.id ? ' is-active' : ''}`,
              onClick: () => setFilter(item.id)
            }, item.label))
          ),
          h('div', { className: 'mcm-toolbar-right' },
            h('label', { className: 'mcm-check' },
              h('input', { type: 'checkbox', checked: redact, onChange: (event) => setRedact(event.target.checked) }),
              '导出时打码密钥'
            ),
            h('input', {
              className: 'mcm-search',
              value: query,
              placeholder: '搜索名称 / 命令 / URL',
              spellCheck: false,
              onChange: (event) => setQuery(event.target.value)
            })
          )
        ),

        error ? h('div', { className: 'mcm-alert mcm-alert-bad' }, error) : null,

        loading && !data
          ? h('div', { className: 'mcm-loading' }, '读取 MCP 服务…')
          : h('div', { className: 'mcm-list' },
              filtered.length === 0
                ? h('div', { className: 'mcm-empty' },
                    h('div', { className: 'mcm-empty-icon' }, '⌁'),
                    h('h3', {}, servers.length ? '没有匹配的服务' : '还没有 MCP 服务'),
                    h('p', {}, servers.length ? '换个关键词或筛选条件。' : '点右上角「添加服务」，或用「导入」迁移已有配置。'),
                    servers.length ? null : h('button', { type: 'button', className: 'mcm-btn mcm-btn-primary', onClick: () => setEditor({ mode: 'new' }) }, '添加第一个服务')
                  )
                : filtered.map((server) => h(ServerRow, {
                    key: `${server.external ? 'ext' : 'own'}:${server.serverName}`,
                    server,
                    busy: busyName === server.serverName,
                    onToggle: (item, enabled) => act(item.serverName, () => api('/servers/toggle', {
                      method: 'POST',
                      body: JSON.stringify({ serverName: item.serverName, enabled })
                    }), enabled ? `已启用 ${item.serverName}` : `已停用 ${item.serverName}`),
                    onEdit: (item) => setEditor({ mode: 'edit', server: item }),
                    onDelete: (item) => {
                      if (!window.confirm(`确定删除 ${item.serverName}？会同时移除它对应的 patch 行。`)) return
                      act(item.serverName, () => api('/servers/delete', {
                        method: 'POST',
                        body: JSON.stringify({ serverName: item.serverName })
                      }), `已删除 ${item.serverName}`)
                    },
                    onCheck: (item) => act(item.serverName, () => api('/servers/check', {
                      method: 'POST',
                      body: JSON.stringify({ serverName: item.serverName })
                    }).then((result) => {
                      const probe = result.results?.find((row) => row.serverName === item.serverName)
                      if (probe) toast(probe.reachable ? 'ok' : 'bad', probe.reachable ? `可达（HTTP ${probe.statusCode}，${probe.ms}ms）` : probe.error)
                      else toast('warn', '该服务当前不是 active 状态，未执行探测')
                    })),
                    onReconnect: (item) => act(item.serverName, () => api('/servers/reconnect', {
                      method: 'POST',
                      body: JSON.stringify({ serverName: item.serverName })
                    }), `已请求重启 ${item.serverName}`),
                    onLogs: async (serverName) => {
                      const result = await api(`/logs?serverName=${encodeURIComponent(serverName)}&limit=120`)
                      return result.events || []
                    }
                  }))
            ),

        editor
          ? h(Editor, {
              meta: meta || { blank: { stdio: {}, 'streamable-http': {} }, templates: [] },
              initial: editor.mode === 'edit' ? editor.server.config : (meta?.blank?.stdio || {}),
              initialEnabled: editor.mode === 'edit' ? editor.server.enabled : true,
              originalName: editor.mode === 'edit' ? editor.server.serverName : null,
              onClose: () => setEditor(null),
              onSaved: () => refresh(true),
              toast
            })
          : null,

        importing
          ? h(ImportDialog, {
              onClose: () => setImporting(false),
              onImported: () => refresh(true),
              toast
            })
          : null,

        toastState
          ? h('div', { className: `mcm-toast mcm-toast-${toastState.kind}` }, toastState.text)
          : null
      )
    }

    // ------------------------------------------------------------------ 样式
    const CSS = `
.mcm{--mcm-bg:var(--dsw-alias-bg-base,#fff);--mcm-layer:var(--dsw-alias-bg-layer-1,#f7f8fa);--mcm-line:var(--dsw-alias-border-secondary,#e6e8eb);--mcm-text:var(--dsw-alias-label-primary,#1f2328);--mcm-sub:var(--dsw-alias-label-secondary,#6b7280);--mcm-accent:var(--dsw-alias-brand-primary,#4f46e5);font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;color:var(--mcm-text);padding:20px 24px 40px;max-width:1080px;margin:0 auto;box-sizing:border-box}
.mcm *{box-sizing:border-box}
.mcm-head{display:flex;gap:24px;justify-content:space-between;align-items:flex-start;flex-wrap:wrap}
.mcm-head-text h2{margin:0 0 6px;font-size:20px;font-weight:650;letter-spacing:-.01em}
.mcm-head-text p{margin:0;color:var(--mcm-sub);font-size:13px;max-width:640px}
.mcm-head-actions{display:flex;gap:8px;flex-wrap:wrap}
.mcm-btn{appearance:none;border:1px solid var(--mcm-line);background:var(--mcm-layer);color:var(--mcm-text);border-radius:8px;padding:7px 13px;font-size:13px;cursor:pointer;transition:background .15s,border-color .15s,transform .1s}
.mcm-btn:hover{background:var(--dsw-alias-bg-layer-2,#eceef2)}
.mcm-btn:active{transform:translateY(1px)}
.mcm-btn:disabled{opacity:.55;cursor:not-allowed}
.mcm-btn-primary{background:var(--mcm-accent);border-color:var(--mcm-accent);color:#fff}
.mcm-btn-primary:hover{filter:brightness(1.05);background:var(--mcm-accent)}
.mcm-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(128px,1fr));gap:10px;margin:20px 0 12px}
.mcm-stat{background:var(--mcm-layer);border:1px solid var(--mcm-line);border-radius:10px;padding:10px 14px;display:flex;flex-direction:column;gap:2px}
.mcm-stat strong{font-size:20px;line-height:1.2;font-variant-numeric:tabular-nums}
.mcm-stat span{font-size:12px;color:var(--mcm-sub)}
.mcm-stat-ok strong{color:#15803d}.mcm-stat-bad strong{color:#b91c1c}.mcm-stat-quiet strong{color:var(--mcm-sub)}
.mcm-meta{display:flex;gap:16px;flex-wrap:wrap;font-size:12px;color:var(--mcm-sub);padding:4px 2px 16px}
.mcm-meta b{font-weight:600;color:var(--mcm-text);margin-right:4px}
.mcm-meta span{max-width:100%;overflow:hidden;text-overflow:ellipsis}
.mcm-toolbar{display:flex;justify-content:space-between;gap:12px;align-items:center;flex-wrap:wrap;margin-bottom:12px}
.mcm-filters{display:flex;gap:4px;background:var(--mcm-layer);padding:4px;border-radius:9px;border:1px solid var(--mcm-line)}
.mcm-filter{border:0;background:transparent;color:var(--mcm-sub);font-size:12px;padding:5px 10px;border-radius:6px;cursor:pointer}
.mcm-filter.is-active{background:var(--mcm-bg);color:var(--mcm-text);box-shadow:0 1px 2px rgba(0,0,0,.06)}
.mcm-toolbar-right{display:flex;gap:12px;align-items:center}
.mcm-check{display:flex;gap:6px;align-items:center;font-size:12px;color:var(--mcm-sub);cursor:pointer}
.mcm-check input{accent-color:var(--mcm-accent)}
.mcm-search{border:1px solid var(--mcm-line);background:var(--mcm-bg);color:var(--mcm-text);border-radius:8px;padding:7px 11px;font-size:13px;width:220px;outline:none}
.mcm-search:focus{border-color:var(--mcm-accent)}
.mcm-list{display:flex;flex-direction:column;gap:8px}
.mcm-card{border:1px solid var(--mcm-line);border-radius:11px;background:var(--mcm-bg);transition:border-color .15s}
.mcm-card:hover{border-color:var(--dsw-alias-border-primary,#d0d5dd)}
.mcm-card-main{display:flex;justify-content:space-between;gap:16px;padding:13px 16px;align-items:flex-start;flex-wrap:wrap}
.mcm-card-title{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.mcm-card-sub{display:flex;flex-direction:column;gap:2px;margin-top:5px}
.mcm-mono{font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.mcm-ellipsis{max-width:520px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:inline-block;color:var(--mcm-sub)}
.mcm-sub-note{font-size:11px;color:var(--mcm-sub)}
.mcm-card-side{display:flex;align-items:center;gap:10px;flex-wrap:wrap;justify-content:flex-end}
.mcm-actions{display:flex;gap:2px;flex-wrap:wrap}
.mcm-link{border:0;background:transparent;color:var(--mcm-sub);font-size:12px;padding:4px 7px;border-radius:6px;cursor:pointer}
.mcm-link:hover{color:var(--mcm-text);background:var(--mcm-layer)}
.mcm-link:disabled{opacity:.4;cursor:not-allowed}
.mcm-link-danger:hover{color:#b91c1c}
.mcm-name{font-weight:600;font-size:14px}
.mcm-tag{font-size:10px;text-transform:uppercase;letter-spacing:.04em;padding:2px 6px;border-radius:5px;background:var(--mcm-layer);color:var(--mcm-sub);border:1px solid var(--mcm-line)}
.mcm-tag-warn{background:#fef3c7;border-color:#fde68a;color:#92400e}
.mcm-tag-quiet{opacity:.75}
.mcm-dot{width:8px;height:8px;border-radius:50%;display:inline-block;background:#9ca3af}
.mcm-dot-ok{background:#16a34a}.mcm-dot-bad{background:#dc2626}.mcm-dot-warn{background:#f59e0b}.mcm-dot-info{background:#2563eb}.mcm-dot-muted{background:#9ca3af}
.mcm-pill{display:inline-flex;align-items:center;gap:6px;font-size:11px;padding:4px 9px;border-radius:999px;background:var(--mcm-layer);border:1px solid var(--mcm-line);white-space:nowrap}
.mcm-pill-ok{color:#15803d;background:#f0fdf4;border-color:#bbf7d0}
.mcm-pill-bad{color:#b91c1c;background:#fef2f2;border-color:#fecaca}
.mcm-pill-warn{color:#92400e;background:#fffbeb;border-color:#fde68a}
.mcm-pill-info{color:#1d4ed8;background:#eff6ff;border-color:#bfdbfe}
.mcm-pill-muted{color:var(--mcm-sub)}
.mcm-pill .mcm-dot{width:6px;height:6px}
.mcm-pill-sub{opacity:.7;font-variant-numeric:tabular-nums}
.mcm-switch{width:38px;height:21px;border-radius:999px;border:1px solid var(--mcm-line);background:var(--mcm-layer);position:relative;cursor:pointer;padding:0;transition:background .18s,border-color .18s;flex:0 0 auto}
.mcm-switch.is-on{background:var(--mcm-accent);border-color:var(--mcm-accent)}
.mcm-switch:disabled{opacity:.5;cursor:not-allowed}
.mcm-switch-knob{position:absolute;top:2px;left:2px;width:15px;height:15px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.25);transition:left .18s}
.mcm-switch.is-on .mcm-switch-knob{left:19px}
.mcm-card-detail{border-top:1px dashed var(--mcm-line);padding:14px 16px 16px;display:flex;flex-direction:column;gap:10px}
.mcm-kv{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:6px 18px;font-size:12px}
.mcm-kv>div{display:flex;justify-content:space-between;gap:12px;border-bottom:1px dotted var(--mcm-line);padding-bottom:4px}
.mcm-kv span{color:var(--mcm-sub)}
.mcm-kv code{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:60%}
.mcm-log-head{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:var(--mcm-sub);margin-top:4px}
.mcm-logs{max-height:220px;overflow:auto;border:1px solid var(--mcm-line);border-radius:8px;background:var(--mcm-layer);padding:6px 8px}
.mcm-log{display:flex;gap:8px;font:11px/1.7 ui-monospace,Menlo,Consolas,monospace;border-bottom:1px solid rgba(0,0,0,.04);padding:2px 0}
.mcm-log:last-child{border-bottom:0}
.mcm-log-time{color:var(--mcm-sub);flex:0 0 auto}
.mcm-log-kind{color:var(--mcm-sub);flex:0 0 auto;min-width:52px;opacity:.8}
.mcm-log-msg{word-break:break-word}
.mcm-log-warn{color:#92400e}.mcm-log-error{color:#b91c1c}
.mcm-empty-line{font-size:12px;color:var(--mcm-sub);padding:8px}
.mcm-detail-note{font-size:11px;color:var(--mcm-sub);line-height:1.6}
.mcm-empty{text-align:center;padding:48px 20px;border:1px dashed var(--mcm-line);border-radius:12px;background:var(--mcm-layer)}
.mcm-empty-icon{font-size:32px;color:var(--mcm-sub);opacity:.7;margin-bottom:6px}
.mcm-empty h3{margin:0 0 6px;font-size:15px}
.mcm-empty p{margin:0 auto 14px;color:var(--mcm-sub);font-size:13px;max-width:420px}
.mcm-loading{padding:40px;text-align:center;color:var(--mcm-sub);font-size:13px}
.mcm-alert{border-radius:9px;padding:10px 14px;font-size:12px;line-height:1.6;margin-top:10px}
.mcm-alert-bad{background:#fef2f2;border:1px solid #fecaca;color:#991b1b}
.mcm-alert-ok{background:#f0fdf4;border:1px solid #bbf7d0;color:#166534}
.mcm-modal-mask{position:fixed;inset:0;background:rgba(15,17,22,.45);display:flex;align-items:center;justify-content:center;z-index:2147481000;padding:20px}
.mcm-modal{width:min(720px,100%);max-height:88vh;overflow:auto;background:var(--mcm-bg);border-radius:14px;box-shadow:0 24px 64px rgba(0,0,0,.28);border:1px solid var(--mcm-line)}
.mcm-modal-head{display:flex;justify-content:space-between;gap:16px;padding:18px 22px 10px}
.mcm-modal-head h3{margin:0 0 4px;font-size:16px}
.mcm-modal-head p{margin:0;font-size:12px;color:var(--mcm-sub)}
.mcm-icon-btn{border:0;background:transparent;font-size:16px;color:var(--mcm-sub);cursor:pointer;padding:4px 8px;border-radius:6px}
.mcm-icon-btn:hover{background:var(--mcm-layer);color:var(--mcm-text)}
.mcm-modal-body{padding:8px 22px 18px}
.mcm-modal-foot{border-top:1px solid var(--mcm-line);padding:12px 22px;display:flex;justify-content:flex-end}
.mcm-modal-actions{display:flex;gap:8px}
.mcm-form{display:flex;flex-direction:column;gap:14px}
.mcm-form-row{display:grid;grid-template-columns:1fr 1fr;gap:14px}
.mcm-field{display:flex;flex-direction:column;gap:5px;min-width:0}
.mcm-field-wide{grid-column:1/-1}
.mcm-field-label{font-size:12px;font-weight:600;display:flex;gap:8px;align-items:baseline;flex-wrap:wrap}
.mcm-field-hint{font-weight:400;color:var(--mcm-sub);font-size:11px}
.mcm-input{border:1px solid var(--mcm-line);border-radius:8px;background:var(--mcm-bg);color:var(--mcm-text);padding:8px 10px;font-size:13px;outline:none;width:100%;resize:vertical}
.mcm-input:focus{border-color:var(--mcm-accent);box-shadow:0 0 0 3px rgba(79,70,229,.12)}
.mcm-input::placeholder{color:#9ca3af}
.mcm-seg{display:flex;gap:4px;background:var(--mcm-layer);border:1px solid var(--mcm-line);padding:3px;border-radius:9px}
.mcm-seg-item{flex:1;border:0;background:transparent;color:var(--mcm-sub);font-size:12px;padding:6px 10px;border-radius:6px;cursor:pointer}
.mcm-seg-item.is-active{background:var(--mcm-bg);color:var(--mcm-text);box-shadow:0 1px 2px rgba(0,0,0,.06)}
.mcm-inline{display:flex;gap:10px;align-items:center;height:36px}
.mcm-inline-note{font-size:12px;color:var(--mcm-sub)}
.mcm-templates{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.mcm-templates-label{font-size:12px;color:var(--mcm-sub)}
.mcm-chip{border:1px solid var(--mcm-line);background:var(--mcm-layer);border-radius:999px;padding:4px 10px;font-size:12px;color:var(--mcm-text);cursor:pointer}
.mcm-chip:hover{border-color:var(--mcm-accent);color:var(--mcm-accent)}
.mcm-file{font-size:12px}
.mcm-toast{position:fixed;left:50%;bottom:32px;transform:translateX(-50%);background:#111827;color:#f9fafb;font-size:12px;padding:9px 16px;border-radius:999px;box-shadow:0 10px 30px rgba(0,0,0,.3);z-index:2147482000;max-width:90vw;animation:mcm-in .2s ease}
.mcm-toast-bad{background:#991b1b}
.mcm-toast-warn{background:#92400e}
@keyframes mcm-in{from{opacity:0;transform:translate(-50%,6px)}to{opacity:1;transform:translate(-50%,0)}}
@media (max-width:720px){.mcm-form-row{grid-template-columns:1fr}.mcm-card-main{flex-direction:column}.mcm-card-side{width:100%;justify-content:space-between}.mcm-search{width:100%}}
`

    function ensureStyle() {
      if (document.getElementById(STYLE_ID)) return
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = CSS
      document.head.appendChild(style)
    }

    const inject = ['slots']

    function apply(ctx) {
      ensureStyle()
      ctx.slots.inject('settings.section', () => {
        return ctx.slots.register(
          { name: 'settings.section', id: 'mcp-manager', order: 34, label: 'MCP 服务' },
          () => h(Panel, {})
        )
      })
    }

    const module = { exports: {} }
    module.exports.apply = apply
    module.exports.inject = inject
    return module.exports
  }
})
