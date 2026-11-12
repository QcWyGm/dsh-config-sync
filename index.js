/**
 * dsh-config-sync — 宿主半身（Host half）
 *
 * 职责边界（重要）
 * ----------------
 * DSH 运行期间不可能安全地做 push/pull：capture 要读正在被应用持有的 cordis.patch.yml，
 * apply 写完之后会被退出时的进程回写覆盖。所以这个插件**不执行**同步动作，只做两件事：
 *   1. 只读体检：两端版本契约、仓库领先/落后、待提交文件、bundle 能否在本机解析；
 *   2. 备命令：按本机实际路径生成一份 同步-推送.cmd / 同步-拉取.cmd，
 *      退出 DSH 后双击即可跑，参数不用手敲。
 *
 * 约束
 * ----
 * - apply() 不抛异常：抛了会让 loader 那条 fiber 失败，启动期报 "Failed to load plugins"。
 * - 只 inject 一定存在的服务（webServer），否则 fiber 会一直 PENDING 拖住整棵插件树。
 * - 零第三方依赖：只用 node:* 内建（第三方插件不能 import @deepseek-ai/*，它们在 app.asar 里）。
 */
import { execFile, execFileSync } from 'node:child_process'
import { AsyncLocalStorage } from 'node:async_hooks'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const pluginRequire = createRequire(import.meta.url)

const PACKAGE_ID = 'dsh-config-sync'
const ROUTE_STATUS = '/config-sync/status'
const ROUTE_PREPARE = '/config-sync/prepare'
const ROUTE_SETTINGS = '/config-sync/settings'
const ROUTE_UPDATE = '/config-sync/update'
const ROUTE_SCOPE = '/config-sync/scope'
const ROUTE_CONFLICT = '/config-sync/conflict'
const SETTINGS_NAME = 'dsh-config-sync.json'

/**
 * 双语：面板是中文还是英文，跟客户端语言走（客户端每个请求都带 accept-language）。
 * t(zh, en) 只在**面向用户**的文案上用；生成的 .cmd 脚本内容、日志一律保持中文。
 */
const langStore = new AsyncLocalStorage()

function pickLang(req) {
  try {
    const raw = String((req && req.headers && (req.headers['accept-language'] || req.headers['Accept-Language'])) || '').toLowerCase()
    if (!raw) return 'zh'
    return raw.includes('zh') ? 'zh' : 'en'
  } catch { return 'zh' }
}

function t(zh, en) {
  return langStore.getStore() === 'en' ? en : zh
}

// ---- 插件自身的版本与更新源 ----
// 插件目录就是 index.js 所在目录（apply 会把它部署成 <AppRoot>\dsh-config-sync-<ver>\）。
const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url))
const PLUGIN_VERSION = (() => {
  try {
    const pkg = JSON.parse(readFileSync(join(PLUGIN_DIR, 'package.json'), 'utf8'))
    return String(pkg.version || '')
  } catch { return '' }
})()
// version.json 放在公开插件仓库根：{ version, notes, releasedAt, tgz, sha256 }
// 更新检查只读这一个文件，几百字节，不拉整包。公开仓库不需要令牌。
//
// 为什么不止一个地址：raw.githubusercontent.com 在这类网络上时通时不通（本机实测一次 20 秒超时 code=000、
// 另一次 538ms 正常），而宿主的 fetch 是 Node 内置实现、**不读系统代理**，超时一到就被 AbortController 掐断，
// 面板上只剩一句 "This operation was aborted"。
//
// 候选顺序：两个实时反代（gh-proxy / ghfast，实测 1 秒内拿到最新清单，且能把 tgz 一起拉下来）→ 直连 raw。
// **不要**用 jsDelivr 兜清单：它对 `@main` 这类分支别名有明显缓存（实测发版后仍返回上一版清单，purge 接口也没
// 立刻刷新），拿它当清单源会让"有新版本"晚几小时才出现，比读不到更误导人。
// 用户自己在设置里填了清单地址时只用他那一个 —— 不掺镜像，免得"读到的其实不是他指定的源"。
const RAW_MANIFEST_URL = 'https://raw.githubusercontent.com/QcWyGm/dsh-config-sync/main/version.json'
const UPDATE_MANIFEST_MIRRORS = [
  'https://gh-proxy.com/https://raw.githubusercontent.com/QcWyGm/dsh-config-sync/main/version.json',
  'https://ghfast.top/https://raw.githubusercontent.com/QcWyGm/dsh-config-sync/main/version.json',
  RAW_MANIFEST_URL,
]
const UPDATE_MANIFEST_URL = RAW_MANIFEST_URL
// 30 秒：慢链路 10 秒根本不够（raw 通的时候也要几百毫秒到十几秒不等）
const UPDATE_FETCH_TIMEOUT = 30 * 1000
const UPDATE_CHECK_TTL = 30 * 60 * 1000

/**
 * 定位客户端根目录（AppRoot）。
 * 首选 config.appRoot；其次由插件自身位置反推（插件被 apply 部署在 <AppRoot>\dsh-config-sync-<ver>\，
 * 上一级就是 AppRoot，换机不用改配置）；都对不上时按常见安装位置探测。
 * 判据：解包版有 resources\app\package.json，打包版有 resources\app.asar —— 只看目录名会让装错位置的情况蒙混过去，
 * 只认解包版又会让 asar 构建的机器全部落空（那台会把"插件所在目录"当成客户端根）。
 */
function isAppRoot(path) {
  if (!path) return false
  if (isFile(join(path, 'resources', 'app', 'package.json'))) return true
  // 打包版：判据是 resources\app.asar 存在。
  // 注意 Electron 主进程里 statSync('...\\app.asar') 报的是**目录**（asar 被当成一个只读目录挂载），
  // 只写 .isFile() 会让真实客户端里永远认不出客户端根 —— 外面用普通 node 验证却一切正常，极易漏掉。
  const asar = join(path, 'resources', 'app.asar')
  try {
    const st = statSync(asar)
    return st.isFile() || st.isDirectory()
  } catch { return false }
}

/** 宿主自带 bundle 的落点：解包版 resources\app\dsh\node_modules，打包版 resources\app.asar.unpacked\dsh\node_modules。 */
function hostDshNodeModules(appRoot) {
  if (!appRoot) return []
  return [
    join(appRoot, 'resources', 'app', 'dsh', 'node_modules'),
    join(appRoot, 'resources', 'app.asar.unpacked', 'dsh', 'node_modules'),
  ]
}

/** 注册表里的 InstallLocation 最权威：客户端被卸载重装到别的盘时，只有它立刻指向新位置。
 *  用 PowerShell 读三条 Uninstall 根（HKLM / WOW6432Node / HKCU），失败就当没读到。 */
let registryAppRootCache = null
let registryAppRootLoaded = false
function readRegistryAppRoot() {
  if (registryAppRootLoaded) return registryAppRootCache
  registryAppRootLoaded = true
  registryAppRootCache = null
  try {
    const script = "$k=@('HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'," +
      "'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'," +
      "'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*');" +
      "Get-ItemProperty -Path $k -ErrorAction SilentlyContinue | " +
      "Where-Object { $_.DisplayName -like '*DeepSeek Harness*' -and $_.InstallLocation } | " +
      "Select-Object -First 1 -ExpandProperty InstallLocation"
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, timeout: 8000, encoding: 'utf8' })
    const value = String(out || '').trim().replace(/[\\/]+$/, '')
    if (value && (isFile(join(value, 'resources', 'app.asar')) || isFile(join(value, 'resources', 'app', 'package.json'))) ) {
      registryAppRootCache = value
    }
  } catch { /* 读不到就退回按位置探测 */ }
  return registryAppRootCache
}

function resolveAppRoot(explicit) {
  const candidates = []
  if (explicit) candidates.push(explicit)
  try { candidates.push(dirname(dirname(fileURLToPath(import.meta.url)))) } catch { /* 忽略 */ }
  if (process.env.DSH_APP_ROOT) candidates.push(process.env.DSH_APP_ROOT)
  const fromRegistry = readRegistryAppRoot()
  if (fromRegistry) candidates.push(fromRegistry)
  if (process.env.LOCALAPPDATA) candidates.push(join(process.env.LOCALAPPDATA, 'Programs', 'DeepSeekHarness'))
  // 客户端会被卸载重装到别的盘（每台机器不一定同盘），所以把现有盘符都扫一遍；
  // 判据仍是 resources\app.asar / resources\app\package.json，不看目录名。
  for (const letter of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
    candidates.push(`${letter}:\\DeepSeekHarness`, `${letter}:\\DSH`)
  }
  for (const c of candidates) {
    if (isAppRoot(c)) return c
  }
  // 一个都认不出就返回空，让上层明确报错；绝不把插件自己所在的那一级当成客户端根。
  return ''
}

/**
 * 读客户端 app 版本：解包版直接读 resources\app\package.json；打包版从 app.asar 里取 dsh\package.json。
 * 读不到返回 null（调用方只告警，不阻断）。
 */
function readAppMeta(appRoot) {
  if (!appRoot) return null
  const plain = readJson(join(appRoot, 'resources', 'app', 'package.json'))
  if (plain) return plain
  const asar = join(appRoot, 'resources', 'app.asar')
  // Electron 主进程把 asar 当目录挂载：直接按「目录 + 内部路径」读最省事（外面普通 node 读不到就是 null，不用管）。
  const viaMount = readJson(join(asar, 'dsh', 'package.json'))
  if (viaMount) return viaMount
  if (!isFile(asar)) return null
  try {
    const fd = openSync(asar, 'r')
    try {
      const head = Buffer.alloc(16)
      readSync(fd, head, 0, 16, 0)
      const headerSize = head.readUInt32LE(4)
      const jsonLen = head.readUInt32LE(12)
      if (jsonLen < 2 || jsonLen > 64 * 1024 * 1024) return null
      const json = Buffer.alloc(jsonLen)
      readSync(fd, json, 0, jsonLen, 16)
      const header = JSON.parse(json.toString('utf8'))
      const entry = header?.files?.dsh?.files?.['package.json'] || header?.files?.['package.json']
      if (!entry || entry.size == null || entry.offset == null) return null
      const body = Buffer.alloc(Number(entry.size))
      readSync(fd, body, 0, Number(entry.size), 8 + headerSize + Number(entry.offset))
      return JSON.parse(body.toString('utf8'))
    } finally { closeSync(fd) }
  } catch { return null }
}

/** 读 JSON；失败返回 null，绝不抛。 */
function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return null }
}

function readText(path) {
  try { return readFileSync(path, 'utf8') } catch { return '' }
}

/**
 * 本机同步设置（仓库路径 + 远端地址 + SSH 私钥路径）。
 * 只存路径不存密钥内容；文件跟着本机走、不进仓库，所以换机重填一次即可。
 */
function settingsPath(dshHome) {
  return join(dshHome, SETTINGS_NAME)
}

function readSettings(dshHome) {
  const raw = readJson(settingsPath(dshHome)) || {}
  return {
    repoPath: typeof raw.repoPath === 'string' ? raw.repoPath : '',
    remoteUrl: typeof raw.remoteUrl === 'string' ? raw.remoteUrl : '',
    sshKey: typeof raw.sshKey === 'string' ? raw.sshKey : '',
    // 两个自动化开关，默认关：不打开就完全保持原来的手动流程
    autoPull: raw.autoPull === true,
    autoPush: raw.autoPush === true,
    autoRestart: raw.autoRestart !== false,
    // 更新清单地址（留空用内置默认）；换镜像/自建仓库或本地测试时才会填
    updateManifestUrl: typeof raw.updateManifestUrl === 'string' ? raw.updateManifestUrl : '',
    // 仓库是私有库时，读清单/下包都要带只读令牌（Gitee 私人令牌）；留空就按匿名 raw 读
    updateToken: typeof raw.updateToken === 'string' ? raw.updateToken : '',
    // 备份快照放哪：留空 = 默认 <DshHome>\backups（apply.ps1 每次跑之前都往那儿打一份）
    backupRoot: typeof raw.backupRoot === 'string' ? raw.backupRoot : '',
  }
}

/** 备份根：设置里填了就用填的，否则用默认 <DshHome>\backups。 */
function backupRootOf(dshHome, settings) {
  const custom = settings && typeof settings.backupRoot === 'string' ? settings.backupRoot.trim() : ''
  return custom || join(dshHome, 'backups')
}

function writeSettings(dshHome, s) {
  const payload = JSON.stringify({
    repoPath: s.repoPath || '',
    remoteUrl: s.remoteUrl || '',
    sshKey: s.sshKey || '',
    autoPull: s.autoPull === true,
    autoPush: s.autoPush === true,
    autoRestart: s.autoRestart !== false,
    updateManifestUrl: s.updateManifestUrl || '',
    updateToken: s.updateToken || '',
    backupRoot: s.backupRoot || '',
  }, null, 2) + '\n'
  writeFileSync(settingsPath(dshHome), payload, 'utf8')
}

/** 没配过时给一个能用的默认私钥：优先 gitee 那把，其次通用 id_ed25519。 */
function defaultSshKey() {
  const dir = join(homedir(), '.ssh')
  for (const name of ['id_ed25519_gitee', 'id_ed25519', 'id_rsa']) {
    const p = join(dir, name)
    if (isFile(p)) return p
  }
  return ''
}

/** ssh.exe 与私钥：生成脚本时用它们拼 GIT_SSH_COMMAND，免依赖 .ssh\config。
 *  GIT_SSH_COMMAND 的第一个词必须是可执行程序；Windows 上 Git 有两种安装位（系统级 / 用户级），
 *  只查 %ProgramFiles% 会让用户级安装的机器拼出「-i …」这种非法命令（git 交给 sh 后报 invalid option）。
 */
function sshExeCandidates() {
  const list = []
  const add = (p) => { if (p) list.push(p) }
  const lad = process.env.LOCALAPPDATA
  if (lad) {
    add(join(lad, 'Programs', 'Git', 'usr', 'bin', 'ssh.exe'))
    add(join(lad, 'Programs', 'Git', 'mingw64', 'bin', 'ssh.exe'))
  }
  for (const r of [process.env.ProgramFiles, process.env.ProgramW6432, process.env['ProgramFiles(x86)']]) {
    if (r) add(join(r, 'Git', 'usr', 'bin', 'ssh.exe'))
  }
  add(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'OpenSSH', 'ssh.exe'))
  for (const dir of String(process.env.PATH || '').split(';')) {
    const d = dir.trim()
    if (d) add(join(d, 'ssh.exe'))
  }
  return list
}

function resolveSshExe() {
  for (const p of sshExeCandidates()) {
    if (isFile(p)) return p
  }
  return ''
}

/** git 的 core.sshCommand 优先级最高：用户显式写的命令本身带 ssh 程序，直接照用。 */
function readSshCommandFromGitConfig(repo) {
  const files = [join(homedir(), '.gitconfig')]
  if (repo) files.push(join(repo, '.git', 'config'))
  for (const f of files) {
    try {
      if (!isFile(f)) continue
      const m = readFileSync(f, 'utf8').match(/^\s*sshCommand\s*=\s*(.+)$/mi)
      if (m && m[1].trim()) return m[1].trim()
    } catch { /* 忽略 */ }
  }
  return ''
}

function isDir(path) {
  try { return statSync(path).isDirectory() } catch { return false }
}

function isFile(path) {
  try { return statSync(path).isFile() } catch { return false }
}

/**
 * 一个目录算不算 dsh-config 仓库：判据是同时有 apply.ps1 与 profile/package.json
 * （避免把同名目录认错）。sync.ps1 用来看「能不能真的推送/拉取」。
 */
function isRepoDir(dir) {
  return Boolean(dir) && isFile(join(dir, 'apply.ps1')) && isFile(join(dir, 'profile', 'package.json'))
}

/**
 * 定位 dsh-config 仓库，并说清这个路径是怎么来的（设置文件 → 插件配置 → 自动探测）。
 * 设置文件优先：用户可以在面板里改，不该被 cordis.patch.yml 里的旧值锁死。
 */
function resolveRepo(explicit, dshHome) {
  const settingsRepo = dshHome ? readSettings(dshHome).repoPath : ''
  const tried = []
  const pick = (value, source) => {
    if (!value) return null
    tried.push(`${source}:${value}`)
    return isRepoDir(value) ? { repo: value, source } : null
  }
  // 设置里的路径是用户在面板里亲手填的：填了但已失效（目录被移走/改名）就原样报回去，
  // 让面板停在"未配置"强制他重设，而不是静默换成自动探测到的另一个仓库。
  if (settingsRepo && !isRepoDir(settingsRepo)) {
    return { repo: settingsRepo, source: 'settings', tried }
  }
  for (const hit of [
    pick(settingsRepo, 'settings'),
    pick(explicit, 'config'),
    (() => {
      const env = process.env.DSH_CONFIG_REPO || ''
      return env ? pick(env, 'env') : null
    })(),
  ]) {
    if (hit) return hit
  }

  const home = homedir()
  for (const c of ['D:\\dsh-config', 'G:\\dsh-config', 'C:\\dsh-config', join(home, 'dsh-config')]) {
    if (isRepoDir(c)) {
      tried.push(`自动探测:${c}`)
      return { repo: c, source: 'auto' }
    }
  }
  // 都没命中：把「用户填过但不对」的那个原样带回去，面板才能显示他填了什么、错在哪。
  return { repo: settingsRepo || '', source: settingsRepo ? 'settings' : (explicit ? 'config' : 'none'), tried }
}

