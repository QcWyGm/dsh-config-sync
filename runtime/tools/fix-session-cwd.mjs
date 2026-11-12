// 修正会话日志头部的 cwd —— 跨机还原会话的必要一步。
//
// 背景：DSH 把会话存在 <home>\sessions\<编码目录名>\<会话>\session.v4.jsonl.zstd，
// 目录名由「工作区绝对路径」编码而来；同时会话文件第一行 header 里还存着 cwd。
// 换机器/换盘后目录名按本机路径重新编码，但文件里的 cwd 仍是源机路径，
// DSH 校验两者不一致 → 判定 corrupt session log → sessionController 起不来 →
// 工作区/会话列表全空、界面报 "web boot: 1 entry did not activate"。
//
// ⚠ 关键：这些 .zstd 是**追加写入的多帧文件**（一个事件一帧，几百上千帧），
// 而 Node 的 zstdDecompressSync / createZstdDecompress 都**只解第一帧**。
// 若按"解压全文 → 改 header → 整文件重新压缩"来做，第二帧起的内容会被全部丢掉
// （文件从 900 KB 缩成 200 字节，会话只剩一个空壳）。所以这里只重写第一帧：
// 用二分找出第一帧的结束偏移，替换该帧，后面的字节原样保留。
//
// 用法：node fix-session-cwd.mjs <spec.json> [结果输出文件]
//   spec.json = { "home": "<DSH home>", "dirs": { "<编码目录名>": "<本机工作区路径>" } }
// 只改 header 的 cwd，正文一帧都不动；已正确则跳过（幂等）。
//
// 第三个参数是给「客户端自带 Electron 当 node 跑」（ELECTRON_RUN_AS_NODE=1）用的：
// Electron 是 GUI 子系统程序，stdout 抓不到，结果必须落到文件里由 PowerShell 读。

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const specPath = process.argv[2];
const outPath = process.argv[3] || '';
if (!specPath) {
  console.error('用法：node fix-session-cwd.mjs <spec.json> [out.json]');
  process.exit(2);
}
const emit = (obj) => {
  const text = JSON.stringify(obj);
  if (outPath) {
    try { fs.writeFileSync(outPath, text, 'utf8'); } catch { console.log(text); }
  } else {
    console.log(text);
  }
};
if (typeof zlib.zstdDecompressSync !== 'function' || typeof zlib.zstdCompressSync !== 'function') {
  console.error(`当前 Node ${process.version} 不支持 zstd，无法修正会话头部`);
  process.exit(2);
}

const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
const home = String(spec.home || '').replace(/\//g, '\\').replace(/\\+$/, '');
const dirs = spec.dirs || {};
const sessionsRoot = path.join(home, 'sessions');

const result = { fixed: 0, alreadyOk: 0, missing: 0, failed: [] };

/** 第一帧解出来的文本（多帧文件也只返回第一帧）。 */
function decodeFirstFrame(buf) {
  return zlib.zstdDecompressSync(buf);
}

/** 二分找第一帧的结束偏移：前缀能解出与整文件相同的首帧文本，即为「够长」。 */
function firstFrameEnd(buf, expected) {
  let lo = 1;
  let hi = buf.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    let ok = false;
    try {
      ok = decodeFirstFrame(buf.subarray(0, mid)).equals(expected);
    } catch {
      ok = false;
    }
    if (ok) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

if (!fs.existsSync(sessionsRoot)) {
  emit(result);
  process.exit(0);
}

for (const [dirName, cwd] of Object.entries(dirs)) {
  const dirPath = path.join(sessionsRoot, dirName);
  if (!fs.existsSync(dirPath)) { result.missing++; continue; }
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = path.join(dirPath, entry.name, 'session.v4.jsonl.zstd');
    if (!fs.existsSync(file)) continue;
    try {
      const buf = fs.readFileSync(file);
      const first = decodeFirstFrame(buf);
      const nl = first.indexOf(0x0a);
      if (nl < 0) throw new Error('第一帧里没有 header 行');
      const header = JSON.parse(first.subarray(0, nl).toString('utf8'));
      if (header.cwd === cwd) { result.alreadyOk++; continue; }

      header.cwd = cwd;
      const newFrame = zlib.zstdCompressSync(Buffer.from(JSON.stringify(header) + '\n', 'utf8'));
      const rest = buf.subarray(firstFrameEnd(buf, first));
      const rebuilt = Buffer.concat([newFrame, rest]);
      if (rebuilt.length + 64 < buf.length) {
        throw new Error(`重写后变小（${buf.length} → ${rebuilt.length}），正文可能被丢，已跳过`);
      }
      fs.writeFileSync(file, rebuilt);

      const verifyText = decodeFirstFrame(fs.readFileSync(file)).toString('utf8');
      const verifyHeader = JSON.parse(verifyText.slice(0, verifyText.indexOf('\n')));
      if (verifyHeader.cwd !== cwd) throw new Error('写回后校验失败');
      result.fixed++;
    } catch (e) {
      result.failed.push({ file, error: e.message });
    }
  }
}

emit(result);
process.exit(result.failed.length ? 1 : 0);
