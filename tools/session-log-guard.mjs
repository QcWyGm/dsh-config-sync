// 会话日志跨机同步护栏
//
// 解决的问题
//   同步是「整文件覆盖」：capture 把本机日志整份拷进仓库、apply 把仓库日志整份铺回本机。
//   两台机器同时在同一个会话里跑，各自 append 出不同 lineage；整文件覆盖必然让其中一方
//   的事件整段消失，DSH 启动时报
//     corrupt session log: released v2 row N has seq gap (expected N, got M)
//   更糟的是拼接：本机文件被换成较短版本后 DSH 仍按自己的 eventCount 继续 append，
//   于是「A 的前 10776 条 + B 从 12304 起」首尾相接 —— B 机报的就是这个。
//
// 用法（capture.ps1 / apply.ps1 调用）
//   node session-log-guard.mjs decide <srcFile> <dstFile> <outJson>
//     输出决策 { ok, action, relation, detail, srcInfo, dstInfo, mergedFile? }
//     action = keep_dst  保留目标（目标更全或完全相同）
//              take_src  源是目标的严格超集，正常覆盖
//              merge     真分叉，并集已写到 mergedFile，调用方用它覆盖
//              corrupt   ★任何一方自身 seq 不连续，拒绝写，等人工处理
//   node session-log-guard.mjs merge <aFile> <bFile> <outFile>
//     求并集写盘（救援用）
//   node session-log-guard.mjs check <file> [<file2>]
//     只体检
//
// 退出码：0=可以继续，1=坏档/无法自动处理，2=用法或 IO 错误

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  loadLog, restAfterHeader, compareRaw, compareSeqs, findGaps, seqTailOf, mergeLogs,
} from './session-log-lib.mjs';

/** 中间产物一律落在临时目录，绝不写进会话目录（DSH 会扫那个目录） */
function tmpPath(tag) {
  return path.join(os.tmpdir(), `dsh-sessionlog-${tag}-${Date.now()}-${process.pid}.zstd`);
}

export function summarize(log) {
  const g = findGaps(log.rows);
  return {
    bytes: log.bytes,
    frames: log.frames.length,
    rows: log.rows.length,
    seqFirst: g.first,
    seqTail: g.tail,
    gaps: g.gaps.length,
    gapSample: g.gaps.slice(0, 3),
    cwd: log.header && log.header.cwd,
  };
}

