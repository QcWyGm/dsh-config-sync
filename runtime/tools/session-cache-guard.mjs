// 会话投影缓存守卫（session_projcache 陈旧记录自动清理）
//
// 解决的问题
//   DSH 的「新建会话」不是每次真建，UI 会先在工作区里找一条**空白会话**复用：
//     client-ui-workspace/createInWorkspace() → sessions.ids.find(summary.blank && ...)
//     → createNamed({ sessionId: blank })
//   而 summary.blank 来自投影缓存 session_projcache\sessions\<id>.json 里的
//   record.rows.sessionListMetadata.val.blank。
//
//   缓存是「写一半就停」的产物：某次会话创建时缓存写出了 blank:true + seq:-1，
//   之后日志继续追加（有了 turn/start、user/message），缓存却没被推进。
//   于是列表仍把这条会话当"空白"，UI 挑它复用 → 宿主抛
//     session/agent-busy: session "<id>" is owned by subagent routing
//   （子会话 origin=subagent 不允许被主会话直接复用），新建会话直接失败。
//
// 处理办法
//   删掉那条 cache json，DSH 下次读列表时会按完整日志重建缓存，blank 也就跟着变 false。
//   这是纯文件操作，不碰任何上游代码、不改日志、不改工作区登记。
//
// 判定条件（四重，全中才算陈旧，宁可漏判不可误删）
//   1) 缓存能解析，且 record.rows.sessionListMetadata.val.blank === true
//   2) 能找到对应日志 sessions\<workspace>\<id>\session.v*.jsonl.zstd
//   3) 日志里确实有 turn/start 或 user/message 事件（真空会话不会有）
//   4) 日志最后事件 seq > 缓存记录的最大 seq（缓存确实落后于日志）
//
// 导出：
//   scanSessionCaches(dshHome, opts)   只读扫描，返回候选与判定依据
//   clearSessionCaches(dshHome, ids)   删除指定缓存（先备份）
//   runGuard(dshHome, opts)            扫描 + 按需清理，供定时器与路由共用

import {
  existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { splitFrames } from './session-log-lib.mjs'

/** 缓存相对 .dsh 的固定位置 */
const CACHE_REL = ['storages', 'session_projcache', 'sessions']
/** 日志相对 .dsh 的固定位置 */
const LOG_ROOT_REL = ['sessions']
/** 判定日志正文时最多读这么多字节（够覆盖首个 turn/start，减少大日志的解析成本） */
const HEAD_BYTES = 256 * 1024
/** 真空会话日志一般只有 header 帧，超过这个大小才值得去解析 */
const MIN_LOG_BYTES = 64

function safeStat(path) {
  try {
    return statSync(path)
  } catch {
    return null
  }
}

function isDir(path) {
  const st = safeStat(path)
  return st !== null && st.isDirectory()
}

/** 缓存目录 */
export function cacheDirOf(dshHome) {
  return join(dshHome, ...CACHE_REL)
}

/** 日志根目录 */
export function logRootOf(dshHome) {
  return join(dshHome, ...LOG_ROOT_REL)
}

/**
 * 建立 sessionId → 日志路径 的索引。
 * 一次遍历 sessions\<workspace>\<sessionId>\session.v*.jsonl.zstd（两层，不做深递归）。
 */
export function indexSessionLogs(dshHome) {
  const root = logRootOf(dshHome)
  const map = new Map()
  if (!isDir(root)) return map
  let workspaces
  try {
    workspaces = readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory())
  } catch {
    return map
  }
  for (const ws of workspaces) {
    const wsPath = join(root, ws.name)
    let sessions
    try {
      sessions = readdirSync(wsPath, { withFileTypes: true }).filter((e) => e.isDirectory())
    } catch {
      continue
    }
    for (const s of sessions) {
      const sPath = join(wsPath, s.name)
      let files
      try {
        files = readdirSync(sPath).filter((f) => /^session\.v\d+\.jsonl\.zstd$/i.test(f))
      } catch {
        continue
      }
      if (files.length === 0) continue
      // 同一会话只会有一份现役日志；万一有多份取 mtime 最新的
      let best = null
      for (const f of files) {
        const p = join(sPath, f)
        const st = safeStat(p)
        if (st === null) continue
        if (best === null || st.mtimeMs > best.mtimeMs) best = { path: p, mtimeMs: st.mtimeMs, bytes: st.size }
      }
      if (best !== null) map.set(s.name, best)
    }
  }
  return map
}

