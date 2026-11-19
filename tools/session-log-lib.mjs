// 会话日志（session.v*.jsonl.zstd）底层读写库
//
// 背景：这份文件是 append-only 的**多帧 zstd**。首帧是 header（一行 JSON），之后是事件行，
// 每行带连续 seq。实测 11MB 的日志里 6884 帧装了 10776 个事件 —— 写入侧会把多个事件压进同一帧，
// 所以「一帧一个事件」的假设不成立，读正文必须逐行解析。
//
// 切帧办法：
//   A) 二分逐帧试解 —— 1 万帧 × 24 次试解，10MB 要 11 秒，太慢，不能进同步热路径。
//   B) 扫描帧魔数 28 B5 2F FD 当候选，逐候选验证「切出来能解且解完是完整行」。
//      随机数据命中魔数概率约 1/2^32，12MB 期望 0.003 次，误判由验证兜掉。
//      每帧只解一次 = O(n) 原生解压。本库用 B：12MB 全解析约 640ms。
//
// 判定原则（append-only 的硬性质）：
//   同源两份日志去掉首帧（首帧 cwd 会被归一成占位符，字节不同）后，短的那份必然是长的那份的
//   **字节前缀**。于是只需一次 memcmp：
//     identical / 一方是另一方前缀 → 同源，保留更长的那份，零风险
//     互不为前缀                   → 可能分叉（也可能只是帧边界重压过），再用 seq 集合判断：
//                                     一方 seq 是另一方子集 → 仍是同源，取超集
//                                     两边各有对方没有的 seq → 真分叉，按 seq 求并集
//
// 导出的主要函数见各段注释。

import fs from 'node:fs';
import zlib from 'node:zlib';

const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd];

export function isFrameMagic(buf, i) {
  return (
    i + 4 <= buf.length &&
    buf[i] === ZSTD_MAGIC[0] &&
    buf[i + 1] === ZSTD_MAGIC[1] &&
    buf[i + 2] === ZSTD_MAGIC[2] &&
    buf[i + 3] === ZSTD_MAGIC[3]
  );
}

/**
 * 找第一帧（header）的结束偏移。
 * 注意：不能靠「zstdDecompressSync(buf) 成功」来判断「整份只有一帧」—— Node 的
 * zstdDecompressSync 遇到多帧缓冲会忽略后续帧并返回第一帧内容，据此返回 buf.length
 * 会把 rest 判成空。所以这里只做「下一个魔数位置能切出完整行」的精确判定，判不出来就 -1。
 */
export function firstFrameEnd(buf) {
  if (!isFrameMagic(buf, 0)) return -1;
  for (let i = 1; i + 4 <= buf.length; i++) {
    if (!isFrameMagic(buf, i)) continue;
    for (const plus of [0, 4, 8]) {
      const e = i + plus;
      if (e > buf.length) continue;
      try {
        const out = zlib.zstdDecompressSync(buf.subarray(0, e));
        if (out.length > 0 && out[out.length - 1] === 0x0a) return e;
      } catch {
        /* 假帧头或 checksum 未计入，试下一个偏移 */
      }
    }
  }
  return -1;
}

/** 扫描候选帧头并验证，返回真实帧边界 */
export function splitFrames(buf) {
  if (buf.length === 0) return [];
  if (!isFrameMagic(buf, 0)) throw new Error('not a zstd frame stream (bad magic at byte 0)');

  const cands = [0];
  for (let i = 1; i + 4 <= buf.length; i++) {
    if (buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd) cands.push(i);
  }
  cands.push(buf.length);

  const frames = [];
  let start = 0;
  for (let k = 1; k < cands.length; k++) {
    const end = cands[k];
    if (end <= start) continue;
    const slice = buf.subarray(start, end);
    let ok = false;
    let decoded = null;
    try {
      decoded = zlib.zstdDecompressSync(slice);
      ok = decoded.length > 0 && decoded[decoded.length - 1] === 0x0a;
    } catch {
      ok = false;
    }
    const isLast = k === cands.length - 1;
    if (ok) {
      frames.push({ start, end, data: slice, decoded });
      start = end;
      continue;
    }
    if (isLast) {
      // 末帧：可能带 4 字节 checksum 未计入，也可能就是尾巴不完整
      let fixed = null;
      for (const plus of [4, 8]) {
        const e = end + plus;
        if (e > buf.length) continue;
        try {
          const out = zlib.zstdDecompressSync(buf.subarray(start, e));
          if (out.length > 0) {
            fixed = { start, end: e, data: buf.subarray(start, e), decoded: out };
            break;
          }
        } catch {
          /* 继续 */
        }
      }
      if (fixed) {
        frames.push(fixed);
        start = fixed.end;
      } else if (decoded !== null) {
        frames.push({ start, end, data: slice, decoded });
        start = end;
      } else {
        frames.push({ start, end, data: slice, decoded: null });
        start = end;
      }
    }
    // 非末帧且解码失败：假帧头，继续累积到下一个候选
  }
  if (start < buf.length) {
    let decoded = null;
    try {
      decoded = zlib.zstdDecompressSync(buf.subarray(start));
    } catch {
      decoded = null;
    }
    frames.push({ start, end: buf.length, data: buf.subarray(start), decoded });
  }
  return frames;
}

