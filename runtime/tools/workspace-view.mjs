/**
 * workspace-view — 配置同步面板「工作区显示状态」卡片的宿主侧工具（0.3.76）
 *
 * 职责：在本插件内自包含地读写 DSH 的两套原生隐藏/归档状态文件，不依赖
 * session-manager 的 web API（那个 API 需要 DSH connection owner 凭证，插件
 * 自己的路由拿不到）。
 *
 * 两个权威落点：
 *   1) <DshHome>\storages\workspace.json  -> global.archivedSessionIds[]   会话级「隐藏」
 *   2) <DshHome>\dsh-session-manager\workspace-archives.v1.json
 *        -> workspaces[wsId] = {workspaceId, archived:true, archivedAt, sessionIds, pending}
 *                                                                        工作区级「归档」
 *
 * 三态（工作区）：
 *   normal       显示：无 archive 记录 + 该工作区会话都不在 archivedSessionIds
 *   hide-sessions 隐藏会话：无 archive 记录 + 该工作区所有会话进 archivedSessionIds（工作区仍留列表）
 *   archive      归档工作区：写 archive 记录 archived:true + 所有会话进 archivedSessionIds（工作区从列表消失）
 *   partial      部分会话被单独隐藏（只读状态，前端显示但切换时按用户所选三态归一化）
 *
 * 会话级独立操作：隐藏/显示单个会话只增删 global.archivedSessionIds 里的一个 id，
 * 不碰工作区 archive 记录 —— 与工作区三态互不影响。
 *
 * 会话名称：从会话日志开头的 `session/title` 事件读取（fallback / provider 两种，
 * 取最后一个、即 provider 生成的那个）；没有 title 事件时回退到第一条 user/message
 * 文本。只读每个日志的前若干 zstd 帧，不解压整份历史，按 mtime 缓存。
 *
 * 格式保持：两个状态文件原本都是 UTF-8 无 BOM、LF、2 空格缩进、末尾一个 \n。
 * 写回统一用 JSON.stringify(obj, null, 2) + '\n'，实测与原文件逐字节一致。
 */
import * as fs from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const WS_REL = ['storages', 'workspace.json']
const ARCH_REL = ['dsh-session-manager', 'workspace-archives.v1.json']
const SESSIONS_REL = ['sessions']

const ZSTD_MAGIC = 0xfd2fb528
const TITLE_EVENTS = ['session.v4.jsonl.zstd', 'session.v3.jsonl.zstd', 'session.v2.jsonl.zstd', 'session.jsonl.zstd', 'session.jsonl']
const TITLE_FRAME_LIMIT = 40          // 只读开头 40 帧：title 事件在前 10 帧内
const TITLE_CACHE = new Map()         // path+mtime -> {title, byId}

function readJson(path) {
  try {
    const s = fs.readFileSync(path, 'utf8').replace(/^\uFEFF/, '')
    return JSON.parse(s)
  } catch {
    return null
  }
}

/** 覆盖写：先写临时文件再 copyFile 覆盖（Windows 上 copyFile 覆盖是原子的），失败回退直写。 */
function writeJsonAtomic(path, obj) {
  const text = JSON.stringify(obj, null, 2) + '\n'
  const tmp = `${path}.wv-${process.pid}-${Date.now()}.tmp`
  try {
    fs.writeFileSync(tmp, text, 'utf8')
    try {
      fs.copyFileSync(tmp, path)
    } finally {
      try { fs.unlinkSync(tmp) } catch { }
    }
  } catch (error) {
    try { fs.unlinkSync(tmp) } catch { }
    fs.writeFileSync(path, text, 'utf8')
  }
}

function archivePath(dshHome) { return join(dshHome, ...ARCH_REL) }
function workspacePath(dshHome) { return join(dshHome, ...WS_REL) }

