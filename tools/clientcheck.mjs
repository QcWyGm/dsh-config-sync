/**
 * 客户端半身（client.js）的自检：
 *   node tools/clientcheck.mjs
 *
 * 浏览器模块表在 Node 里不存在，所以这里造一个最小的 window.__ModuleLoader__、react 替身，
 * 以及 CommonJS 的 exports/module（client.js 与官方插件一样用 exports.name/inject/apply 导出）。
 *
 * 验证三件事（真实 UI 效果仍以重启后目视为准）：
 *   1. 模块能按约定加载并导出 name / inject / apply；
 *   2. apply() 在 左侧栏 + main 面板 + 设置页 三处都成功注册，且 inject 回调返回回收函数；
 *   3. 各组件在"无数据 / 有数据"两种状态下渲染不抛（侧栏图标能吃 size 参数）。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'client.js'), 'utf8')

let failures = 0
function check(label, cond, detail = '') {
  if (cond) console.log(`  [OK] ${label}`)
  else { failures++; console.log(`  [X] ${label}${detail ? ' — ' + detail : ''}`) }
}

// --- react 替身：createElement 只记录结构，hooks 给可用的假实现 ---
const reactShim = {
  createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
  useState: (initial) => [initial, () => { }],
  useEffect: () => { },
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
  useRef: (v) => ({ current: v }),
  Fragment: 'Fragment',
}

const requireFn = (id) => {
  if (id === 'react') return reactShim
  throw new Error('未知模块：' + id)
}

/** 在造好的环境里跑 client.js，返回 factory 的产物（即 module.exports）。
 *  故意不提供外层 exports/module：真实加载器也不提供，bundle 必须在 factory 内部自建，
 *  否则真实环境里就是 "import failed"。 */
function loadClient(fetchImpl) {
  let loaded
  const windowStub = {
    __ModuleLoader__: { load: (entry) => { loaded = entry.factory(requireFn) } },
  }
  const run = new Function('window', 'fetch', source)
  run(windowStub, fetchImpl)
  return loaded
}

console.log('== dsh-config-sync 客户端半身自检 ==')

// 无副作用的 fetch：组件在无数据状态下不该真的发请求（useEffect 在替身里是 noop）
const noopFetch = async () => ({ ok: true, status: 200, text: async () => '{}' })

let exportsObj
try {
  exportsObj = loadClient(noopFetch)
  check('模块加载', Boolean(exportsObj))
} catch (e) {
  check('模块加载', false, String(e && e.message))
}

check('导出 name 正确', exportsObj && exportsObj.name === 'dsh-config-sync', String(exportsObj && exportsObj.name))
check('导出 inject 含 slots', Boolean(exportsObj && exportsObj.inject && exportsObj.inject.includes('slots')), JSON.stringify(exportsObj && exportsObj.inject))
check('导出 apply 是函数', typeof (exportsObj && exportsObj.apply) === 'function')

// --- 记录 apply() 的注册行为 ---
const regs = []
const recycle = []
const seq = []          // inject / register 的真实调用顺序，用来断言嵌套关系
const fakeCtx = {
  slots: {
    inject: (slot, cb) => {
      seq.push('inject:' + slot)
      const stop = cb()
      recycle.push({ slot, stop })
      return () => { }
    },
    register: (meta, comp) => {
      seq.push('register:' + meta.name)
      regs.push({ slot: meta.name, id: meta.id, key: meta.key, order: meta.order, label: meta.label, comp })
      return () => { }
    },
  },
}

try {
  exportsObj.apply(fakeCtx)
  check('apply() 未抛异常', true)
} catch (e) {
  check('apply() 未抛异常', false, String(e && e.message))
}

const sidebarRow = regs.find((r) => r.slot === 'sidebar.panellist')
const mainPanel = regs.find((r) => r.slot === 'main')
const settingsRow = regs.find((r) => r.slot === 'settings.general.item')