/**
 * git 可执行文件的位置。
 * Electron 主进程的 PATH 往往不含 Git（用户双击启动时继承的环境很干净），
 * 裸 'git' 会 ENOENT，体检就只剩一堆 null。所以按常见安装位置先探测一遍。
 */
let gitExeCache = null
function resolveGitExe() {
  if (gitExeCache !== null) return gitExeCache
  const envRoot = process.env.ProgramFiles || 'C:\\Program Files'
  const candidates = [
    process.env.DSH_SYNC_GIT || '',
    join(envRoot, 'Git', 'cmd', 'git.exe'),
    join(process.env.ProgramW6432 || envRoot, 'Git', 'cmd', 'git.exe'),
    join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Git', 'cmd', 'git.exe'),
    join(process.env.LOCALAPPDATA || '', 'Programs', 'Git', 'cmd', 'git.exe'),
    'C:\\Program Files\\Git\\bin\\git.exe',
  ].filter((p) => p && p !== '\\' && !p.startsWith('\\'))
  gitExeCache = candidates.find((p) => { try { return existsSync(p) } catch { return false } }) || 'git'
  return gitExeCache
}

/** 跑 git，拿标准输出；找不到 git 或失败返回 null。 */
function git(repo, args) {
  return new Promise((resolve) => {
    execFile(resolveGitExe(), ['-C', repo, ...args], { windowsHide: true, timeout: 20000 }, (err, stdout) => {
      resolve(err ? null : String(stdout || '').trim())
    })
  })
}

function readBundles(profileDir) {
  const pkg = readJson(join(profileDir, 'package.json'))
  return {
    bundles: Array.isArray(pkg?.dsh?.profile?.bundles) ? pkg.dsh.profile.bundles : [],
    deps: Object.keys(pkg?.dependencies || {}),
  }
}

/**
 * 打包版客户端把宿主 bundle 塞在 app.asar 里（dsh/node_modules/<pkg>），磁盘上没有目录。
 * 只查路径会把 asar 版的 20 多个自带 bundle 全判成「缺失」，进而误删实验性 bundle —— 所以读包内包名。
 * 读不到（没 node 运行环境/头损坏）返回 null，调用方当作「判不了」，不要报缺失。
 */
let asarNamesCache = new Map()
function asarBundleNames(appRoot) {
  if (!appRoot) return null
  const asar = join(appRoot, 'resources', 'app.asar')
  if (asarNamesCache.has(asar)) return asarNamesCache.get(asar)
  let names = null
  try {
    if (isFile(asar)) {
      const fd = openSync(asar, 'r')
      try {
        const head = Buffer.alloc(16)
        readSync(fd, head, 0, 16, 0)
        const jsonLen = head.readUInt32LE(12)
        const json = Buffer.alloc(jsonLen)
        readSync(fd, json, 0, jsonLen, 16)
        const header = JSON.parse(json.toString('utf8'))
        const root = header?.files?.dsh?.files?.node_modules || header?.files?.node_modules
        names = []
        const walk = (node, prefix, depth) => {
          if (!node || !node.files || depth > 2) return
          for (const [k, v] of Object.entries(node.files)) {
            const name = prefix ? `${prefix}/${k}` : k
            if (v && v.files) { names.push(name); walk(v, name, depth + 1) }
          }
        }
        walk(root, '', 1)
      } finally { closeSync(fd) }
    }
  } catch { names = null }
  asarNamesCache.set(asar, names)
  return names
}