/** 一条缓存的概览（不解析日志） */
export function readCacheRecord(cachePath) {
  const st = safeStat(cachePath)
  if (st === null) return null
  let json
  try {
    json = JSON.parse(readFileSync(cachePath, 'utf8'))
  } catch (error) {
    return { cachePath, bytes: st.size, mtimeMs: st.mtimeMs, broken: true, error: String(error && error.message) }
  }
  const record = json && json.record ? json.record : {}
  const rows = record.rows && typeof record.rows === 'object' ? record.rows : {}
  const meta = rows.sessionListMetadata && typeof rows.sessionListMetadata === 'object' ? rows.sessionListMetadata : null
  // 缓存记录自身的最大 seq —— 用来判断它落后日志多少
  let maxSeq = -1
  for (const key of Object.keys(rows)) {
    const row = rows[key]
    if (row && typeof row.seq === 'number' && row.seq > maxSeq) maxSeq = row.seq
  }
  return {
    cachePath,
    bytes: st.size,
    mtimeMs: st.mtimeMs,
    version: json && json.version,
    identity: record.identity && typeof record.identity === 'object' ? record.identity : null,
    blank: meta !== null && meta.val && typeof meta.val === 'object' ? meta.val.blank === true : null,
    blankMetaSeq: meta !== null && typeof meta.seq === 'number' ? meta.seq : null,
    lastPromptAt: meta !== null && meta.val && typeof meta.val === 'object' ? meta.val.lastPromptAt ?? null : null,
    maxSeq,
    rowKeys: Object.keys(rows),
  }
}

/**
 * 只看日志头部若干帧，判断里面有没有真正发生过一轮对话。
 * 返回 { hasTurn, turnSeq, hasUser, tailSeq, decodedFrames }
 */
export function inspectLogHead(logPath) {
  const st = safeStat(logPath)
  const out = { logPath, bytes: st ? st.size : 0, mtimeMs: st ? st.mtimeMs : 0, hasTurn: false, turnSeq: null, hasUser: false, tailSeq: null, decodedFrames: 0 }
  if (st === null || st.size < MIN_LOG_BYTES) return out
  let buf
  try {
    buf = readFileSync(logPath)
  } catch (error) {
    out.error = String(error && error.message)
    return out
  }
  const slice = buf.length > HEAD_BYTES ? buf.subarray(0, HEAD_BYTES) : buf
  let frames
  try {
    frames = splitFrames(slice)
  } catch (error) {
    out.error = String(error && error.message)
    return out
  }
  let text = ''
  for (const f of frames) {
    if (!f.decoded) continue
    out.decodedFrames += 1
    text += f.decoded.toString('utf8')
    if (text.length > HEAD_BYTES * 4) break
  }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let obj
    try {
      obj = JSON.parse(line)
    } catch {
      continue
    }
    if (typeof obj.seq === 'number') out.tailSeq = obj.seq
    if (obj.type === 'turn/start') {
      out.hasTurn = true
      if (out.turnSeq === null && typeof obj.seq === 'number') out.turnSeq = obj.seq
    }
    if (obj.type === 'user/message') out.hasUser = true
  }
  return out
}

/**
 * 扫描全部投影缓存，标出陈旧记录。
 *
 * @param {string} dshHome
 * @param {object} [opts]
 * @param {boolean} [opts.deep=true] 是否去解析日志正文（false 只按缓存自身字段粗筛）
 * @param {number}  [opts.maxLogs=200] 最多解析多少份日志（防止极端情况下拖慢启动）
 * @returns {{ ok:boolean, dshHome:string, cacheDir:string, scanned:number, stale:Array, blank:number, errors:Array }}
 */