function frameText(frame) {
  if (frame.decoded) return frame.decoded.toString('utf8');
  return zlib.zstdDecompressSync(frame.data).toString('utf8');
}

/**
 * 解析整份日志。
 * 返回 { header, rows:[{ seq, text, frameIndex }], frames }
 *   rows[].text 是该事件的原始 JSON 行文本（merge 时逐行复用，保证内容不变）
 */
export function parseLog(buf) {
  const frames = splitFrames(buf);
  if (frames.length === 0) return { header: null, rows: [], frames };

  let header = null;
  let rowStart = 0;
  try {
    const first = frameText(frames[0]);
    const line = first.split('\n').find((l) => l.trim() !== '');
    if (line) {
      header = JSON.parse(line);
      rowStart = 1;
    }
  } catch {
    header = null;
    rowStart = 0;
  }

  const rows = [];
  for (let i = rowStart; i < frames.length; i++) {
    let text = null;
    try {
      text = frameText(frames[i]);
    } catch {
      text = null;
    }
    if (text === null) {
      rows.push({ seq: null, text: null, frameIndex: i });
      continue;
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let seq = null;
      try {
        const obj = JSON.parse(line);
        if (typeof obj.seq === 'number') seq = obj.seq;
      } catch {
        seq = null;
      }
      rows.push({ seq, text: line, frameIndex: i });
    }
  }
  return { header, rows, frames, headerText: header ? JSON.stringify(header) : null };
}

export function loadLog(path) {
  const buf = fs.readFileSync(path);
  const log = parseLog(buf);
  log.path = path;
  log.bytes = buf.length;
  log.buf = buf;
  return log;
}

/** 去掉首帧后的字节（跨机同源字节前缀判定用）。切不出首帧时返回 null。 */
export function restAfterHeader(buf) {
  const e = firstFrameEnd(buf);
  if (e <= 0) return null;
  if (e >= buf.length) return Buffer.alloc(0);
  return buf.subarray(e);
}

export function findGaps(rows) {
  const gaps = [];
  const seqs = [];
  for (const r of rows) if (typeof r.seq === 'number') seqs.push(r.seq);
  for (let i = 1; i < seqs.length; i++) {
    if (seqs[i] !== seqs[i - 1] + 1) gaps.push({ at: i, expected: seqs[i - 1] + 1, got: seqs[i] });
  }
  return { gaps, seqs, first: seqs.length ? seqs[0] : null, tail: seqs.length ? seqs[seqs.length - 1] : null };
}

export function seqTailOf(log) {
  for (let i = log.rows.length - 1; i >= 0; i--) {
    if (typeof log.rows[i].seq === 'number') return log.rows[i].seq;
  }
  return null;
}