/** bundle 解析顺序与 DSH 一致：profile\node_modules 优先，再宿主的 node_modules（解包版路径 / asar 包内）。 */
function unresolvedBundles(bundles, profileDir, appRoot) {
  const searchRoots = [join(profileDir, 'node_modules'), ...hostDshNodeModules(appRoot)]
  const inAsar = asarBundleNames(appRoot)
  const missing = []
  for (const b of bundles) {
    const rel = String(b).replace(/\//g, '\\')
    let found = false
    for (const root of searchRoots) {
      if (isFile(join(root, rel, 'package.json'))) { found = true; break }
    }
    if (!found && inAsar) found = inAsar.includes(String(b))
    // 包内清单读不到时（inAsar === null）按「判不了」放过，绝不误报缺失
    if (!found && inAsar !== null) missing.push(b)
  }
  return missing
}

function missingDeps(deps, profileDir) {
  return deps.filter((d) => !isDir(join(profileDir, 'node_modules', String(d).replace(/\//g, '\\'))))
}

/**
 * 还原会用到的快照。规则与 restore.ps1 保持一致：不加 -BackupDir 时取
 * 「备份根」下按修改时间最新的一份；备份根默认 <DshHome>\backups，可在面板里改。
 * 返回的不只是"最新一份"：面板要列出所有快照让人挑，所以带上全量列表（最多 60 份）。
 */
function inspectBackup(dshHome, rootOverride) {
  const root = rootOverride || join(dshHome, 'backups')
  const defaultRoot = join(dshHome, 'backups')
  const empty = { root, defaultRoot, custom: root !== defaultRoot, exists: false, latest: '', latestAt: null, count: 0, latestFiles: 0, candidates: [], snapshots: [] }
  let names = []
  try { names = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name) } catch { return empty }
  const all = []
  for (const name of names) {
    const dir = join(root, name)
    try {
      const st = statSync(dir)
      let files = 0
      let bytes = 0
      const stack = [dir]
      while (stack.length) {
        const cur = stack.pop()
        let entries = []
        try { entries = readdirSync(cur, { withFileTypes: true }) } catch { continue }
        for (const e of entries) {
          const p = join(cur, e.name)
          if (e.isDirectory()) stack.push(p)
          else {
            files++
            try { bytes += statSync(p).size } catch { }
          }
        }
      }
      // 只有落过 profile 的快照能用来还原配置（新机器首次拉取时 apply 会留下空快照）
      const hasProfile = isFile(join(dir, 'package.json'))
      all.push({ name, dir, at: st.mtimeMs, files, bytes, hasProfile })
    } catch { }
  }
  all.sort((a, b) => b.at - a.at)
  if (!all.length) return { ...empty, exists: true }
  const usable = all.filter((x) => x.hasProfile)
  const latestPick = usable[0] || all[0]
  return {
    root,
    defaultRoot,
    custom: root !== defaultRoot,
    exists: true,
    latest: latestPick.dir,
    latestAt: latestPick.at,
    count: all.length,
    latestFiles: latestPick.files,
    candidates: all.slice(0, 8).map((x) => ({ name: x.name, dir: x.dir, at: x.at, files: x.files, bytes: x.bytes, usable: x.hasProfile })),
    snapshots: all.slice(0, 60).map((x) => ({ name: x.name, dir: x.dir, at: x.at, files: x.files, bytes: x.bytes, usable: x.hasProfile })),
  }
}

/**
 * 体检。全部只读，不写任何文件（除了 prepare 那次由用户显式触发的 cmd 生成）。
 */
async function inspect(config) {
  const dshHome = config?.dshHome || process.env.DSH_HOME || join(homedir(), '.dsh')
  const resolved = resolveRepo(config?.repoPath, dshHome)
  const repo = resolved.repo
  const appRoot = resolveAppRoot(config?.appRoot)
  const profileDir = join(dshHome, 'profiles', config?.profileName || 'desktop')

  const localApp = readAppMeta(appRoot)
  const localVersion = typeof localApp?.version === 'string' ? localApp.version : ''
  const electronVersion = readText(join(appRoot, 'version')).trim()
  const contract = readJson(join(repo, 'profile', 'host-contract.json'))
  const contractVersion = typeof contract?.appVersion === 'string' ? contract.appVersion : ''

  const { bundles, deps } = readBundles(profileDir)
  const unresolved = unresolvedBundles(bundles, profileDir, appRoot)
  const missing = missingDeps(deps, profileDir)

  const settings = readSettings(dshHome)
  const gitRemoteUrl = repo && isDir(join(repo, '.git')) ? await git(repo, ['remote', 'get-url', 'origin']) : null
  const sshKey = settings.sshKey || defaultSshKey()

  const gitStatus = repo && isDir(join(repo, '.git'))
    ? (await git(repo, ['status', '--porcelain'])) ?? null
    : null
  const head = repo ? await git(repo, ['log', '-1', '--pretty=%h %s']) : null
  const branch = repo ? await git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']) : null
  const counts = repo ? await git(repo, ['rev-list', '--left-right', '--count', 'HEAD...@{upstream}']) : null
  let ahead = null
  let behind = null
  if (counts) {
    const parts = counts.split(/\s+/)
    ahead = Number(parts[0] ?? '')
    behind = Number(parts[1] ?? '')
    if (!Number.isFinite(ahead)) ahead = null
    if (!Number.isFinite(behind)) behind = null
  }

  const dirty = gitStatus === null ? null : gitStatus.split('\n').filter(Boolean).length
  const versionMatch = Boolean(localVersion && contractVersion && localVersion === contractVersion)
  // 本机数据（会话/资料）有没有比"上次同步"更新：git 干净也可能有新会话没 capture
  const syncState = readSyncState(dshHome)
  const local = localPending(dshHome, syncState.lastSyncAt, config?.profileName, { repo, appRoot })

  const advice = []
  if (!appRoot) {
    advice.push(t(
      '定位不到客户端根目录：插件不在 <客户端根> 下（如 D:\\DeepSeekHarness\\dsh-config-sync-0.1.0），'
      + '或客户端是打包版（resources\\app.asar）而这里没认出来 —— 三份同步脚本会因此生成不了',
      'Cannot locate the client root: the plugin is not under <client root> (e.g. D:\\DeepSeekHarness\\dsh-config-sync-0.1.0), '
      + 'or this is a packaged build (resources\\app.asar) that was not recognized — the three sync scripts cannot be generated.',
    ))
  }
  if (!repo) {
    advice.push(t(
      '还没有配置仓库目录：请在下面的「本机仓库」卡里点「设置路径」，指向那台机器上的 dsh-config 仓库（含 apply.ps1 和 profile\\package.json）',
      'The repo directory is not set: use the Local repo card below to point at the dsh-config repo on this machine (it must contain apply.ps1 and profile\\package.json).',
    ))
  } else if (!isRepoDir(repo)) {
    advice.push(t(
      `仓库目录不在了或不像仓库（缺 apply.ps1 或 profile\\package.json）：${repo} —— 请在「本机仓库」卡里重新设路径`,
      `The repo directory is missing or does not look like a repo (no apply.ps1 or profile\\package.json): ${repo} — set the path again in the Local repo card.`,
    ))
  } else if (!isFile(join(repo, 'sync.ps1'))) {
    advice.push(t(
      `仓库目录里没有 sync.ps1，推送/拉取跑不起来：${repo}`,
      `The repo directory has no sync.ps1, so push/pull cannot run: ${repo}`,
    ))
  }
  if (repo && !(gitRemoteUrl || settings.remoteUrl)) {
    advice.push(t(
      '还没有配置云端仓库地址：推送/拉取生成不了，请在「云端仓库」卡里填远端地址并保存',
      'The cloud repo is not set: push/pull cannot be generated — fill in the remote URL in the Cloud repo card and save.',
    ))
  }
  if (!localVersion) {
    advice.push(t(
      `读不到客户端版本（${appRoot ? `${appRoot}\\resources\\app\\package.json 或 resources\\app.asar` : 'AppRoot 没定位到'}）`,
      `Cannot read the client version (${appRoot ? `${appRoot}\\resources\\app\\package.json or resources\\app.asar` : 'AppRoot not found'})`,
    ))
  }
  if (localVersion && contractVersion && !versionMatch) {
    advice.push(t(
      `两端客户端版本不同：本机 ${localVersion}，仓库契约 ${contractVersion}。先升级较旧那台，或 pull 时加 -AllowVersionDrift`,
      `The two clients differ: this machine ${localVersion}, repo contract ${contractVersion}. Upgrade the older one, or pass -AllowVersionDrift when pulling.`,
    ))
  }
  if (unresolved.length) {
    advice.push(t(
      `${unresolved.length} 个 bundle 在本机解析不到，启动会在 entry loading 崩溃：${unresolved.join(', ')}`,
      `${unresolved.length} bundle(s) cannot be resolved on this machine and will crash entry loading: ${unresolved.join(', ')}`,
    ))
  }
  if (missing.length) {
    advice.push(t(
      `${missing.length} 个依赖没装（pnpm install 没跑成）：${missing.join(', ')}`,
      `${missing.length} dependency(ies) missing (pnpm install did not finish): ${missing.join(', ')}`,
    ))
  }
  if (behind !== null && behind > 0) {
    advice.push(t(`仓库落后 ${behind} 个提交：退出 DSH 后执行「拉取」`, `The repo is ${behind} commit(s) behind: run Pull after DSH exits.`))
  }
  if (ahead !== null && ahead > 0) {
    advice.push(t(`仓库领先 ${ahead} 个提交（本机改过还没推）：退出 DSH 后执行「推送」`, `${ahead} local commit(s) not pushed yet: run Push after DSH exits.`))
  }
  if (dirty !== null && dirty > 0) {
    advice.push(t(`工作区有 ${dirty} 项未提交：退出 DSH 后跑「推送」会一并提交`, `${dirty} uncommitted change(s): running Push after DSH exits commits them too.`))
  }
  if (local.known && local.pending > 0) {
    advice.push(t(
      `本机有 ${local.pending} 个文件在上次同步之后有更新（新会话/资料之类），仓库里还没有：退出 DSH 后跑「推送」`,
      `${local.pending} file(s) changed since the last sync (new sessions/materials) and are not in the repo yet: run Push after DSH exits.`,
    ))
  }
  if (!advice.length) advice.push(t('仓库与本机一致，没有待办', 'The repo matches this machine — nothing to do.'))

  return {
    ok: true,
    at: Date.now(),
    repo: {
      path: repo,
      // 有路径 ≠ 目录还在：路径被移走/改名时这里必须是 false，面板才会重新强制设置。
      exists: Boolean(repo) && isRepoDir(repo),
      // 路径是怎么来的：settings=本机设置（面板可改）、config=插件配置、env=环境变量、auto=自动探测、none=没配
      source: resolved.source,
      configured: Boolean(settings.repoPath || config?.repoPath),
      tried: resolved.tried || [],
      branch: branch || '',
      head: head || '',
      dirty,
      ahead,
      behind,
    },
    version: { local: localVersion, contract: contractVersion, electron: electronVersion, match: versionMatch },
    // 本机数据侧：上次同步时间 + 「之后又写过多少文件」，与 repo.dirty 是两件事
    local: { ...syncState, ...local },
    bundles: { total: bundles.length, unresolved },
    deps: { total: deps.length, missing },
    advice,
    backup: inspectBackup(dshHome, backupRootOf(dshHome, settings)),
    remote: {
      url: gitRemoteUrl || settings.remoteUrl || '',
      urlSource: gitRemoteUrl ? 'git' : (settings.remoteUrl ? 'settings' : 'none'),
      // 配没配过云端仓库：推送/拉取都以它为前置，缺了面板就强制先设
      configured: Boolean(gitRemoteUrl || settings.remoteUrl),
      sshKey,
      sshKeyExists: Boolean(sshKey) && isFile(sshKey),
      sshKeyFrom: settings.sshKey ? 'settings' : (sshKey ? 'default' : 'none'),
      sshConfig: isFile(join(homedir(), '.ssh', 'config')),
      updateTokenSet: Boolean(settings.updateToken),
      // 备份根：留空=默认。面板「还原备份」卡据此显示当前值并判断是否被改过
      backupRoot: backupRootOf(dshHome, settings),
      backupRootCustom: Boolean(settings.backupRoot),
      settingsPath: settingsPath(dshHome),
    },
    paths: { appRoot, dshHome, profileDir },
    auto: {
      pull: settings.autoPull === true,
      push: settings.autoPush === true,
      restart: settings.autoRestart !== false,
      checking: autoState.checking,
      lastCheckAt: autoState.lastCheckAt,
      lastCheckError: autoState.lastCheckError,
      drift: autoState.drift,
      pending: autoState.pending,
      watcherStartedAt: autoState.watcherStartedAt,
      script: autoScript(dshHome, repo),
      // post-exit.ps1 上次执行的结果（成功/失败/是否回滚），客户端启动后据此弹 5 秒提示
      lastResult: readAutoResult(dshHome),
    },
    // 拉取被本机文件挡住时 sync.ps1 留下的冲突清单，面板「同步冲突」卡据此渲染
    conflicts: (() => {
      const c = readConflicts(dshHome)
      if (!c) return { exists: false, total: 0, pending: 0, at: '', backupDir: '' }
      const pending = c.items.filter((it) => !it.choice).length
      return { exists: true, total: c.items.length, pending, at: c.at || '', backupDir: c.backupDir || '' }
    })(),
  }
}

/** 只在 Host 本机、且来源可信时放行（防任意网页 POST 进来）。 */
function originAllowed(req) {
  const host = String(req.headers.host || '')
  const hostLocal = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(host)
  const site = String(req.headers['sec-fetch-site'] || '').toLowerCase()
  if (site === 'cross-site' || site === 'same-site') return false
  const origin = req.headers.origin
  if (origin === undefined || origin === '') return true
  if (origin === 'null') return hostLocal
  if (/^app:/i.test(String(origin))) return hostLocal
  try { return new URL(String(origin)).host === host } catch { return false }
}

function sendJson(res, code, body) {
  try {
    res.statusCode = code
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.setHeader('cache-control', 'no-store')
    res.end(JSON.stringify(body))
  } catch { /* 客户端已断开就忽略 */ }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (c) => {
      data += c
      if (data.length > 64 * 1024) { reject(new Error('body too large')); req.destroy() }
    })
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })
}

/**
 * 生成"退出后执行"的 cmd：参数按本机实际路径写死，双击即可。
 * action: push | pull | restore
 */
const PS_EXE = '%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe -ExecutionPolicy Bypass -NoProfile'
// 绝对路径调任务列表和代码页：PATH 被裁过（或用户改坏）时也能跑，别指望 `tasklist` 能解析到
const TASKLIST = '%SystemRoot%\\System32\\tasklist.exe'
const CHCP = '%SystemRoot%\\System32\\chcp.com'
const FIND = '%SystemRoot%\\System32\\find.exe'
const PROC_GUARD = [
  `${TASKLIST} /fi "imagename eq DeepSeek Harness.exe" | ${FIND} /i "DeepSeek Harness.exe" >nul && (`,
  '  echo [X] DeepSeek Harness 还在运行，请先完全退出（窗口 + 托盘）再重试。',
  '  pause',
  '  exit /b 1',
  ')',
]

function cmdHead(title) {
  return [
    '@echo off',
    `${CHCP} 65001 >nul`,
    'setlocal',
    `echo 本脚本由 DSH 插件 dsh-config-sync 生成：${title}`,
    ...PROC_GUARD,
    'echo.',
  ]
}

/**
 * cmd 的 echo 会把 < > | & ^ 当语法、把 % 当变量展开：
 * 直接 echo 一句带 `<时间戳>` 的提示，双击时会变成"从叫 时间戳 的文件读输入"并报
 * The system cannot find the file specified，那句话还打不出来。所有动态文案先过这里。
 */
function echoSafe(text) {
  return String(text).replace(/%/g, '%%').replace(/[<>|&^]/g, (c) => '^' + c)
}

/**
 * 生成 cmd 时要调用的 PowerShell 入口从哪来：
 *   1) 仓库里已经有 sync.ps1 / restore.ps1 → 用仓库那份（同步脚本随之更新）；
 *   2) 只有插件、仓库还没克隆（新机器刚装完）→ 用插件自带的 runtime\（随 tgz 一起发布）。
 * 两条路径都必须存在，否则明确报错，不生成一个双击必然失败的脚本。
 */
function pickPs1(repo, name) {
  const fromRepo = join(repo, name)
  if (isFile(fromRepo)) return fromRepo
  const fromPlugin = join(pluginRoot(), 'runtime', name)
  if (isFile(fromPlugin)) return fromPlugin
  throw new Error(t(
    `找不到 ${name}：仓库里没有（${fromRepo}），插件自带的 runtime 也没有（${fromPlugin}）`,
    `Cannot find ${name}: not in the repo (${fromRepo}) and not in the plugin's bundled runtime (${fromPlugin})`,
  ))
}

function pluginRoot() {
  try { return dirname(fileURLToPath(import.meta.url)) } catch { return '' }
}

function buildCmd(config, action, repo, appRoot, dshHome, state = {}) {
  const isRestore = action === 'restore' || action === 'restore-backup'
  const restorePs1 = isRestore ? pickPs1(repo, 'restore.ps1') : ''
  const syncPs1 = isRestore ? '' : pickPs1(repo, 'sync.ps1')
  // 仓库还没克隆时先建出目录，脚本要落在那里；clone 由 sync.ps1 首次执行时做完。
  if (!isDir(repo)) { try { mkdirSync(repo) } catch { /* 建不出来就让后面的 writeFileSync 报 */ } }
  const common = [`-RepoRoot "${repo}"`, `-AppRoot "${appRoot}"`, `-DshHome "${dshHome}"`]

  // push/pull 要跟远端认证：设置里配了私钥就用它，不靠 .ssh\config 的默认选择。
  // 铁律：GIT_SSH_COMMAND 必须以可执行程序开头。找不到 ssh.exe 时宁可不设（交给 .ssh\config），
  // 也不能输出「-i "key" -o …」——git 会把它当命令交给 sh，直接 invalid option，报错还伪装成"仓库读不到"。
  const settings = readSettings(dshHome)
  const key = settings.sshKey || defaultSshKey()
  const hasKey = Boolean(key) && isFile(key)
  const coreSsh = readSshCommandFromGitConfig(repo)
  const sshExe = coreSsh ? '' : resolveSshExe()
  let envLines = []
  if (hasKey && coreSsh) {
    envLines = [
      `set GIT_SSH_COMMAND=${coreSsh}`,
      `echo ${echoSafe(`认证：git config core.sshCommand（私钥 ${key} 由该命令使用）`)}`,
    ]
  } else if (hasKey && sshExe) {
    envLines = [
      `set GIT_SSH_COMMAND="${sshExe}" -i "${key}" -o BatchMode=yes -o StrictHostKeyChecking=accept-new`,
      `echo ${echoSafe(`认证：SSH 私钥 ${key}`)}`,
      `echo ${echoSafe(`认证：ssh ${sshExe}`)}`,
    ]
  } else if (hasKey) {
    envLines = [
      `echo ${echoSafe(`认证：私钥 ${key}`)}`,
      `echo ${echoSafe('认证：本机没找到 ssh.exe，脚本内不设 GIT_SSH_COMMAND（它必须以可执行程序开头）')}`,
      `echo ${echoSafe('认证：改为交给 .ssh\\config；若仍报 Could not read from remote，就装 Git 官方版或配 git config core.sshCommand')}`,
    ]
  } else {
    envLines = [`echo ${echoSafe('认证：未配置私钥，交给 .ssh\\config 决定')}`]
  }

  if (isRestore) {
    // 生成时如果已经有快照，就把那一份明写进脚本（双击前就知道退回哪里）；
    // 还没有快照（新机器刚装插件）时不写 -BackupDir，交给 restore.ps1 运行时取最新一份 ——
    // 否则脚本会一直咬住"生成那一刻没有快照"，之后拉取生成了快照也用不上。
    // 面板「还原备份」里点某一行的还原时，state.backupDir 会带来那一份的绝对路径（已校验在备份根之下）。
    const settings = readSettings(dshHome)
    const backup = inspectBackup(dshHome, backupRootOf(dshHome, settings))
    const picked = String(state.backupDir || '')
    const pickedSnap = picked ? (backup.snapshots || []).find((s) => s.dir === picked) : null
    const backupArg = (picked || backup.latest) ? [`-BackupDir "${picked || backup.latest}"`] : []
    const allArgs = [...common, ...backupArg]
    const dry = `${PS_EXE} -File "${restorePs1}" ${allArgs.join(' ')} -DryRun`
    const real = `${PS_EXE} -File "${restorePs1}" ${allArgs.join(' ')}`
    const backupLines = (picked || backup.latest)
      ? [
        `echo ${echoSafe(`备份快照：${picked || backup.latest}`)}`,
        `echo ${echoSafe(`快照时间：${new Date(pickedSnap ? pickedSnap.at : backup.latestAt).toLocaleString('zh-CN', { hour12: false })}　备份根下共 ${backup.count} 份，这份含 ${pickedSnap ? pickedSnap.files : backup.latestFiles} 个文件`)}`,
      ]
      : [
        `echo ${echoSafe(`备份快照：${backup.root}（生成脚本时这里还没有快照）`)}`,
        `echo ${echoSafe('执行时由 restore.ps1 自动取该目录下最新一份；若那时仍为空，会提示你先跑一次拉取。')}`,
      ]
    const text = [
      ...cmdHead('把本机 profile 退回到下面这个快照（先自保、再回退、再核对/重装依赖）。'),
      ...backupLines,
      'echo.',
      'echo 要换成别的快照或仓库某提交，编辑本文件，把 -BackupDir 改掉或换成 -FromCommit。',
      'echo.',
      'echo [第一步] 只看不动，先打印还原计划：',
      dry,
      'echo.',
      'if /i "%~1"=="--yes" goto SYNC_RUN',
      'set /p GO=按上面的计划执行还原？(y/N) ',
      'if /i "%GO%"=="y" goto SYNC_RUN',
      `echo ${echoSafe('没有收到确认（y），已退出：本机什么都没改。')}`,
      'exit /b 0',
      ':SYNC_RUN',
      'echo.',
      'echo [第二步] 开始还原（会先把当前 profile 另存一份再覆盖）：',
      real,
      'echo.',
      'echo 执行结束。确认无误后再启动 DSH。',
      'pause',
    ].join('\r\n')
    // 指定了某一份快照（面板点行还原）时脚本名带上快照名，多份还原脚本可以同时存在、互不覆盖
    const fileName = pickedSnap ? `同步-还原-${pickedSnap.name}.cmd` : '同步-还原.cmd'
    const path = join(repo, fileName)
    writeFileSync(path, text, 'utf8')
    return { action, label: t('还原（本机 → 快照）', 'Restore (machine → snapshot)'), path, command: real,
      backup: { dir: picked || backup.latest, root: backup.root, at: pickedSnap ? pickedSnap.at : backup.latestAt, count: backup.count, files: pickedSnap ? pickedSnap.files : backup.latestFiles } }
  }

  const target = action === 'push' ? 'push' : 'pull'
  const label = target === 'push'
    ? t('推送（本机 → 远端）', 'Push (machine → remote)')
    : t('拉取（远端 → 本机）', 'Pull (remote → machine)')
  // 提交说明只对 push 有意义：用户在面板里填一句，时间由 sync.ps1 在实际执行那一刻追加。
  // 这里只做清洗（去引号/换行、% 转义、限长）：引号会破坏参数结构，% 会被 cmd 当变量展开。
  const note = target === 'push' ? String(state.message || '').replace(/["\r\n]/g, ' ').replace(/%/g, '%%').trim().slice(0, 120) : ''
  const command = [PS_EXE, '-File', `"${syncPs1}"`, target, ...common.map((c) => c),
    ...(note ? ['-Message', `"${note}"`] : [])].join(' ')
  const ahead = Number(state.ahead) || 0
  const dirty = Number(state.dirty) || 0
  const warnings = []
  if (target === 'pull') {
    if (ahead > 0) {
      warnings.push(t(
        `本机领先远端 ${ahead} 个提交（还没推送），拉取后这些改动在仓库里仍然缺失`,
        `This machine is ${ahead} commit(s) ahead (not pushed yet); after pulling, those changes are still missing from the repo.`,
      ))
    }
    if (dirty > 0) {
      warnings.push(t(
        `工作区有 ${dirty} 项未提交，拉取会用仓库版本覆盖对应的本机文件`,
        `${dirty} uncommitted change(s): pulling overwrites the matching local files with the repo version.`,
      ))
    }
    warnings.push(t(
      '拉取 = 拉远端 + apply 到本机：会用仓库里的版本覆盖本机配置',
      'Pull = fetch the remote and apply it locally: the repo version overwrites the local config.',
    ))
  }
  const guard = target === 'pull'
    ? [
      ...(ahead > 0 ? [`echo ${echoSafe(`[!] 本机领先远端 ${ahead} 个提交（还没推送），这些改动拉取后不会进仓库。`)}`] : []),
      ...(dirty > 0 ? [`echo ${echoSafe(`[!] 工作区有 ${dirty} 项未提交，拉取会用仓库版本覆盖对应本机文件。`)}`] : []),
      `echo ${echoSafe('[!] 拉取会用仓库里的版本覆盖本机配置（覆盖前仍会先存一份 backups\\config-<时间戳> 快照）。')}`,
      'echo.',
      // chcp 之后 set /p 读不到被重定向的输入（会拿到空值静默退出），所以另给一个 --yes 免确认开关，
      // 顺便让"没人按 y"这件事有明确回执，而不是什么都不发生。
      'if /i "%~1"=="--yes" goto SYNC_RUN',
      'set /p GO=拉取会覆盖本机配置，确认继续？(y/N) ',
      'if /i "%GO%"=="y" goto SYNC_RUN',
      `echo ${echoSafe('没有收到确认（y），已退出：本机什么都没改。')}`,
      'exit /b 0',
      ':SYNC_RUN',
      'echo.',
    ]
    : []
  const text = [
    ...cmdHead(`会先确认 DSH 是否已退出，再执行「${label}」。`),
    ...envLines,
    'echo.',
    ...guard,
    ...(note ? [`echo ${echoSafe(`提交说明：${note}（时间自动附在后面）`)}`] : []),
    command,
    'echo.',
    `echo 执行结束。若为拉取，确认无误后启动 DSH。`,
    'pause',
  ].join('\r\n')
  const path = join(repo, `同步-${target === 'push' ? '推送' : '拉取'}.cmd`)
  writeFileSync(path, text, 'utf8')
  return { action: target, label, path, command, warnings, message: note }
}

/* ============================ 自动同步 / 自动推送 ============================
 * 插件跑在 DSH 主进程里：DSH 一退出插件就没了，所以"等 DSH 完全关闭再同步"不能由插件自己盯。
 * 做法是：需要动手时，插件用 detached 方式拉起 runtime\post-exit.ps1（它只等本进程 pid 消失），
 * 由那个外部脚本在退出后执行 pull / push，必要时再重启客户端。
 * 两个开关默认关；关着一行代码都不会跑。
 */

const ROUTE_AUTO = '/config-sync/auto'

const autoState = {
  checking: false,
  lastCheckAt: 0,
  lastCheckError: '',
  drift: null,          // { ahead, behind, at }
  pending: null,        // { mode, at, reason?, restarted? } 已排队、等退出后执行
  watcherStartedAt: 0,
  timer: null,
  interval: null,       // 每 2 分钟的复查（会话/资料是运行中产生的，只判一次会全漏）
}

function autoScript(dshHome, repo) {
  const fromPlugin = join(pluginRoot(), 'runtime', 'post-exit.ps1')
  if (isFile(fromPlugin)) return fromPlugin
  const fromRepo = join(repo || '', 'post-exit.ps1')
  return isFile(fromRepo) ? fromRepo : ''
}

/**
 * 上次「退出后自动同步」的结果（post-exit.ps1 落的盘）。
 * 只读，读不到/坏掉都返回 null，绝不影响客户端启动。
 * 字段：{ mode, ok, at(ms), code, message, restored, log }
 */
function readAutoResult(dshHome) {
  try {
    const file = join(dshHome, 'auto-sync-result.json')
    if (!isFile(file)) return null
    const j = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
    if (!j || typeof j !== 'object') return null
    return {
      mode: j.mode === 'push' ? 'push' : 'pull',
      ok: j.ok === true,
      at: Number(j.at) || 0,
      code: Number(j.code) || 0,
      message: String(j.message || ''),
      restored: j.restored === true,
      log: String(j.log || ''),
    }
  } catch { return null }
}

/** 只读探询：fetch 一次再比 HEAD 与 origin/<branch>。任何失败都返回 null，绝不影响客户端启动。 */
async function checkDrift(repo) {
  if (!repo || !isDir(join(repo, '.git'))) return null
  const branch = await currentBranch(repo)
  const fetched = await git(repo, ['fetch', 'origin', '--quiet'])
  if (fetched === null) return null
  const counts = await git(repo, ['rev-list', '--left-right', '--count', `HEAD...origin/${branch}`])
  if (!counts) return null
  const [ahead, behind] = counts.trim().split(/\s+/).map((n) => Number(n) || 0)
  return { ahead, behind, branch, at: Date.now() }
}

/** 系统确认框（立在 DSH 窗口前面，不开面板也看得见）。Yes → true。 */
function askConfirm(title, text) {
  return new Promise((resolve) => {
    // 参数走 spawn 的数组形式，不经过 shell 解析，所以文本里的引号/换行不会被二次解释。
    const safe = (s) => String(s).replace(/'/g, "''")
    const script = [
      'Add-Type -AssemblyName System.Windows.Forms | Out-Null',
      `$r = [System.Windows.Forms.MessageBox]::Show('${safe(text)}', '${safe(title)}', ` +
        '[System.Windows.Forms.MessageBoxButtons]::YesNo, [System.Windows.Forms.MessageBoxIcon]::Question)',
      'if ($r -eq [System.Windows.Forms.DialogResult]::Yes) { exit 6 } else { exit 7 }',
    ].join('\n')
    const ps = spawn('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true, stdio: 'ignore' })
    ps.on('error', () => resolve(false))
    ps.on('close', (code) => resolve(code === 6))
    // 12 分钟没人点就当取消，别把后台挂着
    const timer = setTimeout(() => { try { ps.kill() } catch { } resolve(false) }, 12 * 60 * 1000)
    try { timer.unref?.() } catch { }
  })
}

/**
 * 找 powershell 的绝对路径。
 * 不能只写 'powershell.exe' 靠 PATH：Electron 主进程继承的 PATH 可能被裁剪（本机实测就是
 * spawn 返回对象、pid 看着有，但进程根本没起来、post-exit 的日志一行都没落 —— 假成功）。
 */
function powershellExe() {
  const root = process.env.SystemRoot || 'C:\\Windows'
  for (const c of [
    join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    join(root, 'Sysnative', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
  ]) {
    if (isFile(c)) return c
  }
  return 'powershell.exe'
}

/** 记录"起守护进程"这件事本身：成功/失败都留痕，否则失败时只剩一个不存在的 pid。 */
function logLaunch(dshHome, text) {
  try {
    const dir = join(dshHome, 'logs')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'auto-sync-launch.log'), `[${new Date().toISOString()}] ${text}\n`, { flag: 'a' })
  } catch { }
}

/** 拼 PowerShell 单引号字面量（路径里有单引号就双写）。 */
function psQuote(value) {
  return "'" + String(value).replace(/'/g, "''") + "'"
}

/**
 * 拉起外部守护：等本进程退出后执行一次同步。
 *
 * 两个坑都在这踩过：
 * 1. spawn() 找不到可执行文件是**异步**报错，不会抛异常 —— 只看 try/catch 会"假装成功"；
 *    所以下面要等 launcher 的 exit 码，失败就如实返回，并写 auto-sync-launch.log。
 * 2. 直接用 `detached: true` 起 powershell，在 Windows 上它会**当场退出**：
 *    实测（同一个 exe、同一个脚本）detached=true 时进程 3 秒后已消失、post-exit 日志一行没有；
 *    detached=false 立刻就在写日志。所以这里不 detached，而是让一个短命 powershell 用
 *    Start-Process 把真正的 post-exit 起成独立进程 —— 父进程（DSH）退出后它照样活着。
 */
async function spawnWatcher({ mode, repo, appRoot, dshHome, restart, extraArgs = [] }) {
  const script = autoScript(dshHome, repo)
  if (!script) return { ok: false, error: t('插件与仓库里都没有 post-exit.ps1，无法排队', 'post-exit.ps1 is in neither the plugin nor the repo — cannot queue') }

  // 同一时刻只允许一次同步。实测过的坑：启动首检排了 push、用户在确认框点确认又排了 pull，
  // 两个守护都在等同一个 pid —— DSH 一退出它们**同时开工**，一次推送一次拉取并行跑、各重启一次，
  // 配置可能互相覆盖。锁文件记 pid，进程还活着就拒掉后来者。
  const lockFile = join(dshHome, 'auto-sync.lock')
  try {
    if (isFile(lockFile)) {
      const lockText = readFileSync(lockFile, 'utf8')
      const lockPid = Number((lockText.match(/"pid"\s*:\s*(\d+)/) || [])[1])
      if (lockPid > 0) {
        let alive = false
        try { process.kill(lockPid, 0); alive = true } catch { alive = false }
        if (alive) {
          const lockMode = (lockText.match(/"mode"\s*:\s*"([a-z]+)"/) || [])[1]
          // 同一种同步已经在等，直接复用，别再加一个并行的
          if (lockMode === mode) return { ok: true, pid: lockPid, reused: true }
          // 不同的同步正在等（例如首检排了推送、用户在确认框点了拉取）：用户的手动动作优先，
          // 干掉那个还没开工的等待进程，改排这一次。它此时只可能在等 DSH 退出，没有副作用。
          try { process.kill(lockPid) } catch { }
          logLaunch(dshHome, `取消上一个等待中的 ${lockMode || '同步'}（pid ${lockPid}），改排 ${mode}`)
        }
      }
      try { unlinkSync(lockFile) } catch { }
    }
  } catch { }

  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script,
    // 这一段是「等待态」：隐藏进程只盯着 DSH 退出，退出后才由它拉起一个可见窗口干活，
    // 否则排队期间（可能几小时）会一直挂着一个挡视线的空窗口。
    '-Mode', mode, '-WatchPid', String(process.pid), '-Phase', 'wait', '-DshHome', dshHome]
  if (repo) args.push('-RepoRoot', repo)
  if (appRoot) args.push('-AppRoot', appRoot)
  if (restart) args.push('-Restart')
  // 更新模式要带上下载地址与校验值，交给 post-exit 的 run 段执行
  if (Array.isArray(extraArgs) && extraArgs.length) args.push(...extraArgs)
  const exe = powershellExe()
  const inner = [
    // 等待态进程保持**隐藏**；可见窗口由 post-exit.ps1 在 DSH 真正退出后自己弹（-Phase run）。
    `$p = Start-Process -FilePath ${psQuote(exe)} -ArgumentList @(${args.map(psQuote).join(', ')}) -WindowStyle Hidden -PassThru`,
    'Write-Output $p.Id',
  ].join('; ')
  const encoded = Buffer.from(inner, 'utf16le').toString('base64')
  let child
  try {
    child = spawn(exe, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  } catch (error) {
    const msg = String((error && error.message) || error)
    logLaunch(dshHome, `启动失败 ${mode} exe=${exe}：${msg}`)
    return { ok: false, error: t(`拉不起 powershell（${exe}）：${msg}`, `Cannot launch PowerShell (${exe}): ${msg}`) }
  }
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (c) => { stdout += c })
  child.stderr.on('data', (c) => { stderr += c })
  const code = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve('timeout'), 8000)
    child.once('exit', (c) => { clearTimeout(timer); resolve(c) })
    child.once('error', (e) => { clearTimeout(timer); resolve('error:' + ((e && e.message) || e)) })
  })
  if (code !== 0) {
    const detail = String(stderr || stdout || code).trim().slice(0, 300)
    logLaunch(dshHome, `启动失败 ${mode} exe=${exe}：${detail}`)
    return { ok: false, error: t(`拉不起 post-exit（launcher 退出码 ${code}）：${detail}`, `Cannot launch post-exit (launcher exit code ${code}): ${detail}`) }
  }
  const pid = Number(String(stdout).trim().split(/\s+/).pop()) || 0
  autoState.watcherStartedAt = Date.now()
  try {
    writeFileSync(lockFile, JSON.stringify({ pid, mode, at: Date.now() }), 'utf8')
  } catch { }
  logLaunch(dshHome, `已启动 ${mode} pid=${pid} exe=${exe} script=${script}`)
  return { ok: true, pid }
}

/**
 * 宿主是 Electron 主进程（插件就装在主进程里），所以能拿到 app —— 但 CLI 形态运行、
 * 或加载器换了模块解析时取不到，一律返回 null，调用方退回 taskkill。
 */
function electronApp() {
  try {
    const mod = pluginRequire('electron')
    return mod && mod.app && mod.BrowserWindow ? mod : null
  } catch { return null }
}

/**
 * 让客户端**真的退出**。
 *
 * 旧实现是 `taskkill /PID <主进程>`（不带 /F）：对 Electron 主进程无效 ——
 * 主进程没有自己的顶层窗口，实测直接报 "This process can only be terminated forcefully"，
 * 于是「确认后自动退出 DSH」根本不生效，守护进程只能干等到 30 分钟超时。
 *
 * 现在优先 app.quit()（走 before-quit，配置照常落盘）；拿不到 electron 才退回 taskkill。
 */
function closeDsh() {
  const exe = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe')
  const imageName = 'DeepSeek Harness.exe'
  const run = (args) => {
    try { spawn(isFile(exe) ? exe : 'taskkill', args, { stdio: 'ignore', windowsHide: true, detached: false }) } catch { }
  }

  // 先走一次「礼貌关闭」（不带 /F 只对带窗口的进程有效，会让 Electron 走正常关闭流程）。
  run(['/IM', imageName])
  // 3.5 秒后强制收尾：实测点关闭后 7 个进程全部残留（单杀 process.pid 只打掉一个子进程，
  // 因为插件跑在子进程里、进程号不是客户端主进程），必须按映像名整族收掉，
  // 否则「退出后自动推送」的等待进程会一直等到 30 分钟超时。
  const timer = setTimeout(() => { run(['/IM', imageName, '/F']) }, 3500)
  try { timer.unref?.() } catch { }

  // Electron 主进程形态下 app.quit 更温和（有 before-quit 落盘）；拿到了就先用它
  const el = electronApp()
  if (el) { try { setTimeout(() => { try { el.app.quit() } catch { } }, 150) } catch { } }
  return true
}

function isProcessAlive(pid) {
  if (!pid) return false
  try { process.kill(pid, 0); return true } catch { return false }
}
const STATE_NAME = 'config-sync-state.json'

/**
 * 上次同步成功的时间（由 sync.ps1 在 push/pull 成功后写进 <DshHome>\config-sync-state.json）。
 * 面板拿它当"本机数据有没有比仓库新"的分界线 —— 以前只比 git status，新会话还没 capture 时
 * 面板会显示"仓库与本机一致"，看着像没同步，其实只是没跑 capture。
 */
function readSyncState(dshHome) {
  const s = readJson(join(dshHome, STATE_NAME)) || {}
  return {
    lastSyncAt: typeof s.lastSyncAt === 'string' ? s.lastSyncAt : '',
    mode: typeof s.mode === 'string' ? s.mode : '',
    head: typeof s.head === 'string' ? s.head : '',
  }
}

/** 本机登记的工作区目录（capture 会把它们镜像进仓库，所以它们变了也算待推送）。 */
function workspaceRoots(dshHome) {
  const reg = readJson(join(dshHome, 'storages', 'workspace.json')) || {}
  const list = (reg.tables && reg.tables.workspaces) || reg.workspaces || []
  return Array.isArray(list)
    ? list.map((w) => (w && typeof w.path === 'string' ? w.path : '')).filter(Boolean)
    : []
}

/**
 * 本机 DSH 数据里「上次同步之后又写过」的文件有多少个。
 * 只看 mtime，不读内容、**不跑 capture**（跑 capture 要复制整个工作区，几 GB）。
 * 代价控制：跳过 node_modules / models / .git 等，最多 20000 个文件、最多 1.5 秒。
 *
 * 为什么要补一层内容比对：`profile\cordis.patch.yml` 这类文件 **DSH 每次启动都会重写**
 * （把仓库里存的 `{{APP_ROOT}}` 占位符展开成真实安装路径），mtime 永远比上次同步新，
 * 只看 mtime 就会出现「明明什么都没改，面板却一直建议推送」。所以对这几个有仓库对应物的
 * 单文件，mtime 更新后再把内容归一（占位符还原、换行统一）比一次，相同就不计入。
 */
function localPending(dshHome, lastSyncAt, profileName, ctx = {}) {
  const since = lastSyncAt ? Date.parse(lastSyncAt) : NaN
  if (!Number.isFinite(since)) return { known: false, pending: 0, newestAt: '', sample: [] }
  const skip = new Set(['node_modules', '.git', 'models', '_tmp', 'staging', 'logs', 'attachments'])
  const profile = join(dshHome, 'profiles', profileName || 'desktop')
  const stack = [
    join(dshHome, 'sessions'),
    join(dshHome, 'skills'),
    join(dshHome, '.agent-presets'),
    join(dshHome, 'mnemon'),
    join(dshHome, 'AGENTS.md'),
    join(dshHome, 'prompt-inject.md'),
    join(profile, 'package.json'),
    join(profile, 'pnpm-lock.yaml'),
    join(profile, 'cordis.patch.yml'),
    join(profile, 'host-contract.json'),
    ...workspaceRoots(dshHome),
  ]
  // 有仓库对应物的单文件：路径 → 仓库里的那份。只有这些才值得读内容比对。
  const repoRoot = String(ctx.repo || '')
  const mirrored = new Map()
  if (repoRoot) {
    mirrored.set(join(dshHome, 'AGENTS.md'), join(repoRoot, 'prompt', 'AGENTS.md'))
    mirrored.set(join(dshHome, 'prompt-inject.md'), join(repoRoot, 'prompt', 'prompt-inject.md'))
    for (const f of ['package.json', 'pnpm-lock.yaml', 'cordis.patch.yml', 'host-contract.json']) {
      mirrored.set(join(profile, f), join(repoRoot, 'profile', f))
    }
  }
  const deadline = Date.now() + 1500
  let scanned = 0
  let pending = 0
  let newest = 0
  const sample = []
  while (stack.length && scanned < 20000 && Date.now() < deadline) {
    const cur = stack.pop()
    let st
    try { st = statSync(cur) } catch { continue }
    if (st.isDirectory()) {
      if (skip.has(basename(cur))) continue
      let entries = []
      try { entries = readdirSync(cur) } catch { continue }
      for (const e of entries) stack.push(join(cur, e))
      continue
    }
    scanned++
    if (st.mtimeMs > since) {
      // 镜像文件的 mtime 更新可能只是宿主重写占位符：内容归一后一致就不算待推送
      const twin = mirrored.get(cur)
      if (twin && isFile(twin)) {
        try {
          if (mirrorText(cur, ctx.appRoot) === mirrorText(twin, ctx.appRoot)) continue
        } catch { }
      }
      pending++
      if (st.mtimeMs > newest) newest = st.mtimeMs
      if (sample.length < 3) sample.push(`${basename(dirname(cur))}/${basename(cur)}`)
    }
  }
  return {
    known: true,
    pending,
    newestAt: newest ? new Date(newest).toISOString() : '',
    sample,
    truncated: scanned >= 20000 || Date.now() >= deadline,
  }
}

/** 读成"可比较的文本"：换行统一、去尾部空白、把真实安装路径还原成 {{APP_ROOT}} 占位符。 */
function mirrorText(file, appRoot) {
  let text = readFileSync(file, 'utf8').replace(/\r\n/g, '\n').replace(/\s+$/, '')
  const root = String(appRoot || '').replace(/[\\/]+$/, '')
  if (root) {
    for (const variant of new Set([root, root.replace(/\\/g, '/'), root.replace(/\//g, '\\')])) {
      if (variant) text = text.split(variant).join('{{APP_ROOT}}')
    }
  }
  return text
}

async function repoState(repo) {
  if (!repo || !isDir(join(repo, '.git'))) return { ahead: 0, dirty: 0 }
  const status = await git(repo, ['status', '--porcelain'])
  const dirty = status ? status.split('\n').filter((l) => l.trim()).length : 0
  return { ahead: await aheadCount(repo), dirty }
}

/** 当前分支名（游离 HEAD 时给出 'main' 兜底，跟以前的行为一致）。 */
async function currentBranch(repo) {
  const raw = await git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])
  const name = String(raw || '').trim()
  return name && name !== 'HEAD' ? name : 'main'
}

/**
 * 本机领先远端多少提交。
 * 不能把分支名写死成 origin/main（以前就是这么写的，分支叫 master 或改了名时「领先」永远算 0）。
 * 优先用上游追踪（HEAD --not @{upstream}），没有上游时用当前分支对应的 origin/<分支>。
 */
async function aheadCount(repo) {
  const parse = (s) => Number(String(s || '').trim()) || 0
  const viaUpstream = await git(repo, ['rev-list', '--count', 'HEAD', '--not', '@{upstream}'])
  if (viaUpstream) return parse(viaUpstream)
  const branch = await currentBranch(repo)
  return parse(await git(repo, ['rev-list', '--count', 'HEAD', '--not', `origin/${branch}`]))
}

/** action 白名单：单个动作，或 all=一次性生成三个脚本。 */
const ACTIONS = ['push', 'pull', 'restore', 'restore-backup', 'all']


/** 远端地址只接受三种写法，别的一律拒（避免把乱七八糟的东西塞进 git remote）。 */
const REMOTE_RE = /^(git@[\w.\-]+:[^\s]+|ssh:\/\/[^\s]+|https:\/\/[^\s]+)$/i

/**
 * 保存仓库路径 / 远端地址 / 私钥路径。三样都可以单独改，也可以一起改。
 * 顺序：先校验 → 写设置文件 → 改 git remote（失败就回滚设置文件），不会留下半截状态。
 */
async function handleSettings(req, res, config) {
  if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: 'POST only' }); return }
  if (!originAllowed(req)) { sendJson(res, 403, { ok: false, error: 'cross-origin request rejected' }); return }
  const dshHome = config?.dshHome || process.env.DSH_HOME || join(homedir(), '.dsh')
  const file = settingsPath(dshHome)
  const prevRaw = isFile(file) ? readFileSync(file, 'utf8') : null
  try {
    const raw = await readBody(req)
    const body = raw.trim() ? JSON.parse(raw) : {}
    const has = (k) => Object.prototype.hasOwnProperty.call(body, k)
    const before = readSettings(dshHome)

    let repoPath = before.repoPath
    if (has('repoPath')) {
      repoPath = String(body.repoPath || '').trim().replace(/[\\/]+$/, '')
      if (!repoPath) throw new Error(t('仓库路径不能为空', 'Repo path cannot be empty'))
      // 新机器上这个目录常常还不存在、或者是个空目录（等着首次拉取去克隆）：都允许存。
      // 只有「已经有别的东西、又明显不是 dsh-config 仓库」才拒，免得住错地方把人家目录写乱。
      if (isDir(repoPath) && !isRepoDir(repoPath)) {
        let entries = []
        try { entries = readdirSync(repoPath) } catch { }
        if (entries.length > 0 && !isFile(join(repoPath, '.git', 'HEAD'))) {
          throw new Error(t(
            `这个目录里已经有别的东西，又不像 dsh-config 仓库（缺 apply.ps1 或 profile\\package.json）：${repoPath}`,
            `That directory already holds something else and does not look like a dsh-config repo (no apply.ps1 or profile\\package.json): ${repoPath}`,
          ))
        }
      }
    }

    let remoteUrl = before.remoteUrl
    if (has('remoteUrl')) {
      remoteUrl = String(body.remoteUrl || '').trim()
      if (!remoteUrl) throw new Error(t('远端地址不能为空', 'Remote URL cannot be empty'))
      if (!REMOTE_RE.test(remoteUrl)) throw new Error(t('远端地址只支持 git@host:path、ssh:// 或 https:// 三种写法', 'Remote URL must be git@host:path, ssh:// or https://'))
    }

    let sshKey = before.sshKey
    if (has('sshKey')) {
      sshKey = String(body.sshKey || '').trim()
      if (sshKey && !isFile(sshKey)) throw new Error(t(`私钥文件不存在：${sshKey}`, `Private key file does not exist: ${sshKey}`))
    }

    // 更新令牌：私有仓库读清单/下包要用。字段没给就沿用原值，明确 clearUpdateToken 才清空。
    let updateToken = before.updateToken
    if (body.clearUpdateToken === true) updateToken = ''
    else if (has('updateToken')) updateToken = String(body.updateToken || '').trim()

    // 更新清单地址：留空=用内置默认；填了必须 http(s)，免得写成半截路径
    let updateManifestUrl = before.updateManifestUrl
    if (body.clearUpdateManifestUrl === true) updateManifestUrl = ''
    else if (has('updateManifestUrl')) {
      updateManifestUrl = String(body.updateManifestUrl || '').trim()
      if (updateManifestUrl && !/^https?:\/\//i.test(updateManifestUrl)) {
        throw new Error(t('清单地址只能是 http(s) 链接；想用内置默认地址就留空', 'The manifest URL must be an http(s) link; leave it empty to use the built-in default'))
      }
    }

    // 备份根：留空 = 恢复默认 <DshHome>\backups；填了必须是绝对路径（相对路径会随 cwd 漂）
    let backupRoot = before.backupRoot
    if (body.clearBackupRoot === true) backupRoot = ''
    else if (has('backupRoot')) {
      backupRoot = String(body.backupRoot || '').trim().replace(/[\\/]+$/, '')
      if (backupRoot && !isAbsolute(backupRoot)) {
        throw new Error(t('备份目录要填绝对路径（例如 D:\\DSH备份）', 'The backup folder must be an absolute path (e.g. D:\\DSH-backups)'))
      }
      if (/["\r\n]/.test(backupRoot)) throw new Error(t('备份路径里不能含引号或换行', 'The backup path must not contain quotes or newlines'))
    }

    // 两个自动化开关：只能布尔；字段没给就沿用原值（面板保存单个字段时不会把开关冲掉）
    const autoPull = has('autoPull') ? body.autoPull === true : before.autoPull
    const autoPush = has('autoPush') ? body.autoPush === true : before.autoPush
    const autoRestart = has('autoRestart') ? body.autoRestart !== false : before.autoRestart

    if (!has('repoPath') && !has('remoteUrl') && !has('sshKey') &&
        !has('autoPull') && !has('autoPush') && !has('autoRestart') &&
        !has('backupRoot') &&
        !has('updateToken') && !has('updateManifestUrl') && body.clearUpdateToken !== true && body.clearUpdateManifestUrl !== true && body.clearBackupRoot !== true) {
      throw new Error(t(
        '没有要保存的字段（repoPath / remoteUrl / sshKey / autoPull / autoPush / backupRoot / updateToken / updateManifestUrl 至少给一个）',
        'Nothing to save (provide at least one of repoPath / remoteUrl / sshKey / autoPull / autoPush / backupRoot / updateToken / updateManifestUrl)',
      ))
    }

    // 新仓库路径一落盘，后面的 git remote 要对它做，别用改之前解析出来的旧仓库。
    const repo = repoPath || (resolveRepo(config?.repoPath, dshHome).repo || '')
    writeSettings(dshHome, { repoPath, remoteUrl, sshKey, autoPull, autoPush, autoRestart, updateToken, updateManifestUrl, backupRoot })

    const changed = {
      repoPath: before.repoPath !== repoPath,
      remoteUrl: before.remoteUrl !== remoteUrl,
      sshKey: before.sshKey !== sshKey,
      autoPull: before.autoPull !== autoPull,
      autoPush: before.autoPush !== autoPush,
      backupRoot: before.backupRoot !== backupRoot,
    }
    let gitSet = null
    if (repo && isDir(join(repo, '.git')) && remoteUrl) {
      const current = await git(repo, ['remote', 'get-url', 'origin'])
      if (current !== remoteUrl) {
        // 没有 origin 的新仓库（拷目录/解 tgz 得来的、不是 clone 的）不能 set-url，要先 add。
        const args = current === null
          ? ['-C', repo, 'remote', 'add', 'origin', remoteUrl]
          : ['-C', repo, 'remote', 'set-url', 'origin', remoteUrl]
        const result = await new Promise((resolve) => {
          execFile(resolveGitExe(), args,
            { windowsHide: true, timeout: 20000 }, (err, _out, stderr) => resolve({ err, stderr }))
        })
        if (result.err) {
          // 回滚：设置文件恢复原样，别让面板显示一个 git 并未采用的地址
          if (prevRaw === null) { try { unlinkSync(file) } catch { } } else { writeFileSync(file, prevRaw, 'utf8') }
          throw new Error(t(
            `${current === null ? 'git remote add' : 'git remote set-url'} 失败：${String(result.stderr || result.err.message || result.err).trim()}`,
            `${current === null ? 'git remote add' : 'git remote set-url'} failed: ${String(result.stderr || result.err.message || result.err).trim()}`,
          ))
        }
        gitSet = remoteUrl
      }
    }

    const sshKey2 = sshKey || defaultSshKey()
    sendJson(res, 200, {
      ok: true,
      changed,
      gitRemoteSet: Boolean(gitSet),
      repo: {
        path: repo || '',
        exists: Boolean(repo) && isRepoDir(repo),
        source: repoPath ? 'settings' : (resolveRepo(config?.repoPath, dshHome).source || 'none'),
        hasGit: Boolean(repo) && isDir(join(repo, '.git')),
        hasSync: Boolean(repo) && isFile(join(repo, 'sync.ps1')),
      },
      remote: {
        url: remoteUrl,
        sshKey: sshKey2,
        sshKeyExists: Boolean(sshKey2) && isFile(sshKey2),
        sshKeyFrom: sshKey ? 'settings' : (sshKey2 ? 'default' : 'none'),
        updateTokenSet: Boolean(updateToken),
        updateManifestUrl: updateManifestUrl || '',
        backupRoot: backupRoot || backupRootOf(dshHome, { backupRoot: '' }),
        backupRootCustom: Boolean(backupRoot),
        settingsPath: file,
      },
    })
  } catch (error) {
    sendJson(res, 400, { ok: false, error: String((error && error.message) || error) })
  }
}

/**
 * 插件自身的更新检查。
 *
 * 老版本机器上怎么知道有新版本：插件每次打开面板（以及每 30 分钟）读一次云端仓库根目录的
 * version.json，只比版本号，几百字节，不拉整包。有新版 → 面板标题下多一条「有新版本 x.y.z」
 * 和「更新」按钮；点更新才真正下载 tgz（带 sha256 校验）。
 */
const updateState = {
  checkedAt: 0,
  checking: false,
  manifest: null,   // { version, notes, releasedAt, tgz, sha256 }
  error: '',
  requestUrl: '',   // 用户配置的清单地址（空 = 用内置候选列表）
  url: '',          // 这次实际读到清单的源（tgz 的相对地址按它解析）
  sources: [],      // 依次试过的源与各自结果，面板要能看见"为什么不通"
  // DSH 运行中把包装好之后记在这里：{ version, at, backup, log }
  // 只是本进程内存态：重启后 PLUGIN_VERSION 就是新版本，自然不需要它了
  liveInstall: null,
  // 只下载、不安装时记在这里：{ version, sha256, file, size, at, url }
  // 覆盖插件目录的动作留到 DSH 退出后（post-exit -Mode update），
  // 因为运行中覆盖会让宿主重建插件树、把用户正在看的面板卸载掉。
  prepared: null,
}

function versionParts(v) {
  return String(v || '').replace(/^v/i, '').split(/[.\-+]/).map((x) => Number(String(x).replace(/[^0-9]/g, '')) || 0)
}

/** a>b 返回 1，相等 0，a<b 返回 -1。 */
function compareVersion(a, b) {
  const pa = versionParts(a)
  const pb = versionParts(b)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0
    const y = pb[i] || 0
    if (x !== y) return x > y ? 1 : -1
  }
  return 0
}