export function decide(srcFile, dstFile) {
  const out = { src: srcFile, dst: dstFile };

  if (!fs.existsSync(dstFile)) {
    out.ok = true;
    out.action = 'take_src';
    out.relation = 'dst_missing';
    out.detail = '目标不存在，直接铺';
    return out;
  }
  if (!fs.existsSync(srcFile)) {
    out.ok = true;
    out.action = 'keep_dst';
    out.relation = 'src_missing';
    out.detail = '源不存在，保留目标';
    return out;
  }

  const sSize = fs.statSync(srcFile).size;
  const dSize = fs.statSync(dstFile).size;
  if (sSize === dSize) {
    const a = fs.readFileSync(srcFile);
    const b = fs.readFileSync(dstFile);
    if (a.equals(b)) {
      out.ok = true;
      out.action = 'keep_dst';
      out.relation = 'identical';
      out.detail = '两边字节完全相同';
      out.srcInfo = { bytes: sSize };
      out.dstInfo = { bytes: dSize };
      return out;
    }
  }

  let S;
  let D;
  try {
    S = loadLog(srcFile);
  } catch (e) {
    out.ok = false;
    out.action = 'keep_dst';
    out.relation = 'src_unreadable';
    out.detail = `源无法解析（${e.message}），保留目标不动`;
    return out;
  }
  try {
    D = loadLog(dstFile);
  } catch (e) {
    out.ok = true;
    out.action = 'take_src';
    out.relation = 'dst_unreadable';
    out.detail = `目标无法解析（${e.message}），用源覆盖修复`;
    out.srcInfo = summarize(S);
    return out;
  }

  out.srcInfo = summarize(S);
  out.dstInfo = summarize(D);

  // 自身已坏的档不能用来覆盖，也不能当合并基底
  if (out.srcInfo.gaps > 0) {
    out.ok = false;
    out.action = 'keep_dst';
    out.relation = 'src_corrupt';
    out.detail = `源自身有 ${out.srcInfo.gaps} 处 seq 跳号（已坏），拒绝覆盖目标`;
    return out;
  }
  if (out.dstInfo.gaps > 0) {
    // 目标自身已断档（正是 B 机报 "seq gap" 的形态）
    //   1) 源干净且 seq 覆盖目标 → 直接用源
    //   2) 否则拿源去填目标的洞：并集连续就写并集（救援）
    //   3) 洞填不满 → 事件真丢了，拒绝写，留给人工
    const sq = compareSeqs(S.rows, D.rows);
    out.seqRelation = { relation: sq.relation, onlyA: sq.onlyA.length, onlyB: sq.onlyB.length };
    if (sq.relation === 'a_superset' || sq.relation === 'equal') {
      out.ok = true;
      out.action = 'take_src';
      out.relation = 'dst_corrupt_fix_by_src';
      out.detail = `目标自身有 ${out.dstInfo.gaps} 处 seq 跳号，源是它的超集且干净，用源修复`;
      return out;
    }

    const repaired = mergeLogs(S, D);
    out.forkDetail = {
      onlySrc: sq.onlyA.length,
      onlyDst: sq.onlyB.length,
      sampleOnlySrc: sq.onlyA.slice(0, 5),
      sampleOnlyDst: sq.onlyB.slice(0, 5),
      holes: repaired.holes,
      conflictingSeq: repaired.conflicts.slice(0, 10),
    };
    if (repaired.holes.length > 0) {
      out.ok = false;
      out.action = 'keep_dst';
      out.relation = 'dst_corrupt_unrepairable';
      out.detail = `目标自身有 ${out.dstInfo.gaps} 处 seq 跳号，用源补齐后仍有 ${repaired.holes.length} 处空洞（事件已丢失），需人工处理`;
      return out;
    }
    const repairedPath = tmpPath('repaired');
    fs.writeFileSync(repairedPath, repaired.buffer);
    out.ok = true;
    out.action = 'merge';
    out.mergedFile = repairedPath;
    out.mergedInfo = {
      bytes: repaired.buffer.length,
      rows: repaired.rows,
      seqFirst: repaired.seqFirst,
      seqTail: repaired.seqTail,
      fromSrc: repaired.fromA,
      fromDst: repaired.fromB,
      conflictingSeq: repaired.conflicts.length,
    };
    out.relation = 'dst_corrupt_repaired_by_src';
    out.detail = `目标自身有 ${out.dstInfo.gaps} 处 seq 跳号，用源补齐洞后连续（${repaired.rows} 个事件，seq ${repaired.seqFirst}..${repaired.seqTail}），用修复件覆盖`;
    return out;
  }

  // 两边都自洽：先做字节前缀判定（最快最严），再做 seq 集合判定
  const restS = restAfterHeader(S.buf);
  const restD = restAfterHeader(D.buf);
  const cmp = restS && restD ? compareRaw(restS, restD) : { relation: 'fork' };
  out.byteRelation = cmp.relation;

  if (cmp.relation === 'identical') {
    out.ok = true;
    out.action = 'keep_dst';
    out.relation = 'identical';
    out.detail = '去掉首帧后字节一致，同源且同步';
    return out;
  }
  if (cmp.relation === 'b_is_prefix_of_a') {
    out.ok = true;
    out.action = 'take_src';
    out.relation = 'dst_prefix_of_src';
    out.detail = `目标落后 ${out.srcInfo.rows - out.dstInfo.rows} 个事件且是其字节前缀，安全覆盖`;
    return out;
  }
  if (cmp.relation === 'a_is_prefix_of_b') {
    out.ok = true;
    out.action = 'keep_dst';
    out.relation = 'src_prefix_of_dst';
    out.detail = `源落后 ${out.dstInfo.rows - out.srcInfo.rows} 个事件，保留目标（不回退）`;
    return out;
  }

  // 字节不是前缀关系：可能是「同一批事件被重新压过帧」，也可能是真分叉。用 seq 集合判定。
  const sq = compareSeqs(S.rows, D.rows);
  out.seqRelation = { relation: sq.relation, onlyA: sq.onlyA.length, onlyB: sq.onlyB.length };

  if (sq.relation === 'equal') {
    out.ok = true;
    out.action = 'keep_dst';
    out.relation = 'same_seqset';
    out.detail = `seq 集合一致（${sq.countA} 个事件），只是帧边界/压缩不同，保留目标`;
    return out;
  }
  if (sq.relation === 'a_superset') {
    out.ok = true;
    out.action = 'take_src';
    out.relation = 'src_superset';
    out.detail = `源多 ${sq.onlyA.length} 个事件、不丢目标任何事件，安全覆盖`;
    return out;
  }
  if (sq.relation === 'b_superset') {
    out.ok = true;
    out.action = 'keep_dst';
    out.relation = 'dst_superset';
    out.detail = `目标多 ${sq.onlyB.length} 个事件，保留目标（不回退）`;
    return out;
  }

  // 真分叉：两边各有对方没有的事件
  const merged = mergeLogs(S, D);
  out.relation = 'fork';
  out.forkDetail = {
    divergeAt: cmp.divergeAt,
    onlySrc: sq.onlyA.length,
    onlyDst: sq.onlyB.length,
    sampleOnlySrc: sq.onlyA.slice(0, 5),
    sampleOnlyDst: sq.onlyB.slice(0, 5),
    holes: merged.holes,
    conflictingSeq: merged.conflicts.slice(0, 10),
  };

  if (merged.holes.length > 0) {
    out.ok = false;
    out.action = 'keep_dst';
    out.detail = `两边分叉且并集仍有 ${merged.holes.length} 处空洞（事件真丢了，补不回来），保留目标并备份，需人工判断`;
    return out;
  }

  const mergedPath = tmpPath('merged');
  fs.writeFileSync(mergedPath, merged.buffer);
  out.ok = true;
  out.action = 'merge';
  out.mergedFile = mergedPath;
  out.mergedInfo = {
    bytes: merged.buffer.length,
    rows: merged.rows,
    seqFirst: merged.seqFirst,
    seqTail: merged.seqTail,
    fromSrc: merged.fromA,
    fromDst: merged.fromB,
    conflictingSeq: merged.conflicts.length,
  };
  out.detail = `真分叉，已按 seq 求并集为 ${merged.rows} 个事件（seq ${merged.seqFirst}..${merged.seqTail}，相容冲突 ${merged.conflicts.length} 个），用并集覆盖以免丢事件`;
  return out;
}

