/**
 * 无 UI 环境下的宿主半身自检：
 *   node tools/selftest.mjs [repoPath]
 *
 * 用一个假 ctx 拉起 index.js 的 apply()，验证两件事：
 *   1. 两个路由都注册上了；
 *   2. GET /config-sync/status 返回合法 JSON（结构字段齐全）；
 *   3. POST /config-sync/prepare 能在仓库根生成 .cmd，且带进程检查与正确参数。
 * 不碰 DSH、不写 profile。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply } from '../index.js'

const repoArg = process.argv[2] || 'D:\\dsh-config'
const routes = new Map()

// prepare 写的是仓库根固定文件名。若那里已经有给用户用的真文件，先记下内容，断言完原样还原。
const FILE_NAME = { push: '同步-推送.cmd', pull: '同步-拉取.cmd', restore: '同步-还原.cmd' }
const backup = new Map()
for (const action of ['pull', 'push', 'restore']) {
  const file = join(repoArg, FILE_NAME[action])
  if (existsSync(file)) backup.set(file, readFileSync(file, 'utf8'))
}

const registered = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('apply() 没有注册任何路由（webServer 未被 inject？）')), 5000)
  const ctx = {
    inject: (names, cb) => {
      const scoped = {
        effect: (fn) => fn(),
        webServer: {
          register: (route) => {
            routes.set(route.path, route.handler)
            clearTimeout(timer)
            resolve(true)
            return () => { }
          },
        },
        logger: { warn: () => { } },
      }
      cb(scoped)
    },
  }
  try { apply(ctx, { repoPath: repoArg, profileName: 'desktop' }) } catch (e) { reject(e) }
})

function fakeRes() {
  const res = {
    statusCode: 200,
    headers: {},
    body: '',
    setHeader: (k, v) => { res.headers[k] = v },
    end: (chunk) => { if (chunk) res.body += chunk },
    destroy: () => { },
  }
  return res
}

function fakeReq({ method = 'GET', headers = {}, body = '' } = {}) {
  const handlers = {}
  const req = {
    method,
    headers,
    destroy: () => { },
    on: (event, fn) => { handlers[event] = fn; return req },
  }
  setImmediate(() => {
    if (body) handlers.data?.(body)
    handlers.end?.()
  })
  return req
}

function call(path, init) {
  const handler = routes.get(path)
  if (!handler) throw new Error(`路由未注册：${path}`)
  const res = fakeRes()
  const req = fakeReq(init)
  return new Promise((resolve) => {
    const done = () => resolve(res)
    const origEnd = res.end
    res.end = (chunk) => { origEnd(chunk); done() }
    handler(req, res)
  })
}

let failures = 0
function check(label, cond, detail = '') {
  if (cond) console.log(`  [OK] ${label}`)
  else { failures++; console.log(`  [X] ${label}${detail ? ' — ' + detail : ''}`) }
}

console.log('== dsh-config-sync 宿主半身自检 ==')
check('apply() 注册了路由', routes.size === 9 && routes.has('/config-sync/update') && routes.has('/config-sync/scope') && routes.has('/config-sync/conflict') && routes.has('/config-sync/roots') && routes.has('/config-sync/feedback'), `实际 ${routes.size} 条：${[...routes.keys()].join(', ')}`)

const status = await call('/config-sync/status', { headers: { host: 'localhost:3080' } })
const body = JSON.parse(status.body || '{}')
check('status 返回 200', status.statusCode === 200, String(status.statusCode))
check('status.ok === true', body.ok === true, status.body.slice(0, 160))
check('含 repo / version / bundles / deps / advice',
  Boolean(body.repo && body.version && body.bundles && body.deps && Array.isArray(body.advice)))
check('repo 探测到仓库', Boolean(body.repo?.exists), body.repo?.path || '(空)')
check('版本契约两个字段都读到',
  typeof body.version?.local === 'string' && typeof body.version?.contract === 'string',
  `${body.version?.local} / ${body.version?.contract}`)
check('bundle 数量与解析结果都在',
  typeof body.bundles?.total === 'number' && Array.isArray(body.bundles?.unresolved))
check('依赖缺失是数组', Array.isArray(body.deps?.missing))
check('status 带回备份快照地址', Boolean(body.backup && body.backup.latest), body.backup && body.backup.latest)
check('备份快照目录在本机真实存在', Boolean(body.backup && body.backup.latest && existsSync(body.backup.latest)), body.backup && body.backup.root)
console.log('  建议：' + (body.advice || []).join(' | '))
const latestSnapshot = (body.backup && body.backup.latest) || ''

function restoreCmd(file) {
  const before = backup.get(file)
  if (before === undefined) unlinkSync(file)
  else writeFileSync(file, before, 'utf8')
}

for (const action of ['pull', 'push', 'restore']) {
  const prepared = await call('/config-sync/prepare', {
    method: 'POST',
    headers: { host: 'localhost:3080', 'content-type': 'application/json' },
    body: JSON.stringify({ action }),
  })
  const payload = JSON.parse(prepared.body || '{}')
  check(`prepare(${action}) 返回 200 且 ok`, prepared.statusCode === 200 && payload.ok === true, prepared.body.slice(0, 160))
  check(`prepare(${action}) 写出了 cmd`, existsSync(payload.path || ''), payload.path || '(无路径)')
  check(`prepare(${action}) 的文件名是中文`, /[\\/][^\\/]*[\u4e00-\u9fa5][^\\/]*\.cmd$/.test(payload.path || ''), payload.path || '(无路径)')
  if (existsSync(payload.path || '')) {
    // prepare 会就地覆盖仓库根的 同步-推送/拉取/还原.cmd —— 那是给人用的真文件，
    // 自检只借用这条路径做断言，结束后必须还原成原样（没有过就删掉）。
    const text = readFileSync(payload.path, 'utf8')
    check(`cmd 里带进程检查`, /DeepSeek Harness\.exe/.test(text))
    // GIT_SSH_COMMAND 的第一个词必须是可执行程序/完整命令，绝不能以 -i 这种参数开头。
    // 踩过的坑：探测不到 ssh.exe 时拼出 `-i "key" -o …`，git 交给 sh 直接 invalid option。
    if (action !== 'restore' && /GIT_SSH_COMMAND=/.test(text)) {
      const line = text.split('\r\n').find((l) => l.includes('GIT_SSH_COMMAND=')) || ''
      const value = line.slice(line.indexOf('GIT_SSH_COMMAND=') + 'GIT_SSH_COMMAND='.length).trim()
      check(`GIT_SSH_COMMAND 以程序/命令开头（不是裸参数）`,
        !/^-/.test(value.replace(/^\s+/, '')),
        value.slice(0, 120))
    }
    if (action === 'restore') {
      check('还原 cmd 先 DryRun 再确认再真跑', /-DryRun/.test(text) && /set \/p GO=/.test(text) && text.includes('restore.ps1'))
      check('还原 cmd 里写着快照地址', Boolean(latestSnapshot) && text.includes(latestSnapshot), latestSnapshot || '(status 没给快照)')
      check('还原 cmd 把 -BackupDir 明写出来', text.includes(`-BackupDir "${latestSnapshot}"`), latestSnapshot || '(无)')
      check('prepare(restore) 响应里带快照字段', Boolean(payload.backup && payload.backup.dir), JSON.stringify(payload.backup || null))
    } else {
      check(`cmd 里调的是 sync.ps1 ${action}`, new RegExp(`sync\\.ps1".*${action}`).test(text))
      if (action === 'pull') {
        // pull 会覆盖本机配置，脚本必须在真跑之前要一次 y 确认
        check('pull cmd 里有确认守卫（set /p GO=）', /set \/p GO=/.test(text))
        check('pull cmd 说明"会覆盖本机配置"', text.includes('覆盖本机配置'))
        check('prepare(pull) 返回 warnings（本机领先时提示别点错）',
          Array.isArray(payload.warnings) && payload.warnings.length > 0,
          JSON.stringify(payload.warnings || null))
      } else {
        check(`prepare(${action}) 不需要确认守卫`, !/set \/p GO=/.test(text))
      }
      check(`prepare(${action}) 给了中文标签`, typeof payload.label === 'string' && /[\u4e00-\u9fa5]/.test(payload.label), payload.label || '(无)')
      check(`${action} cmd 用中文写动作名`,
        text.includes(action === 'push' ? '推送' : '拉取'),
        action)
    }
    check('cmd 用的是 CRLF', text.includes('\r\n'))
    restoreCmd(payload.path)
  }
}

// 一键生成三个：一次 POST 写出三份，且各自内容正确
const allRes = await call('/config-sync/prepare', {
  method: 'POST',
  headers: { host: 'localhost:3080', 'content-type': 'application/json' },
  body: JSON.stringify({ action: 'all' }),
})
const allPayload = JSON.parse(allRes.body || '{}')
check('prepare(all) 返回 200 且 ok', allRes.statusCode === 200 && allPayload.ok === true, allRes.body.slice(0, 160))
check('prepare(all) 一次写出三份脚本', Array.isArray(allPayload.built) && allPayload.built.length === 3, String(allPayload.built && allPayload.built.length))
check('prepare(all) 覆盖 push/pull/restore',
  Array.isArray(allPayload.built) && ['push', 'pull', 'restore'].every((a) => allPayload.built.some((b) => b.action === a)),
  JSON.stringify((allPayload.built || []).map((b) => b.action)))
check('prepare(all) 三份文件都真实存在',
  Array.isArray(allPayload.built) && allPayload.built.every((b) => existsSync(b.path || '')),
  JSON.stringify((allPayload.built || []).map((b) => existsSync(b.path || ''))))
check('prepare(all) 里 restore 那份带快照地址',
  Array.isArray(allPayload.built) && allPayload.built.some((b) => b.action === 'restore' && b.backup && b.backup.dir),
  JSON.stringify((allPayload.built || []).filter((b) => b.action === 'restore').map((b) => b.backup)))
for (const b of (allPayload.built || [])) restoreCmd(b.path)

const cross = await call('/config-sync/prepare', {
  method: 'POST',
  headers: { host: 'localhost:3080', origin: 'https://evil.example', 'content-type': 'application/json' },
  body: JSON.stringify({ action: 'push' }),
})
check('跨站请求被拒（403）', cross.statusCode === 403, String(cross.statusCode))

const bad = await call('/config-sync/prepare', {
  method: 'POST',
  headers: { host: 'localhost:3080', 'content-type': 'application/json' },
  body: JSON.stringify({ action: 'delete-everything' }),
})
check('非法 action 被拒（400）', bad.statusCode === 400, String(bad.statusCode))

// --- 云端仓库设置：展示字段 + 保存校验（只写本机设置文件，不动 git remote） ---
check('status 带回远端地址与私钥字段',
  Boolean(body.remote && typeof body.remote.url === 'string' && typeof body.remote.sshKey === 'string' && body.remote.settingsPath),
  JSON.stringify(body.remote && { url: body.remote.url, key: body.remote.sshKey, from: body.remote.sshKeyFrom }))
check('status 说得出云端仓库是否已配置', Boolean(body.remote) && typeof body.remote.configured === 'boolean', String(body.remote && body.remote.configured))
check('status 的私钥来源可解释', Boolean(body.remote && ['settings', 'default', 'none'].includes(body.remote.sshKeyFrom)), body.remote && body.remote.sshKeyFrom)

const settingsFile = body.remote.settingsPath
const prevSettings = existsSync(settingsFile) ? readFileSync(settingsFile, 'utf8') : null
const putSettings = (payload) => call('/config-sync/settings', {
  method: 'POST',
  headers: { host: 'localhost:3080', 'content-type': 'application/json' },
  body: JSON.stringify(payload),
})

// 非法地址
const badUrl = await putSettings({ remoteUrl: 'ftp://x/y', sshKey: body.remote.sshKey })
check('非法远端地址被拒（400）', badUrl.statusCode === 400, String(badUrl.statusCode))

// 不存在的私钥
const badKey = await putSettings({ remoteUrl: body.remote.url, sshKey: 'C:\\nope\\no.key' })
check('不存在的私钥被拒（400）', badKey.statusCode === 400, String(badKey.statusCode))

// 合法保存：沿用当前地址，所以不会触发 git remote set-url（自检不该改用户仓库）
const okSave = await putSettings({ remoteUrl: body.remote.url, sshKey: body.remote.sshKey })
const okPayload = JSON.parse(okSave.body || '{}')
check('合法设置保存成功', okSave.statusCode === 200 && okPayload.ok === true, okSave.body.slice(0, 160))
check('保存后不回写非当前地址（gitRemoteSet=false，自检不动仓库）', okPayload.gitRemoteSet === false, String(okPayload.gitRemoteSet))
check('保存后设置文件落盘', existsSync(settingsFile), settingsFile)
check('设置文件含 remoteUrl 字段', existsSync(settingsFile) && readFileSync(settingsFile, 'utf8').includes('remoteUrl'))

// 保存后再生成一次 push，确认私钥被接进脚本（此时设置文件里的 sshKey 已生效）
const again = await call('/config-sync/prepare', {
  method: 'POST',
  headers: { host: 'localhost:3080', 'content-type': 'application/json' },
  body: JSON.stringify({ action: 'push' }),
})
const againPayload = JSON.parse(again.body || '{}')
check('保存后再生成 push 成功', again.statusCode === 200 && againPayload.ok === true, again.body.slice(0, 160))
if (existsSync(againPayload.path || '')) {
  const text = readFileSync(againPayload.path, 'utf8')
  const keyInFile = okPayload.remote && okPayload.remote.sshKey
  check('push 脚本带 GIT_SSH_COMMAND', text.includes('GIT_SSH_COMMAND'))
  check('push 脚本里的私钥路径与设置一致', Boolean(keyInFile) && text.includes(keyInFile), keyInFile || '(无)')
  restoreCmd(againPayload.path)
}

// 设置里留着一条已失效的路径（目录被移走）时：必须报 exists=false 且不静默回退到自动探测
{
  const dead = mkdtempSync(join(tmpdir(), 'cfg-sync-dead-'))
  const currentRaw = existsSync(settingsFile) ? readFileSync(settingsFile, 'utf8') : null
  let prev = {}
  try { prev = currentRaw ? JSON.parse(currentRaw) : {} } catch { prev = {} }
  writeFileSync(settingsFile, JSON.stringify({ ...prev, repoPath: dead }, null, 2), 'utf8')
  const st = JSON.parse((await call('/config-sync/status', { headers: { host: 'localhost:3080' } })).body || '{}')
  check('失效路径下 exists=false（不假装仓库在）', st.repo && st.repo.exists === false, JSON.stringify(st.repo && { path: st.repo.path, exists: st.repo.exists, source: st.repo.source }))
  check('失效路径不会被静默换成自动探测的仓库', st.repo && st.repo.source === 'settings', String(st.repo && st.repo.source))
  const blocked = await call('/config-sync/prepare', {
    method: 'POST',
    headers: { host: 'localhost:3080', 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'restore' }),
  })
  // 路径不存在/还是空目录时按设计是允许生成的（新机器第一步 pull 会自动克隆），
  // 但必须带 bootstrap 说明，不能静默当作仓库已就绪。
  const blockedPayload = JSON.parse(blocked.body || '{}')
  check('失效路径下生成带 bootstrap 提示', blockedPayload.ok === true && Boolean(blockedPayload.bootstrap), blocked.body.slice(0, 160))
  if (currentRaw === null) { try { unlinkSync(settingsFile) } catch { } } else writeFileSync(settingsFile, currentRaw, 'utf8')
  rmSync(dead, { recursive: true, force: true })
}

// 还原设置文件（保存动作会覆盖它，用户可能本来就有内容）
if (prevSettings === null) { try { unlinkSync(settingsFile) } catch { } }
else writeFileSync(settingsFile, prevSettings, 'utf8')

// --- 仓库路径：可配置、默认只读、非法路径要拦、没配就生成不了 ---
check('status 带回仓库路径来源', Boolean(body.repo && ['settings', 'config', 'env', 'auto', 'none'].includes(body.repo.source)), body.repo && body.repo.source)
check('status 说得出仓库是否已配置', Boolean(body.repo) && typeof body.repo.configured === 'boolean', String(body.repo && body.repo.configured))

const badRepo = await putSettings({ repoPath: 'C:\\nope\\not-a-repo' })
// 新机器上仓库还没克隆时，这个路径本来就不存在 —— 允许保存（等着首次拉取去克隆），不再当错误拦。
check('不存在的仓库路径可以保存（待克隆目标）', badRepo.statusCode === 200, String(badRepo.statusCode))

const notRepo = await putSettings({ repoPath: body.repo.path ? body.repo.path + '\\profile' : 'C:\\Windows' })
check('不像仓库的目录被拒（400）', notRepo.statusCode === 400, String(notRepo.statusCode))

const okRepo = await putSettings({ repoPath: body.repo.path })
const okRepoPayload = JSON.parse(okRepo.body || '{}')
check('合法仓库路径保存成功', okRepo.statusCode === 200 && okRepoPayload.ok === true, okRepo.body.slice(0, 160))
check('保存后设置文件里出现 repoPath', existsSync(settingsFile) && readFileSync(settingsFile, 'utf8').includes('repoPath'))

// 还原设置文件（保存动作会覆盖它，用户可能本来就有内容）
if (prevSettings === null) { try { unlinkSync(settingsFile) } catch { } }
else writeFileSync(settingsFile, prevSettings, 'utf8')

// --- 同步内容勾选（scope）：默认全勾；勾选落盘到本机 config-sync-scope.json（不进仓库） ---
// 这里会真的写用户的 scope 文件，所以先备份、断言完原样还原（和上面设置文件同一套做法）。
const dshHomeDir = dirname(settingsFile)
const scopeFile = join(dshHomeDir, 'config-sync-scope.json')
const prevScope = existsSync(scopeFile) ? readFileSync(scopeFile, 'utf8') : null
const scopeGet = await call('/config-sync/scope', { headers: { host: 'localhost:3080' } })
const scopeBody = JSON.parse(scopeGet.body || '{}')
check('scope 返回 200', scopeGet.statusCode === 200, String(scopeGet.statusCode))
check('scope 列出十组同步内容', Array.isArray(scopeBody.groups) && scopeBody.groups.length === 10, `${(scopeBody.groups || []).length} 组`)
check('scope 每组都带标题 / 说明 / 明细项',
  (scopeBody.groups || []).every((g) => g && typeof g.title === 'string' && typeof g.desc === 'string' && Array.isArray(g.items)),
  (scopeBody.groups || []).map((g) => g.id).join(', '))
check('没配过时默认全勾（组与明细都参与同步）', (scopeBody.groups || []).every((g) => g.enabled === true))
check('deleteCloud 默认关闭（取消勾选不删云端副本）', scopeBody.deleteCloud === false)
check('scope 带回本机文件路径（面板要显示出来）', Boolean(scopeBody.path && scopeBody.path.endsWith('config-sync-scope.json')), scopeBody.path || '(空)')

// 挑一个「本机真实存在、且允许单独排除」的明细项来测组内排除（不能用编出来的名字：
// 服务端会把不存在的排除项清掉，否则以后勾不回来——那反而会被判失败）
const exTarget = (scopeBody.groups || [])
  .filter((g) => g.id !== 'skills')
  .map((g) => ({ group: g.id, item: (g.items || []).find((i) => i.excludable !== false) }))
  .find((x) => Boolean(x.item)) || null
const groupsPayload = { skills: { enabled: false, excluded: [] } }
if (exTarget) groupsPayload[exTarget.group] = { enabled: true, excluded: [exTarget.item.id] }
const scopePost = await call('/config-sync/scope', {
  method: 'POST',
  headers: { host: 'localhost:3080', 'content-type': 'application/json' },
  body: JSON.stringify({ deleteCloud: true, groups: groupsPayload }),
})
const scopePostBody = JSON.parse(scopePost.body || '{}')
check('scope 保存返回 ok', scopePost.statusCode === 200 && scopePostBody.ok === true, scopePost.body.slice(0, 160))
check('scope 落盘到本机 config-sync-scope.json', existsSync(scopeFile), scopeFile)
check('落盘记住取消的组、组内排除项与 deleteCloud',
  existsSync(scopeFile) && (() => {
    try {
      const o = JSON.parse(readFileSync(scopeFile, 'utf8'))
      const okGroup = o.deleteCloud === true && o.groups?.skills?.enabled === false
      const okItem = !exTarget || (Array.isArray(o.groups?.[exTarget.group]?.excluded) && o.groups[exTarget.group].excluded.includes(exTarget.item.id))
      return okGroup && okItem
    } catch { return false }
  })(), scopeFile)
check('全勾的组不写进文件（默认就是全勾，文件只留差异）',
  existsSync(scopeFile) && !readFileSync(scopeFile, 'utf8').includes('"storages-record"'), scopeFile)
check('不存在的排除项会被清掉（免得以后看不见却一直挡着同步）',
  existsSync(scopeFile) && (() => {
    try {
      const o = JSON.parse(readFileSync(scopeFile, 'utf8'))
      const ids = []
      for (const [id, g] of Object.entries(o.groups || {})) for (const x of (g.excluded || [])) ids.push(`${id}:${x}`)
      const real = new Set()
      for (const g of (scopeBody.groups || [])) for (const i of (g.items || [])) real.add(`${g.id}:${i.id}`)
      return ids.every((x) => real.has(x))
    } catch { return false }
  })(), scopeFile)
const scopeAfter = JSON.parse((await call('/config-sync/scope', { headers: { host: 'localhost:3080' } })).body || '{}')
check('读回来的状态与保存的一致',
  (scopeAfter.groups || []).some((g) => g.id === 'skills' && g.enabled === false)
  && (!exTarget || (scopeAfter.groups || []).some((g) => g.id === exTarget.group && g.items.some((i) => i.id === exTarget.item.id && i.enabled === false))),
  (scopeAfter.groups || []).map((g) => `${g.id}:${g.enabled}`).join(', '))
if (prevScope === null) { try { unlinkSync(scopeFile) } catch { } } else writeFileSync(scopeFile, prevScope, 'utf8')

// --- 同步冲突清单：pull 被本机文件挡住时，脚本写清单、面板读清单、用户逐项选 ---
const conflictFile = join(dshHomeDir, 'sync-conflicts.json')
const prevConflict = existsSync(conflictFile) ? readFileSync(conflictFile, 'utf8') : null
// 真机上可能正躺着一份待处理的清单（那是用户的数据）：先挪开再测，finally 原样放回
if (prevConflict !== null) { try { unlinkSync(conflictFile) } catch { } }
try {
  const confEmpty = JSON.parse((await call('/config-sync/conflict', { headers: { host: 'localhost:3080' } })).body || '{}')
  check('冲突接口：没有清单时 exists=false，不报错', confEmpty.ok === true && confEmpty.exists === false,
    `exists=${confEmpty.exists}`)

  // 备份目录：本机 / 云端两份副本分目录存，同一相对路径一一对应
  const backupRoot = join(dshHomeDir, 'backups', 'conflict-selftest-拉取冲突-Pull-conflict')
  mkdirSync(join(backupRoot, '本机-Local', 'mnemon'), { recursive: true })
  mkdirSync(join(backupRoot, '云端-Cloud', 'mnemon'), { recursive: true })
  mkdirSync(join(backupRoot, '本机-Local', '__selftest-probe__'), { recursive: true })
  mkdirSync(join(backupRoot, '云端-Cloud', '__selftest-probe__'), { recursive: true })
  writeFileSync(join(backupRoot, '本机-Local', 'mnemon', 'a.json'), 'LOCAL-COPY')
  writeFileSync(join(backupRoot, '云端-Cloud', 'mnemon', 'a.json'), 'CLOUD-COPY')
  writeFileSync(join(backupRoot, '本机-Local', '__selftest-probe__', 'probe.txt'), 'FROM-LOCAL')
  writeFileSync(join(backupRoot, '云端-Cloud', '__selftest-probe__', 'probe.txt'), 'FROM-CLOUD')
  writeFileSync(join(backupRoot, '说明-README.txt'), 'DSH 配置同步 —— 拉取冲突备份\r\n', 'utf8')
  const probeDst = join(repoArg, '__selftest-probe__', 'probe.txt')

  writeFileSync(conflictFile, JSON.stringify({
    at: '2026-11-12 20:05:00',
    repo: repoArg,
    head: 'aaaaaaa',
    remoteHead: 'bbbbbbb',
    backupDir: backupRoot,
    items: [
      { path: 'mnemon/data/a.json', kind: 'untracked', localSize: 12, remoteSize: 20, binary: false, localPreview: 'L1', remotePreview: 'R1', localSaved: true, cloudSaved: true, choice: '' },
      { path: '__selftest-probe__/probe.txt', kind: 'modified', localSize: 10, remoteSize: 10, binary: false, localPreview: 'LP', remotePreview: 'RP', localSaved: true, cloudSaved: true, choice: '' },
    ],
  }, null, 2), 'utf8')

  const confGet = JSON.parse((await call('/config-sync/conflict', { headers: { host: 'localhost:3080' } })).body || '{}')
  check('冲突清单：GET 带回条目、两侧预览、备份目录与两份副本标记',
    confGet.ok === true && confGet.exists === true && (confGet.items || []).length === 2
    && confGet.items[0].localPreview === 'L1' && confGet.items[0].remotePreview === 'R1'
    && confGet.items[0].localSaved === true && confGet.items[0].cloudSaved === true
    && String(confGet.backupDir || '').endsWith('拉取冲突-Pull-conflict'),
    `${(confGet.items || []).length} 项`)

  const confPost = JSON.parse((await call('/config-sync/conflict', {
    method: 'POST',
    headers: { host: 'localhost:3080', 'content-type': 'application/json' },
    body: JSON.stringify({ items: [{ path: 'mnemon/data/a.json', choice: 'cloud' }] }),
  })).body || '{}')
  check('冲突清单：POST 保存选择（只覆盖传进来的项）',
    confPost.ok === true && confPost.total === 2 && confPost.chosen === 1 && confPost.pending === 1,
    `total=${confPost.total} chosen=${confPost.chosen} pending=${confPost.pending}`)
  const confOnDisk = JSON.parse(readFileSync(conflictFile, 'utf8'))
  check('冲突清单：选择落盘，未传的项保持原值',
    confOnDisk.items[0].choice === 'cloud' && confOnDisk.items[1].choice === '')

  const confUnknown = JSON.parse((await call('/config-sync/conflict', {
    method: 'POST',
    headers: { host: 'localhost:3080', 'content-type': 'application/json' },
    body: JSON.stringify({ items: [{ path: 'not/in/list.txt', choice: 'cloud' }] }),
  })).body || '{}')
  check('冲突清单：清单外的 path 被忽略（不让面板往 JSON 里塞任意路径）',
    confUnknown.ok === true && confOnDisk.items.every((it) => it.path !== 'not/in/list.txt')
    && JSON.parse(readFileSync(conflictFile, 'utf8')).items.length === 2)

  // 两份副本都能单独还原：写回的是同一相对路径，来源按 side 选
  const restoreLocal = JSON.parse((await call('/config-sync/conflict', {
    method: 'POST',
    headers: { host: 'localhost:3080', 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'restore', path: '__selftest-probe__/probe.txt', side: 'local' }),
  })).body || '{}')
  check('冲突清单：还原本机副本（side=local，写回工作区）',
    restoreLocal.ok === true && restoreLocal.side === 'local'
    && existsSync(probeDst) && readFileSync(probeDst, 'utf8') === 'FROM-LOCAL',
    restoreLocal.error || '')

  const restoreCloud = JSON.parse((await call('/config-sync/conflict', {
    method: 'POST',
    headers: { host: 'localhost:3080', 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'restore', path: '__selftest-probe__/probe.txt', side: 'cloud' }),
  })).body || '{}')
  check('冲突清单：还原云端副本（side=cloud，写回工作区）',
    restoreCloud.ok === true && restoreCloud.side === 'cloud'
    && existsSync(probeDst) && readFileSync(probeDst, 'utf8') === 'FROM-CLOUD',
    restoreCloud.error || '')

  const restoreMissing = JSON.parse((await call('/config-sync/conflict', {
    method: 'POST',
    headers: { host: 'localhost:3080', 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'restore', path: 'mnemon/data/a.json', side: 'cloud' }),
  })).body || '{}')
  check('冲突清单：备份里缺某一侧副本时明确报错，不假装成功',
    restoreMissing.ok === false && /云端副本/.test(String(restoreMissing.error || '')))

  const confReset = JSON.parse((await call('/config-sync/conflict', {
    method: 'POST',
    headers: { host: 'localhost:3080', 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'reset' }),
  })).body || '{}')
  check('冲突清单：放弃清单会删掉文件', confReset.ok === true && confReset.cleared === true && !existsSync(conflictFile))

  const statusConf = JSON.parse((await call('/config-sync/status', { headers: { host: 'localhost:3080' } })).body || '{}')
  check('status 带回冲突概要（面板据此决定是否显示这张卡）',
    statusConf.conflicts && statusConf.conflicts.exists === false && typeof statusConf.conflicts.total === 'number',
    JSON.stringify(statusConf.conflicts || null))
} finally {
  if (prevConflict === null) { try { unlinkSync(conflictFile) } catch { } } else writeFileSync(conflictFile, prevConflict, 'utf8')
  try { rmSync(join(repoArg, '__selftest-probe__'), { recursive: true, force: true }) } catch { }
  try { rmSync(backupRoot, { recursive: true, force: true }) } catch { }
}
// --- 必需组：profile 是 apply 的前置条件（缺了直接 Die），所以不许取消勾选 ---
const reqPost = await call('/config-sync/scope', {
  method: 'POST',
  headers: { host: 'localhost:3080', 'content-type': 'application/json' },
  body: JSON.stringify({ deleteCloud: false, groups: { profile: { enabled: false, excluded: ['package.json'] } } }),
})
check('必需组不能取消：POST 关掉 profile 也不落盘',
  reqPost.statusCode === 200
  && (!existsSync(scopeFile) || !readFileSync(scopeFile, 'utf8').includes('"profile"')),
  existsSync(scopeFile) ? readFileSync(scopeFile, 'utf8').slice(0, 120) : '(文件不存在)')
const reqAfter = JSON.parse((await call('/config-sync/scope', { headers: { host: 'localhost:3080' } })).body || '{}')
const profileGroup = (reqAfter.groups || []).find((g) => g.id === 'profile') || {}
check('回读里 profile 仍是勾选、并标了 required',
  profileGroup.enabled === true && profileGroup.required === true,
  `enabled=${profileGroup.enabled} required=${profileGroup.required}`)
check('其余组没有 required 标记（只有真正会报错的那组被钉死）',
  (reqAfter.groups || []).filter((g) => g.id !== 'profile').every((g) => g.required !== true))
if (prevScope === null) { try { unlinkSync(scopeFile) } catch { } } else writeFileSync(scopeFile, prevScope, 'utf8')
// D:\dsh-config，所以这里退一步做静态断言——宿主源码里确实有这道守卫，且提示指向面板。
{
  const here = dirname(fileURLToPath(import.meta.url))
  const src = readFileSync(join(here, '..', 'index.js'), 'utf8')
  check('宿主在没仓库时拒绝生成（有守卫）', src.includes('还没有配置仓库目录'), 'index.js')
  check('守卫提示指向面板「本机仓库」卡，而不是让人去改 cordis.patch.yml',
    /还没有配置仓库目录[\s\S]{0,160}本机仓库/.test(src), 'index.js')
  check('云端仓库没配时也拒绝生成推送/拉取（有守卫）', src.includes('还没有配置云端仓库地址'), 'index.js')
  check('还原不受云端仓库影响（守卫排除 restore）', /action !== 'restore'/.test(src), 'index.js')
  check('仓库没有 origin 时会 remote add（而不是 set-url 失败）', /'remote', 'add', 'origin'/.test(src), 'index.js')
  // 「只装了插件、仓库还没克隆」也要能生成脚本：执行体退回插件自带的 runtime。
  check('生成脚本时执行体有 runtime 兜底', /pluginRoot\(\)[\s\S]{0,80}'runtime'/ .test(src) || /'runtime', name/.test(src), 'index.js')
  check('仓库未克隆时返回 bootstrap 提示', src.includes('bootstrap'), 'index.js')
  // 同一份 selftest 会跑在两种布局里：发布仓库（<root>\tools\ + <root>\runtime\）
  // 和配置仓库里的 plugin\dsh-config-sync\tools\（<root>\sync.ps1 + <root>\tools\）。
  // 所以这里按实际文件探测，而不是写死向下几层。
  const pluginRoot = existsSync(join(here, '..', 'package.json')) ? join(here, '..') : join(here, '..', '..')
  const repoRoot = join(here, '..', '..', '..')
  const packScript = [join(pluginRoot, 'tools', 'pack-plugin.ps1'), join(repoRoot, 'tools', 'pack-plugin.ps1')].find((p) => existsSync(p)) || ''
  check('打包脚本会把 ps1 打进 runtime', Boolean(packScript), packScript || 'tools/pack-plugin.ps1')
  const syncScript = [join(pluginRoot, 'runtime', 'sync.ps1'), join(pluginRoot, 'sync.ps1'), join(repoRoot, 'runtime', 'sync.ps1')].find((p) => existsSync(p)) || ''
  check('sync.ps1 支持首次自动初始化仓库', Boolean(syncScript) && readFileSync(syncScript, 'utf8').includes('Initialize-RepoIfNeeded'), syncScript || 'sync.ps1')
  // 冲突备份要「两份副本 + 中英文说明」，面板才能对哪一份都执行还原
  const syncSrc = syncScript ? readFileSync(syncScript, 'utf8') : ''
  check('冲突备份：本机/云端两份副本分目录（目录名带中英文）',
    syncSrc.includes('本机-Local') && syncSrc.includes('云端-Cloud'), syncScript || 'sync.ps1')
  check('冲突备份：云端副本按字节落盘（cat-file blob + cmd 重定向，不过 PowerShell 转码）',
    syncSrc.includes('Save-BlobToFile') && /cat-file blob/.test(syncSrc), 'sync.ps1')
  check('冲突备份：目录名写明用途（拉取冲突 / Pull conflict）',
    syncSrc.includes('拉取冲突-Pull-conflict'), 'sync.ps1')
  check('冲突备份：附中英双语说明文件与清单快照',
    syncSrc.includes('说明-README.txt') && syncSrc.includes('清单-Conflicts.json'), 'sync.ps1')
  check('冲突备份：每项都记录两份副本是否备份成功（面板据此置灰按钮）',
    syncSrc.includes('localSaved') && syncSrc.includes('cloudSaved'), 'sync.ps1')
  // 重启客户端必须脱离进度窗口的控制台/作业，否则手动关窗口会把刚重启的客户端一起带走。
  const postExit = [join(pluginRoot, 'runtime', 'post-exit.ps1'), join(pluginRoot, 'post-exit.ps1'), join(repoRoot, 'post-exit.ps1')].find((p) => existsSync(p)) || ''
  const postExitSrc = postExit ? readFileSync(postExit, 'utf8') : ''
  check('重启客户端走 explorer 代启（不被进度窗口连坐）',
    postExitSrc.includes('function Start-Detached') && /explorer\.exe/.test(postExitSrc) && postExitSrc.includes('Start-Detached $exe'),
    postExit || 'post-exit.ps1')

  // 进度窗口的收尾：推送/拉取完成后窗口留着等用户自己关（不自动消失），
  // 且客户端是在这之前由 explorer 拉起来的 —— 所以点 × 关掉窗口不会把客户端带走。
  check('推送/拉取完成后进度窗口不自动关闭（等按键或点 ×）',
    postExitSrc.includes("if ($Mode -eq 'pull' -or $Mode -eq 'push'") && postExitSrc.includes('RawUI.ReadKey'),
    postExit || 'post-exit.ps1')
  check('插件更新完成后窗口同样留着（不与同步窗口两套行为）',
    /-eq 'pull'.*?-eq 'push'.*?-eq 'update'/.test(postExitSrc) && postExitSrc.includes('插件更新已完成'),
    postExit || 'post-exit.ps1')
  check('客户端在窗口开始等待之前就已拉起（关窗口不影响它）',
    postExitSrc.indexOf('if ($Restart) { RestartClient }') > 0
      && postExitSrc.indexOf('if ($Restart) { RestartClient }') < postExitSrc.lastIndexOf('Finish 0'),
    postExit || 'post-exit.ps1')

  // 执行体优先级：仓库里那份 sync.ps1 是随配置仓库同步来的副本，插件升级后可能还是旧版；
  // 旧版没有冲突清单/exit 6，会把 pull 退回「直接 git pull + 失败回滚」——
  // 真实故障：面板 18 项全选「用云端」，清单读都没读就被旧执行体覆盖回滚。
  check('执行体选择：插件 runtime 优先、仓库副本兜底',
    postExitSrc.includes('function Find-PluginScript')
      && postExitSrc.indexOf('function Find-PluginScript') < postExitSrc.indexOf("$sync = Find-PluginScript 'sync.ps1'"),
    postExit || 'post-exit.ps1')
  check('仓库 sync.ps1 只作兜底（不得排在插件前面）',
    postExitSrc.indexOf("$sync = Find-PluginScript 'sync.ps1'") > 0
      && postExitSrc.indexOf("$sync = Find-PluginScript 'sync.ps1'") < postExitSrc.indexOf('if (-not $sync -and $RepoRoot)'),
    postExit || 'post-exit.ps1')

  // 更新源自检：raw.githubusercontent.com 在部分网络下直连不通，而 Node 的 fetch 不读系统代理，
  // 超时一到就 abort（面板上那句 "This operation was aborted"）。所以内置候选必须带实时反代排在前面。
  // 不要用 jsDelivr 兜清单：它对 @main 这类分支别名缓存很久，发版后仍返回上一版清单（实测 + purge 也没立刻刷新）。
  const indexSrc = readFileSync(join(pluginRoot, 'index.js'), 'utf8')
  check('更新清单带实时反代候选（gh-proxy 排在最前，raw 兜底）',
    indexSrc.includes('gh-proxy.com') && indexSrc.includes('ghfast.top') &&
    indexSrc.includes('UPDATE_MANIFEST_MIRRORS') && !indexSrc.includes('cdn.jsdelivr.net/gh/QcWyGm'),
    'index.js')
  check('清单按候选依次尝试并汇总失败原因', indexSrc.includes('async function fetchManifestAuto'), 'index.js')
  check('清单超时放宽到 30 秒（raw 慢链路 10 秒会假失败）',
    indexSrc.includes('UPDATE_FETCH_TIMEOUT = 30 * 1000'), 'index.js')
  // 0.3.7：更新拆成「只下载」和「退出后安装」两段。
  // 为什么：DSH 开着的时候覆盖插件目录，宿主会重新同步插件树、把「配置同步」面板卸载掉 ——
  // 用户看到的就是"更新到一半页面自己跳走，还得点回来才能按重启"。所以覆盖必须留到退出之后。
  check('宿主有「只下载」动作（prepare → update-staging，不碰插件目录）',
    indexSrc.includes("action === 'prepare'") && indexSrc.includes('async function downloadPackage') &&
    indexSrc.includes('update-staging'), 'index.js')
  check('只下载会按候选地址逐个试并校验 sha256',
    /function downloadPackage[\s\S]{0,1200}createHash\('sha256'\)/.test(indexSrc), 'index.js')
  check('宿主有「装并重启」动作（install-restart，把本地包交给退出后的脚本）',
    indexSrc.includes("action === 'install-restart'") &&
    /action === 'install-restart'[\s\S]{0,900}-UpdateTgz/.test(indexSrc), 'index.js')
  check('退出后的安装直接吃已下好的本地包（不重复下载）',
    postExitSrc.includes('Test-Path -LiteralPath $UpdateTgz -PathType Leaf'),
    postExit || 'post-exit.ps1')
  check('运行中静默安装仍保留给 CLI/兼容（界面不用它）',
    indexSrc.includes("action === 'install-live'") && indexSrc.includes('function runInstallPlugin'), 'index.js')
  check('只重启走 relaunch（不碰仓库也不装插件）',
    indexSrc.includes("mode: 'relaunch'") && postExitSrc.includes("'relaunch'"), postExit || 'post-exit.ps1')
  const installer = [join(pluginRoot, 'runtime', 'install-plugin.ps1'), join(pluginRoot, 'install-plugin.ps1')].find((p) => existsSync(p)) || ''
  const installerSrc = installer ? readFileSync(installer, 'utf8') : ''
  check('安装器存在并自报结果（RESULT: 行）', Boolean(installer) && installerSrc.includes('RESULT:'), installer || 'runtime/install-plugin.ps1')
  check('安装器覆盖前先备份、写坏能回滚',
    installerSrc.includes('function Restore-Backup') && installerSrc.includes('plugin-{0}-{1}'),
    installer || 'runtime/install-plugin.ps1')
  check('安装器按候选地址逐个下载', installerSrc.includes("-split '\\|'"), installer || 'runtime/install-plugin.ps1')
  const clientSrc = readFileSync(join(pluginRoot, 'client.js'), 'utf8')
  check('面板按钮走「下载更新 → 重启并安装」，不再运行中安装',
    clientSrc.includes("action: 'prepare'") && clientSrc.includes("action: 'install-restart'") &&
    !clientSrc.includes("action: 'install-live'") &&
    clientSrc.includes('重启并安装') && clientSrc.includes('Restart & install'), 'client.js')
  check('面板会展示「已下载，待安装」这一态',
    clientSrc.includes('preparedReady') && clientSrc.includes('已下载，待安装'), 'client.js')

  // 0.3.8：同步内容勾选 —— 面板写 <DshHome>\config-sync-scope.json，capture/apply 读同一个文件。
  // 关键契约：默认全勾、未勾选一律跳过、deleteCloud 默认关（关着时绝不删云端副本）。
  const pickRuntime = (name) => [join(pluginRoot, 'runtime', name), join(pluginRoot, name)].find((p) => existsSync(p)) || ''
  const commonSrc = pickRuntime('dsh-sync-common.ps1') ? readFileSync(pickRuntime('dsh-sync-common.ps1'), 'utf8') : ''
  const captureSrc = pickRuntime('capture.ps1') ? readFileSync(pickRuntime('capture.ps1'), 'utf8') : ''
  const applySrc = pickRuntime('apply.ps1') ? readFileSync(pickRuntime('apply.ps1'), 'utf8') : ''
  const pickTool = (name) => [join(pluginRoot, 'runtime', 'tools', name), join(pluginRoot, 'tools', name)].find((p) => existsSync(p)) || ''
  const helperSrc = pickTool('fix-session-cwd.mjs') ? readFileSync(pickTool('fix-session-cwd.mjs'), 'utf8') : ''
  // 执行体没跑起来时 PowerShell 只喷红字、$LASTEXITCODE 还是上一条命令残留的 0，
  // 整次同步就被当成成功（写 ok:true + 刷分水岭），本机改动静默滞留。三道锁缺一不可。
  check('调用执行体前压哨兵值，且终止错误被捕获后一律判失败',
    postExitSrc.includes('$LASTEXITCODE = -1')
      && postExitSrc.includes('$invokeOk = $false')
      && /catch \{[\s\S]{0,400}执行体调用异常/.test(postExitSrc)
      && /if \(-not \$invokeOk\)[\s\S]{0,260}\$code = 1/.test(postExitSrc),
    'post-exit.ps1')
  check('调用执行体前确认文件仍存在（安装覆盖到一半也能拦住）',
    /\$sync = Find-PluginScript 'sync\.ps1'[\s\S]{0,1200}Test-Path -LiteralPath \$sync/.test(postExitSrc),
    'post-exit.ps1')
  check('同步失败时不刷新同步分水岭（免得失败变成静默漏推）',
    postExitSrc.includes('RestartClient -SkipWatermark:$failed')
      && postExitSrc.includes('function RestartClient([switch]$SkipWatermark)')
      && /if \(-not \$SkipWatermark\)/.test(postExitSrc),
    'post-exit.ps1')

  const SCOPE_GROUPS = ['profile', 'prompt', 'skills', 'presets', 'storages-record', 'settings', 'mnemon', 'local-plugins', 'workspace', 'conversations']
  check('公共脚本提供 scope 读取与判断函数',
    ['Get-SyncScope', 'Test-SyncGroupEnabled', 'Test-SyncItemEnabled', 'Test-SyncDeleteCloud', 'Skip-SyncGroup', 'Skip-SyncItem']
      .every((n) => commonSrc.includes(`function ${n}`)), 'dsh-sync-common.ps1')
  check('scope 文件不存在时按全勾处理（老机器行为不变）',
    commonSrc.includes('config-sync-scope.json') && /function Get-SyncScope[\s\S]{0,700}Test-Path/.test(commonSrc),
    'dsh-sync-common.ps1')
  check('capture 十组都按勾选判断',
    SCOPE_GROUPS.every((g) => captureSrc.includes(`Test-SyncGroupEnabled $Scope '${g}'`)),
    SCOPE_GROUPS.filter((g) => !captureSrc.includes(`Test-SyncGroupEnabled $Scope '${g}'`)).join(', ') || 'capture.ps1')
  const EXCLUDABLE = ['skills', 'presets', 'settings', 'local-plugins', 'prompt', 'storages-record', 'workspace', 'conversations']
  check('capture 组内还能单独排除（skills / presets / settings / local-plugins / prompt / 台账 / 工作区 / 会话）',
    EXCLUDABLE.every((g) => captureSrc.includes(`Test-SyncItemEnabled $Scope '${g}'`)),
    EXCLUDABLE.filter((g) => !captureSrc.includes(`Test-SyncItemEnabled $Scope '${g}'`)).join(', ') || 'capture.ps1')
  check('apply 十组都按勾选跳过（未勾选的不还原）',
    SCOPE_GROUPS.every((g) => applySrc.includes(`Test-SyncGroupEnabled $Scope '${g}'`)),
    SCOPE_GROUPS.filter((g) => !applySrc.includes(`Test-SyncGroupEnabled $Scope '${g}'`)).join(', ') || 'apply.ps1')
  check('deleteCloud 默认关：关着时跳过就只是跳过，不删云端副本',
    /function Skip-SyncGroup[\s\S]{0,400}Test-SyncDeleteCloud/.test(commonSrc)
    && commonSrc.includes('if (-not (Test-SyncDeleteCloud $Scope)) { return }'), 'dsh-sync-common.ps1')
  check('apply 的 -PruneSkills 不会删掉被排除的本机 Skill',
    applySrc.includes("(Test-SyncItemEnabled $Scope 'skills' $_.Name)"), 'apply.ps1')
  check('会话按工作区过滤，且未勾选的会话不会被铺回本机',
    captureSrc.includes('$skipSessDirs') && applySrc.includes('$skipConvDirs'), 'capture/apply')
  check('工作区登记表也跟着过滤（不会「数据跳过了、登记表还写着」）',
    captureSrc.includes("$entries = @($entries | Where-Object { Test-SyncItemEnabled $Scope 'workspace' $_.Id })")
    && applySrc.includes("$plan = @($plan | Where-Object { Test-SyncItemEnabled $Scope 'workspace' $_.Id })"),
    'capture/apply')

  // apply 的非零退出码等同于「拉取失败」，post-exit 会据此回滚；
  // 所以「没有 pnpm」这种环境差异不能让整次拉取失败 —— 只要 node_modules 在，依赖就是好的。
  check('依赖已就绪时 apply 不因缺少 pnpm 而失败退出',
    applySrc.includes("Join-Path $ProfileDir 'node_modules'")
      && applySrc.includes('$skipBecauseReady'), 'apply.ps1')
  check('node_modules 不存在时仍然明确报错（不静默放过）',
    /if \(Test-Path -LiteralPath \$nodeModules\)[\s\S]{0,300}exit 1/.test(applySrc), 'apply.ps1')

  // 登记表：同一路径撞了两台机器各自建的 ID 时，必须保留当前机器在用的 ID，
  // 否则 defaultWorkspaceId 悬空、整张表校验不过（工作区列表空、会话读不出）。
  check('登记表同路径冲突时保留本机 ID（不是仓库 ID）',
    applySrc.includes('$localIdSet')
      && applySrc.indexOf('Where-Object { $localIdSet.ContainsKey($_) }')
         < applySrc.indexOf('Where-Object { $mfIdSet.ContainsKey($_) }'),
    'apply.ps1')
  check('defaultWorkspaceId 以本机为准（原值还在表里就不动）',
    applySrc.includes('$localDefault')
      && applySrc.includes('$ids -contains $localDefault')
      && applySrc.includes("$localGlobal['defaultWorkspaceId'] = $ids[0]"),
    'apply.ps1')

  // 会话还原的前提：能展开 {{APP_ROOT}} 占位符。做不到就别铺 —— 铺了 DSH 一个都不登记，
  // 用户看到的就是「工作区还在、会话全没了」（真实事故）。
  check('node 探测覆盖常见安装位置（不只有 PATH）',
    commonSrc.includes("nodejs\\node.exe")
      && commonSrc.includes('function Get-HostNodeExe'),
    'dsh-sync-common.ps1')
  check('找不到 Node 时跳过会话还原而不是铺坏文件',
    /if \(\$cwdMap\.Count -gt 0\) \{[\s\S]{0,400}跳过会话还原[\s\S]{0,200}return/.test(applySrc),
    'apply.ps1')
  check('会话还原用的是统一探测到的执行器（Node 或客户端 Electron）',
    applySrc.includes('$nodeRunner = Get-HostNodeRunner $AppRoot')
      && applySrc.includes('$nodeRunner.Electron')
      && commonSrc.includes('function Get-HostNodeRunner'),
    'apply.ps1')
  // 客户端 Electron 是 GUI 子系统，stdout 抓不到 —— 结果必须落文件，否则面板/日志永远报失败
  check('会话头部修正的结果写成文件（Electron 跑时 stdout 抓不到）',
    helperSrc.includes('const outPath = process.argv[3]')
      && helperSrc.includes('emit(result)')
      && applySrc.includes('$resultPath'),
    'fix-session-cwd.mjs')
  check('面板有「同步内容」卡：逐组勾选 + 展开明细 + deleteCloud 开关',
    clientSrc.includes('function ScopeCard') && clientSrc.includes('callScope(')
    && clientSrc.includes('同步内容') && clientSrc.includes('Sync content')
    && clientSrc.includes('取消勾选时顺手删掉云端副本'), 'client.js')
  // 必需组（profile）三处钉死：脚本侧判断、宿主保存、面板复选框
  check('必需组在脚本侧钉死（手改 JSON 关掉也按开启处理）',
    commonSrc.includes('$SyncRequiredGroups')
    && /function Test-SyncGroupEnabled[\s\S]{0,260}Test-SyncRequiredGroup/.test(commonSrc),
    'dsh-sync-common.ps1')
  check('必需组在宿主侧钉死（保存时拒绝写入关闭状态）',
    indexSrc.includes('SCOPE_REQUIRED_GROUPS')
    && /for \(const \[id, g\] of Object\.entries\(groupsIn\)\)[\s\S]{0,260}scopeGroupRequired\(id\)\) continue/.test(indexSrc),
    'index.js')
  check('必需组在面板上不可勾掉（复选框禁用 + 标注）',
    clientSrc.includes('g.required === true') && clientSrc.includes('必需内容'), 'client.js')
  // 只读优先：不做「勾一下就写盘」，要先点「修改」、再点「保存」
  check('面板默认只读：勾选前必须先点「修改」',
    clientSrc.includes('const [editing, setEditing]')
    && clientSrc.includes("disabled: busy || !editing")
    && clientSrc.includes("M('修改', 'Edit')")
    && /onClick: \(\) => save\(state\)/.test(clientSrc), 'client.js')
  // 展开/收起改成点整行，单独的「明细」按钮要消失
  check('取消「明细」按钮：展开收起靠点当前行',
    !clientSrc.includes("M('明细', 'Details')")
    && clientSrc.includes('onClick: canExpand')
    && clientSrc.includes("expanded ? '▾' : '▸'"), 'client.js')
  check('同步内容卡与问题反馈卡挂在页面最下面（其后不再有别的 Section）', (() => {
    // 顺序：概览 → 同步目标 → 自动化与插件更新 → 退出后执行 → 还原备份 → 同步内容 → 问题反馈；
    // 判据是「顺序」而不是写死紧跟，中间还会插卡（本机路径就插在同步目标之前）。
    const order = ["概览", "同步目标", "自动化与插件更新", "退出后执行", "还原备份", "同步内容", "问题反馈"]
      .map((k) => ({ k, at: clientSrc.indexOf(`Section(M('${k}'`) }))
    if (order.some((p) => p.at < 0)) return false
    if (!order.every((p, i) => (i === 0 ? true : p.at > order[i - 1].at))) return false
    // 问题反馈必须是最后一个 Section
    const tail = clientSrc.slice(order[order.length - 1].at + 1)
    return !/Section\(M\(/.test(tail)
  })(), 'client.js')
  // 「还原备份」卡：地址可改（留空=默认）、列出快照、点「立即还原」先出确认框再排队
  check('控件：还原备份卡有备份目录、快照列表与立即还原',
    clientSrc.includes('backupRoot') && clientSrc.includes('backup.snapshots')
    && clientSrc.includes("M('立即还原', 'Restore now')") && clientSrc.includes("M('还原备份', 'Restore backup')"), 'client.js')
  check('控件：还原先弹确认（差异预览）再排队，不是点了就动手',
    clientSrc.includes("action: 'restore-preview'") && clientSrc.includes("action: 'restore-now'")
    && clientSrc.includes('askRestore') && clientSrc.includes('doRestore')
    && clientSrc.includes('pvRemovePlugins') && clientSrc.includes('pvRemoveFiles'), 'client.js')
  check('控件：快照行显示相对时间与插件数',
    clientSrc.includes('const rel = (at)') && clientSrc.includes('${s.plugins ? ` · ${s.plugins} 个插件`'), 'client.js')

  // 0.3.25 起「还原」与「立即拉取」共用一条流水线：面板排队 → 客户端退出 → 可见进度窗口执行 → 自动重启
  const restoreScript = [join(pluginRoot, 'runtime', 'restore.ps1'), join(repoRoot, 'restore.ps1')].find((p) => existsSync(p)) || ''
  const restoreSrc = restoreScript ? readFileSync(restoreScript, 'utf8') : ''
  check('post-exit 有 restore 分支：执行体是 restore.ps1，且必须带 -RollbackToPoint',
    postExitSrc.includes("if ($Mode -eq 'restore')")
    && postExitSrc.includes("Find-PluginScript 'restore.ps1'")
    && postExitSrc.includes('RollbackToPoint = $true'), postExit || 'post-exit.ps1')
  check('post-exit 的 restore 分支沿用同一套返回码判据（哨兵 -1 + 没跑完即失败）',
    /if \(\$Mode -eq 'restore'\)[\s\S]{0,3000}?\$LASTEXITCODE = -1/.test(postExitSrc)
    && /if \(\$Mode -eq 'restore'\)[\s\S]{0,3500}?执行体没有正常跑完/.test(postExitSrc),
    'post-exit.ps1')
  check('post-exit 的 restore 分支有专属收尾文案',
    postExitSrc.includes('完成（已还原）') && postExitSrc.includes('还原失败'), 'post-exit.ps1')
  check('restore.ps1 提供 -RollbackToPoint 时点回退',
    restoreSrc.includes('[switch]$RollbackToPoint') && restoreSrc.includes('3.5 时点回退'), 'restore.ps1')
  check('时点回退：撤走的插件只删 junction 链接（不穿进去删目标）',
    /if \(\$item\.LinkType\)[\s\S]{0,220}\[IO\.Directory\]::Delete/.test(restoreSrc.replace(/\r/g, '')), 'restore.ps1')
  check('时点回退：写 rollback-manifest.json（可再还原，不留糊涂账）',
    restoreSrc.includes('rollback-manifest.json') && restoreSrc.includes('rollback\\files'), 'restore.ps1')
  check('时点回退：相对路径基准先归一成完整路径（避免 8.3 短名算错）',
    restoreSrc.includes('(Get-Item -LiteralPath $ProfileDir -Force).FullName'), 'restore.ps1')
  check('备份列表带插件数（面板要显示 N 个插件）',
    indexSrc.includes('plugins = Object.keys(pkg?.dependencies') && indexSrc.includes('plugins: x.plugins'), 'index.js')
  check('restore-now 复用 spawnWatcher，并把快照目录带进执行体',
    /action === 'restore-now'[\s\S]{0,900}?spawnWatcher\(\{[\s\S]{0,220}?mode: 'restore'/.test(indexSrc)
    && indexSrc.includes("extraArgs: ['-BackupDir', backupDir]"), 'index.js')
  check('restore-preview 与 prepare 共用同一套快照校验（口径不漂移）',
    indexSrc.includes('function resolveSnapshotDir')
    && (indexSrc.match(/resolveSnapshotDir\(dshHome, body\.backupDir\)/g) || []).length >= 2, 'index.js')
  check('还原不需要仓库也能排队（只动本机快照）',
    /const isRestore = action === 'restore-now'/.test(indexSrc) && /if \(!repo && !isRestore\) throw/.test(indexSrc), 'index.js')
}

// 提交说明：面板里填的那句要进 push 脚本，时间由 sync.ps1 执行时追加
const noted = await call('/config-sync/prepare', {
  method: 'POST',
  headers: { host: 'localhost:3080', 'content-type': 'application/json' },
  body: JSON.stringify({ action: 'push', message: '修 侧栏入口 "和" 特殊字符' }),
})
const notedPayload = JSON.parse(noted.body || '{}')
check('prepare(push) 接受提交说明', noted.statusCode === 200 && notedPayload.ok === true, noted.body.slice(0, 160))
check('提交说明进了脚本（-Message）', existsSync(notedPayload.path || '') && readFileSync(notedPayload.path, 'utf8').includes('-Message'))
check('提交说明里的双引号被清洗掉',
  Boolean(notedPayload.message) && !notedPayload.message.includes('"'),
  notedPayload.message || '(无)')
if (existsSync(notedPayload.path || '')) restoreCmd(notedPayload.path)
const pullNote = await call('/config-sync/prepare', {
  method: 'POST',
  headers: { host: 'localhost:3080', 'content-type': 'application/json' },
  body: JSON.stringify({ action: 'pull', message: '不该进拉取脚本' }),
})
const pullNotePayload = JSON.parse(pullNote.body || '{}')
check('拉取脚本不吃提交说明',
  existsSync(pullNotePayload.path || '') && !readFileSync(pullNotePayload.path, 'utf8').includes('不该进拉取脚本'),
  pullNotePayload.path || '(无)')
if (existsSync(pullNotePayload.path || '')) restoreCmd(pullNotePayload.path)

// 配置仓库根目录那 6 个执行体，是「插件还没装 / 正在升级」时的兜底副本。
// 它们一直靠人工同步，结果漂成半新半旧：sync/apply/common/post-exit 已升到 0.3.23，
// capture/restore 还停在两天前的旧版 —— 平时不显形，只有 pull 真正走进「仓库副本」
// 那条兜底路才会跑到旧逻辑。所以按字节比对，漂了就报，不再指望人记得。
console.log('')
console.log('== 配置仓库执行体副本一致性 ==')
const execNames = ['apply.ps1', 'capture.ps1', 'dsh-sync-common.ps1', 'post-exit.ps1', 'restore.ps1', 'sync.ps1']
// 两种布局都认：发布仓库（<root>\runtime）与配置仓库里的 plugin\ 镜像（<root>\runtime）
const hereSelf = dirname(fileURLToPath(import.meta.url))
const pluginRootSelf = existsSync(join(hereSelf, '..', 'package.json')) ? join(hereSelf, '..') : join(hereSelf, '..', '..')
const pluginRuntime = join(pluginRootSelf, 'runtime')
if (!existsSync(repoArg) || !existsSync(pluginRuntime)) {
  console.log(`  [SKIP] 没有配置仓库（${repoArg}）或没有插件 runtime，跳过逐字节比对`)
} else {
  for (const name of execNames) {
    const mirror = join(repoArg, name)
    const source = join(pluginRuntime, name)
    let same = false
    let detail = ''
    if (!existsSync(mirror)) detail = `配置仓库没有 ${name}`
    else if (!existsSync(source)) detail = `插件 runtime 没有 ${name}`
    else {
      same = readFileSync(mirror).equals(readFileSync(source))
      if (!same) detail = `副本 ${readFileSync(mirror).length}B / 正本 ${readFileSync(source).length}B，跑 tools/sync-plugin-mirror.ps1 重新同步`
    }
    check(`执行体副本与插件 runtime 逐字节一致：${name}`, same, detail)
  }
  // tools\fix-session-cwd.mjs 同样是随仓库同步的副本，改了插件忘了同步会静默跑旧逻辑
  const mirrorTool = join(repoArg, 'tools', 'fix-session-cwd.mjs')
  const sourceTool = join(pluginRuntime, 'tools', 'fix-session-cwd.mjs')
  const toolSame = existsSync(mirrorTool) && existsSync(sourceTool) && readFileSync(mirrorTool).equals(readFileSync(sourceTool))
  check('执行体副本与插件 runtime 逐字节一致：tools/fix-session-cwd.mjs', toolSame,
    existsSync(mirrorTool) ? '内容已漂移，跑 tools/sync-plugin-mirror.ps1 重新同步' : '配置仓库没有 tools/fix-session-cwd.mjs')
}

// 内置运行时链接修复（0.3.24）：客户端升级会清空 resources\runtime，
// 装卸插件的 pnpm 调用随即报 MODULE_NOT_FOUND（真正运行时在 ~\.dsh\dsh-runtimes 下）。
// apply 每次落地幂等补回 junction，这 4 条断言盯住「函数在、被调用、不覆盖、探针对」。
console.log('')
console.log('== 内置运行时链接修复 ==')
{
  const commonPath = join(pluginRuntime, 'dsh-sync-common.ps1')
  const applyPath = join(pluginRuntime, 'apply.ps1')
  const commonText = existsSync(commonPath) ? readFileSync(commonPath, 'utf8') : ''
  const applyText = existsSync(applyPath) ? readFileSync(applyPath, 'utf8') : ''
  check('common 提供 Repair-PrimaryRuntimeLink 函数',
    /function\s+Repair-PrimaryRuntimeLink\s*\(/.test(commonText),
    '插件 runtime 的 dsh-sync-common.ps1 里没有该函数')
  check('apply.ps1 落地时调用该函数（不靠人手补链接）',
    /Repair-PrimaryRuntimeLink\s+\$AppRoot\s+\$DshHome/.test(applyText),
    'apply.ps1 里找不到调用点，升级后链接不会自动补回')
  check('已有真实运行时目录时绝不覆盖（只告警不重建）',
    /LinkType/.test(commonText) && /客户端自带运行时目录存在/.test(commonText) && /本次不动/.test(commonText),
    '缺少 LinkType 判据：可能把客户端自带的真实目录当成链接处理')
  check('探针落在 pnpm.mjs 本身，不是只看目录存在',
    /dependencies\\pnpm\\bin\\pnpm\.mjs/.test(commonText),
    '探针路径不是 pnpm.mjs，运行时缺文件时会被误判为已就绪')
}

// 空白本机仓库 → 只允许拉取（0.3.26）：新机器把路径指到一个空目录不是错误，
// 而是「等着从云端拉」的正常状态。断言盯四件事：状态判定、不报异常、push 全线拦住、pull 放行。
console.log('')
console.log('== 空白本机仓库：只允许拉取 ==')
{
  const indexNew = readFileSync(join(pluginRootSelf, 'index.js'), 'utf8')
  const clientNew = readFileSync(join(pluginRootSelf, 'client.js'), 'utf8')
  const syncNew = existsSync(join(pluginRuntime, 'sync.ps1')) ? readFileSync(join(pluginRuntime, 'sync.ps1'), 'utf8') : ''
  check('index.js 提供 repoPhase 四态判定（ok/empty/missing/unusable）',
    /function repoPhase\(dir\)/.test(indexNew) && /return others\.length === 0 \? 'empty' : 'unusable'/.test(indexNew),
    'repoPhase 缺失或 empty 判据变了：空目录会被当成「不像仓库」继续报异常')
  check('只有插件自己生成的 同步-*.cmd 与隐藏项算「空」',
    /同步-\[\\s\\S\]\*\\?\.cmd/i.test(indexNew) || /同步-\[/i.test(indexNew),
    'empty 判据没有排除 同步-*.cmd：生成过脚本之后就会被误判成 unusable')
  check('status 暴露 phase / empty / pushAllowed / pullAllowed',
    /pushAllowed: phase === 'ok'/.test(indexNew) && /pullAllowed: phase === 'ok' \|\| phase === 'empty'/.test(indexNew),
    'status 没有暴露门禁字段，面板只能靠 exists 猜，空目录会被整块禁掉')
  check('空目录的 advice 改成「执行拉取」而不是报错',
    /本机仓库还是空目录：/.test(indexNew) && /既不是空目录、也不像 dsh-config 仓库/.test(indexNew),
    'advice 分支没区分 empty 与 unusable')
  check('check 在非 ok 状态短路，不去撞空目录的 git',
    /if \(phase !== 'ok'\) \{[\s\S]{0,220}?autoState\.checking = false/.test(indexNew),
    'check 仍会对空目录跑 fetch/drift：lastCheckError 会被填成「读不到远端」')
  check('push-now 在空目录被拒并给出去拉取的提示', /mode === 'push' && repoPhase\(repo\) !== 'ok'/.test(indexNew),
    'handleAuto 的 push-now 没有门禁')
  check('prepare 拒绝单独生成推送、all 时跳过 push',
    /\(action === 'push' \|\| action === 'all'\) && phase !== 'ok'/.test(indexNew)
    && /wanted = phase === 'ok' \? \['push', 'pull', 'restore'\] : \['pull', 'restore'\]/.test(indexNew),
    'prepare 仍会为空目录生成推送脚本')
  check('sync.ps1 的 push 分支有空仓库守卫', /本机仓库还没有内容/.test(syncNew),
    'sync.ps1 push 仍会对空目录 init + 抓取 + 推送')
  check('面板：空目录不算「必须设置」，徽标不标红',
    /const missing = Boolean\(props\.data\) && !repo\.exists && !repo\.empty/.test(clientNew)
    && /if \(repo\.empty\) \{/.test(clientNew)
    && /const canPush = Boolean\(data && data\.repo && data\.repo\.exists && data\.repo\.pushAllowed !== false\)/.test(clientNew),
    'panel 仍把空目录当成未配置（强制编辑态 + 红色错误）')
  check('面板：推送按钮单独门禁（拉取仍可点）',
    /const pushAllowed = Boolean\(repo\.exists\) && repo\.pushAllowed !== false/.test(clientNew)
    && /const canPush = Boolean\(data && data\.repo && data\.repo\.exists && data\.repo\.pushAllowed !== false\)/.test(clientNew),
    '面板的推送按钮没有单独门禁')
}

// 任意 git 托管平台（0.3.27）：远端地址只校验写法，认证自检提示按 origin 的真实主机名现算，
// 不再写死 git@gitee.com —— 否则用 GitHub/GitLab 的人照着提示敲会连到错的主机。
console.log('')
console.log('== 任意 git 托管平台：提示不写死 gitee ==')
{
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const commonNew = readFileSync(join(root, 'runtime', 'dsh-sync-common.ps1'), 'utf8')
  const syncNew = readFileSync(join(root, 'runtime', 'sync.ps1'), 'utf8')
  const clientNew = readFileSync(join(root, 'client.js'), 'utf8')
  check('common 提供 Get-RemoteHost（认 git@host / ssh:// / https://）',
    commonNew.includes('function Get-RemoteHost') && commonNew.includes('^ssh://(?:[^@/]+@)?([^/:]+)'),
    'common 里没有主机名解析')
  check('common 提供 Get-RemoteAuthHint（https 给 ls-remote，ssh 给 ssh -T）',
    commonNew.includes('function Get-RemoteAuthHint') && commonNew.includes('ls-remote --heads origin') && commonNew.includes('ssh -T git@'),
    'https 与 ssh 两种认证没有分开提示')
  check('sync.ps1 的自检提示不再写死 git@gitee.com',
    !syncNew.includes('ssh -T git@gitee.com') && (syncNew.match(/Get-RemoteAuthHint/g) || []).length >= 3,
    '仍有 gitee 硬编码或提示没接上')
  check('面板占位与说明不再只暗示 Gitee',
    clientNew.includes('git@<host>:you/dsh-config.git')
      && clientNew.includes('git@github.com:you/dsh-config.git')
      && clientNew.includes('自建 Gitea'),
    '面板还只提 Gitee')
}

// 默认工作区校正（0.3.28）：重启客户端之前把 workspace.json 的 defaultWorkspaceId 校正到
// default-workspace，否则重启后新开的那条会话会落在「上次用的工作区」上。
// 断言只盯结构与时机，不真写用户的 workspace.json。
console.log('')
console.log('== 默认工作区校正 ==')
{
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const post = readFileSync(join(root, 'runtime', 'post-exit.ps1'), 'utf8')
  const host = readFileSync(join(root, 'index.js'), 'utf8')
  check('post-exit 提供 Set-DefaultWorkspace',
    post.includes('function Set-DefaultWorkspace'),
    '没有默认工作区校正函数')
  const callMatch = post.match(/^ {4}Set-DefaultWorkspace\r?\n/m)
  check('校正发生在重启之前（RestartClient 里、启动之前调用）',
    Boolean(callMatch) && callMatch.index < post.indexOf('$how = Start-Detached $exe'),
    '调用点不在 Start-Detached 之前')
  check('默认目标认 default-workspace（标题或路径）且可被设置覆盖或关闭',
    post.includes("$title -eq 'default-workspace'")
      && post.includes('deepseek-harness\\default-workspace')
      && post.includes("defaultWorkspace")
      && post.includes('off|none'),
    '目标匹配或 off 开关缺失')
  check('写前备份、写后回读校验（值 + 工作区条数）',
    post.includes(".bak-' + $stamp") && post.includes('countAfter -ne $countBefore'),
    '缺少备份或回读校验')
  check('设置字段 defaultWorkspace 进 read/write 与保存白名单',
    host.includes('defaultWorkspace: typeof raw.defaultWorkspace')
      && host.includes('defaultWorkspace: s.defaultWorkspace ||')
      && host.includes("has('defaultWorkspace')"),
    'index.js 没带该字段')
}

// 跨机路径占位符（0.3.30）：仓库里不写死盘符，落地时按本机根展开；展开不掉的记 pending 让用户确认。
// 只做只读断言（不写真实的 roots.json / 不提交仓库），写入路径留给手工验证。
console.log('')
console.log('== 跨机路径占位符与问题反馈 ==')
{
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const common = readFileSync(join(root, 'runtime', 'dsh-sync-common.ps1'), 'utf8')
  const captureSrc = readFileSync(join(root, 'runtime', 'capture.ps1'), 'utf8')
  const applySrc = readFileSync(join(root, 'runtime', 'apply.ps1'), 'utf8')
  const host = readFileSync(join(root, 'index.js'), 'utf8')
  const cli = readFileSync(join(root, 'client.js'), 'utf8')

  check('common 提供路径根读写与占位符双向转换',
    common.includes('function Get-SyncRoots') && common.includes('function Save-SyncRoots')
      && common.includes('function ConvertTo-TokenText') && common.includes('function Expand-TokenText')
      && common.includes('function Get-MissingTokens'),
    '缺占位符函数')
  check('common 覆盖四种路径写法（原样 / 双反斜杠 / 正斜杠 / 转义斜杠）',
    common.includes('function Get-PathVariants') && common.includes("$p.Replace($bs, '/')"),
    '变体列表不全')
  check('占位符按根长度降序替换（workspaceHome 在 appRoot 之下不会替换错位）',
    common.includes('Sort-Object { $_.Value.Length } -Descending'),
    '没有按长度排序')
  check('capture 写仓库前把本机根换成占位符',
    captureSrc.includes('ConvertTo-TokenText $txt $roots') && captureSrc.includes('Get-SyncRoots $DshHome $AppRoot $WorkspaceHome'),
    'capture 没做归一')
  check('capture 首次自动落一份 config-sync-roots.json',
    captureSrc.includes('Save-SyncRoots $DshHome $roots'),
    '没写 roots 文件')
  const settingsCount = (captureSrc.match(/Repo = 'settings\\/g) || []).length
  const applyCount = (applySrc.match(/Repo = 'settings\\/g) || []).length
  check('capture 覆盖到各插件自己的配置（不止 4 个）', settingsCount >= 11, `实际 ${settingsCount} 项`)
  check('capture 与 apply 的 settings 清单一致', settingsCount === applyCount, `capture ${settingsCount} / apply ${applyCount}`)
  check('apply 展开占位符，缺值的跳过不写并记 pending',
    applySrc.includes('Expand-TokenText $txt $roots') && applySrc.includes('Write-PendingPaths $DshHome $pendingItems')
      && applySrc.includes('continue'),
    'apply 没按缺失跳过')
  check('workspace.json（DSH 工作区登记）进了同步范围',
    captureSrc.includes("storages\\workspace.json") && applySrc.includes("storages\\workspace.json"),
    '工作区登记表没同步')
  check('面板有「本机路径」卡：只读展示 + 「修改」进编辑 + 保存',
    cli.includes("M('本机路径', 'Local paths')") && cli.includes("M('修改', 'Edit')")
      && cli.includes('callRoots') && cli.includes('setCustom') && cli.includes('addCustom'),
    'client.js 缺本机路径卡的修改态')
  check('本机路径卡默认只读（值用等宽字展示，token 作灰字说明）',
    cli.includes('const isEditing = editing || forced') && cli.includes('{{ROOT:${k}}}'),
    '只读态/自选目录没渲染')
  check('面板会列出待确认项（token + 文件 + 说明）',
    cli.includes('data.missing') && cli.includes('m.token'),
    '待确认清单没渲染')
  check('面板有「问题反馈」卡：提交 + 列表 + 连接状态 + 令牌入口',
    cli.includes("M('问题反馈', 'Feedback')") && cli.includes('callFeedback')
      && cli.includes('st.connected') && cli.includes("query: { action: 'token' }")
      && cli.includes("query: { action: 'flush' }"),
    'client.js 缺反馈卡')
  check('反馈走 GitHub Issue：建 issue + 列表 + 关单 + 离线队列',
    host.includes('GH_FEEDBACK_LABEL') && host.includes('/repos/${repo}/issues')
      && host.includes('labels: [GH_FEEDBACK_LABEL]')
      && host.includes('config-sync-feedback-outbox.json') && host.includes("action === 'flush'")
      && host.includes("method: 'PATCH'"),
    'index.js 没走 Issue')
  check('令牌自动从本机 git 凭据取，落到本机私有文件',
    host.includes('tokenFromGitCredential') && host.includes('config-sync-gh.json')
      && host.includes('credential') && host.includes('fill'),
    '缺自动取令牌')
  check('反馈正文自动附环境块（版本/机器/时间）',
    host.includes('### 环境 / Environment') && host.includes('issueBodyOf'),
    '没附环境信息')
  check('读不需要令牌：带令牌失败自动退回匿名',
    host.includes("const attempts = g.token ? [g.token, ''] : ['']") && host.includes('readAnon'),
    '没有匿名降级')
  check('关单只有仓库所有者能点（服务端挡别人的令牌）',
    host.includes('ownerOf') && host.includes('onlyCloseByOwner'.replace('onlyCloseByOwner', 'canClose'))
      && host.includes("login.toLowerCase() !== owner.toLowerCase()"),
    '服务端没校验所有者')
  check('无令牌时提交不失败，给浏览器预填链接',
    host.includes('newIssueUrl') && host.includes('issues/new?') && host.includes('needToken'),
    '没有无令牌降级')
  check('面板按权限置灰关单按钮',
    cli.includes('!st.canClose') && cli.includes("M('仅所有者', 'Owner only')") && cli.includes('fallbackUrl'),
    '面板没做权限态')
  check('反馈列表可按状态筛选 + 关键词搜索',
    cli.includes("seg('open'") && cli.includes("seg('closed'") && cli.includes("seg('all'")
      && cli.includes('setKw') && cli.includes('st.counts'),
    '没有筛选/查询')

  const rootsGet = await call('/config-sync/roots', { headers: { host: 'localhost:3080' } })
  const rootsBody = JSON.parse(rootsGet.body || '{}')
  check('GET /config-sync/roots 返回本机根 + 探测值 + 待确认清单',
    rootsBody.ok === true && rootsBody.roots && typeof rootsBody.roots.appRoot === 'string'
      && rootsBody.detected && Array.isArray(rootsBody.missing),
    '结构不全')
  check('roots 的待确认项带人话说明（不是只给 token）',
    rootsBody.missing.every((m) => typeof m.token === 'string' && typeof m.hint === 'string'),
    '缺 hint')

  const fbGet = await call('/config-sync/feedback', { headers: { host: 'localhost:3080' } })
  const fbBody = JSON.parse(fbGet.body || '{}')
  check('GET /config-sync/feedback 返回连接状态 + Issue 列表 + 待发队列',
    fbBody.ok === true && Array.isArray(fbBody.items) && typeof fbBody.connected === 'boolean'
      && typeof fbBody.repo === 'string' && Array.isArray(fbBody.outbox) && typeof fbBody.ghFile === 'string'
      && typeof fbBody.canClose === 'boolean' && typeof fbBody.owner === 'string',
    JSON.stringify(fbBody).slice(0, 400))
  check('GET /config-sync/feedback 同时给出 open/closed/total 计数',
    fbBody.counts && typeof fbBody.counts.open === 'number' && typeof fbBody.counts.closed === 'number'
      && typeof fbBody.counts.total === 'number',
    JSON.stringify(fbBody.counts))
  check('跨站请求被拒（roots）', await (async () => {
    const r = await call('/config-sync/roots', {
      method: 'POST',
      headers: { host: 'localhost:3080', origin: 'https://evil.example.com', 'content-type': 'application/json' },
      body: '{}',
    })
    return r.statusCode === 403
  })(), '没拦住')
}

console.log('')
console.log(failures === 0 ? '结论：全部通过' : `结论：${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