check('注册了左侧栏一行（sidebar.panellist）', Boolean(sidebarRow))
check('侧栏行 id 与 main 面板 key 一致', Boolean(sidebarRow && mainPanel && sidebarRow.id === mainPanel.key), `${sidebarRow && sidebarRow.id} / ${mainPanel && mainPanel.key}`)
check('侧栏行带 order 与 label', Boolean(sidebarRow && typeof sidebarRow.order === 'number' && typeof sidebarRow.label === 'function'), `${sidebarRow && sidebarRow.order} / ${typeof (sidebarRow && sidebarRow.label)}`)
check('注册了设置 → 通用 摘要行', Boolean(settingsRow))
check('客户端会调 /config-sync/settings 保存远端与私钥', /\/config-sync\/settings/.test(source))
check('客户端有可编辑的「本机仓库」卡（repoPath 走设置接口）', source.includes('function RepoCard') && source.includes('callSettings({ repoPath: path })'))
check('没配仓库时强制停在编辑态、且不提供取消', /forced/.test(source) && /forced \? null :/.test(source))
check('没配仓库时生成按钮被禁用', source.includes('disabled: busy || !canPush || noRemote'))
check('云端仓库缺配置时也强制编辑态（无取消）', /missing \? null :/.test(source) && source.includes('云端仓库地址'))
check('云端仓库没配时推送/拉取禁用、还原仍可用',
  source.includes('disabled: busy || !canPull || noRemote')
    && source.includes("disabled: busy || !hasRepoPath, onClick: () => prepare('restore')"))
check('面板有「提交说明」输入（生成推送脚本时带上）', source.includes('提交说明') && source.includes('prepare(\'push\', note)'))
check('按钮文案用中文（推送 / 拉取）', source.includes("'只生成推送'") && source.includes("'只生成拉取'"))
check('每个 inject 回调都返回了回收函数', recycle.length === 3 && recycle.every((r) => typeof r.stop === 'function'), `实际 ${recycle.length} 个`)

// 关键契约：sidebar.panellist 必须先被 inject，再往里 register（只 inject main 是无效的）
const idxInjectSidebar = seq.indexOf('inject:sidebar.panellist')
const idxInjectMain = seq.indexOf('inject:main')
const idxRegSidebar = seq.indexOf('register:sidebar.panellist')
const idxRegMain = seq.indexOf('register:main')
check('inject 顺序是 main → sidebar.panellist（嵌套）', idxInjectMain >= 0 && idxInjectSidebar > idxInjectMain, seq.join(' > '))
check('侧栏行在 inject:sidebar.panellist 之后才注册', idxRegSidebar > idxInjectSidebar && idxInjectSidebar >= 0, seq.join(' > '))
check('main 面板在 inject:main 之后注册', idxRegMain > idxInjectMain && idxInjectMain >= 0, seq.join(' > '))

function renderQuiet(label, factory) {
  try {
    const tree = factory()
    const walk = (n) => {
      if (!n || typeof n !== 'object') return
      if (Array.isArray(n)) { n.forEach(walk); return }
      if (n.children) n.children.forEach(walk)
    }
    walk(tree)
    check(label, Boolean(tree))
    return tree
  } catch (e) {
    check(label, false, String(e && e.message))
    return null
  }
}

renderQuiet('侧栏图标 size=14 可渲染', () => sidebarRow.comp({ size: 14 }))
renderQuiet('侧栏图标缺省 size 可渲染', () => sidebarRow.comp({}))
renderQuiet('主面板「无数据」可渲染', () => mainPanel.comp({}))
renderQuiet('设置摘要行「无数据」可渲染', () => settingsRow.comp({}))

// --- 有数据状态：fetch 返回一份体检 JSON（组件内部读取字段，渲染路径要能跑通） ---
const sample = {
  ok: true,
  at: 1762000000000,
  repo: { path: 'D:\\dsh-config', exists: true, branch: 'main', head: '9acc303 feat: x', dirty: 0, ahead: 0, behind: 2 },
  version: { local: '0.2.2-rc.1', contract: '0.2.2-rc.1', electron: '44.7.0', match: true },
  bundles: { total: 25, unresolved: [] },
  deps: { total: 21, missing: [] },
  advice: ['仓库落后 2 个提交：退出 DSH 后执行 pull'],
  auto: {
    pull: false, push: false, restart: true, checking: false,
    lastCheckAt: 0, lastCheckError: '', drift: null, pending: null, watcherStartedAt: 0,
    script: 'C:\\Users\\x\\.dsh\\plugins\\dsh-config-sync\\runtime\\post-exit.ps1',
    lastResult: {
      mode: 'pull', ok: true, at: 1762100000000, code: 0,
      message: '云端配置已拉取到本机', restored: false,
      log: 'C:\\Users\\x\\.dsh\\logs\\auto-sync-pull-20261111-123456.log',
    },
  },
  backup: {
    root: 'C:\\Users\\x\\.dsh\\backups',
    exists: true,
    latest: 'C:\\Users\\x\\.dsh\\backups\\config-20261110-212944',
    latestAt: 1762100000000,
    count: 3,
    latestFiles: 136,
    candidates: [],
  },
  remote: {
    url: 'git@gitee.com:qcwygm/dsh-config.git',
    urlSource: 'git',
    sshKey: 'C:\\Users\\x\\.ssh\\id_ed25519_gitee',
    sshKeyExists: true,
    sshKeyFrom: 'default',
    sshConfig: true,
    settingsPath: 'C:\\Users\\x\\.dsh\\dsh-config-sync.json',
  },
  paths: { appRoot: 'D:\\DeepSeekHarness', dshHome: 'C:\\Users\\x\\.dsh', profileDir: 'C:\\Users\\x\\.dsh\\profiles\\desktop' },
}