// ---------------- 批量模式（capture.ps1 / apply.ps1 用这个） ----------------
//
// 为什么批量：一台机器有几十个会话日志，逐个 spawn node 光是进程启动就要几秒。
// 一次调用把整批跑完，只启动一次进程。
//
//   node session-log-guard.mjs batch <jobJson> <outJson>
//
// jobJson：
//   { "jobs": [ { "src": "<要被采用的候选>", "dst": "<当前生效的那份>", "writeTo": "<把赢家写到哪里>" } ] }
//
//   capture 语义：src = 本机文件，dst = 仓库文件，writeTo = 仓库文件
//   apply   语义：src = 仓库文件，dst = 本机文件，writeTo = 本机文件
//
// 每项结果 { src, dst, ok, action, relation, detail, wrote, backup, mergedFile? }
//   action=keep_dst  → 不写
//   action=take_src  → 把 src 字节写到 writeTo（原文件先备份）
//   action=merge     → 把并集写到 writeTo（原文件先备份）
//   ok=false         → 不写，调用方应 Warn 并让用户知道这条会话需要人工处理
//
// 备份位置由调用方给（backupDir）：绝不能把备份写进会话目录 —— DSH 会扫那个目录，
// 多出来的 *.guard-bak 文件会被当成无法识别的会话产物。
function backupTo(srcPath, backupDir) {
  if (!backupDir) return null;
  fs.mkdirSync(backupDir, { recursive: true });
  const base = path.basename(srcPath).replace(/[^\w.\-]+/g, '_');
  const dst = path.join(backupDir, `${Date.now()}-${process.pid}-${base}`);
  fs.copyFileSync(srcPath, dst);
  return dst;
}

export function runBatch(jobFile, outFile) {
  const spec = JSON.parse(fs.readFileSync(jobFile, 'utf8'));
  const jobs = Array.isArray(spec.jobs) ? spec.jobs : [];
  const backupDir = spec.backupDir || '';
  const results = [];
  let nTake = 0;
  let nMerge = 0;
  let nKeep = 0;
  let nFail = 0;

  for (const j of jobs) {
    const r = { src: j.src, dst: j.dst };
    try {
      const d = decide(j.src, j.dst);
      r.ok = d.ok;
      r.action = d.action;
      r.relation = d.relation;
      r.detail = d.detail;
      if (d.forkDetail) r.forkDetail = d.forkDetail;
      if (d.mergedInfo) r.mergedInfo = d.mergedInfo;
      // 目标不存在时 decide 直接给 take_src，此时没有 dst 可备份
      if (d.action === 'take_src' && j.writeTo) {
        if (fs.existsSync(j.writeTo)) r.backup = backupTo(j.writeTo, backupDir);
        fs.copyFileSync(j.src, j.writeTo);
        r.wrote = j.writeTo;
        nTake++;
      } else if (d.action === 'merge' && j.writeTo && d.mergedFile) {
        if (fs.existsSync(j.writeTo)) r.backup = backupTo(j.writeTo, backupDir);
        fs.copyFileSync(d.mergedFile, j.writeTo);
        r.wrote = j.writeTo;
        try { fs.unlinkSync(d.mergedFile); } catch { /* 临时件删不掉也不影响结果 */ }
        nMerge++;
      } else if (d.action === 'keep_dst') {
        nKeep++;
      }
      if (!d.ok) nFail++;
    } catch (e) {
      r.ok = false;
      r.action = 'keep_dst';
      r.relation = 'guard_error';
      r.detail = `护栏自身出错：${e.message}`;
      nFail++;
    }
    results.push(r);
  }

  const report = { ok: nFail === 0, total: jobs.length, take: nTake, merge: nMerge, keep: nKeep, failed: nFail, results };
  if (outFile) fs.writeFileSync(outFile, JSON.stringify(report, null, 2), 'utf8');
  return report;
}

