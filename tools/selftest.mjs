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
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
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
check('apply() 注册了路由', routes.size === 5 && routes.has('/config-sync/update'), `实际 ${routes.size} 条：${[...routes.keys()].join(', ')}`)

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

// 「没配仓库就生成不了」这条分支只能在没有仓库的机器上跑到：本机自动探测一定命中
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
  // 重启客户端必须脱离进度窗口的控制台/作业，否则手动关窗口会把刚重启的客户端一起带走。
  const postExit = [join(pluginRoot, 'runtime', 'post-exit.ps1'), join(pluginRoot, 'post-exit.ps1'), join(repoRoot, 'post-exit.ps1')].find((p) => existsSync(p)) || ''
  const postExitSrc = postExit ? readFileSync(postExit, 'utf8') : ''
  check('重启客户端走 explorer 代启（不被进度窗口连坐）',
    postExitSrc.includes('function Start-Detached') && /explorer\.exe/.test(postExitSrc) && postExitSrc.includes('Start-Detached $exe'),
    postExit || 'post-exit.ps1')

  // 更新源自检：raw.githubusercontent.com 在部分网络下直连不通，而 Node 的 fetch 不读系统代理，
  // 10 秒一到就 abort（面板上那句 "This operation was aborted"）。所以内置候选必须带 CDN 兜在前面。
  const indexSrc = readFileSync(join(pluginRoot, 'index.js'), 'utf8')
  check('更新清单带 CDN 候选（jsDelivr 排在最前）',
    indexSrc.includes('cdn.jsdelivr.net/gh/QcWyGm/dsh-config-sync') && indexSrc.includes('UPDATE_MANIFEST_MIRRORS'),
    'index.js')
  check('清单按候选依次尝试并汇总失败原因', indexSrc.includes('async function fetchManifestAuto'), 'index.js')
  check('清单超时放宽到 30 秒（raw 慢链路 10 秒会假失败）',
    indexSrc.includes('UPDATE_FETCH_TIMEOUT = 30 * 1000'), 'index.js')
  // 运行中静默安装：宿主调 install-plugin.ps1，装完提示重启，不退出 DSH
  check('宿主支持运行中静默安装（install-live）',
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
  check('面板按钮走静默安装 + 单独重启',
    clientSrc.includes("action: 'install-live'") && clientSrc.includes("action: 'restart'"), 'client.js')
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

console.log('')
console.log(failures === 0 ? '结论：全部通过' : `结论：${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