/**
 * 清单里 tgz 可以写相对路径（releases/xxx.tgz）。下载地址按"读到清单的那个源"优先，
 * 其余镜像依次兜底 —— 清单通了不代表包一定也能从同一个域名下下来。
 */
function resolveTgzCandidates(manifest, manifestUrl = '') {
  const tgz = String((manifest && manifest.tgz) || '')
  if (!tgz) return []
  // 清单里写了绝对地址就照它来，不替用户猜镜像
  if (/^https?:\/\//i.test(tgz)) return [tgz]
  const rel = tgz.replace(/^\.?\//, '')
  const bases = []
  const actual = String(manifestUrl || '').replace(/[^/]*$/, '')
  if (actual) bases.push(actual)
  for (const cand of UPDATE_MANIFEST_MIRRORS) {
    const base = cand.replace(/[^/]*$/, '')
    if (base && !bases.includes(base)) bases.push(base)
  }
  return bases.map((base) => base + rel)
}

/** version.json 里的 tgz 可以写相对路径（releases/xxx.tgz），拼在仓库 raw 根上。 */
function resolveTgzUrl(manifest, manifestUrl = UPDATE_MANIFEST_URL) {
  const list = resolveTgzCandidates(manifest, manifestUrl)
  if (list.length) return list[0]
  // 没给 tgz 时保留原来的兜底行为（返回空串，调用方自己报错）
  return ''
}

async function fetchManifest(url, timeoutMs = UPDATE_FETCH_TIMEOUT) {
  if (typeof fetch !== 'function') throw new Error(t('当前运行环境没有 fetch，无法检查更新', 'fetch is unavailable in this runtime — cannot check for updates'))
  const seconds = Math.round(timeoutMs / 1000)
  const ctrl = typeof AbortController === 'function' ? new AbortController() : null
  let timedOut = false
  const timer = ctrl ? setTimeout(() => { timedOut = true; try { ctrl.abort() } catch { } }, timeoutMs) : null
  try {
    const res = await fetch(url, { cache: 'no-store', signal: ctrl ? ctrl.signal : undefined })
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}${res.status === 403 ? t('（私有仓库要填只读令牌）', ' (a read-only token is required for private repos)') : ''}`)
    }
    const json = await res.json()
    if (!json || !json.version) throw new Error(t('version.json 里没有 version 字段', 'version.json has no "version" field'))
    return json
  } catch (error) {
    // abort 的原话是 "This operation was aborted"，看不出是谁的问题，换成能看懂的话
    if (timedOut) throw new Error(t(`超时（${seconds} 秒内没有响应）`, `timed out (no response in ${seconds}s)`))
    throw error
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * 读清单：自定义地址只用它自己；没配则按 UPDATE_MANIFEST_MIRRORS 依次试，第一个成功的就用。
 * 全失败时把每个源各自的失败原因汇总抛出 —— 面板上一眼能看出是超时、HTTP 状态还是解析失败。
 */
async function fetchManifestAuto(targetUrl, token = '', timeoutMs = UPDATE_FETCH_TIMEOUT) {
  const custom = String(targetUrl || '').trim()
  const candidates = custom ? [custom] : UPDATE_MANIFEST_MIRRORS.slice()
  const tried = []
  for (const cand of candidates) {
    try {
      const manifest = await fetchManifest(withAccessToken(cand, token), timeoutMs)
      tried.push({ url: cand, ok: true })
      return { manifest, url: cand, tried }
    } catch (error) {
      const msg = String((error && error.message) || error)
      let host = cand
      try { host = new URL(cand).host } catch { }
      tried.push({ url: cand, host, ok: false, error: msg })
      if (custom) break
    }
  }
  const detail = tried.map((x) => `${x.host || x.url}：${x.ok ? 'ok' : x.error}`).join('；')
  const error = new Error(t(`所有更新源都读不到（${detail}）`, `No update source could be reached (${detail})`))
  error.sources = tried
  throw error
}

/**
 * 私有仓库的 raw 链接匿名读会 403，必须换成 Gitee API 的 raw 端点再带 access_token。
 * 注意 API 的 raw 端点不吃"分支写进路径"，分支要单独给 ref：
 *   https://gitee.com/<owner>/<repo>/raw/<branch>/<path>
 * → https://gitee.com/api/v5/repos/<owner>/<repo>/raw/<path>?ref=<branch>&access_token=…
 * 公开库不填令牌时保持原样，行为跟以前一致。
 */
function withAccessToken(url, token) {
  const raw = String(url || '')
  if (!token) return raw
  let target = raw
  const m = /^https:\/\/gitee\.com\/([^/]+)\/([^/]+)\/raw\/([^/]+)\/(.+)$/.exec(raw.split('?')[0])
  if (m) target = `https://gitee.com/api/v5/repos/${m[1]}/${m[2]}/raw/${m[4]}?ref=${encodeURIComponent(m[3])}`
  const sep = target.includes('?') ? '&' : '?'
  return target + sep + 'access_token=' + encodeURIComponent(token)
}

async function checkUpdate({ force = false, url = '', token = '' } = {}) {
  const custom = String(url || '').trim()
  const now = Date.now()
  if (!force && updateState.requestUrl === custom && updateState.token === token && updateState.checkedAt && now - updateState.checkedAt < UPDATE_CHECK_TTL && (updateState.manifest || updateState.error)) {
    return updateState
  }
  updateState.checking = true
  updateState.requestUrl = custom
  updateState.token = token
  try {
    const got = await fetchManifestAuto(custom, token)
    updateState.manifest = got.manifest
    updateState.url = got.url
    updateState.sources = got.tried
    updateState.error = ''
  } catch (error) {
    updateState.manifest = null
    if (Array.isArray(error && error.sources)) updateState.sources = error.sources
    updateState.error = String((error && error.message) || error)
  } finally {
    updateState.checking = false
    updateState.checkedAt = Date.now()
  }
  return updateState
}

function updatePayload(state, settings = {}) {
  const remote = state.manifest
  const custom = String(settings.updateManifestUrl || '')
  const installed = state.liveInstall || null
  // 装好了但进程还在跑旧代码 = 需要重启；重启后 PLUGIN_VERSION 追上来，这条自然消失
  const restartRequired = Boolean(installed && compareVersion(installed.version, PLUGIN_VERSION) > 0)
  return {
    ok: !state.error,
    local: { version: PLUGIN_VERSION || t('未知', 'unknown'), dir: PLUGIN_DIR },
    // 更新相关的配置集中在这里（清单地址、令牌是否已存），别散到「云端仓库」卡里
    config: {
      manifestUrl: custom || UPDATE_MANIFEST_MIRRORS[0],
      manifestUrlIsDefault: !custom,
      manifestSources: custom ? [] : UPDATE_MANIFEST_MIRRORS.slice(),
      tokenSet: Boolean(settings.updateToken),
    },
    remote: remote ? {
      version: String(remote.version || ''),
      notes: String(remote.notes || ''),
      // 清单里的说明是中英两份（notes / notesEn），由客户端按自己的语言挑
      notesEn: String(remote.notesEn || ''),
      releasedAt: String(remote.releasedAt || ''),
      tgz: resolveTgzUrl(remote, state.url),
      sha256: String(remote.sha256 || ''),
    } : null,
    hasUpdate: remote ? compareVersion(remote.version, PLUGIN_VERSION) > 0 : false,
    checking: state.checking,
    checkedAt: state.checkedAt || 0,
    error: state.error || '',
    // 这次实际用上的源，以及每个源的成败 —— 检查失败时面板直接把原因列出来
    sourceUsed: state.url || '',
    sources: Array.isArray(state.sources) ? state.sources : [],
    installed,
    // 已经下到暂存目录、等着退出后安装的那个包；ready = 版本比当前进程里的新
    prepared: state.prepared
      ? {
        version: String(state.prepared.version || ''),
        file: String(state.prepared.file || ''),
        size: Number(state.prepared.size) || 0,
        sha256: String(state.prepared.sha256 || ''),
        at: Number(state.prepared.at) || 0,
        ready: compareVersion(state.prepared.version, PLUGIN_VERSION) > 0,
      }
      : null,
    restartRequired,
    pending: autoState.pending,
  }
}

/**
 * 把新版本的包**只下载到暂存目录**，一个字节都不碰插件目录。
 *
 * 为什么不能边运行边装：覆盖插件目录会让宿主重新同步插件树，把「配置同步」这个 main 面板
 * 卸载掉 —— 用户正在看的页面在装到一半时自己跳走，还得点回来才能按「重启」。
 * 所以把流程拆成两段：这里只负责落盘 + 校验 sha256，真正的覆盖交给退出后的 post-exit。
 *
 * 候选地址逐个试（raw 常常不通，反代在前面兜着），全失败时把每个源的原因汇总抛出。
 * 返回 { ok, file, size, sha256, url } 或 { ok:false, error }
 */
async function downloadPackage({ urls, sha256, version, dshHome }) {
  if (typeof fetch !== 'function') return { ok: false, error: t('当前运行环境没有 fetch，无法下载更新包', 'fetch is unavailable in this runtime — cannot download the update package') }
  const dir = join(dshHome, 'update-staging')
  try { mkdirSync(dir, { recursive: true }) } catch { }
  const file = join(dir, `dsh-config-sync-${version}.tgz`)
  const want = String(sha256 || '').toLowerCase()
  const errors = []
  for (const rawUrl of urls) {
    const url = String(rawUrl || '').trim()
    if (!url) continue
    try {
      const ctrl = typeof AbortController === 'function' ? new AbortController() : null
      const timer = ctrl ? setTimeout(() => { try { ctrl.abort() } catch { } }, 120 * 1000) : null
      let res
      try {
        res = await fetch(url, { cache: 'no-store', signal: ctrl ? ctrl.signal : undefined })
      } finally {
        if (timer) clearTimeout(timer)
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const buf = Buffer.from(await res.arrayBuffer())
      if (!buf.length) throw new Error(t('下载到的文件是空的', 'the downloaded file is empty'))
      const hash = createHash('sha256').update(buf).digest('hex')
      if (want && hash !== want) throw new Error(t(`sha256 不一致（拿到 ${hash}）`, `sha256 mismatch (got ${hash})`))
      writeFileSync(file, buf)
      return { ok: true, file, size: buf.length, sha256: hash, url }
    } catch (error) {
      let host = url
      try { host = new URL(url).host } catch { }
      errors.push(`${host}：${(error && error.message) || String(error)}`)
    }
  }
  return { ok: false, error: t('下载更新包失败（每个地址都试过了）：', 'cannot download the update package (every URL was tried): ') + errors.join(t('；', '; ')) }
}

/**
 * 运行中直接把新版本装进插件目录（不退出 DSH）。
 *
 * 注意：界面**不再走这条**。运行中覆盖插件目录会让宿主把当前面板卸载掉，
 * 用户看到的就是"更新到一半页面自己跳走"。面板改为「prepare 下载 → 退出后安装」，
 * 见 downloadPackage 的注释。这个函数留给 CLI / 兼容场景。
 *
 * 为什么当年能这么干：插件的 ps1 只是磁盘上的脚本，index.js 已经读进内存 —— 覆盖文件不会让当前进程崩，
 * 只是"文件是新的、进程还是旧的"，所以装完必须提示重启才生效。
 * 真正干活的是 runtime/install-plugin.ps1：它自己依次尝试候选下载地址、校验 sha256、解包、
 * 备份旧目录（<DshHome>\backups\plugin-<旧版本>-<时间戳>）、覆盖，失败就把备份拷回去。
 * 返回 { ok, version, backup, log, error }
 */
function runInstallPlugin({ version, sha256, urls, dshHome }) {
  const script = join(PLUGIN_DIR, 'runtime', 'install-plugin.ps1')
  if (!isFile(script)) return Promise.resolve({ ok: false, error: t('插件目录里没有 runtime\\install-plugin.ps1', 'runtime\\install-plugin.ps1 is missing from the plugin directory') })
  const sysRoot = process.env.SystemRoot || 'C:\\Windows'
  const ps = join(sysRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const args = [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script,
    '-PluginDir', PLUGIN_DIR,
    '-Version', String(version || ''),
    '-Sha256', String(sha256 || ''),
    '-TgzUrls', urls.join('|'),
    '-DshHome', dshHome,
  ]
  return new Promise((resolve) => {
    execFile(ps, args, { windowsHide: true, timeout: 6 * 60 * 1000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      const text = String(stdout || '') + String(stderr || '')
      // 脚本最后一行固定是 RESULT:{json}；前面是给人看的进度
      const line = text.split(/\r?\n/).filter((l) => l.startsWith('RESULT:')).pop()
      if (!line) {
        resolve({ ok: false, error: t('安装脚本没有返回结果：', 'The installer returned no result: ') + (text.trim().slice(-400) || String((err && err.message) || '无输出')) })
        return
      }
      try { resolve(JSON.parse(line.slice('RESULT:'.length))) } catch { resolve({ ok: false, error: t('安装脚本返回的结果不是合法 JSON', 'The installer result is not valid JSON') }) }
    })
  })
}

/**
 * 更新接口：
 *   GET  /config-sync/update             读缓存（30 分钟内不重复拉）
 *   POST {action:'check'}                强制重新检查
 *   POST {action:'install-live'}         运行中下载+校验+覆盖安装（不退出 DSH），装完提示重启生效
 *   POST {action:'restart'}              排队"退出后重启"，立刻关闭 DSH，由退出后的脚本用 explorer 代启拉回来
 *   POST {action:'apply'}                兜底：退出 DSH → 可见窗口下载/校验/安装 → 自动重启
 */
async function handleUpdate(req, res, config) {
  const dshHome = config?.dshHome || process.env.DSH_HOME || join(homedir(), '.dsh')
  const settings = readSettings(dshHome)
  // 清单地址允许被设置覆盖：换镜像/自建仓库、或本地搭测试服务时不改动插件源码。
  // 留空 = 用内置候选列表（jsDelivr 优先、raw 兜底）
  const manifestUrl = String(settings.updateManifestUrl || '')
  const updateToken = String(settings.updateToken || '')
  try {
    if (req.method === 'GET') {
      sendJson(res, 200, updatePayload(await checkUpdate({ url: manifestUrl, token: updateToken }), settings))
      return
    }
    if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: 'GET or POST only' }); return }
    if (!originAllowed(req)) { sendJson(res, 403, { ok: false, error: 'cross-origin request rejected' }); return }
    const raw = await readBody(req)
    const body = raw.trim() ? JSON.parse(raw) : {}
    const action = String(body.action || 'check')

    if (action === 'check') {
      const state = await checkUpdate({ force: true, url: manifestUrl, token: updateToken })
      sendJson(res, 200, { ok: !state.error, action, ...updatePayload(state, settings) })
      return
    }

    // 只下载：把包落到 <DshHome>\update-staging\，校验 sha256，**不动插件目录**。
    // 面板点「下载更新」走这条 —— 页面不会因为插件被改写而重置。
    if (action === 'prepare') {
      const state = await checkUpdate({ force: true, url: manifestUrl, token: updateToken })
      const remote = state.manifest
      if (!remote) throw new Error(t(`读不到更新清单：${state.error || '未知原因'}`, `Cannot read the update manifest: ${state.error || 'unknown reason'}`))
      if (compareVersion(remote.version, PLUGIN_VERSION) <= 0) {
        throw new Error(t(`已经是最新版本（${PLUGIN_VERSION}），无需更新`, `Already on the latest version (${PLUGIN_VERSION}) — no update needed`))
      }
      // 同一个版本已经下好就不重复下（DSH 一直开着时用户可能点第二次）
      const prev = updateState.prepared
      if (prev && prev.version === String(remote.version) && isFile(prev.file)) {
        sendJson(res, 200, { ok: true, action, prepared: prev, ...updatePayload(state, settings) })
        return
      }
      const urls = resolveTgzCandidates(remote, state.url)
      if (!urls.length) throw new Error(t('version.json 里没有给 tgz 下载地址', 'version.json gives no tgz download URL'))
      const got = await downloadPackage({ urls, sha256: String(remote.sha256 || ''), version: String(remote.version), dshHome })
      if (!got.ok) throw new Error(String(got.error || t('下载失败', 'download failed')))
      updateState.prepared = {
        version: String(remote.version),
        sha256: got.sha256,
        file: got.file,
        size: got.size,
        at: Date.now(),
        url: got.url,
      }
      sendJson(res, 200, { ok: true, action, prepared: updateState.prepared, ...updatePayload(state, settings) })
      return
    }

    // 装并重启：退出 DSH → 退出后的脚本用**已经下好的本地包**覆盖安装 → 自动拉起
    // 覆盖发生在 DSH 已退出之后，所以运行中的面板不会被打断，用户也不会被弹走。
    if (action === 'install-restart') {
      const prepared = updateState.prepared
      if (!prepared || !isFile(prepared.file)) {
        throw new Error(t('还没有下好的更新包，请先点「下载更新」', 'No downloaded package yet — click "Download update" first'))
      }
      if (compareVersion(prepared.version, PLUGIN_VERSION) <= 0) {
        updateState.prepared = null
        throw new Error(t(`已经是最新版本（${PLUGIN_VERSION}），无需安装`, `Already on the latest version (${PLUGIN_VERSION}) — nothing to install`))
      }
      const repo = resolveRepo(config?.repoPath, dshHome).repo || ''
      const appRoot = resolveAppRoot(config?.appRoot) || ''
      const started = await spawnWatcher({
        mode: 'update',
        repo,
        appRoot,
        dshHome,
        restart: true,
        extraArgs: [
          '-PluginDir', PLUGIN_DIR,
          '-UpdateTgz', prepared.file,
          '-UpdateVersion', String(prepared.version),
          '-UpdateSha256', String(prepared.sha256 || ''),
        ],
      })
      if (!started.ok) throw new Error(started.error)
      autoState.pending = { mode: 'update', at: Date.now(), version: String(prepared.version), restart: true, watcherPid: started.pid, installFrom: prepared.file }
      const closed = closeDsh()
      autoState.pending.closeRequested = closed
      sendJson(res, 200, { ok: true, action, started: true, pending: autoState.pending, closeRequested: closed, ...updatePayload(await checkUpdate({ force: false, url: manifestUrl, token: updateToken }), settings) })
      return
    }

    // 运行中直接装（不退出 DSH，**界面已不再使用**，留给 CLI/兼容）：下载 → 校验 sha256 → 备份旧版 → 覆盖插件目录
    if (action === 'install-live') {
      const state = await checkUpdate({ force: true, url: manifestUrl, token: updateToken })
      const remote = state.manifest
      if (!remote) throw new Error(t(`读不到更新清单：${state.error || '未知原因'}`, `Cannot read the update manifest: ${state.error || 'unknown reason'}`))
      if (compareVersion(remote.version, PLUGIN_VERSION) <= 0) {
        throw new Error(t(`已经是最新版本（${PLUGIN_VERSION}），无需更新`, `Already on the latest version (${PLUGIN_VERSION}) — no update needed`))
      }
      const urls = resolveTgzCandidates(remote, state.url)
      if (!urls.length) throw new Error(t('version.json 里没有给 tgz 下载地址', 'version.json gives no tgz download URL'))
      // 包只有一百多 KB，同步做完再回包：前端把按钮置灰等这一下就够了
      const report = await runInstallPlugin({ version: String(remote.version), sha256: String(remote.sha256 || ''), urls, dshHome })
      if (!report.ok) throw new Error(String(report.error || t('安装失败', 'install failed')))
      updateState.liveInstall = {
        version: String(remote.version),
        at: Date.now(),
        backup: String(report.backup || ''),
        log: String(report.log || ''),
      }
      // 注意 hasUpdate 仍是 true：进程里跑的还是旧代码，重启后 PLUGIN_VERSION 才追上来。
      // 面板靠 restartRequired 换成「已装好，重启生效」
      sendJson(res, 200, { ok: true, action, installed: updateState.liveInstall, ...updatePayload(state, settings) })
      return
    }

    // 只重启：排队"退出后拉起"，由 post-exit 的 relaunch 模式用 explorer 代启（不继承本窗口作业）
    if (action === 'restart') {
      const repo = resolveRepo(config?.repoPath, dshHome).repo || ''
      const appRoot = resolveAppRoot(config?.appRoot) || ''
      const started = await spawnWatcher({ mode: 'relaunch', repo, appRoot, dshHome, restart: true })
      if (!started.ok) throw new Error(started.error)
      autoState.pending = { mode: 'relaunch', at: Date.now(), restart: true, watcherPid: started.pid }
      const closed = closeDsh()
      autoState.pending.closeRequested = closed
      sendJson(res, 200, { ok: true, action, pending: autoState.pending, closeRequested: closed })
      return
    }

    if (action === 'apply') {
      const state = await checkUpdate({ force: true, url: manifestUrl, token: updateToken })
      const remote = state.manifest
      if (!remote) throw new Error(t(`读不到更新清单：${state.error || '未知原因'}`, `Cannot read the update manifest: ${state.error || 'unknown reason'}`))
      if (compareVersion(remote.version, PLUGIN_VERSION) <= 0) {
        throw new Error(t(`已经是最新版本（${PLUGIN_VERSION}），无需更新`, `Already on the latest version (${PLUGIN_VERSION}) — no update needed`))
      }
      const tgz = resolveTgzUrl(remote, state.url)
      if (!tgz) throw new Error(t('version.json 里没有给 tgz 下载地址', 'version.json gives no tgz download URL'))
      const notes = String((langStore.getStore() === 'en' ? (remote.notesEn || remote.notes) : remote.notes) || '').trim()
      const yes = await askConfirm(
        t('更新「配置同步」插件', 'Update the Config Sync plugin'),
        t(
          `把插件从 ${PLUGIN_VERSION} 更新到 ${remote.version}？`
          + (notes ? `\n\n${notes}` : '')
          + '\n\n更新过程：退出 DSH → 下载并校验安装包 → 备份旧版 → 覆盖安装 → 自动重启。',
          `Update the plugin from ${PLUGIN_VERSION} to ${remote.version}?`
          + (notes ? `\n\n${notes}` : '')
          + '\n\nSteps: exit DSH → download and verify the package → back up the old version → install over it → relaunch automatically.',
        ),
      )
      if (!yes) { sendJson(res, 200, { ok: true, action, cancelled: true, ...updatePayload(state, settings) }); return }

      const repo = resolveRepo(config?.repoPath, dshHome).repo || ''
      const appRoot = resolveAppRoot(config?.appRoot) || ''
      const started = await spawnWatcher({
        mode: 'update',
        repo,
        appRoot,
        dshHome,
        restart: true,
        extraArgs: [
          '-PluginDir', PLUGIN_DIR,
          '-UpdateVersion', String(remote.version),
          '-UpdateTgz', tgz,
          '-UpdateSha256', String(remote.sha256 || ''),
          ...(updateToken ? ['-UpdateToken', updateToken] : []),
        ],
      })
      if (!started.ok) throw new Error(started.error)
      autoState.pending = { mode: 'update', at: Date.now(), version: String(remote.version), restart: true, watcherPid: started.pid }
      const closed = closeDsh()
      autoState.pending.closeRequested = closed
      sendJson(res, 200, { ok: true, action, started: true, pending: autoState.pending, closeRequested: closed })
      return
    }

    throw new Error(t('action 只能是 check / install-live / restart / apply', 'action must be check / install-live / restart / apply'))
  } catch (error) {
    sendJson(res, 400, { ok: false, error: String((error && error.message) || error) })
  }
}

/* ------------------------------------------------------------------------- *
 * 同步内容勾选（scope）
 *
 * 面板「同步内容」卡片的数据落点：<DshHome>\config-sync-scope.json。
 * capture.ps1 / apply.ps1 读的是**同一个文件**，所以面板上的勾选立刻对
 * 「推送」和「拉取」两侧生效。文件不存在 = 全勾（保持老行为）。
 *
 * 语义：未勾选 = 推送不抓、拉取不还原；deleteCloud（默认关闭）打开时才顺带删掉仓库副本。
 * ------------------------------------------------------------------------- */

function scopePath(dshHome) {
  return join(dshHome, 'config-sync-scope.json')
}

function readScope(dshHome) {
  const fallback = { version: 1, deleteCloud: false, groups: {} }
  try {
    const obj = readJson(scopePath(dshHome))
    if (!obj || typeof obj !== 'object') return fallback
    return {
      version: 1,
      deleteCloud: obj.deleteCloud === true,
      groups: (obj.groups && typeof obj.groups === 'object') ? obj.groups : {},
    }
  } catch {
    return fallback
  }
}

function writeScope(dshHome, scope) {
  const file = scopePath(dshHome)
  try { mkdirSync(dirname(file), { recursive: true }) } catch { }
  const payload = JSON.stringify({
    version: 1,
    deleteCloud: scope.deleteCloud === true,
    groups: scope.groups && typeof scope.groups === 'object' ? scope.groups : {},
  }, null, 2) + '\n'
  writeFileSync(file, payload, 'utf8')
  return file
}

// 必需组：不许取消勾选 —— 因为不勾就会报错，而不是"少同步一点"。
// profile 里的 package.json / cordis.patch.yml 是 apply 的前置条件（仓库里缺它们 apply.ps1 直接 Die），
// host-contract.json 是两端版本一致性校验（丢了它版本不一致也照铺，客户端可能起不来）。
const SCOPE_REQUIRED_GROUPS = ['profile']
function scopeGroupRequired(id) { return SCOPE_REQUIRED_GROUPS.includes(id) }

function scopeGroupEnabled(scope, id) {
  if (scopeGroupRequired(id)) return true
  const g = scope && scope.groups ? scope.groups[id] : null
  if (!g || typeof g !== 'object') return true
  return g.enabled !== false
}

function scopeItemEnabled(scope, id, item) {
  if (scopeGroupRequired(id)) return true
  if (!scopeGroupEnabled(scope, id)) return false
  const g = scope.groups ? scope.groups[id] : null
  const ex = g && Array.isArray(g.excluded) ? g.excluded : []
  return !ex.includes(item)
}

/** 目录下的子目录名（排序稳定，避免面板每次顺序都在变） */
function listSubDirs(dir) {
  try {
    if (!existsSync(dir)) return []
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b))
  } catch {
    return []
  }
}