// ---------------- CLI ----------------

const [cmd, ...rest] = process.argv.slice(2).filter((a) => a !== undefined);

function emit(code, obj) {
  console.log(JSON.stringify(obj, null, 2));
  process.exit(code);
}

const invokedDirectly = process.argv[1] && /session-log-guard\.mjs$/i.test(process.argv[1]);

if (invokedDirectly) {
  if (cmd === 'decide') {
    const [src, dst, outFile] = rest;
    if (!src || !dst) emit(2, { error: '用法：decide <src> <dst> [outJson]' });
    let r;
    try {
      r = decide(src, dst);
    } catch (e) {
      r = { ok: false, action: 'keep_dst', relation: 'guard_error', detail: `护栏自身出错：${e.message}` };
    }
    const text = JSON.stringify(r, null, 2);
    if (outFile) {
      try {
        fs.writeFileSync(outFile, text, 'utf8');
      } catch {
        /* 写不出就只走 stdout */
      }
    }
    emit(r.ok ? 0 : 1, r);
  } else if (cmd === 'merge') {
    const [a, b, outFile] = rest;
    if (!a || !b || !outFile) emit(2, { error: '用法：merge <a> <b> <out>' });
    try {
      const A = loadLog(a);
      const B = loadLog(b);
      const m = mergeLogs(A, B);
      fs.writeFileSync(outFile, m.buffer);
      emit(m.holes.length === 0 ? 0 : 1, {
        ok: m.holes.length === 0,
        out: outFile,
        bytes: m.buffer.length,
        rows: m.rows,
        seqFirst: m.seqFirst,
        seqTail: m.seqTail,
        holes: m.holes,
        conflictingSeq: m.conflicts.length,
      });
    } catch (e) {
      emit(2, { error: e.message });
    }
  } else if (cmd === 'check') {
    const [a, b] = rest;
    if (!a) emit(2, { error: '用法：check <file> [<file2>]' });
    try {
      const A = loadLog(a);
      const gapsA = findGaps(A.rows);
      const out = { self: { file: a, ok: gapsA.gaps.length === 0, ...summarize(A) } };
      let rc = out.self.ok ? 0 : 1;
      if (b) {
        const B = loadLog(b);
        const gapsB = findGaps(B.rows);
        out.other = { file: b, ok: gapsB.gaps.length === 0, ...summarize(B) };
        out.compare = {
          bytes: (() => {
            const ra = restAfterHeader(A.buf);
            const rb = restAfterHeader(B.buf);
            return ra && rb ? compareRaw(ra, rb) : { relation: 'unavailable' };
          })(),
          seqs: (() => {
            const s = compareSeqs(A.rows, B.rows);
            return { relation: s.relation, onlyA: s.onlyA.length, onlyB: s.onlyB.length, sampleOnlyA: s.onlyA.slice(0, 5), sampleOnlyB: s.onlyB.slice(0, 5) };
          })(),
        };
        if (out.compare.bytes.relation === 'fork' && out.compare.seqs.relation === 'both_exclusive') rc = 1;
      }
      emit(rc, out);
    } catch (e) {
      emit(2, { error: e.message });
    }
  } else if (cmd === 'batch') {
    const [jobFile, outFile] = rest;
    if (!jobFile) emit(2, { error: '用法：batch <jobJson> <outJson>' });
    try {
      const r = runBatch(jobFile, outFile);
      emit(r.ok ? 0 : 1, r);
    } catch (e) {
      emit(2, { error: e.message });
    }
  } else {
    emit(2, {
      error: '用法：session-log-guard.mjs <decide|merge|check|batch> ...',
      examples: ['decide <src> <dst> [outJson]', 'merge <a> <b> <out>', 'check <file> [<file2>]', 'batch <jobJson> <outJson>'],
    });
  }
}

export { seqTailOf };
