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

/** 首帧是否带 zstd content checksum（帧头描述符 FHD 的 bit2）。 */
function frameHasChecksum(buf) {
  return buf.length > 4 && ((buf.readUInt8(4) >> 2) & 1) === 1;
}

const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd];
const isFrameMagic = (b, i) => b[i] === 0x28 && b[i + 1] === 0xb5 && b[i + 2] === 0x2f && b[i + 3] === 0xfd;

/**
 * 第一帧的结束偏移（即下一帧的起点）。
 * 二分得到的是「最小可解前缀」——解压器只要能出数据就返回成功，
 * 所以带 content checksum 的帧会算短 4 字节（checksum 那段被当成可省）。
 * 不算这 4 字节就会把旧 checksum 留在文件里，DSH 读第二帧时报
 * "corrupt Zstandard session log: invalid frame magic at byte N"，连新建会话都失败。
 * 因此：先按 FHD 判断补 4 字节，再以「下一帧帧头」为准做一次校正。
 */
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
  const min = lo;
  const withChecksum = min + (frameHasChecksum(buf) ? 4 : 0);
  // 帧尾就落在 min / min+4 / min+4 后面紧跟帧头，三种情况都认；否则退回 min+4
  if (min >= buf.length || isFrameMagic(buf, min)) return min;
  if (withChecksum >= buf.length || isFrameMagic(buf, withChecksum)) return withChecksum;
  return Math.min(withChecksum, buf.length);
}

const projSpec = spec.projcache || {};
if (!fs.existsSync(sessionsRoot) && !Object.keys(projSpec).length) {
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

      const text = first.toString('utf8');
      // 只替换首帧里的 cwd 值，首帧其余文本（含可能的追加行）原样保留
      const newText = text.replace(/"cwd"\s*:\s*("(?:[^"\\]|\\.)*")/, `"cwd":${JSON.stringify(cwd)}`);
      const newFrame = zlib.zstdCompressSync(Buffer.from(newText, 'utf8'));
      let end = firstFrameEnd(buf, first);
      // 历史写坏的文件里，第一帧边界之后还残留着 4 字节旧 checksum，
      // 真正可用的下一帧在后面的帧头处——顺手把这段残缺尾巴丢掉（自愈）。
      if (end < buf.length && !isFrameMagic(buf, end)) {
        for (let k = end; k < Math.min(end + 9, buf.length); k++) {
          if (isFrameMagic(buf, k)) { end = k; break; }
        }
      }
      const rest = buf.subarray(end);
      if (rest.length && !isFrameMagic(rest, 0)) {
        throw new Error(`第一帧边界（${end}）之后不是 zstd 帧头，跳过以免写坏后续帧`);
      }
      const rebuilt = Buffer.concat([newFrame, rest]);
      if (rebuilt.length + 64 < buf.length) {
        throw new Error(`重写后变小（${buf.length} → ${rebuilt.length}），正文可能被丢，已跳过`);
      }
      // 先自检、后落盘：任何一项不过都不写文件
      const preText = decodeFirstFrame(rebuilt).toString('utf8');
      const preHeader = JSON.parse(preText.slice(0, preText.indexOf('\n')));
      if (preHeader.cwd !== cwd) throw new Error('自检失败：header.cwd 未生效，未写入');
      // 自检看的是「新首帧之后」，所以用新帧长度，不是旧文件的 end
      if (rebuilt.length > newFrame.length && !isFrameMagic(rebuilt, newFrame.length)) {
        throw new Error(`自检失败：第 ${newFrame.length} 字节处不是下一帧帧头，未写入`);
      }
      fs.writeFileSync(file, rebuilt);

      const verifyText = decodeFirstFrame(fs.readFileSync(file)).toString('utf8');
      const verifyHeader = JSON.parse(verifyText.slice(0, verifyText.indexOf('\n')));
      if (verifyHeader.cwd !== cwd) throw new Error('写回后校验失败：header.cwd 未生效');
      result.fixed++;
    } catch (e) {
      result.failed.push({ file, error: e.message });
    }
  }
}

// projcache（<home>\storages\session_projcache\sessions\<sessionId>.json）里也存着
// record.identity.cwd。它是纯 JSON，可以安全地只替换那一个字符串，其余字节不动。
// 不换的话，B 机打开这些会话时 cwd 仍指 A 机的目录，历史对话回不到正确工作区。
const projMap = projSpec;
const projDir = path.join(home, 'storages', 'session_projcache', 'sessions');
result.projFixed = 0;
result.projAlreadyOk = 0;
result.projFailed = [];
if (Object.keys(projMap).length && fs.existsSync(projDir)) {
  for (const entry of fs.readdirSync(projDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.json')) continue;
    const sid = entry.name.slice(0, -5);
    const target = projMap[sid];
    if (!target) continue;
    const file = path.join(projDir, entry.name);
    try {
      const text = fs.readFileSync(file, 'utf8');
      const doc = JSON.parse(text);
      const cur = doc && doc.record && doc.record.identity && doc.record.identity.cwd;
      if (typeof cur !== 'string') continue;
      if (cur === target) { result.projAlreadyOk++; continue; }
      // 只换第一处出现（record.identity.cwd 在文件靠前位置），其余字节原样保留
      const re = /"cwd"\s*:\s*("(?:[^"\\]|\\.)*")/;
      const m = re.exec(text);
      if (!m) throw new Error('找不到 identity.cwd 的字面位置');
      const from = m[1];
      const to = JSON.stringify(target);
      if (from === to) { result.projAlreadyOk++; continue; }
      const next = text.slice(0, m.index) + '"cwd": ' + to + text.slice(m.index + m[0].length);
      // 只在「内容真的没变」时算已正确。早先这里用 next.length === text.length 判等，
      // 两台机器路径长度相同时（D:\DeepSeekHarness → E:\DeepSeekHarness 这种）会把
      // 该改的文件误判成「本就正确」，cwd 就留在源机路径上（隔离环境实测抓到）。
      if (next === text) { result.projAlreadyOk++; continue; }
      fs.writeFileSync(file, next, 'utf8');
      const check = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (check.record.identity.cwd !== target) throw new Error('写回后校验失败');
      result.projFixed++;
    } catch (e) {
      result.projFailed.push({ file, error: e.message });
    }
  }
}

emit(result);
process.exit((result.failed.length || result.projFailed.length) ? 1 : 0);
