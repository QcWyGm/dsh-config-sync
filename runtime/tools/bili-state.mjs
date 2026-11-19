#!/usr/bin/env node
// billion-context 压缩状态跨机同步工具。
//
// 背景：billion-context（下称 bili）把每个会话的压缩状态（blocks/refs/摘要）存在自己的
// SQLite 库 index.db 里，DSH 的会话日志里没有。跨机同步只搬 sessions 日志时，接收端
// bili 会认为这是一份没有任何压缩记录的新会话 —— 它算不出可压区间（max compressible
// 不足阈值），于是整段 surface 直发 provider，报 CONTEXT_WINDOW_EXCEEDED。
//
// 这个工具按会话导出/导入「压缩状态」，不含消息正文（正文由 bili 自己从 DSH 会话日志
// 重新 ingest，没必要搬）。导出格式与 bili 自带 `sessions archive` 的 archive.jsonl
// 行结构兼容，便于互相迁移。
//
// 用法：
//   node bili-state.mjs probe
//   node bili-state.mjs export <sessionId> <outFile> [--all-blocks]
//   node bili-state.mjs import <inFile> [--dry-run]
//   node bili-state.mjs info <inFile>
//
// 退出码：0 成功；1 失败；2 用法/IO。

import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const FORMAT = 1

function biliSessionsDir() {
  const cfg = process.env.BILI_CONFIG_FILE
  if (cfg) {
    const dir = path.dirname(path.resolve(cfg))
    const cand = path.join(dir, 'sessions')
    if (existsSync(path.join(cand, 'index.db'))) return cand
  }
  const explicit = process.env.BILI_DATA_DIR || process.env.BILLION_CONTEXT_DATA_DIR
  if (explicit) {
    // 显式指定即视为权威：允许指到数据根（…\billion-context）或直接指到 sessions 目录。
    // 找不到 index.db 就返回 null（= 这台机器没有 bili 数据），不再回头去猜用户主目录——
    // 隔离测试/无插件机器都靠这条语义，否则会误抓真实库。
    const direct = path.resolve(explicit)
    if (existsSync(path.join(direct, 'index.db'))) return direct
    const cand = path.join(direct, 'sessions')
    if (existsSync(path.join(cand, 'index.db'))) return cand
    return null
  }
  const home = process.env.USERPROFILE || process.env.HOME || os.homedir()
  const candidates = [
    path.join(home, '.local', 'share', 'billion-context', 'sessions'),
    path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'billion-context', 'sessions'),
    path.join(process.env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'billion-context', 'sessions'),
  ]
  for (const c of candidates) if (existsSync(path.join(c, 'index.db'))) return c
  return null
}

function openDb(dir, readOnly) {
  const file = path.join(dir, 'index.db')
  if (!existsSync(file)) throw new Error(`index.db 不存在：${file}`)
  return new DatabaseSync(file, { readOnly: !!readOnly })
}

function tableColumns(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all()
}

// 按目标表的实际列生成插入/更新用的列清单：丢掉导出文件里不存在的列，
// 也丢掉「值为 null 但目标列 NOT NULL」的列（否则会直接约束失败；
// 丢掉后该列落 DEFAULT）。bili 的表大量使用 NOT NULL DEFAULT '{}'，
// 少一列就会炸，这是必须的保底处理。
function pickColumns(info, row, only) {
  const notNull = new Set(info.filter((c) => c.notnull === 1).map((c) => c.name))
  const allowed = only ? new Set(only) : null
  return info
    .map((c) => c.name)
    .filter((n) => row[n] !== undefined && !(row[n] === null && notNull.has(n)))
    .filter((n) => !allowed || allowed.has(n))
}

function insertRow(db, table, info, row) {
  const use = pickColumns(info, row)
  if (!use.length) return false
  db.prepare(`INSERT INTO ${table} (${use.join(', ')}) VALUES (${use.map(() => '?').join(', ')})`)
    .run(...use.map((c) => row[c]))
  return true
}

