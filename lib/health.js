/* dsh-mcp-manager — 轻量健康检查 */

const DEFAULT_TIMEOUT_MS = 4_000

/**
 * 对 HTTP / Streamable HTTP MCP 服务做一次可达性探测。
 * 任何 HTTP 响应（包括 401/405）都说明端口活着；只有连接失败 / 超时才算掉线。
 * 不读取响应体：MCP 端点可能返回 SSE 长连接，读完会挂住。
 */
export async function probeHttp(server, options = {}) {
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : DEFAULT_TIMEOUT_MS
  const started = Date.now()
  try {
    const response = await fetch(server.url, {
      method: 'GET',
      redirect: 'manual',
      headers: {
        accept: 'application/json, text/event-stream',
        ...(server.headers || {})
      },
      signal: AbortSignal.timeout(timeoutMs)
    })
    try {
      await response.body?.cancel()
    } catch {
      /* ignore */
    }
    return {
      reachable: true,
      statusCode: response.status,
      ms: Date.now() - started,
      checkedAt: new Date().toISOString()
    }
  } catch (error) {
    const message = error?.name === 'TimeoutError' || error?.name === 'AbortError'
      ? `超时（>${timeoutMs}ms）`
      : String((error && error.message) || error)
    return {
      reachable: false,
      statusCode: null,
      ms: Date.now() - started,
      checkedAt: new Date().toISOString(),
      error: message
    }
  }
}

/** stdio 服务无法从进程外部安全探测，只能依赖插件 fiber 的运行态。 */
export function stdioCheck() {
  return {
    reachable: true,
    skipped: true,
    reason: 'stdio 由官方 MCP 客户端托管，管理面板通过运行态判断（断线重连由客户端负责）',
    checkedAt: new Date().toISOString()
  }
}