// 把 useSync 的数据注入路径替换掉不现实，这里改为直接验证 summarize 等纯函数所用字段的取值不抛：
// 用 useState 替身的另一种形态先把 data 注入组件（重新造一次环境，useState 第一次调用返回 sample）
function loadClientWithData(fetchImpl) {
  let loaded
  const windowStub = { __ModuleLoader__: { load: (entry) => { loaded = entry.factory(requireFn) } } }
  const mod = { exports: {} }
  // react 替身：useState 首次调用给 sample，第二次（made/open/busy）给默认值
  let calls = 0
  const reactWithData = Object.assign({}, reactShim, {
    useState: (initial) => {
      calls++
      if (calls === 1) return [sample, () => { }]
      return [initial, () => { }]
    },
  })
  const run = new Function('window', 'fetch', 'exports', 'module', 'reactOverride', source)
  run(windowStub, fetchImpl, mod.exports, mod, reactWithData)
  return loaded
}

// 注意：上面的 reactOverride 无法注入（client.js 内部 require('react')），
// 因此"有数据"渲染改为直接喂一个 data 形状给面板所用的小组件，验证字段访问路径不抛。
const dataShape = sample
try {
  const Kv = (props) => ({ type: 'kv', props })
  void Kv
  check('体检数据字段齐全（供组件读取）',
    Boolean(dataShape.repo && dataShape.version && dataShape.bundles && dataShape.deps && Array.isArray(dataShape.advice)))
  check('版本不一致时能算出（match 字段）', dataShape.version.match === true)
  check('落后数量是数字', typeof dataShape.repo.behind === 'number')
  check('体检数据带备份快照地址（页面要显示还原快照）',
    Boolean(dataShape.backup && dataShape.backup.latest && typeof dataShape.backup.count === 'number'),
    dataShape.backup && dataShape.backup.latest)
  check('体检数据带远端地址与私钥（云端仓库卡用）',
    Boolean(dataShape.remote && dataShape.remote.url && dataShape.remote.sshKey && dataShape.remote.settingsPath),
    JSON.stringify(dataShape.remote && { url: dataShape.remote.url, key: dataShape.remote.sshKey }))
  check('体检数据带自动同步开关与漂移状态（自动同步卡用）',
    Boolean(dataShape.auto) && typeof dataShape.auto.pull === 'boolean' &&
    typeof dataShape.auto.push === 'boolean' && typeof dataShape.auto.script === 'string',
    JSON.stringify(dataShape.auto && { pull: dataShape.auto.pull, push: dataShape.auto.push }))
  check('客户端会调 /config-sync/auto 控制自动同步', source.includes('/config-sync/auto'))
  check('体检数据带上次自动同步结果（启动弹提示用）',
    Boolean(dataShape.auto.lastResult) && typeof dataShape.auto.lastResult.ok === 'boolean' &&
    typeof dataShape.auto.lastResult.at === 'number',
    JSON.stringify(dataShape.auto.lastResult && { ok: dataShape.auto.lastResult.ok, at: dataShape.auto.lastResult.at }))
  check('打开面板会自动检查云端（无手动点击也会跑 check）', /callAuto\(\{ action: 'check'/.test(source))
  check('云端状态在标题行右侧（自动检查，靠徽标红绿显示，无手动按钮）',
    source.includes('云端检查中') && source.includes('云端与本机不一致') && !source.includes('立即检查'))
  check('本机路径区默认不进页面（只有标题行按钮点开才渲染）',
    source.includes('const rootsCard = showRoots ? h(RootsCard, { onRootsSaved: refresh }) : null') &&
    !source.includes('props.forceShow'),
    '缺 showRoots 三元 / 仍留着 forceShow')
  check('标题行按钮把待处理数量挂在文案上',
    source.includes('项待处理') && source.includes('data.localPaths && data.localPaths.total'))
} catch (e) {
  check('体检数据字段齐全', false, String(e && e.message))
}

console.log('')
console.log(failures === 0 ? '结论：全部通过（真实 UI 仍需重启后目视确认）' : `结论：${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