function log(msg) {
  process.stdout.write(msg + '\n')
}

function cmdProbe() {
  const dir = biliSessionsDir()
  if (!dir) {
    log('没有找到 billion-context 的 sessions 目录（本机没装 bili，或换了数据目录）')
    return 1
  }
  const db = openDb(dir, true)
  const cols = tableColumns(db, 'sessions')
  const n = db.prepare('SELECT COUNT(*) AS c FROM sessions').get().c
  log(`bili sessions dir: ${dir}`)
  log(`sessions 行数: ${n}；schema 列数: ${cols.length}`)
  const sample = db.prepare('SELECT session_id, status, last_ingested_seq, next_block_id FROM sessions LIMIT 3').all()
  for (const s of sample) log(`  ${s.session_id}  status=${s.status} ingested=${s.last_ingested_seq} nextBlock=${s.next_block_id}`)
  db.close()
  return 0
}

function cmdExport(sessionId, outFile, allBlocks, full) {
  const dir = biliSessionsDir()
  if (!dir) {
    log('没有找到 billion-context 的 sessions 目录')
    return 1
  }
  const db = openDb(dir, true)
  try {
    const sessCols = tableColumns(db, 'sessions').map((c) => c.name)
    const row = db.prepare('SELECT * FROM sessions WHERE session_id = ?').get(sessionId)
    if (!row) {
      log(`bili 库里没有会话 ${sessionId}（这台机器没在这个会话上跑过 bili 压缩）`)
      return 1
    }
    // metadata_json 是 bili 自己的查询缓存（cacheLedger / publicSnapshot / foldCoverage 等），
    // 接收端会自己重建；它占 2.4 MB 左右，默认不发，--full 才带上。
    // 注意必须 delete 键而不是置 null：这一列是 NOT NULL DEFAULT '{}'，写 null 会直接约束失败，
    // 而删掉键就能落到 DEFAULT 上。
    if (!full && row.metadata_json !== undefined) {
      delete row.metadata_json
    }
    const blocks = allBlocks
      ? db.prepare('SELECT * FROM blocks WHERE session_id = ? ORDER BY ord').all(sessionId)
      : db.prepare('SELECT * FROM blocks WHERE session_id = ? AND active = 1 ORDER BY ord').all(sessionId)
    const refs = db.prepare('SELECT * FROM refs WHERE session_id = ? ORDER BY ord').all(sessionId)
    const deadRefs = db.prepare('SELECT * FROM dead_refs WHERE session_id = ? ORDER BY ord').all(sessionId)
    const ccr = db.prepare('SELECT * FROM ccr_entries WHERE session_id = ? ORDER BY ord').all(sessionId)
    const ext = db.prepare('SELECT * FROM session_ext WHERE session_id = ?').all(sessionId)
    const checkpoints = db.prepare('SELECT * FROM checkpoints WHERE session_id = ?').all(sessionId)

    // 只搬「压缩状态」需要的内容：block 的摘要（summary_hash / one_hash）。
    // 消息正文（messages 的 content_hash）不搬 —— 接收端 bili 会从 DSH 会话日志重新 ingest。
    // checkpoint 的 state_hash 是「fork 基线快照」，单个就能到 20 MB 以上，而且压缩判定用不到它，
    // 所以默认不发（只发 checkpoint 行本身，import 时会因为缺 content 而跳过该行）；
    // --full 才把 checkpoint 快照一起带上（用于跨机接续 fork）。
    const wanted = new Set()
    for (const b of blocks) {
      if (b.summary_hash) wanted.add(b.summary_hash)
      if (b.one_hash) wanted.add(b.one_hash)
    }
    if (full) {
      for (const c of checkpoints) if (c.state_hash) wanted.add(c.state_hash)
    }
    for (const e of ccr) if (e.content_hash) wanted.add(e.content_hash)

    const content = {}
    let contentBytes = 0
    const getContent = db.prepare('SELECT bytes, byte_len FROM content WHERE hash = ?')
    for (const hash of wanted) {
      const c = getContent.get(hash)
      if (!c) continue
      const text = Buffer.from(c.bytes).toString('utf8')
      content[hash] = text
      contentBytes += Buffer.byteLength(text, 'utf8')
    }

    const dump = {
      format: FORMAT,
      kind: 'billion-context-compaction-state',
      sessionId,
      exportedAt: Date.now(),
      schemaUserVersion: db.prepare('PRAGMA user_version').get().user_version,
      sessionColumns: sessCols,
      session: row,
      blocks,
      refs,
      deadRefs,
      ccrEntries: ccr,
      sessionExt: ext,
      checkpoints,
      content,
      // 显式声明：没有 messages / mediaMaps，接收端不要指望能从这里恢复消息正文
      omitted: ['messages', 'message_media'],
    }
    const text = JSON.stringify(dump)
    mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true })
    writeFileSync(outFile, text, 'utf8')
    const bytes = Buffer.byteLength(text, 'utf8')
    log(`导出 ${sessionId}`)
    log(`  blocks: ${blocks.length}${allBlocks ? '（全部，含已被取代的）' : '（仅 active）'}`)
    log(`  refs: ${refs.length}  checkpoints: ${checkpoints.length}  content 条: ${Object.keys(content).length}（${(contentBytes / 1048576).toFixed(2)} MB）`)
    log(`  落盘: ${outFile}  共 ${(bytes / 1048576).toFixed(2)} MB`)
    return 0
  } finally {
    db.close()
  }
}