export function scanSessionCaches(dshHome, opts = {}) {
  const deep = opts.deep !== false
  const maxLogs = Number.isFinite(opts.maxLogs) ? opts.maxLogs : 200
  const cacheDir = cacheDirOf(dshHome)
  const report = { ok: true, dshHome, cacheDir, scanned: 0, blank: 0, stale: [], errors: [], logsInspected: 0 }
  if (!isDir(cacheDir)) {
    report.ok = false
    report.errors.push(`缓存目录不存在：${cacheDir}`)
    return report
  }

  let names
  try {
    names = readdirSync(cacheDir).filter((f) => f.toLowerCase().endsWith('.json'))
  } catch (error) {
    report.ok = false
    report.errors.push(`读缓存目录失败：${String(error && error.message)}`)
    return report
  }

  const logIndex = deep ? indexSessionLogs(dshHome) : new Map()
  const judged = []

  for (const name of names) {
    const cachePath = join(cacheDir, name)
    const rec = readCacheRecord(cachePath)
    if (rec === null) continue
    report.scanned += 1
    if (rec.broken) {
      // 缓存自己都解析不了，DSH 读它也会失败；但删除有风险（可能是别的格式版本），只报不改
      report.errors.push(`缓存无法解析：${name}（${rec.error}）`)
      continue
    }
    if (rec.blank !== true) continue
    report.blank += 1

    const id = name.replace(/\.json$/i, '')
    const item = {
      id,
      cachePath,
      cacheBytes: rec.bytes,
      cacheMtime: rec.mtimeMs,
      cacheMaxSeq: rec.maxSeq,
      blankMetaSeq: rec.blankMetaSeq,
      cwd: rec.identity ? rec.identity.cwd ?? null : null,
      createdAt: rec.identity ? rec.identity.createdAt ?? null : null,
      logPath: null,
      logBytes: null,
      logTailSeq: null,
      hasTurn: null,
      hasUser: null,
      stale: false,
      reason: '',
    }

    if (!deep) {
      // 粗筛：缓存 seq 还停在 -1 说明上一次写出后再没推进过，高度可疑
      if (rec.maxSeq <= 0) {
        item.stale = true
        item.reason = `缓存从未推进（maxSeq=${rec.maxSeq}）且仍标记 blank`
      } else {
        item.reason = '未检查日志（deep=false）'
      }
      judged.push(item)
      continue
    }

    const log = logIndex.get(id)
    if (log === undefined) {
      item.reason = '找不到对应会话日志，跳过（可能是别的机器同步来的空壳）'
      judged.push(item)
      continue
    }
    if (report.logsInspected >= maxLogs) {
      item.reason = `本次已达日志解析上限 ${maxLogs} 份，跳过`
      judged.push(item)
      continue
    }
    report.logsInspected += 1
    item.logPath = log.path
    item.logBytes = log.bytes
    const head = inspectLogHead(log.path)
    item.hasTurn = head.hasTurn
    item.hasUser = head.hasUser
    item.logTailSeq = head.tailSeq
    if (head.error) item.reason = `日志解析出错：${head.error}`

    const progressed = head.hasTurn || head.hasUser
    if (!progressed) {
      item.reason = '日志里确实没有对话事件（真空会话），缓存是对的'
      judged.push(item)
      continue
    }
    if (typeof head.tailSeq === 'number' && head.tailSeq <= rec.maxSeq) {
      item.reason = `缓存并不落后日志（缓存 maxSeq=${rec.maxSeq}，日志 tail=${head.tailSeq}），不动`
      judged.push(item)
      continue
    }
    item.stale = true
    item.reason = `日志已有对话（turn=${head.hasTurn} 首轮 seq=${head.turnSeq}，user=${head.hasUser}，tail=${head.tailSeq}），缓存仍标 blank 且停在 seq=${rec.maxSeq}`
    judged.push(item)
  }

  report.stale = judged.filter((x) => x.stale)
  report.candidates = judged
  return report
}