function countEntries(dir) {
  try {
    if (!existsSync(dir)) return 0
    return readdirSync(dir).length
  } catch {
    return 0
  }
}

/** profile 目录：优先 desktop，其次 profiles 下唯一的那一个 */
function resolveProfileDir(dshHome) {
  const desktop = join(dshHome, 'profiles', 'desktop')
  if (existsSync(desktop)) return desktop
  const all = listSubDirs(join(dshHome, 'profiles'))
  return all.length === 1 ? join(dshHome, 'profiles', all[0]) : desktop
}

/** 本机登记的工作区（title 用用户自己起的名，路径只用来判断在不在） */
function listWorkspaceEntries(dshHome) {
  try {
    const reg = readJson(join(dshHome, 'storages', 'workspace.json'))
    const table = reg && reg.tables && reg.tables.workspaces
    if (!table || typeof table !== 'object') return []
    return Object.keys(table).sort().map((id) => {
      const w = table[id] || {}
      const title = typeof w.title === 'string' && w.title.trim() ? w.title.trim() : id
      return { id, title, path: typeof w.path === 'string' ? w.path : '' }
    })
  } catch {
    return []
  }
}

/** link: 进 profile 的本地插件目录名（capture 会把它们打包成 local-plugins\*.zip） */
function listLocalPlugins(dshHome) {
  try {
    const pkg = readJson(join(resolveProfileDir(dshHome), 'package.json'))
    const deps = pkg && pkg.dependencies
    if (!deps || typeof deps !== 'object') return []
    const names = []
    for (const [name, spec] of Object.entries(deps)) {
      if (typeof spec !== 'string' || !spec.startsWith('link:')) continue
      const target = spec.slice(5).replace(/\//g, '\\').replace(/\\+$/, '')
      const leaf = target.split('\\').filter(Boolean).pop()
      names.push(leaf || name)
    }
    return names.sort((a, b) => a.localeCompare(b))
  } catch {
    return []
  }
}

/**
 * 面板要显示的十组内容 + 组内明细项。
 * 明细项一律用「本机实际存在的名字」，因为用户勾的就是自己看得见的那份。
 */
function collectScopeGroups(dshHome, appRoot) {
  const profileDir = resolveProfileDir(dshHome)
  const groups = []

  const profileFiles = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'cordis.yml', 'cordis.patch.yml']
    .filter((f) => existsSync(join(profileDir, f)))
  groups.push({ id: 'profile', titleZh: '本机 profile', titleEn: 'Local profile',
    descZh: 'package.json / lock / cordis 等宿主启动要读的配置', descEn: 'package.json, lockfiles and cordis config the host loads at startup',
    // 这几个文件互相咬合（lock 与 package.json 的 specifier 必须一致），只做整体开关
    required: true,
    items: profileFiles.map((f) => ({ id: f, label: f, excludable: false })) })

  const promptFiles = ['AGENTS.md', 'prompt-inject.md'].filter((f) => existsSync(join(dshHome, f)))
  groups.push({ id: 'prompt', titleZh: '全局提示', titleEn: 'Global prompts',
    descZh: 'AGENTS.md 与 prompt-inject.md，所有会话共用的提示词', descEn: 'AGENTS.md and prompt-inject.md — prompts shared by every session',
    items: promptFiles.map((f) => ({ id: f, label: f })) })

  const skills = listSubDirs(join(dshHome, 'skills'))
  groups.push({ id: 'skills', titleZh: 'Skills', titleEn: 'Skills',
    descZh: '整个 skills 目录镜像到云端，另一台机器直接铺回来', descEn: 'The whole skills folder mirrored to the cloud and restored on the other machine',
    items: skills.map((n) => ({ id: n, label: n })) })

  const presets = listSubDirs(join(dshHome, '.agent-presets'))
  groups.push({ id: 'presets', titleZh: 'Agent 预设', titleEn: 'Agent presets',
    descZh: 'Agent 预设目录（新建/编辑过的预设）', descEn: 'Agent preset folders',
    items: presets.map((n) => ({ id: n, label: n })) })

  const ledgerDir = join(dshHome, 'storages', '@montersy123', 'dsh-skill-market', 'data')
  const ledger = [
    { id: 'skill-market-installed.json', src: join(ledgerDir, 'installed.json') },
    { id: 'skill-market-panel.json', src: join(ledgerDir, 'panel.json') },
  ].filter((x) => existsSync(x.src))
  groups.push({ id: 'storages-record', titleZh: '技能市场台账', titleEn: 'Skill market ledger',
    descZh: '技能市场的安装台账与面板状态', descEn: 'Skill-market install ledger and panel state',
    items: ledger.map((f) => ({ id: f, label: f })) })

  const settingsFiles = [
    { id: 'our-free-model.json', src: join(dshHome, 'our-free-model', 'settings.json') },
    { id: 'comfyui-workflows.json', src: join(dshHome, 'data', 'dsh-comfyui', 'workflows.json') },
    { id: 'dsh-pet-main-config.jsonc', src: join(dshHome, 'dsh-pet', 'main-config.jsonc') },
    { id: 'dsh-market-state.json', src: join(profileDir, '.dsh-market', 'state.json') },
  ].filter((x) => existsSync(x.src))
  groups.push({ id: 'settings', titleZh: '插件设置与工作流', titleEn: 'Plugin settings & workflows',
    descZh: '免付费模型设置、ComfyUI 工作流库、桌宠配置、插件市场状态', descEn: 'Free-model settings, ComfyUI workflows, desktop-pet config, market state',
    items: settingsFiles.map((x) => ({ id: x.id, label: x.id })) })

  const mnemonDir = appRoot ? join(appRoot, 'mnemon') : ''
  const mnemonCount = mnemonDir && existsSync(mnemonDir) ? countEntries(mnemonDir) : 0
  groups.push({ id: 'mnemon', titleZh: '记忆数据', titleEn: 'Memory data',
    descZh: '记忆插件的数据目录（mnemon）', descEn: 'Memory-plugin data folder (mnemon)',
    items: mnemonDir && existsSync(mnemonDir) ? [{ id: 'mnemon', label: `mnemon（${mnemonCount} 项）`, excludable: false }] : [] })

  const localPlugins = listLocalPlugins(dshHome)
  groups.push({ id: 'local-plugins', titleZh: '本地源码插件包', titleEn: 'Local plugin packages',
    descZh: 'link 进 profile 的本地插件，打包成 zip 随配置走', descEn: 'link:-mounted local plugins, packaged as zip and carried with the config',
    items: localPlugins.map((n) => ({ id: n, label: n })) })

  const workspaces = listWorkspaceEntries(dshHome)
  groups.push({ id: 'workspace', titleZh: '工作区资料', titleEn: 'Workspace files',
    descZh: '登记过的工作区里的资料（>100MB 与模型权重本来就不同步）', descEn: 'Files inside registered workspaces (big files and model weights are never synced)',
    items: workspaces.map((w) => ({ id: w.id, label: w.title })) })

  groups.push({ id: 'conversations', titleZh: '会话记录', titleEn: 'Conversations',
    descZh: '每个工作区的对话、附件与缓存（按工作区勾选）', descEn: 'Chats, attachments and caches per workspace',
    items: workspaces.map((w) => ({ id: w.id, label: w.title })) })

  const scope = readScope(dshHome)
  for (const g of groups) {
    g.enabled = scopeGroupEnabled(scope, g.id)
    for (const it of g.items) it.enabled = scopeItemEnabled(scope, g.id, it.id)
  }
  return { scope, groups }
}