/** 只扫前 maxFrames 个 zstd 帧的字节边界，返回 Buffer 片段；不再往后读。 */
function scanFrameBuffers(buf, maxFrames) {
  const out = []
  let offset = 0
  while (offset < buf.length && out.length < maxFrames) {
    const start = offset
    if (buf.length - offset < 4 || buf.readUInt32LE(offset) !== ZSTD_MAGIC) break
    offset += 4
    if (offset === buf.length) break
    if (buf.length - offset < 1) break
    const d = buf.readUInt8(offset++)
    if ((d & 0x18) !== 0) break
    const csf = d >>> 6
    const single = (d & 0x20) !== 0
    const checksum = (d & 0x04) !== 0
    const df = d & 0x03
    const dictBytes = df === 3 ? 4 : df
    const sizeBytes = csf === 0 ? (single ? 1 : 0) : (1 << csf)
    offset += (single ? 0 : 1) + dictBytes + sizeBytes
    let ok = true
    for (;;) {
      if (buf.length - offset < 3) { ok = false; break }
      const bh = buf.readUIntLE(offset, 3); offset += 3
      const last = (bh & 1) !== 0
      const bt = (bh >>> 1) & 0x03
      const bs = bh >>> 3
      if (bt === 0x03) { ok = false; break }
      offset += bt === 0x01 ? 1 : bs
      if (last) break
    }
    if (!ok) break
    if (checksum) offset += 4
    out.push(buf.subarray(start, offset))
  }
  return out
}

function cleanTitle(text) {
  if (typeof text !== 'string') return ''
  let s = text.replace(/\s+/g, ' ').trim()
  // 系统提醒 / 工具输出这类前缀不作为标题
  if (/^<system-reminder>/.test(s)) return ''
  if (/^\[MNEMON\]/.test(s)) return ''
  if (s.length > 48) s = s.slice(0, 48) + '…'
  return s
}

/** 从单个会话日志文件提取标题。返回 {title} 并写入缓存。 */
function titleFromFile(file) {
  let mtime = 0
  try { mtime = fs.statSync(file).mtimeMs } catch { return { title: '' } }
  const key = `${file}:${mtime}`
  const hit = TITLE_CACHE.get(key)
  if (hit) return hit
  let result = { title: '' }
  try {
    const buf = fs.readFileSync(file)
    let text = ''
    if (file.endsWith('.zstd')) {
      for (const fr of scanFrameBuffers(buf, TITLE_FRAME_LIMIT)) {
        try { text += zstdDecompressSync(fr).toString('utf8') } catch { /* torn frame */ }
      }
    } else {
      text = buf.toString('utf8', 0, 256 * 1024)
    }
    let lastTitle = ''
    let firstUserText = ''
    for (const line of text.split('\n')) {
      if (!line) continue
      let ev
      try { ev = JSON.parse(line) } catch { continue }
      if (ev.type === 'session/title' && ev.data && typeof ev.data.title === 'string') {
        lastTitle = ev.data.title
      }
      if (!firstUserText && ev.type === 'user/message' && ev.data && Array.isArray(ev.data.content)) {
        for (const part of ev.data.content) {
          if (part && part.type === 'text' && typeof part.text === 'string') {
            firstUserText = part.text
            break
          }
        }
      }
      if (lastTitle) break
    }
    result = { title: cleanTitle(lastTitle) || cleanTitle(firstUserText) }
  } catch {
    result = { title: '' }
  }
  if (TITLE_CACHE.size > 400) TITLE_CACHE.clear()
  TITLE_CACHE.set(key, result)
  return result
}

/** 建一次 sid -> 日志文件路径 的索引（目录遍历很快，不读文件内容）。 */
function buildSessionLogIndex(dshHome) {
  const byId = new Map()
  const root = join(dshHome, ...SESSIONS_REL)
  let projects
  try { projects = fs.readdirSync(root, { withFileTypes: true }) } catch { return byId }
  for (const proj of projects) {
    if (!proj.isDirectory()) continue
    const pd = join(root, proj.name)
    let dirs
    try { dirs = fs.readdirSync(pd, { withFileTypes: true }) } catch { continue }
    for (const d of dirs) {
      if (!d.isDirectory()) continue
      const dd = join(pd, d.name)
      for (const name of TITLE_EVENTS) {
        const f = join(dd, name)
        if (fs.existsSync(f)) { byId.set(d.name, f); break }
      }
    }
  }
  return byId
}

