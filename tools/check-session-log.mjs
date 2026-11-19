// 会话日志（session.v*.jsonl.zstd）完整性检查器
//
// 用途：跨机同步前后判定一份会话日志是否「自洽」（seq 连续）、以及两份日志
// 之间是「包含关系」（可以安全覆盖）还是「分叉」（覆盖就会丢事件、产生 seq gap）。
//
// 为什么必须做：会话日志是 append-only 的多帧 zstd，每个事件一帧、行内带 seq。
// 两台机器同时在同一个会话里跑，各自追加自己的帧；同步只按文件覆盖，
// 后推的一方赢、另一方那段事件被整段丢掉 —— 表现就是 DSH 启动时报
//   corrupt session log: released v2 row N has seq gap (expected N, got M)
//
// 用法：
//   node check-session-log.mjs <log 文件> [<对比的 log 文件>]
// 输出 JSON：
//   { ok, rows, header, gaps:[{at,expected,got}], seqTail, seqFirst, verdict }
//   带第二个参数时额外输出 { compare: { relation: 'prefix'|'superset'|'fork'|'identical'|'disjoint', ... } }
//
// 退出码：0=自洽；1=有 gap / 分叉；2=用法或解压失败

import fs from 'node:fs';
import zlib from 'node:zlib';

const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd];
const isFrameMagic = (b, i) => b.length >= i + 4 && b[i] === 0x28 && b[i + 1] === 0xb5 && b[i + 2] === 0x2f && b[i + 3] === 0xfd;

/** 把多帧 zstd 缓冲逐帧解开，拼成完整明文。节点只解第一帧，所以必须自己切帧。 */
function decompressAllFrames(buf) {
  const out = [];
  let off = 0;
  while (off < buf.length) {
    if (!isFrameMagic(buf, off)) {
      // 帧头之后有杂字节：记下来交给上层判定（可能是历史写坏残留）
      throw new Error(`invalid frame magic at byte ${off}`);
    }
    // 二分找这一帧的最小可解前缀
    let lo = off + 1;
    let hi = buf.length;
    let expected = null;
    let frameEnd = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      let got = null;
      try { got = zlib.zstdDecompressSync(buf.subarray(off, mid)); } catch { got = null; }
      if (got === null) { lo = mid + 1; continue; }
      if (expected === null) { expected = got; frameEnd = mid; hi = mid - 1; continue; }
      if (got.length >= expected.length) { frameEnd = mid; hi = mid - 1; } else { lo = mid + 1; }
    }
    if (frameEnd < 0) throw new Error(`failed to decode frame at byte ${off}`);
    // 带 content checksum 的帧，二分结果会短 4 字节：用「下一处帧头」校正
    const withCs = frameEnd + 4;
    if (frameEnd < buf.length && isFrameMagic(buf, frameEnd)) {
      // 正好落在帧头，不用修
    } else if (withCs <= buf.length && (withCs === buf.length || isFrameMagic(buf, withCs))) {
      frameEnd = withCs;
    }
    out.push(zlib.zstdDecompressSync(buf.subarray(off, frameEnd)));
    off = frameEnd;
  }
  return Buffer.concat(out);
}

function analyze(file) {
  const buf = fs.readFileSync(file);
  const text = decompressAllFrames(buf).toString('utf8');
  const lines = text.split('\n').filter((l) => l.trim() !== '');
  if (lines.length === 0) return { ok: false, rows: 0, error: 'empty log' };

  let header = null;
  try { header = JSON.parse(lines[0]); } catch { header = null; }

  const seqs = [];
  for (let i = 1; i < lines.length; i++) {
    let row;
    try { row = JSON.parse(lines[i]); } catch { continue; }
    if (typeof row.seq === 'number') seqs.push(row.seq);
  }
  const gaps = [];
  for (let i = 1; i < seqs.length; i++) {
    if (seqs[i] !== seqs[i - 1] + 1) {
      gaps.push({ at: i, expected: seqs[i - 1] + 1, got: seqs[i] });
    }
  }
  return {
    ok: gaps.length === 0,
    bytes: buf.length,
    lines: lines.length,
    rows: seqs.length,
    header: header === null ? null : {
      version: header.version,
      sessionId: header.sessionId,
      cwd: header.cwd,
      createdAt: header.createdAt,
      keys: Object.keys(header)
    },
    seqFirst: seqs.length ? seqs[0] : null,
    seqTail: seqs.length ? seqs[seqs.length - 1] : null,
    gaps
  };
}

function relation(a, b) {
  // a、b 的 seq 集合关系
  const sa = new Set(a.seqSet);
  const sb = new Set(b.seqSet);
  const onlyA = [...sa].filter((x) => !sb.has(x));
  const onlyB = [...sb].filter((x) => !sa.has(x));
  let rel;
  if (onlyA.length === 0 && onlyB.length === 0) rel = 'identical';
  else if (onlyB.length === 0) rel = 'superset';   // a 完全包含 b（a 更全）
  else if (onlyA.length === 0) rel = 'prefix';     // a 是 b 的前缀（b 更全）
  else rel = 'fork';                               // 两边互有对方没有的事件 —— 真分叉
  return {
    relation: rel,
    onlyA: onlyA.length,
    onlyB: onlyB.length,
    sampleOnlyA: onlyA.slice(0, 5),
    sampleOnlyB: onlyB.slice(0, 5)
  };
}

function seqSetOf(file) {
  const buf = fs.readFileSync(file);
  const text = decompressAllFrames(buf).toString('utf8');
  const lines = text.split('\n').filter((l) => l.trim() !== '');
  const seqs = [];
  for (let i = 1; i < lines.length; i++) {
    try { const r = JSON.parse(lines[i]); if (typeof r.seq === 'number') seqs.push(r.seq); } catch { }
  }
  return seqs;
}

const args = process.argv.slice(2).filter(Boolean);
if (args.length === 0) {
  console.error('用法：node check-session-log.mjs <log> [<对比 log>]');
  process.exit(2);
}

let rc = 0;
const out = {};
try {
  const a = analyze(args[0]);
  a.seqSet = seqSetOf(args[0]);
  out.self = { file: args[0], ok: a.ok, bytes: a.bytes, rows: a.rows, seqFirst: a.seqFirst, seqTail: a.seqTail, gaps: a.gaps, header: a.header };
  if (!a.ok) rc = 1;
  if (args[1]) {
    const b = analyze(args[1]);
    b.seqSet = seqSetOf(args[1]);
    out.other = { file: args[1], ok: b.ok, bytes: b.bytes, rows: b.rows, seqFirst: b.seqFirst, seqTail: b.seqTail, gaps: b.gaps };
    out.compare = relation(a, b);
    if (out.compare.relation === 'fork') rc = 1;
  }
} catch (e) {
  out.error = e.message;
  rc = 2;
}
console.log(JSON.stringify(out, null, 2));
process.exit(rc);