async function handleScope(req, res, config) {
  const dshHome = config?.dshHome || process.env.DSH_HOME || join(homedir(), '.dsh')
  try {
    if (req.method === 'GET') {
      const appRoot = resolveAppRoot(config?.appRoot) || ''
      const { scope, groups } = collectScopeGroups(dshHome, appRoot)
      sendJson(res, 200, {
        ok: true,
        deleteCloud: scope.deleteCloud === true,
        path: scopePath(dshHome),
        groups: groups.map((g) => ({
          id: g.id,
          title: t(g.titleZh, g.titleEn),
          desc: t(g.descZh, g.descEn),
          enabled: g.enabled,
          required: g.required === true,
          items: g.items.map((it) => ({ id: it.id, label: it.label, enabled: it.enabled, excludable: it.excludable !== false })),
        })),
      })
      return
    }
    if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: 'GET/POST only' }); return }
    if (!originAllowed(req)) { sendJson(res, 403, { ok: false, error: 'cross-origin request rejected' }); return }
    const raw = await readBody(req)
    const body = raw.trim() ? JSON.parse(raw) : {}
    const groupsIn = body && typeof body.groups === 'object' && body.groups ? body.groups : {}
    // 排除项只认「本机当前真实存在、且允许单独排除」的条目：
    // 拖着一堆早就不存在的 id 会让用户以后勾不回来（看不见却一直挡着同步）。
    const allowed = {}
    try {
      const cur = collectScopeGroups(dshHome, resolveAppRoot(config?.appRoot) || '')
      for (const g of cur.groups) allowed[g.id] = new Set(g.items.filter((i) => i.excludable !== false).map((i) => i.id))
    } catch { }
    const clean = {}
    for (const [id, g] of Object.entries(groupsIn)) {
      if (!g || typeof g !== 'object') continue
      // 必需组一律按"开启、无排除"处理：关掉它会让另一台 apply 直接报错，不是"少同步一点"
      if (scopeGroupRequired(id)) continue
      const entry = {}
      if (g.enabled === false) entry.enabled = false
      let ex = Array.isArray(g.excluded) ? g.excluded.filter((x) => typeof x === 'string' && x) : []
      if (allowed[id]) ex = ex.filter((x) => allowed[id].has(x))
      if (ex.length) entry.excluded = ex
      // 全勾的组不落盘：文件里只留"跟默认不一样"的部分，手改起来也清爽
      if (Object.keys(entry).length) clean[id] = entry
    }
    const file = writeScope(dshHome, { deleteCloud: body.deleteCloud === true, groups: clean })
    sendJson(res, 200, { ok: true, path: file, deleteCloud: body.deleteCloud === true })
  } catch (error) {
    sendJson(res, 400, { ok: false, error: String((error && error.message) || error) })
  }
}