function cmdInfo(inFile) {
  const dump = JSON.parse(readFileSync(inFile, 'utf8'))
  log(`文件: ${inFile}（${(statSync(inFile).size / 1048576).toFixed(2)} MB）`)
  log(`  会话: ${dump.sessionId}`)
  log(`  schema: format=${dump.format} userVersion=${dump.schemaUserVersion}`)
  log(`  blocks=${(dump.blocks || []).length} refs=${(dump.refs || []).length} checkpoints=${(dump.checkpoints || []).length} content=${Object.keys(dump.content || {}).length}`)
  const s = dump.session || {}
  log(`  status=${s.status} last_ingested_seq=${s.last_ingested_seq} next_block_id=${s.next_block_id}`)
  log(`  omitted=${(dump.omitted || []).join(',') || '（无）'}`)
  return 0
}

function cmdImport(inFile, dryRun) {
  const dump = JSON.parse(readFileSync(inFile, 'utf8'))
  if (dump.format !== FORMAT || dump.kind !== 'billion-context-compaction-state') {
    log(`不认识的文件格式（format=${dump.format} kind=${dump.kind}）`)
    return 2
  }
  const sessionId = dump.sessionId
  const dir = biliSessionsDir()
  if (!dir) {
    log('没有找到 billion-context 的 sessions 目录（本机没装 bili），无法导入压缩状态')
    return 1
  }
  const db = openDb(dir, false)
  let insSession = 0
  let insBlock = 0
  let skipBlock = 0
  let insRef = 0
  let skipRef = 0
  let insContent = 0
  let skipContent = 0
  let insCp = 0
  try {
    const localVersion = db.prepare('PRAGMA user_version').get().user_version
    if (dump.schemaUserVersion && localVersion !== dump.schemaUserVersion) {
      log(`提示：导出端 schema user_version=${dump.schemaUserVersion}，本机=${localVersion}；按列名逐列写入，缺列会跳过。`)
    }
    db.exec('BEGIN')
    try {
      // 1) content：只补缺的
      const hasContent = db.prepare('SELECT 1 AS x FROM content WHERE hash = ?')
      const insC = db.prepare("INSERT INTO content (hash, byte_len, refcount, algo, bytes) VALUES (?, ?, 1, 'sha256', ?)")
      for (const [hash, text] of Object.entries(dump.content || {})) {
        if (hasContent.get(hash)) { skipContent++; continue }
        const buf = Buffer.from(text, 'utf8')
        insC.run(hash, buf.length, buf)
        insContent++
      }

      // 2) sessions 行：存在就只补压缩相关列，不存在就整行插入
      const sess = dump.session || {}
      const sinfo = tableColumns(db, 'sessions')
      const cols = sinfo.map((c) => c.name)
      const exists = db.prepare('SELECT 1 AS x FROM sessions WHERE session_id = ?').get(sessionId)
      const carry = ['status', 'last_ingested_seq', 'next_block_id', 'next_run_id', 'kstate_json', 'tail_json', 'ccr_json', 'stats_json', 'meta_json', 'metadata_json', 'orphans_json', 'protocol', 'label', 'title', 'host_title', 'origin', 'updated_at']
      if (exists) {
        const use = pickColumns(sinfo, sess, carry.filter((c) => cols.includes(c)))
        if (use.length) {
          db.prepare(`UPDATE sessions SET ${use.map((c) => `${c} = ?`).join(', ')} WHERE session_id = ?`)
            .run(...use.map((c) => sess[c]), sessionId)
          insSession = 1
        }
      } else {
        const use = pickColumns(sinfo, sess)
        db.prepare(`INSERT INTO sessions (${use.join(', ')}) VALUES (${use.map(() => '?').join(', ')})`)
          .run(...use.map((c) => sess[c]))
        insSession = 1
      }

      // 3) blocks：同 block_id 已存在就不动（本机可能已经自己压过更靠后的版本）
      const hasBlock = db.prepare('SELECT 1 AS x FROM blocks WHERE session_id = ? AND block_id = ?')
      const binfo = tableColumns(db, 'blocks')
      for (const b of dump.blocks || []) {
        if (hasBlock.get(sessionId, b.block_id)) { skipBlock++; continue }
        if (insertRow(db, 'blocks', binfo, b)) insBlock++
        else skipBlock++
      }

      // 4) refs：raw_id 与 ord 都可能是唯一键，冲突就跳
      const hasRefOrd = db.prepare('SELECT 1 AS x FROM refs WHERE session_id = ? AND ord = ?')
      const hasRefRaw = db.prepare('SELECT 1 AS x FROM refs WHERE session_id = ? AND raw_id = ?')
      const rinfo = tableColumns(db, 'refs')
      for (const r of dump.refs || []) {
        if (hasRefOrd.get(sessionId, r.ord) || hasRefRaw.get(sessionId, r.raw_id)) { skipRef++; continue }
        if (insertRow(db, 'refs', rinfo, r)) insRef++
        else skipRef++
      }

      // 5) checkpoints / dead_refs / ccr_entries / session_ext：都是小表，冲突就跳
      let skipCpNoState = 0
      const cinfo = tableColumns(db, 'checkpoints')
      for (const cp of dump.checkpoints || []) {
        if (db.prepare('SELECT 1 AS x FROM checkpoints WHERE cp_id = ?').get(cp.cp_id)) continue
        // 默认导出不带 checkpoint 的 state_hash 快照（单个可达 20 MB+），缺 content 就跳过这行，
        // 不然会插出一条指向不存在 state 的 checkpoint。
        if (cp.state_hash && !db.prepare('SELECT 1 AS x FROM content WHERE hash = ?').get(cp.state_hash)) {
          skipCpNoState++
          continue
        }
        if (insertRow(db, 'checkpoints', cinfo, cp)) insCp++
      }
      if (skipCpNoState) log(`  checkpoints 跳过 ${skipCpNoState} 个（导出时没带 state 快照，用 --full 重导可带上）`)
      for (const [table, list] of [
        ['dead_refs', dump.deadRefs || []],
        ['ccr_entries', dump.ccrEntries || []],
        ['session_ext', dump.sessionExt || []],
      ]) {
        if (!list.length) continue
        const info = tableColumns(db, table)
        for (const r of list) {
          try { insertRow(db, table, info, r) } catch { /* 主键冲突或外键缺失：跳过 */ }
        }
      }

      if (dryRun) db.exec('ROLLBACK')
      else db.exec('COMMIT')
    } catch (err) {
      try { db.exec('ROLLBACK') } catch {}
      throw err
    }
    log(`${dryRun ? '（演练，未提交）' : ''}导入 ${sessionId}`)
    log(`  sessions 行: ${insSession ? '已更新/插入' : '无变化'}`)
    log(`  blocks: 新增 ${insBlock}，跳过 ${skipBlock}`)
    log(`  refs: 新增 ${insRef}，跳过 ${skipRef}`)
    log(`  content: 新增 ${insContent}，已存在 ${skipContent}`)
    log(`  checkpoints: 新增 ${insCp}`)
    return 0
  } finally {
    db.close()
  }
}