/**
 * 删除指定会话的缓存（先挪到备份目录，不做物理删除）。
 * 返回 { removed:[{id,from,to}], errors:[] }
 */
export function clearSessionCaches(dshHome, ids, opts = {}) {
  const cacheDir = cacheDirOf(dshHome)
  const backupDir = opts.backupDir || join(dshHome, 'logs', 'session-cache-guard-backup')
  const out = { removed: [], errors: [] }
  const list = Array.isArray(ids) ? ids : []
  if (list.length === 0) return out
  let backupReady = false
  for (const raw of list) {
    const id = String(raw || '').trim()
    if (id === '' || /[\\/]/.test(id) || id.includes('..')) {
      out.errors.push(`非法会话 id：${raw}`)
      continue
    }
    const from = join(cacheDir, `${id}.json`)
    if (!existsSync(from)) {
      out.errors.push(`缓存已不存在：${id}`)
      continue
    }
    try {
      if (!backupReady) {
        mkdirSync(backupDir, { recursive: true })
        backupReady = true
      }
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      const to = join(backupDir, `${stamp}-${id}.json`)
      renameSync(from, to)
      out.removed.push({ id, from, to })
    } catch (error) {
      out.errors.push(`删除失败 ${id}：${String(error && error.message)}`)
    }
  }
  return out
}

/** 追加一行日志到 .dsh\logs\session-cache-guard.log（失败不影响主流程） */
export function appendGuardLog(dshHome, text) {
  try {
    const dir = join(dshHome, 'logs')
    mkdirSync(dir, { recursive: true })
    const line = `[${new Date().toISOString()}] ${text}\n`
    const file = join(dir, 'session-cache-guard.log')
    let prev = ''
    try {
      const st = safeStat(file)
      if (st !== null && st.size > 512 * 1024) prev = ''
      else prev = readFileSync(file, 'utf8')
    } catch {
      prev = ''
    }
    writeFileSync(file, prev + line, 'utf8')
  } catch {
    /* 日志写不出来就算了 */
  }
}

/**
 * 扫描 + 按需清理，路由与定时器共用。
 *
 * @param {string} dshHome
 * @param {object} [opts]
 * @param {boolean} [opts.apply=true] 是否真的删（false 只报告）
 * @param {string[]} [opts.ids] 只处理这些 id（不传=全部陈旧项）
 * @param {boolean} [opts.deep=true]
 * @param {string} [opts.source='manual'] 触发来源，写日志用
 */
export function runGuard(dshHome, opts = {}) {
  const apply = opts.apply !== false
  const source = opts.source || 'manual'
  const scan = scanSessionCaches(dshHome, { deep: opts.deep, maxLogs: opts.maxLogs })
  const wanted = Array.isArray(opts.ids) && opts.ids.length > 0 ? opts.ids.map(String) : scan.stale.map((x) => x.id)
  const result = {
    ok: scan.ok,
    dshHome,
    source,
    applied: apply,
    scanned: scan.scanned,
    blank: scan.blank,
    staleCount: scan.stale.length,
    stale: scan.stale.map((x) => ({ id: x.id, reason: x.reason, cwd: x.cwd, cacheMaxSeq: x.cacheMaxSeq, logTailSeq: x.logTailSeq, logPath: x.logPath })),
    candidates: scan.candidates ? scan.candidates.map((x) => ({ id: x.id, stale: x.stale, reason: x.reason })) : [],
    errors: scan.errors.slice(),
    removed: [],
  }
  if (!apply || wanted.length === 0) return result
  const cleared = clearSessionCaches(dshHome, wanted)
  result.removed = cleared.removed
  result.errors.push(...cleared.errors)
  if (cleared.removed.length > 0) {
    appendGuardLog(dshHome, `[${source}] 清理 ${cleared.removed.length} 条陈旧投影缓存：${cleared.removed.map((x) => x.id).join(', ')}`)
  }
  return result
}