/**
 * 「同步冲突」接口：pull 被本机文件挡住时，sync.ps1 会写 <DshHome>\sync-conflicts.json。
 *   GET                          读清单（两侧预览 + 每项当前选择）
 *   POST {items:[{path,choice}]} 保存选择（choice 只认 '' / 'local' / 'cloud'）
 *   POST {action:'restore',path} 把某一项的本机副本从备份写回工作区
 *   POST {action:'reset'}        放弃这份清单（下次拉取会重新算）
 * 真正按选择落地的是 sync.ps1（下次「立即拉取」读同一份文件），这里只动 JSON 与备份。
 */
function conflictPath(dshHome) { return join(dshHome, 'sync-conflicts.json') }

function readConflicts(dshHome) {
  const p = conflictPath(dshHome)
  if (!isFile(p)) return null
  try {
    const obj = JSON.parse(readFileSync(p, 'utf8'))
    if (!obj || !Array.isArray(obj.items)) return null
    return obj
  } catch { return null }
}

function writeConflicts(dshHome, obj) {
  const p = conflictPath(dshHome)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, JSON.stringify(obj, null, 2) + '\n', 'utf8')
  return p
}

async function handleConflict(req, res, config) {
  const dshHome = config?.dshHome || process.env.DSH_HOME || join(homedir(), '.dsh')
  try {
    if (req.method === 'GET') {
      const obj = readConflicts(dshHome)
      if (!obj) { sendJson(res, 200, { ok: true, exists: false, path: conflictPath(dshHome) }); return }
      const items = obj.items.map((it) => ({
        path: String(it.path || ''),
        kind: String(it.kind || ''),
        localSize: Number(it.localSize) || 0,
        remoteSize: Number(it.remoteSize) || 0,
        binary: it.binary === true,
        localPreview: String(it.localPreview || ''),
        remotePreview: String(it.remotePreview || ''),
        // 备份里到底有没有这一份（旧清单 / 备份失败时面板要把对应按钮置灰）
        localSaved: it.localSaved !== false,
        cloudSaved: it.cloudSaved === true,
        choice: String(it.choice || ''),
      }))
      sendJson(res, 200, {
        ok: true,
        exists: true,
        path: conflictPath(dshHome),
        at: obj.at || '',
        head: obj.head || '',
        remoteHead: obj.remoteHead || '',
        backupDir: obj.backupDir || '',
        items,
      })
      return
    }
    if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: 'GET/POST only' }); return }
    if (!originAllowed(req)) { sendJson(res, 403, { ok: false, error: 'cross-origin request rejected' }); return }
    const raw = await readBody(req)
    const body = raw.trim() ? JSON.parse(raw) : {}
    const obj = readConflicts(dshHome)
    if (!obj) {
      throw new Error(t(
        '当前没有待处理的冲突清单（下次拉取被本机文件挡住时会自动生成）',
        'No pending conflict list (one is created automatically when a pull is blocked)',
      ))
    }

    if (body.action === 'reset') {
      try { unlinkSync(conflictPath(dshHome)) } catch { }
      sendJson(res, 200, { ok: true, cleared: true })
      return
    }

    if (body.action === 'restore') {
      const rel = String(body.path || '').trim()
      if (!rel) throw new Error(t('没有指定要还原的文件', 'No file was given to restore'))
      const side = body.side === 'cloud' ? 'cloud' : 'local'
      // 还原落到「当时发生冲突的那个仓库」（清单里记着），而不是此刻设置里的路径：
      // 用户之后改过 repoPath 也不会把副本写进另一个仓库。
      const repo = String(obj.repo || '') || resolveRepo(config?.repoPath, dshHome).repo || ''
      if (!repo) throw new Error(t('还没有配置仓库目录', 'Repo directory is not configured'))
      const known = obj.items.find((it) => String(it.path) === rel)
      if (!known) throw new Error(t(`冲突清单里没有这个文件：${rel}`, `Not in the conflict list: ${rel}`))
      const base = String(obj.backupDir || '')
      if (!base) throw new Error(t('这份清单没有记录备份目录', 'The list has no backup directory'))
      // 目录名带中英说明；旧清单（0.3.17 最早那版）是 files / files-cloud，这里兜底
      const sub = side === 'cloud'
        ? (isDir(join(base, '云端-Cloud')) ? '云端-Cloud' : 'files-cloud')
        : (isDir(join(base, '本机-Local')) ? '本机-Local' : 'files')
      const src = join(base, sub, rel)
      if (!isFile(src)) {
        throw new Error(side === 'cloud'
          ? t('备份里没有这一项的云端副本（旧版清单不会存云端），无法还原', 'No cloud copy for this item (older lists did not save one)')
          : t('备份里没有这一项的本机副本，无法还原', 'No local copy for this item in the backup'))
      }
      const dst = join(repo, rel)
      mkdirSync(dirname(dst), { recursive: true })
      writeFileSync(dst, readFileSync(src))
      sendJson(res, 200, { ok: true, restored: rel, side })
      return
    }

    const incoming = Array.isArray(body.items) ? body.items : []
    const byPath = new Map(obj.items.map((it) => [String(it.path), it]))
    for (const one of incoming) {
      const p = String((one && one.path) || '')
      const c = String((one && one.choice) || '')
      const target = byPath.get(p)
      if (!target) continue
      target.choice = (c === 'local' || c === 'cloud') ? c : ''
    }
    const saved = writeConflicts(dshHome, obj)
    const pending = obj.items.filter((it) => !it.choice).length
    sendJson(res, 200, {
      ok: true,
      path: saved,
      pending,
      total: obj.items.length,
      chosen: obj.items.length - pending,
    })
  } catch (error) {
    sendJson(res, 400, { ok: false, error: String((error && error.message) || error) })
  }
}