function parseArgs(argv) {
  const args = argv.slice(2)
  const flags = new Set(args.filter((a) => a.startsWith('--')))
  const pos = args.filter((a) => !a.startsWith('--'))
  return { pos, flags }
}

// 批量模式：给 PowerShell 侧调用。参数全走 JSON 文件，避免 PS5.1 把中文/引号拆坏。
//   spec = { mode:"export"|"import", repoDir, biliDir?, sessions?:[..] }
//   export：把本机 bili 库里指定会话的压缩状态写到 repoDir/<sessionId>.json
//   import：把 repoDir 下所有 *.json 导入本机 bili 库
// 结果写到 outJson，PS 侧读文件（Electron 是 GUI 子系统，抓不到 stdout）。
function cmdSync(specFile, outFile) {
  const spec = JSON.parse(readFileSync(specFile, 'utf8'))
  const mode = spec.mode
  const result = { ok: true, mode, exported: [], imported: [], missing: [], skipped: [], failed: [], biliDir: null }
  if (spec.biliDir) process.env.BILI_DATA_DIR = spec.biliDir
  const dir = biliSessionsDir()
  result.biliDir = dir
  if (!dir) {
    // 本机没装 bili / 没有 bili 数据：导出侧当成「这台机器没压缩记录」，导入侧当成「跳过」。
    result.ok = true
    result.noBili = true
    if (mode === 'import') result.skipped.push('本机没有 billion-context 数据目录，压缩状态无处可写')
    writeFileSync(outFile, JSON.stringify(result, null, 2), 'utf8')
    return 0
  }

  const repoDir = spec.repoDir
  mkdirSync(repoDir, { recursive: true })

  if (mode === 'export') {
    const db = openDb(dir, true)
    try {
      const hasSess = db.prepare('SELECT 1 AS x FROM sessions WHERE session_id = ?')
      const sessInfo = db.prepare('PRAGMA table_info(sessions)').all()
      const blocksInfo = db.prepare('PRAGMA table_info(blocks)').all()
      for (const sid of spec.sessions || []) {
        if (!hasSess.get(sid)) { result.missing.push(sid); continue }
        try {
          const row = db.prepare('SELECT * FROM sessions WHERE session_id = ?').get(sid)
          delete row.metadata_json
          const blocks = db.prepare('SELECT * FROM blocks WHERE session_id = ? AND active = 1 ORDER BY ord').all(sid)
          const refs = db.prepare('SELECT * FROM refs WHERE session_id = ? ORDER BY ord').all(sid)
          const deadRefs = db.prepare('SELECT * FROM dead_refs WHERE session_id = ? ORDER BY ord').all(sid)
          const ccr = db.prepare('SELECT * FROM ccr_entries WHERE session_id = ? ORDER BY ord').all(sid)
          const ext = db.prepare('SELECT * FROM session_ext WHERE session_id = ?').all(sid)
          const checkpoints = db.prepare('SELECT * FROM checkpoints WHERE session_id = ?').all(sid)
          const wanted = new Set()
          for (const b of blocks) { if (b.summary_hash) wanted.add(b.summary_hash); if (b.one_hash) wanted.add(b.one_hash) }
          for (const e of ccr) if (e.content_hash) wanted.add(e.content_hash)
          const content = {}
          const getC = db.prepare('SELECT bytes FROM content WHERE hash = ?')
          for (const h of wanted) { const c = getC.get(h); if (c) content[h] = Buffer.from(c.bytes).toString('utf8') }
          const dump = {
            format: FORMAT, kind: 'billion-context-compaction-state', sessionId: sid, exportedAt: Date.now(),
            schemaUserVersion: db.prepare('PRAGMA user_version').get().user_version,
            sessionColumns: sessInfo.map((c) => c.name), blockColumns: blocksInfo.map((c) => c.name),
            session: row, blocks, refs, deadRefs, ccrEntries: ccr, sessionExt: ext, checkpoints, content,
            omitted: ['messages', 'message_media', 'checkpoint.state_hash'],
          }
          const out = path.join(repoDir, sid + '.json')
          writeFileSync(out, JSON.stringify(dump), 'utf8')
          result.exported.push({ sessionId: sid, blocks: blocks.length, refs: refs.length, content: Object.keys(content).length, bytes: statSync(out).size })
        } catch (err) {
          result.failed.push({ sessionId: sid, error: String(err && err.message ? err.message : err) })
        }
      }
    } finally { db.close() }
  } else if (mode === 'import') {
    const db = openDb(dir, false)
    try {
      const localVersion = db.prepare('PRAGMA user_version').get().user_version
      const sinfo = db.prepare('PRAGMA table_info(sessions)').all()
      const binfo = db.prepare('PRAGMA table_info(blocks)').all()
      const rinfo = db.prepare('PRAGMA table_info(refs)').all()
      const cinfo = db.prepare('PRAGMA table_info(checkpoints)').all()
      const files = existsSync(repoDir)
        ? readdirSync(repoDir).filter((f) => f.toLowerCase().endsWith('.json'))
        : []
      for (const f of files) {
        const full = path.join(repoDir, f)
        let dump
        try { dump = JSON.parse(readFileSync(full, 'utf8')) } catch (err) { result.failed.push({ file: f, error: 'JSON 解析失败' }); continue }
        if (dump.format !== FORMAT || dump.kind !== 'billion-context-compaction-state') { result.skipped.push({ file: f, reason: '不是压缩状态文件' }); continue }
        if (localVersion && dump.schemaUserVersion && localVersion !== dump.schemaUserVersion) {
          result.schemaWarnings = result.schemaWarnings || []
          result.schemaWarnings.push(`${f}: 导出端 user_version=${dump.schemaUserVersion}，本机=${localVersion}（按列名逐列写入，缺列落 DEFAULT）`)
        }
        const sid = dump.sessionId
        try {
          db.exec('BEGIN')
          let nc = 0
          const hasContent = db.prepare('SELECT 1 AS x FROM content WHERE hash = ?')
          const insC = db.prepare("INSERT INTO content (hash, byte_len, refcount, algo, bytes) VALUES (?, ?, 1, 'sha256', ?)")
          for (const [hash, text] of Object.entries(dump.content || {})) {
            if (hasContent.get(hash)) continue
            const buf = Buffer.from(text, 'utf8')
            insC.run(hash, buf.length, buf); nc++
          }
          const sess = dump.session || {}
          const exists = db.prepare('SELECT 1 AS x FROM sessions WHERE session_id = ?').get(sid)
          if (exists) {
            const carry = ['status', 'last_ingested_seq', 'next_block_id', 'next_run_id', 'kstate_json', 'tail_json', 'ccr_json', 'stats_json', 'meta_json', 'metadata_json', 'orphans_json', 'protocol', 'label', 'title', 'host_title', 'origin', 'updated_at']
            const use = pickColumns(sinfo, sess, carry)
            if (use.length) db.prepare(`UPDATE sessions SET ${use.map((c) => `${c} = ?`).join(', ')} WHERE session_id = ?`).run(...use.map((c) => sess[c]), sid)
          } else {
            const use = pickColumns(sinfo, sess)
            db.prepare(`INSERT INTO sessions (${use.join(', ')}) VALUES (${use.map(() => '?').join(', ')})`).run(...use.map((c) => sess[c]))
          }
          let nb = 0, sb = 0
          const hasB = db.prepare('SELECT 1 AS x FROM blocks WHERE session_id = ? AND block_id = ?')
          for (const b of dump.blocks || []) {
            if (hasB.get(sid, b.block_id)) { sb++; continue }
            if (insertRow(db, 'blocks', binfo, b)) nb++; else sb++
          }
          let nr = 0, sr = 0
          const hasRO = db.prepare('SELECT 1 AS x FROM refs WHERE session_id = ? AND ord = ?')
          const hasRR = db.prepare('SELECT 1 AS x FROM refs WHERE session_id = ? AND raw_id = ?')
          for (const r of dump.refs || []) {
            if (hasRO.get(sid, r.ord) || hasRR.get(sid, r.raw_id)) { sr++; continue }
            if (insertRow(db, 'refs', rinfo, r)) nr++; else sr++
          }
          let ncp = 0
          for (const cp of dump.checkpoints || []) {
            if (db.prepare('SELECT 1 AS x FROM checkpoints WHERE cp_id = ?').get(cp.cp_id)) continue
            if (cp.state_hash && !db.prepare('SELECT 1 AS x FROM content WHERE hash = ?').get(cp.state_hash)) continue
            if (insertRow(db, 'checkpoints', cinfo, cp)) ncp++
          }
          for (const [table, list] of [['dead_refs', dump.deadRefs || []], ['ccr_entries', dump.ccrEntries || []], ['session_ext', dump.sessionExt || []]]) {
            if (!list.length) continue
            const info = tableColumns(db, table)
            for (const r of list) { try { insertRow(db, table, info, r) } catch {} }
          }
          db.exec('COMMIT')
          result.imported.push({ sessionId: sid, content: nc, blocks: nb, blocksSkipped: sb, refs: nr, refsSkipped: sr, checkpoints: ncp })
        } catch (err) {
          try { db.exec('ROLLBACK') } catch {}
          result.failed.push({ file: f, sessionId: sid, error: String(err && err.message ? err.message : err) })
        }
      }
    } finally { db.close() }
  }
  result.ok = result.failed.length === 0
  writeFileSync(outFile, JSON.stringify(result, null, 2), 'utf8')
  return result.ok ? 0 : 1
}