/** 读视图：列出所有工作区 + 每个工作区下会话的隐藏状态 + 三态归一化 + 会话名称。 */
export function readView(dshHome) {
  const ws = readJson(workspacePath(dshHome))
  const arch = readJson(archivePath(dshHome))
  if (!ws || !ws.tables || !ws.tables.workspaces) {
    return { ok: true, available: false, workspaces: [] }
  }
  const globalArchived = new Set(Array.isArray(ws.global?.archivedSessionIds) ? ws.global.archivedSessionIds : [])
  const archMap = (arch && arch.workspaces && typeof arch.workspaces === 'object') ? arch.workspaces : {}
  const logIndex = buildSessionLogIndex(dshHome)
  const workspaces = []
  for (const [wsId, rec] of Object.entries(ws.tables.workspaces)) {
    if (!rec || typeof rec !== 'object') continue
    const sessionIds = Array.isArray(rec.sessionIds) ? rec.sessionIds.slice() : []
    const archRec = archMap[wsId]
    const workspaceArchived = Boolean(archRec && archRec.archived === true)
    const sessions = sessionIds.map((sid) => {
      const log = logIndex.get(sid)
      const title = log ? titleFromFile(log).title : ''
      return { id: sid, title, hidden: globalArchived.has(sid) }
    })
    const hiddenCount = sessions.filter((s) => s.hidden).length
    let state = 'normal'
    if (workspaceArchived) state = 'archive'
    else if (hiddenCount > 0 && hiddenCount === sessions.length && sessions.length > 0) state = 'hide-sessions'
    else if (hiddenCount > 0) state = 'partial'
    workspaces.push({
      workspaceId: wsId,
      title: rec.title || wsId,
      path: typeof rec.path === 'string' ? rec.path : '',
      sessionCount: sessions.length,
      hiddenCount,
      state,
      archived: workspaceArchived,
      archivedAt: workspaceArchived && typeof archRec.archivedAt === 'number' ? archRec.archivedAt : 0,
      sessions,
    })
  }
  return { ok: true, available: true, workspaces }
}

/** 切换一个工作区的三态。state ∈ normal | hide-sessions | archive。 */
export function setWorkspaceState(dshHome, workspaceId, state) {
  const wsPath = workspacePath(dshHome)
  const archPath = archivePath(dshHome)
  const ws = readJson(wsPath)
  if (!ws || !ws.tables || !ws.tables.workspaces || !ws.tables.workspaces[workspaceId]) {
    throw new Error(`工作区不存在：${workspaceId}`)
  }
  if (!['normal', 'hide-sessions', 'archive'].includes(state)) {
    throw new Error(`不支持的工作区状态：${state}`)
  }
  const rec = ws.tables.workspaces[workspaceId]
  const sids = Array.isArray(rec.sessionIds) ? rec.sessionIds.slice() : []
  const arch = readJson(archPath) || { version: 1, workspaces: {} }
  if (!arch.workspaces || typeof arch.workspaces !== 'object') arch.workspaces = {}
  const ga = new Set(Array.isArray(ws.global?.archivedSessionIds) ? ws.global.archivedSessionIds : [])
  if (!ws.global || typeof ws.global !== 'object') ws.global = {}

  if (state === 'archive') {
    arch.workspaces[workspaceId] = {
      workspaceId,
      archived: true,
      archivedAt: Date.now(),
      sessionIds: sids,
      pending: [],
    }
    for (const sid of sids) ga.add(sid)
  } else {
    // normal / hide-sessions 都不该留工作区归档记录
    delete arch.workspaces[workspaceId]
    if (state === 'hide-sessions') {
      for (const sid of sids) ga.add(sid)
    } else {
      for (const sid of sids) ga.delete(sid)
    }
  }

  ws.global.archivedSessionIds = Array.from(ga)
  writeJsonAtomic(wsPath, ws)
  writeJsonAtomic(archPath, arch)
  return readView(dshHome)
}

/** 单独隐藏/显示一个会话：只增删 global.archivedSessionIds，不碰工作区归档记录。 */
export function setSessionState(dshHome, sessionId, hidden) {
  const wsPath = workspacePath(dshHome)
  const ws = readJson(wsPath)
  if (!ws || !ws.global || typeof ws.global !== 'object') {
    throw new Error('workspace.json 缺少 global 段')
  }
  const ga = new Set(Array.isArray(ws.global?.archivedSessionIds) ? ws.global.archivedSessionIds : [])
  if (hidden) ga.add(sessionId)
  else ga.delete(sessionId)
  ws.global.archivedSessionIds = Array.from(ga)
  writeJsonAtomic(wsPath, ws)
  return readView(dshHome)
}