async function handleStatus(req, res, config) {
  try {
    sendJson(res, 200, await inspect(config))
  } catch (error) {
    sendJson(res, 500, { ok: false, error: String((error && error.message) || error) })
  }
}

/**
 * 自动同步 / 自动推送的控制口：
 *   {action:'check'}      立刻做一次只读 fetch，返回 ahead/behind
 *   {action:'pull-now'}   排队"退出后拉取"，restart=true 时拉完自动拉起客户端；可选择立刻关闭 DSH
 *   {action:'push-now'}   排队"退出后推送"
 *   {action:'cancel'}     取消已排队的动作
 * 只做只读 fetch 比对（check），真正动手一律交给退出后的 post-exit.ps1。
 */
async function handleAuto(req, res, config) {
  if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: 'POST only' }); return }
  if (!originAllowed(req)) { sendJson(res, 403, { ok: false, error: 'cross-origin request rejected' }); return }
  try {
    const raw = await readBody(req)
    const body = raw.trim() ? JSON.parse(raw) : {}
    const action = String(body.action || '')
    const dshHome = config?.dshHome || process.env.DSH_HOME || join(homedir(), '.dsh')
    const settings = readSettings(dshHome)
    const repo = resolveRepo(config?.repoPath, dshHome).repo || ''
    if (!repo) throw new Error(t('还没有配置仓库目录，自动同步无从谈起', 'The repo directory is not configured, so auto sync cannot work'))
    const appRoot = resolveAppRoot(config?.appRoot) || ''

    if (action === 'check') {
      autoState.checking = true
      autoState.lastCheckError = ''
      const drift = await checkDrift(repo)
      autoState.checking = false
      autoState.lastCheckAt = Date.now()
      if (!drift) {
        autoState.lastCheckError = t(
          '读不到远端（fetch 失败或没有 origin），先确认云端仓库地址与 SSH',
          'Cannot read the remote (fetch failed or there is no origin) — check the cloud repo URL and SSH setup',
        )
      }
      autoState.drift = drift
      sendJson(res, 200, { ok: true, action, drift, error: autoState.lastCheckError || null })
      return
    }

    if (action === 'cancel') {
      autoState.pending = null
      sendJson(res, 200, { ok: true, action, pending: null })
      return
    }

    if (action === 'pull-now' || action === 'push-now') {
      const mode = action === 'pull-now' ? 'pull' : 'push'
      // 拉取/推送做完都把客户端拉回来（用户要求"完成后自动启动 dsh"），仍受 autoRestart 开关约束
      const restart = body.restart !== false && settings.autoRestart !== false
      const started = await spawnWatcher({ mode, repo, appRoot, dshHome, restart })
      if (!started.ok) throw new Error(started.error)
      autoState.pending = { mode, at: Date.now(), restart, watcherPid: started.pid, closeRequested: false }
      // 用户明确要求"现在就同步"：排队后请求客户端退出（不带 /F，走正常关闭，配置能存下来）
      let closed = false
      if (body.closeNow !== false) {
        closed = closeDsh()
        autoState.pending.closeRequested = closed
      }
      sendJson(res, 200, { ok: true, action, pending: autoState.pending, closeRequested: closed })
      return
    }

    throw new Error(t('action 只能是 check / pull-now / push-now / cancel', 'action must be check / pull-now / push-now / cancel'))
  } catch (error) {
    sendJson(res, 400, { ok: false, error: String((error && error.message) || error) })
  }
}

/** 启动后的自动检查：延迟跑，避免和客户端自身的启动流程抢 IO；失败只记进状态，不打扰用户。 */
function scheduleAutoStart(config) {
  const dshHome = config?.dshHome || process.env.DSH_HOME || join(homedir(), '.dsh')
  const settings = readSettings(dshHome)
  if (!settings.autoPull && !settings.autoPush) return
  if (autoState.timer) return
  const run = async () => {
    try {
      // 已经排队等退出了就别重复拉起 watcher：第二遍 fetch/stat 纯属浪费
      if (autoState.pending) return
      const repo = resolveRepo(config?.repoPath, dshHome).repo || ''
      if (!repo || !isDir(join(repo, '.git'))) {
        autoState.lastCheckError = t('仓库还没就位，跳过本次自动检查', 'The repo is not in place yet — skipping this auto check')
        autoState.lastCheckAt = Date.now()
        return
      }
      autoState.checking = true
      const drift = await checkDrift(repo)
      autoState.checking = false
      autoState.lastCheckAt = Date.now()
      if (!drift) {
        autoState.lastCheckError = t('读不到远端（fetch 失败或没有 origin）', 'Cannot read the remote (fetch failed or there is no origin)')
        return
      }
      autoState.drift = drift
      const appRoot = resolveAppRoot(config?.appRoot) || ''

      if (settings.autoPull && drift.behind > 0) {
        const yes = await askConfirm(
          t('云端有更新，要同步到本机吗？', 'The cloud has new commits — sync them to this machine?'),
          t(
            `云端比本机多 ${drift.behind} 个提交。\n`
            + '同步需要先完全退出 DSH：确认后客户端会自动关闭，拉取完成后按设置自动重新打开。\n'
            + `（本机领先 ${drift.ahead} 个提交，拉取不会动它们）`,
            `The cloud is ${drift.behind} commit(s) ahead of this machine.\n`
            + 'Syncing requires DSH to fully exit first: after you confirm, the client closes itself and reopens according to your settings once the pull finishes.\n'
            + `(This machine is ${drift.ahead} commit(s) ahead — pulling leaves those alone.)`,
          ),
        )
        if (yes) {
          const started = await spawnWatcher({ mode: 'pull', repo, appRoot, dshHome, restart: settings.autoRestart })
          if (started.ok) {
            autoState.pending = { mode: 'pull', at: Date.now(), restart: settings.autoRestart, watcherPid: started.pid, closeRequested: true }
            closeDsh()
          } else {
            autoState.lastCheckError = started.error
          }
        } else {
          autoState.pending = null
        }
        return
      }

      if (settings.autoPush) {
        // 该不该推，三个来源都算：本地领先的提交、未提交的改动、以及"本机资料比上次同步新"
        // （新会话还没 capture 时仓库是干净的，只看 ahead 会把最该推的那种改动漏掉 —— 真实踩过）
        let dirty = 0
        const raw = await git(repo, ['status', '--porcelain'])
        if (raw) dirty = raw.split('\n').filter((l) => l.trim()).length
        const syncState = readSyncState(dshHome)
        const lp = localPending(dshHome, syncState.lastSyncAt, config?.profileName, { repo, appRoot })
        // 后台调度里拿不到请求语言，所以中英各存一份，由客户端按自己的语言挑
        const reasonZh = drift.ahead > 0 ? `领先 ${drift.ahead} 个提交`
          : dirty > 0 ? `未提交 ${dirty} 项`
            : (lp.known && lp.pending > 0) ? `本机 ${lp.pending} 个文件比上次同步新` : ''
        const reasonEn = drift.ahead > 0 ? `${drift.ahead} commit(s) ahead`
          : dirty > 0 ? `${dirty} uncommitted change(s)`
            : (lp.known && lp.pending > 0) ? `${lp.pending} file(s) newer than the last sync` : ''
        if (reasonZh) {
          // 自动推送不需要确认（用户已开开关），排队等退出即可；推完把客户端拉回来
          const restart = settings.autoRestart !== false
          const started = await spawnWatcher({ mode: 'push', repo, appRoot, dshHome, restart })
          if (started.ok) {
            autoState.pending = { mode: 'push', at: Date.now(), reason: reasonZh, reasonZh, reasonEn, restart, watcherPid: started.pid, closeRequested: false }
          } else {
            autoState.lastCheckError = started.error
          }
        }
      }
    } catch (error) {
      autoState.checking = false
      autoState.lastCheckAt = Date.now()
      autoState.lastCheckError = String((error && error.message) || error)
    }
  }
  // 首检别拖太久：用户可能开起来看一眼就关窗口，20 秒会让他这次关闭什么都没推。
  autoState.timer = setTimeout(run, 8 * 1000)
  try { autoState.timer.unref?.() } catch { }
  // 之后每 2 分钟复查一次：会话/资料是运行中才产生的，只在启动判一次会把它们全漏掉。
  // 命中就排一次队，watcher 已在等进程退出，退出即执行；已排队时 run 会直接返回。
  try {
    autoState.interval = setInterval(run, 2 * 60 * 1000)
    autoState.interval.unref?.()
  } catch { }
}

async function handlePrepare(req, res, config) {
  if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: 'POST only' }); return }
  if (!originAllowed(req)) { sendJson(res, 403, { ok: false, error: 'cross-origin request rejected' }); return }
  try {
    const raw = await readBody(req)
    const body = raw.trim() ? JSON.parse(raw) : {}
    const action = String(body.action || '')
    if (!ACTIONS.includes(action)) throw new Error(t(`action 只能是 ${ACTIONS.join(' / ')}`, `action must be one of ${ACTIONS.join(' / ')}`))
    const message = typeof body.message === 'string' ? body.message : ''
    const dshHome = config?.dshHome || process.env.DSH_HOME || join(homedir(), '.dsh')
    const resolved = resolveRepo(config?.repoPath, dshHome)
    const repo = resolved.repo
    // 仓库还没克隆（新机器只装了插件）也允许生成：脚本会用插件自带的 runtime\，首次拉取由 sync.ps1 现场 clone。
    // 只有「压根没配过路径」才拦。
    if (!repo) {
      throw new Error(t(
        '还没有配置仓库目录：请先在面板「本机仓库」卡里点「设置路径」，指到一个目录（本地还没有仓库时，首次拉取会自动从云端克隆）',
        'The repo directory is not configured: set the path in the Local repo card first (if the repo is not local yet, the first pull clones it from the cloud automatically)',
      ))
    }
    const repoReady = isRepoDir(repo)
    // 推送 / 拉取都以「云端仓库地址」为前置；还原（最新快照或指定快照）只动本机快照，不需要远端。
    if (action !== 'restore' && action !== 'restore-backup') {
      const origin = isDir(join(repo, '.git')) ? await git(repo, ['remote', 'get-url', 'origin']) : null
      const remoteUrl = origin || readSettings(dshHome).remoteUrl
      if (!remoteUrl) {
        throw new Error(t(
          '还没有配置云端仓库地址：请先在面板「云端仓库」卡里填好远端地址并保存，再生成推送/拉取脚本',
          'The cloud repo is not configured: fill in the remote URL in the Cloud repo card and save before generating push/pull scripts',
        ))
      }
    }
    const appRoot = resolveAppRoot(config?.appRoot)
    // 定位不到客户端根就不许生成脚本：-AppRoot 错了会把插件部署进仓库、{{APP_ROOT}} 也全展开错位。
    if (!appRoot) {
      throw new Error(t(
        '定位不到客户端根目录（要能找到 resources\\app\\package.json 或 resources\\app.asar）：'
        + '请确认插件装在 <客户端根> 下（例如 D:\\DeepSeekHarness\\dsh-config-sync-0.1.0），或在设置里填客户端根 appRoot',
        'Cannot locate the client root (needs resources\\app\\package.json or resources\\app.asar): '
        + 'make sure the plugin is installed under <client root> (e.g. D:\\DeepSeekHarness\\dsh-config-sync-0.1.0), or set appRoot in the settings',
      ))
    }
    const state = {...await repoState(repo), message}
    // 「还原备份」点某一行：备份目录必须是备份根之下真实存在的一份快照 ——
    // 面板传来的路径直接拼进 cmd，所以这里既校验存在，也校验不含引号/换行，避免生成出跑不起来的脚本。
    let backupDir = ''
    if (action === 'restore-backup') {
      backupDir = String(body.backupDir || '').trim()
      if (!backupDir) throw new Error(t('没有指定要还原的备份目录', 'No backup directory was given'))
      if (/["\r\n]/.test(backupDir)) throw new Error(t('备份路径里不能含引号或换行', 'The backup path must not contain quotes or newlines'))
      if (!isDir(backupDir)) throw new Error(t(`备份目录不存在：${backupDir}`, `Backup directory does not exist: ${backupDir}`))
      const root = backupRootOf(dshHome, readSettings(dshHome))
      const rel = relative(root, backupDir)
      if (rel.startsWith('..') || rel === '' || isAbsolute(rel)) {
        throw new Error(t(`只能在备份根 ${root} 下选快照，不接受 ${backupDir}`, `Only snapshots under ${root} can be restored; refusing ${backupDir}`))
      }
      if (!isFile(join(backupDir, 'package.json'))) {
        throw new Error(t(
          `这份快照里没有 profile 文件（package.json），还原会失败：${backupDir}`,
          `That snapshot has no profile files (package.json) and cannot be restored: ${backupDir}`,
        ))
      }
    }
    const stateWithBackup = { ...state, backupDir }
    const bootstrap = repoReady ? null : {
      repo,
      note: t(
        '本机还没有这个仓库（或还没克隆）：生成的三份脚本先用插件自带的 runtime，第一次执行拉取/推送会自动从云端克隆到该目录',
        'This repo is not on this machine yet (or not cloned): the three scripts use the plugin\'s bundled runtime, and the first pull/push clones it from the cloud into that directory',
      ),
    }
    if (action === 'all') {
      const built = ['push', 'pull', 'restore'].map((a) => buildCmd(config, a, repo, appRoot, dshHome, state))
      sendJson(res, 200, { ok: true, action, built, bootstrap })
      return
    }
    const built = buildCmd(config, action, repo, appRoot, dshHome, stateWithBackup)
    sendJson(res, 200, { ok: true, action, ...built, bootstrap })
  } catch (error) {
    sendJson(res, 400, { ok: false, error: String((error && error.message) || error) })
  }
}

export function apply(ctx, config) {
  try {
    ctx.inject(['webServer'], (scoped) => {
      // 每个请求按 accept-language 决定返回中文还是英文：AsyncLocalStorage 让 t() 在
      // 任何异步后续里都能读到本次请求的语言，不用把语言参数一层层往下传。
      const withLang = (handler) => (req, res) => langStore.run(pickLang(req), () => handler(req, res, config))
      scoped.effect(() => scoped.webServer.register({
        kind: 'exact',
        path: ROUTE_STATUS,
        handler: withLang(handleStatus),
      }))
      scoped.effect(() => scoped.webServer.register({
        kind: 'exact',
        path: ROUTE_PREPARE,
        handler: withLang(handlePrepare),
      }))
      scoped.effect(() => scoped.webServer.register({
        kind: 'exact',
        path: ROUTE_SETTINGS,
        handler: withLang(handleSettings),
      }))
      scoped.effect(() => scoped.webServer.register({
        kind: 'exact',
        path: ROUTE_AUTO,
        handler: withLang(handleAuto),
      }))
      scoped.effect(() => scoped.webServer.register({
        kind: 'exact',
        path: ROUTE_UPDATE,
        handler: withLang(handleUpdate),
      }))
      scoped.effect(() => scoped.webServer.register({
        kind: 'exact',
        path: ROUTE_SCOPE,
        handler: withLang(handleScope),
      }))
      scoped.effect(() => scoped.webServer.register({
        kind: 'exact',
        path: ROUTE_CONFLICT,
        handler: withLang(handleConflict),
      }))
    })
    // 开关打开才排一次启动检查（默认关 = 什么都不做）
    scheduleAutoStart(config)
    installQuitWhenAllWindowsClosed(ctx)
  } catch (error) {
    // 不抛：缺 webServer 的 profile 里这个插件静默不激活即可
    try { ctx.logger?.warn?.(`[${PACKAGE_ID}] webServer 不可用，设置页面板不会出现：${error}`) } catch { }
  }
}

/**
 * 用户点窗口右上角的关闭键时，让客户端**真的退出**。
 *
 * 为什么要主动补一刀：宿主自己的 window-all-closed 只在"所有窗口都销毁"时才 quit，
 * 实测点了关闭后主进程又活了 1.5 分钟以上（还有隐藏/后台窗口在），
 * 而「退出后自动推送」的守护进程只认"主进程 pid 消失"——于是永远等不到，推送不执行。
 * 这里在窗口 closed 后查一遍：一个可见窗口都没有了就 app.quit()。
 */
function installQuitWhenAllWindowsClosed(ctx) {
  try {
    const el = electronApp()
    if (!el) return
    const flag = '__dshConfigSyncQuitHook'
    if (globalThis[flag]) return
    globalThis[flag] = true
    el.app.on('browser-window-created', (_event, win) => {
      try {
        win.on('closed', () => {
          setTimeout(() => {
            try {
              const alive = el.BrowserWindow.getAllWindows().filter((w) => w && !w.isDestroyed())
              const visible = alive.filter((w) => { try { return w.isVisible() } catch { return false } })
              if (visible.length === 0) {
                try { ctx.logger?.info?.(`[${PACKAGE_ID}] 已无可见窗口，退出客户端（好让退出后同步开始）`) } catch { }
                el.app.quit()
              }
            } catch { }
          }, 600)
        })
      } catch { }
    })
  } catch { }
}

export default { name: PACKAGE_ID, apply }