/** 分块 memcmp。返回 { relation, divergeAt, aLen, bLen } */
export function compareRaw(a, b) {
  const n = Math.min(a.length, b.length);
  const CHUNK = 1 << 16;
  let i = 0;
  while (i < n) {
    const step = Math.min(CHUNK, n - i);
    if (a.compare(b, i, i + step, i, i + step) !== 0) {
      // 二分找第一个不同字节
      let lo = i;
      let hi = i + step - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (a.compare(b, i, mid + 1, i, mid + 1) === 0) lo = mid + 1;
        else hi = mid;
      }
      return { relation: 'fork', divergeAt: lo, aLen: a.length, bLen: b.length };
    }
    i += step;
  }
  if (a.length === b.length) return { relation: 'identical', aLen: a.length, bLen: b.length };
  if (a.length < b.length) return { relation: 'a_is_prefix_of_b', aLen: a.length, bLen: b.length };
  return { relation: 'b_is_prefix_of_a', aLen: a.length, bLen: b.length };
}

/** seq 集合关系：'equal'|'a_superset'|'b_superset'|'both_exclusive' */
export function compareSeqs(rowsA, rowsB) {
  const sa = new Set(rowsA.map((r) => r.seq).filter((s) => typeof s === 'number'));
  const sb = new Set(rowsB.map((r) => r.seq).filter((s) => typeof s === 'number'));
  const onlyA = [];
  const onlyB = [];
  for (const x of sa) if (!sb.has(x)) onlyA.push(x);
  for (const x of sb) if (!sa.has(x)) onlyB.push(x);
  let relation;
  if (onlyA.length === 0 && onlyB.length === 0) relation = 'equal';
  else if (onlyB.length === 0) relation = 'a_superset';
  else if (onlyA.length === 0) relation = 'b_superset';
  else relation = 'both_exclusive';
  return { relation, onlyA, onlyB, countA: sa.size, countB: sb.size };
}

/**
 * 按 seq 求并集，重建一份可读日志。
 *
 * 关键：**逐事件重建**，不复用整帧。因为一帧可能装多个事件，若把「含 48,49,50 的帧」和
 * 「含 50 的帧」都拼进去，输出里 seq 50 就出现两次，DSH 读到就是 expected 51 got 50。
 * 所以这里把每个事件的原始行文本单独压成一帧，保证 seq 严格单调 +1。
 */
export function mergeLogs(logA, logB, preferredHeader) {
  const bySeq = new Map();
  const conflicts = [];
  let anon = 0;

  const add = (log, tag) => {
    for (const r of log.rows) {
      if (r.text === null) continue;
      if (typeof r.seq !== 'number') {
        // 没有 seq 的行无法排序对账，只在没有同 seq 冲突时按出现顺序追加
        bySeq.set(`anon${anon++}`, { key: null, text: r.text, tag });
        continue;
      }
      const cur = bySeq.get(r.seq);
      if (!cur) {
        bySeq.set(r.seq, { key: r.seq, text: r.text, tag });
      } else if (cur.text !== r.text) {
        conflicts.push(r.seq);
      }
    }
  };
  add(logA, 'a');
  add(logB, 'b');

  const keys = [...bySeq.keys()];
  const numeric = keys.filter((k) => typeof k === 'number').sort((x, y) => x - y);
  const anonKeys = keys.filter((k) => typeof k !== 'number');

  const holes = [];
  for (let i = 1; i < numeric.length; i++) {
    if (numeric[i] !== numeric[i - 1] + 1) {
      holes.push({ after: numeric[i - 1], next: numeric[i], missing: numeric[i] - numeric[i - 1] - 1 });
    }
  }

  const headerText = preferredHeader || (logA.header ? JSON.stringify(logA.header) : logB.header ? JSON.stringify(logB.header) : null);
  const parts = [];
  if (headerText) parts.push(zlib.zstdCompressSync(Buffer.from(headerText + '\n', 'utf8')));
  for (const k of numeric) parts.push(zlib.zstdCompressSync(Buffer.from(bySeq.get(k).text + '\n', 'utf8')));
  for (const k of anonKeys) parts.push(zlib.zstdCompressSync(Buffer.from(bySeq.get(k).text + '\n', 'utf8')));

  return {
    buffer: Buffer.concat(parts),
    rows: numeric.length + anonKeys.length,
    seqFirst: numeric.length ? numeric[0] : null,
    seqTail: numeric.length ? numeric[numeric.length - 1] : null,
    holes,
    conflicts,
    fromA: [...bySeq.values()].filter((v) => v.tag === 'a').length,
    fromB: [...bySeq.values()].filter((v) => v.tag === 'b').length,
  };
}