const { pos, flags } = parseArgs(process.argv)
const cmd = pos[0]
let code = 2
try {
  if (cmd === 'probe') code = cmdProbe()
  else if (cmd === 'export') {
    if (!pos[1] || !pos[2]) { log('用法: node bili-state.mjs export <sessionId> <outFile> [--all-blocks] [--full]'); code = 2 }
    else code = cmdExport(pos[1], pos[2], flags.has('--all-blocks'), flags.has('--full'))
  } else if (cmd === 'import') {
    if (!pos[1]) { log('用法: node bili-state.mjs import <inFile> [--dry-run]'); code = 2 }
    else code = cmdImport(pos[1], flags.has('--dry-run'))
  } else if (cmd === 'info') {
    if (!pos[1]) { log('用法: node bili-state.mjs info <inFile>'); code = 2 }
    else code = cmdInfo(pos[1])
  } else if (cmd === 'sync') {
    if (!pos[1] || !pos[2]) { log('用法: node bili-state.mjs sync <specJson> <outJson>'); code = 2 }
    else code = cmdSync(pos[1], pos[2])
  } else {
    log('用法: node bili-state.mjs probe | export <sessionId> <outFile> [--all-blocks] | import <inFile> [--dry-run] | info <inFile>')
  }
} catch (err) {
  log(`错误: ${err && err.message ? err.message : String(err)}`)
  code = 1
}
process.exit(code)
