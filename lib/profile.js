/* ============================================================================
 * dsh-mcp-manager — 磁盘层
 * ----------------------------------------------------------------------------
 * 1) 找到当前 profile 目录（~/.dsh/profiles/<name>）
 * 2) 读写管理器自己的状态文件 <profile>/.dsh-mcp-manager/state.json
 * 3) 把状态渲染进 <profile>/cordis.patch.yml 的托管区块
 *
 * 状态文件是写入模型，patch 文件是 DSH 真正读取的配置；两者每次变更同步写。
 * ========================================================================== */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { applyManagedBlock, renderManagedBlock, hasManagedBlock, MARK_START } from './patch.js'

export const PLUGIN_NAME = 'dsh-mcp-manager'
export const STATE_DIR = '.dsh-mcp-manager'
export const STATE_FILE = 'state.json'
export const PATCH_FILE = 'cordis.patch.yml'

export function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

export function profilesRoot() {
  return path.join(dshHome(), 'profiles')
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function isDir(dir) {
  try {
    return fs.statSync(dir).isDirectory()
  } catch {
    return false
  }
}

function profileHasPackage(dir) {
  const pkg = readJson(path.join(dir, 'package.json'))
  return !!pkg && typeof pkg === 'object'
}

/** 列出所有 profile 目录。 */
export function listProfiles() {
  let entries = []
  try {
    entries = fs.readdirSync(profilesRoot(), { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(profilesRoot(), entry.name))
    .filter((dir) => isDir(dir) && profileHasPackage(dir))
}

function dirFromBaseUrl(baseUrl) {
  if (!baseUrl || typeof baseUrl !== 'string') return null
  try {
    const url = new URL(baseUrl)
    if (url.protocol !== 'file:') return null
    return path.resolve(fileURLToPath(url))
  } catch {
    try {
      if (path.isAbsolute(baseUrl)) return path.resolve(baseUrl)
    } catch {
      /* ignore */
    }
    return null
  }
}

/**
 * 解析当前 profile 目录。按可靠性排序：
 *   1. 显式环境变量
 *   2. 上下文 baseUrl（DSH 以 profile 目录为根）
 *   3. package.json 依赖里装着本插件（link 安装最可靠的判据）
 *   4. DSH_PROFILE 环境变量
 *   5. 只有一个 profile 时直接用它
 */
export function resolveProfileDir(ctx, packageName = PLUGIN_NAME) {
  const explicit = process.env.DSH_MCP_MANAGER_PROFILE_DIR
  if (explicit && isDir(explicit)) return { dir: explicit, source: 'env:DSH_MCP_MANAGER_PROFILE_DIR' }

  const fromContext = dirFromBaseUrl(ctx?.baseUrl) || dirFromBaseUrl(ctx?.get?.('loader')?.config?.baseUrl)
  if (fromContext && isDir(fromContext) && profileHasPackage(fromContext)) {
    return { dir: fromContext, source: 'ctx.baseUrl' }
  }

  const profiles = listProfiles()

  const withDependency = profiles.filter((dir) => {
    const pkg = readJson(path.join(dir, 'package.json'))
    const deps = { ...(pkg?.dependencies || {}), ...(pkg?.devDependencies || {}) }
    return Object.prototype.hasOwnProperty.call(deps, packageName)
  })
  if (withDependency.length) {
    const named = process.env.DSH_PROFILE
    const match = named ? withDependency.find((dir) => path.basename(dir) === named) : null
    return { dir: match || withDependency[0], source: 'profile dependencies' }
  }

  const named = process.env.DSH_PROFILE
  if (named) {
    const dir = path.join(profilesRoot(), named)
    if (isDir(dir)) return { dir, source: 'env:DSH_PROFILE' }
  }

  const cwdMatch = profiles.find((dir) => {
    const name = path.basename(dir)
    return process.cwd().split(/[\\/]/).includes(name)
  })
  if (cwdMatch) return { dir: cwdMatch, source: 'process.cwd' }

  if (profiles.length === 1) return { dir: profiles[0], source: 'only profile' }

  return { dir: null, source: 'not found' }
}

export function patchFilePath(profileDir) {
  return path.join(profileDir, PATCH_FILE)
}

export function stateFilePath(profileDir) {
  return path.join(profileDir, STATE_DIR, STATE_FILE)
}

function normalizeState(raw) {
  const state = { version: 1, servers: [], overrides: [], updatedAt: null }
  if (!raw || typeof raw !== 'object') return state
  if (Array.isArray(raw.servers)) {
    for (const item of raw.servers) {
      if (!item || typeof item !== 'object') continue
      if (typeof item.serverName !== 'string' || !item.serverName) continue
      if (!item.config || typeof item.config !== 'object') continue
      state.servers.push({
        serverName: item.serverName,
        config: item.config,
        disabled: item.disabled === true,
        createdAt: typeof item.createdAt === 'string' ? item.createdAt : null
      })
    }
  }
  if (Array.isArray(raw.overrides)) {
    for (const item of raw.overrides) {
      if (!item || typeof item !== 'object') continue
      if (typeof item.entryId !== 'string' || !item.entryId) continue
      state.overrides.push({ entryId: item.entryId, serverName: typeof item.serverName === 'string' ? item.serverName : null, disabled: true })
    }
  }
  state.updatedAt = typeof raw.updatedAt === 'string' ? raw.updatedAt : null
  return state
}

export function readState(profileDir) {
  if (!profileDir) return normalizeState(null)
  return normalizeState(readJson(stateFilePath(profileDir)))
}

export function writeState(profileDir, state) {
  const file = stateFilePath(profileDir)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const next = { ...state, version: 1, updatedAt: new Date().toISOString() }
  const tmp = file + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', 'utf8')
  fs.renameSync(tmp, file)
  return next
}

export function readPatchText(profileDir) {
  const file = patchFilePath(profileDir)
  try {
    return fs.readFileSync(file, 'utf8')
  } catch (err) {
    if (err && err.code === 'ENOENT') return ''
    throw err
  }
}

/**
 * 把托管区块写进 patch 文件：先备份旧文件，再原子替换。
 * @returns {{ file: string, backup: string, created: boolean }}
 */
export function writePatchBlock(profileDir, state) {
  const file = patchFilePath(profileDir)
  const previous = readPatchText(profileDir)
  const block = renderManagedBlock(state.servers, state.overrides)
  const next = applyManagedBlock(previous, block)
  const backup = file + '.dsh-mcp-manager.bak'
  if (previous) fs.writeFileSync(backup, previous, 'utf8')
  const tmp = file + '.tmp'
  fs.writeFileSync(tmp, next, 'utf8')
  fs.renameSync(tmp, file)
  return { file, backup, created: !previous, hadBlock: hasManagedBlock(previous) }
}

export function patchStatus(profileDir) {
  const file = patchFilePath(profileDir)
  let exists = false
  let size = 0
  try {
    const stat = fs.statSync(file)
    exists = stat.isFile()
    size = stat.size
  } catch {
    /* missing */
  }
  let hasBlock = false
  if (exists) {
    try {
      hasBlock = readPatchText(profileDir).includes(MARK_START)
    } catch {
      /* ignore */
    }
  }
  return { file, exists, size, hasManagedBlock: hasBlock }
}

/** 读插件自身版本，设置页展示用。 */
export function pluginVersion(packageRoot) {
  const pkg = readJson(path.join(packageRoot, 'package.json'))
  return typeof pkg?.version === 'string' ? pkg.version : '0.0.0'
}
