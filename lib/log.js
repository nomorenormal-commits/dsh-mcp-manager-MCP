/* dsh-mcp-manager — 内存事件日志（环形缓冲） */

const LEVELS = ['info', 'warn', 'error']

export function createEventLog(limit = 600) {
  const events = []
  let seq = 0

  function push(event) {
    const entry = {
      seq: (seq += 1),
      at: new Date().toISOString(),
      level: LEVELS.includes(event.level) ? event.level : 'info',
      serverName: event.serverName || null,
      kind: event.kind || 'event',
      message: String(event.message || '')
    }
    events.push(entry)
    if (events.length > limit) events.splice(0, events.length - limit)
    return entry
  }

  function list(options = {}) {
    const serverName = options.serverName || null
    const since = options.since || null
    let result = events
    if (serverName) {
      result = result.filter((event) => event.serverName === serverName || event.serverName === null)
    }
    if (since) {
      result = result.filter((event) => event.at > since)
    }
    const tail = Math.min(Math.max(Number(options.limit) || 200, 1), limit)
    return result.slice(-tail)
  }

  return { push, list, clear: () => events.splice(0, events.length), size: () => events.length }
}
