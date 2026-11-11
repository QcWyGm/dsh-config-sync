/**
 * dsh-config-sync — 客户端半身（浏览器侧）
 *
 * 两个入口，共用一套数据：
 *   1) 左侧栏一行（slot: sidebar.panellist，id = config-sync）+ 配对的 main 面板，
 *      点开就是"配置同步"整页：仓库状态、版本契约、bundle 体检、生成退出后执行的脚本。
 *   2) 设置 → 通用 里的一行摘要（slot: settings.general.item），保留给习惯从设置进的人。
 *
 * 契约说明（从 dshmarket / dsh-mnemon 的实现里读出来的）
 *   - 侧栏行：ctx.slots.register({ name:'sidebar.panellist', id, order, label: () => '...' }, IconComponent)
 *     宿主按 id 负责点击后切换面板，所以必须再注册一个同名 key 的 main 面板：
 *   - 面板：ctx.slots.register({ name:'main', key: <同一 id> }, PageComponent)
 *     两者要在同一个 ctx.slots.inject('main', ...) 作用域里成对注册、成对回收。
 *
 * 纪律：不 import 任何 @deepseek-ai/dsh-client-* 包；样式只用 --dsw-alias-* token；
 * 不上 iframe；React 走 require('react')。
 * 唯一碰 document.body 的地方是"启动即弹上次同步结果"那个浮层：它必须在面板没打开时也能显示，
 * 只能自己 append 一个独立 div（不参与宿主布局，pointer-events:none，5 秒后自己移除）。
 */
window.__ModuleLoader__.load({
  id: 'dsh-config-sync',
  factory: (require) => {
    // 官方 bundle 都在 factory 内部自建 module/exports —— 外层没有这两个名字，
    // 直接用外层的 exports 会在真实加载器里 ReferenceError，整个 bundle import 失败。
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const react = require('react')
    const h = react.createElement

    const name = 'dsh-config-sync'
    const inject = ['slots']
    const PANEL_ID = 'config-sync'
    const TITLE = '配置同步'

    const S = {
      // 侧栏 / 设置摘要行
      row: { display: 'flex', flexDirection: 'column', gap: '6px', padding: '6px 0', width: '100%' },
      head: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', width: '100%' },
      headText: { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 },
      title: { fontSize: '14px', lineHeight: '20px', color: 'var(--dsw-alias-label-primary)' },
      sub: { fontSize: '12px', lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)', wordBreak: 'break-all' },
      chip: { fontSize: '12px', lineHeight: '18px', padding: '0 8px', borderRadius: '999px', whiteSpace: 'nowrap' },
      btn: {
        fontSize: '12px', lineHeight: '20px', padding: '2px 10px', borderRadius: '6px', cursor: 'pointer',
        border: '1px solid var(--dsw-alias-border-l2)', background: 'transparent',
        color: 'var(--dsw-alias-label-primary)',
      },
      btnPrimary: {
        fontSize: '12px', lineHeight: '20px', padding: '3px 12px', borderRadius: '6px', cursor: 'pointer',
        border: '1px solid var(--dsw-alias-button-primary-fill)',
        background: 'var(--dsw-alias-button-primary-fill)',
        color: 'var(--dsw-alias-label-primary-foreground)',
      },
      // 面板整页
      page: {
        height: '100%', overflowY: 'auto', boxSizing: 'border-box',
        padding: '20px 24px', background: 'var(--dsw-alias-bg-base)',
        color: 'var(--dsw-alias-label-primary)',
      },
      pageInner: { maxWidth: '1080px', margin: '0 auto', display: 'flex', flexDirection: 'column', gap: '18px' },
      pageTitle: { fontSize: '18px', lineHeight: '26px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)' },
      pageLead: { fontSize: '12px', lineHeight: '19px', color: 'var(--dsw-alias-label-tertiary)', margin: 0 },
      // 卡片分组：每组一个小标题 + 自适应网格（宽屏两列，窄了自动回落单列，卡片等高）
      section: { display: 'flex', flexDirection: 'column', gap: '10px' },
      sectionHead: { display: 'flex', alignItems: 'baseline', gap: '8px', flexWrap: 'wrap' },
      sectionTitle: { fontSize: '14px', lineHeight: '20px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)' },
      sectionHint: { fontSize: '12px', lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' },
      grid: {
        display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))',
        gap: '12px', alignItems: 'stretch',
      },
      card: {
        display: 'flex', flexDirection: 'column', gap: '8px', padding: '14px', minWidth: 0,
        border: '1px solid var(--dsw-alias-border-l1)', borderRadius: '10px',
        background: 'var(--dsw-alias-settings-card-fill)',
      },
      cardTitle: { fontSize: '13px', lineHeight: '18px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)' },
      kvRow: { display: 'flex', gap: '10px', fontSize: '12px', lineHeight: '18px', alignItems: 'flex-start' },
      kvKey: { width: '84px', flexShrink: 0, color: 'var(--dsw-alias-label-tertiary)' },
      kvVal: { flex: 1, minWidth: 0, color: 'var(--dsw-alias-label-secondary)', wordBreak: 'break-all' },
      advice: { fontSize: '12px', lineHeight: '19px', color: 'var(--dsw-alias-label-secondary)', margin: 0, paddingLeft: '18px', display: 'flex', flexDirection: 'column', gap: '2px' },
      actions: { display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' },
      hint: { fontSize: '12px', lineHeight: '19px', color: 'var(--dsw-alias-label-tertiary)', wordBreak: 'break-all' },
      code: {
        fontSize: '12px', lineHeight: '18px', padding: '8px 10px', borderRadius: '6px',
        background: 'var(--dsw-alias-fill-l1)', color: 'var(--dsw-alias-label-secondary)',
        fontFamily: 'Consolas, ui-monospace, monospace', whiteSpace: 'pre-wrap', wordBreak: 'break-all',
      },
      panel: {
        display: 'flex', flexDirection: 'column', gap: '8px', padding: '10px',
        border: '1px solid var(--dsw-alias-border-l1)', borderRadius: '8px',
        background: 'var(--dsw-alias-settings-card-fill)',
      },
      input: {
        flex: 1, minWidth: 0, fontSize: '12px', lineHeight: '18px', padding: '5px 8px',
        borderRadius: '6px', border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-base)', color: 'var(--dsw-alias-label-primary)',
        fontFamily: 'Consolas, ui-monospace, monospace',
      },
      inputReadonly: {
        flex: 1, minWidth: 0, fontSize: '12px', lineHeight: '18px', padding: '5px 8px',
        borderRadius: '6px', border: '1px solid transparent',
        background: 'transparent', color: 'var(--dsw-alias-label-secondary)',
        fontFamily: 'Consolas, ui-monospace, monospace',
      },
    }

    function chipStyle(kind) {
      // 底色只做"浅色染色"提示状态，文字一律用正文色：
      // 原先把 state-*-primary 既当底色又当文字色，浅绿底 + 浅绿字，看不清（用户实际反馈过）
      const map = {
        ok: 'var(--dsw-alias-state-success-secondary)',
        warn: 'var(--dsw-alias-state-warn-secondary)',
        error: 'var(--dsw-alias-state-error-secondary)',
        idle: 'var(--dsw-alias-fill-l1)',
      }
      return Object.assign({}, S.chip, {
        background: map[kind] || map.idle,
        color: 'var(--dsw-alias-label-primary)',
        fontWeight: 500,
      })
    }

    /** 一个分区：小标题 + 说明 + 内部网格。卡片少时自动单列，宽了并排两列。 */
    function Section(title, hint, cards) {
      const list = (cards || []).filter(Boolean)
      if (!list.length) return null
      return h('div', { style: S.section },
        h('div', { style: S.sectionHead },
          h('div', { style: S.sectionTitle }, title),
          hint ? h('div', { style: S.sectionHint }, hint) : null,
        ),
        h('div', { style: S.grid }, list),
      )
    }

    /**
     * 左侧徽标：只说**本机自身**的状态（配置是否齐、依赖是否缺、有没有未提交/未推送的改动）。
     * 「云端比本机领先多少」一律交给右侧云端徽标（cloudLine），否则标题行会同时出现
     * 「待处理」和「一致」两句都是在讲同一件事，看着像互相矛盾。
     */
    function summarize(data) {
      if (!data) return { kind: 'idle', text: '尚未检测' }
      const { repo, version, bundles, deps } = data
      if (!repo || !repo.exists) return { kind: 'error', text: '仓库路径还没配置（先在本机仓库卡里设置）' }
      if (!data.remote || !data.remote.configured) return { kind: 'error', text: '云端仓库地址还没配置（先在云端仓库卡里设置）' }
      if (bundles.unresolved.length || deps.missing.length) {
        return { kind: 'error', text: `${bundles.unresolved.length} 个 bundle 解析不到 · ${deps.missing.length} 个依赖缺失` }
      }
      if (version.local && version.contract && !version.match) {
        return { kind: 'warn', text: `版本不一致（本机 ${version.local} ≠ 契约 ${version.contract}）` }
      }
      if (repo.behind === null) return { kind: 'idle', text: '读不到本机 git 状态（git 不可用或没 upstream）' }
      if (repo.dirty > 0) return { kind: 'warn', text: `本机有 ${repo.dirty} 处未提交改动，建议推送` }
      if (repo.ahead > 0) return { kind: 'warn', text: `本机有 ${repo.ahead} 个提交还没推送` }
      // git 干净不代表没东西要推：新会话/新资料还躺在 ~\.dsh 里，没 capture 之前仓库是完全干净的
      const local = data.local || {}
      if (local.known && local.pending > 0) {
        return { kind: 'warn', text: `本机有 ${local.pending} 个文件在上次同步后有更新，建议推送` }
      }
      return { kind: 'ok', text: '仓库与本机一致' }
    }

    function chipLabel(kind) {
      if (kind === 'ok') return '一致'
      if (kind === 'error') return '有问题'
      if (kind === 'warn') return '待推送'
      return '未检测'
    }

    async function callStatus() {
      const res = await fetch('/config-sync/status', { cache: 'no-store', credentials: 'same-origin' })
      const text = await res.text()
      let body
      try { body = text ? JSON.parse(text) : null } catch { throw new Error(`${res.status} 返回非 JSON`) }
      if (!res.ok || !body || body.ok !== true) throw new Error((body && body.error) || `${res.status}`)
      return body
    }

    async function callPrepare(action, message) {
      const res = await fetch('/config-sync/prepare', {
        method: 'POST',
        cache: 'no-store',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, message: message || '' }),
      })
      const text = await res.text()
      let body
      try { body = text ? JSON.parse(text) : null } catch { throw new Error(`${res.status} 返回非 JSON`) }
      if (!res.ok || !body || body.ok !== true) throw new Error((body && body.error) || `${res.status}`)
      return body
    }

    async function callSettings(payload) {
      const res = await fetch('/config-sync/settings', {
        method: 'POST',
        cache: 'no-store',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const text = await res.text()
      let body
      try { body = text ? JSON.parse(text) : null } catch { throw new Error(`${res.status} 返回非 JSON`) }
      if (!res.ok || !body || body.ok !== true) throw new Error((body && body.error) || `${res.status}`)
      return body
    }

    /** 自动同步接口：check / pull-now / push-now / cancel。 */
    async function callAuto(payload) {
      const res = await fetch('/config-sync/auto', {
        method: 'POST',
        cache: 'no-store',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const text = await res.text()
      let body
      try { body = text ? JSON.parse(text) : null } catch { throw new Error(`${res.status} 返回非 JSON`) }
      if (!res.ok || !body || body.ok !== true) throw new Error((body && body.error) || `${res.status}`)
      return body
    }

    /** 插件更新：读版本清单（服务端缓存 30 分钟），check 时强制重查。 */
    async function callUpdate(payload) {
      const res = await fetch('/config-sync/update', payload
        ? {
          method: 'POST',
          cache: 'no-store',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        }
        : { cache: 'no-store', credentials: 'same-origin' })
      const text = await res.text()
      let body
      try { body = text ? JSON.parse(text) : null } catch { throw new Error(`${res.status} 返回非 JSON`) }
      if (!res.ok || !body) throw new Error((body && body.error) || `${res.status}`)
      return body
    }

    /** 取一份体检数据 + 生成脚本动作，供两个入口复用。 */
    function useSync() {
      const [data, setData] = react.useState(null)
      const [err, setErr] = react.useState('')
      const [busy, setBusy] = react.useState(false)
      const [made, setMade] = react.useState(null)

      const refresh = react.useCallback(async () => {
        setBusy(true)
        setErr('')
        try { setData(await callStatus()) } catch (e) { setErr(String((e && e.message) || e)) } finally { setBusy(false) }
      }, [])

      react.useEffect(() => {
        let alive = true
        callStatus()
          .then((d) => { if (alive) setData(d) })
          .catch((e) => { if (alive) setErr(String((e && e.message) || e)) })
        return () => { alive = false }
      }, [])

      const prepare = react.useCallback(async (action, message) => {
        setBusy(true)
        setErr('')
        try { setMade(await callPrepare(action, message)) } catch (e) { setErr(String((e && e.message) || e)) } finally { setBusy(false) }
      }, [])

      return { data, err, busy, made, refresh, prepare }
    }

    function Kv(props) {
      return h('div', { style: S.kvRow },
        h('div', { style: S.kvKey }, props.k),
        h('div', { style: S.kvVal }, props.v),
      )
    }

    function Advice(props) {
      return h('ul', { style: S.advice }, (props.items || []).map((a, i) => h('li', { key: i }, a)))
    }

    function MadeNote(props) {
      const made = props.made
      if (!made) return null
      const items = Array.isArray(made.built)
        ? made.built
        : [{ action: made.action, label: made.label, path: made.path, command: made.command, backup: made.backup, warnings: made.warnings }]
      const LABEL = { push: '推送', pull: '拉取', restore: '还原', all: '全部' }
      const backup = items.map((it) => it.backup).find((b) => b && b.dir)
      const when = backup && backup.at ? new Date(backup.at).toLocaleString('zh-CN', { hour12: false }) : ''
      const warnItems = items.flatMap((it) => (Array.isArray(it.warnings) ? it.warnings.map((w) => ({ action: it.action, w })) : []))
      const key = 'warn_' + (warnItems.length ? 1 : 0)
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
        items.map((it, i) => h('div', { key: i, style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
          h('div', { style: S.hint }, `已生成「${it.label || LABEL[it.action] || it.action}」：${it.path}`),
          h('div', { style: S.code }, it.command),
        )),
        backup
          ? h('div', { style: S.hint },
            `还原快照：${backup.dir}（${when}，共 ${backup.count} 份中的最新，含 ${backup.files} 个文件）`)
          : null,
        warnItems.length
          ? h('div', { key, style: { display: 'flex', flexDirection: 'column', gap: '2px' } },
            warnItems.map((x, i) => h('div', {
              key: i,
              style: { ...S.hint, color: 'var(--dsw-alias-state-warn-primary)' },
            }, `[${LABEL[x.action] || x.action}] ${x.w}`)))
          : null,
        h('div', { style: S.hint }, '同步动作必须在 DSH 完全退出后执行——脚本里已带进程检查，双击会先拦一次；拉取脚本会让你先输 y 确认，还原脚本会先跑一遍只看不动。'),
      )
    }

    /**
     * 本机仓库卡：仓库目录（哪台机器上那份 dsh-config）。
     * 默认只读；没配过就强制停在编辑态——不先指定仓库，推送/拉取/还原都无从生成。
     */
    function RepoCard(props) {
      const repo = (props.data && props.data.repo) || {}
      const missing = Boolean(props.data) && !repo.exists
      const [editing, setEditing] = react.useState(false)
      const [path, setPath] = react.useState(repo.path || '')
      const [busy, setBusy] = react.useState(false)
      const [err, setErr] = react.useState('')
      const [msg, setMsg] = react.useState('')
      const sourceLabel = (s) => s === 'settings' ? '本机设置'
        : (s === 'config' ? '插件配置（cordis.patch.yml）' : (s === 'env' ? '环境变量 DSH_CONFIG_REPO' : (s === 'auto' ? '自动探测' : '未配置')))

      // 没配仓库 = 强制编辑态，且不允许「取消」回到只读
      const forced = missing
      const isEditing = editing || forced

      const startEdit = () => { setPath(repo.path || ''); setErr(''); setMsg(''); setEditing(true) }
      const cancelEdit = () => { setEditing(false); setErr(''); setMsg('') }
      const save = async () => {
        setBusy(true); setErr(''); setMsg('')
        try {
          const r = await callSettings({ repoPath: path })
          setMsg(`已保存仓库路径${r.repo && r.repo.hasGit ? '' : '（该目录没有 .git，推送/拉取会失败）'}`)
          setEditing(false)
          if (typeof props.onSaved === 'function') props.onSaved()
        } catch (e) {
          setErr(String((e && e.message) || e))
        } finally { setBusy(false) }
      }

      const row = h('div', { style: S.kvRow },
        h('div', { style: S.kvKey }, '仓库路径'),
        isEditing
          ? h('input', {
            type: 'text', style: S.input, value: path, spellCheck: false,
            placeholder: 'D:\\dsh-config（那台机器上装仓库的目录）',
            onChange: (e) => setPath(e.target.value),
          })
          : h('div', { style: { ...S.kvVal, fontFamily: 'Consolas, ui-monospace, monospace' } }, repo.path || '（未配置）'),
      )

      return h('div', { style: S.card },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } },
          h('div', { style: S.cardTitle }, '本机仓库'),
          h('div', { style: { ...S.hint, flex: 1 } }, isEditing
            ? (forced ? '还没配置仓库目录，先填好并保存，才能生成同步脚本' : '编辑中：改完点保存')
            : '只读展示，点「修改」后可编辑'),
          h('div', { style: S.actions },
            isEditing
              ? h(react.Fragment, null,
                h('button', { type: 'button', style: S.btnPrimary, disabled: busy || !path.trim(), onClick: save }, busy ? '保存中…' : '保存'),
                forced ? null : h('button', { type: 'button', style: S.btn, disabled: busy, onClick: cancelEdit }, '取消'),
              )
              : h('button', { type: 'button', style: S.btn, disabled: !props.data, onClick: startEdit }, '修改'),
          ),
        ),
        row,
        h(Kv, { k: '路径来源', v: sourceLabel(repo.source) + (repo.exists ? '' : '（这个路径不可用）') }),
        h(Kv, { k: '分支 / HEAD', v: repo.exists ? `${repo.branch || '?'} @ ${repo.head || '?'}` : '（不可用）' }),
        h(Kv, { k: '远端', v: repo.exists ? `落后 ${repo.behind ?? '?'} · 领先 ${repo.ahead ?? '?'} · 未提交 ${repo.dirty ?? '?'}` : '（不可用）' }),
        h(Kv, { k: '本机数据', v: (() => {
          const local = props.data && props.data.local
          if (!local || !local.known) return '还没同步过（跑一次推送/拉取后才知道本机有没有新写入）'
          const when = local.lastSyncAt ? new Date(local.lastSyncAt).toLocaleString('zh-CN', { hour12: false }) : '?'
          const tail = local.pending > 0
            ? `上次同步后有 ${local.pending} 个文件更新${local.sample && local.sample.length ? `（如 ${local.sample.join('、')}）` : ''}`
            : '上次同步后没有新写入'
          return `${tail}；上次同步 ${when}${local.mode ? `（${local.mode}）` : ''}`
        })() }),
        h('div', { style: S.hint }, '仓库路径只存本机（C:\\Users\\你\\.dsh\\dsh-config-sync.json），不进仓库；换台机器各配各的。'),
        forced
          ? h('div', { style: { ...S.hint, color: 'var(--dsw-alias-state-error-primary)' } },
            '必须先把仓库目录配好：否则推送/拉取/还原三份脚本都无法生成，体检也只能看个空壳。')
          : null,
        err ? h('div', { style: { ...S.hint, color: 'var(--dsw-alias-state-error-primary)' } }, `保存失败：${err}`) : null,
        msg ? h('div', { style: { ...S.hint, color: 'var(--dsw-alias-state-success-primary)' } }, msg) : null,
      )
    }

    /**
     * 云端仓库卡：远端地址 + SSH 私钥路径。
     * 默认只读展示；点「修改」才变成可编辑，保存走 POST /config-sync/settings，
     * 宿主那边会同时 git remote set-url，失败则回滚设置文件并回显错误。
     */
    function RemoteCard(props) {
      const remote = (props.data && props.data.remote) || {}
      // 没配过云端仓库 = 强制编辑态：不给「取消」，也不许就这么放着去生成推送/拉取
      const missing = Boolean(props.data) && !remote.configured
      const [editing, setEditing] = react.useState(false)
      const [url, setUrl] = react.useState(remote.url || '')
      const [key, setKey] = react.useState(remote.sshKey || '')
      const [busy, setBusy] = react.useState(false)
      const [err, setErr] = react.useState('')
      const [msg, setMsg] = react.useState('')
      const isEditing = editing || missing
      const sourceLabel = (s) => s === 'settings' ? '本机设置' : (s === 'git' ? 'git 配置' : (s === 'default' ? '自动探测' : '未配置'))

      const startEdit = () => {
        setUrl(remote.url || '')
        setKey(remote.sshKey || '')
        setErr('')
        setMsg('')
        setEditing(true)
      }
      const cancelEdit = () => { setEditing(false); setErr(''); setMsg('') }
      const save = async () => {
        setBusy(true); setErr(''); setMsg('')
        try {
          const r = await callSettings({ remoteUrl: url, sshKey: key })
          setMsg(`已保存${r.gitRemoteSet ? '，并已更新本机 git origin' : ''}`)
          setEditing(false)
          if (typeof props.onSaved === 'function') props.onSaved()
        } catch (e) {
          setErr(String((e && e.message) || e))
        } finally { setBusy(false) }
      }

      const field = (label, value, onChange, placeholder) => h('div', { style: S.kvRow },
        h('div', { style: S.kvKey }, label),
        isEditing
          ? h('input', {
            type: 'text', style: S.input, value, placeholder, spellCheck: false,
            onChange: (e) => onChange(e.target.value),
          })
          : h('div', { style: { ...S.kvVal, fontFamily: 'Consolas, ui-monospace, monospace' } }, value || '（未配置）'),
      )

      return h('div', { style: S.card },
        h('div', {
          style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
        },
          h('div', { style: S.cardTitle }, '云端仓库'),
          h('div', { style: { ...S.hint, flex: 1 } }, isEditing
            ? (missing ? '还没配置云端仓库地址，填好远端地址并保存，才能生成推送/拉取' : '编辑中：改完点保存')
            : '只读展示，点「修改」后可编辑'),
          isEditing
            ? h('div', { style: S.actions },
              h('button', { type: 'button', style: S.btnPrimary, disabled: busy || !url.trim(), onClick: save }, busy ? '保存中…' : '保存'),
              missing ? null : h('button', { type: 'button', style: S.btn, disabled: busy, onClick: cancelEdit }, '取消'),
            )
            : h('div', { style: S.actions },
              h('button', { type: 'button', style: S.btn, disabled: !props.data, onClick: startEdit }, '修改'),
            ),
        ),
        field('远端地址', isEditing ? url : (remote.url || ''), setUrl, 'git@gitee.com:账号/dsh-config.git'),
        field('SSH 私钥', isEditing ? key : (remote.sshKey || ''), setKey, 'C:\\Users\\你\\.ssh\\id_ed25519_gitee'),
        h(Kv, { k: '私钥来源', v: `${sourceLabel(remote.sshKeyFrom)}${remote.sshKeyExists ? '' : '（文件不存在，需修改）'}` }),
        h(Kv, { k: '地址来源', v: sourceLabel(remote.urlSource) }),
        h(Kv, { k: '设置文件', v: remote.settingsPath || '（未知）' }),
        h('div', { style: S.hint }, '只存私钥路径，不存密钥内容；这份设置跟本机走、不进仓库。保存远端地址时会同时更新本机 git 的 origin，git 改失败则整套回滚。'),
        missing
          ? h('div', { style: { ...S.hint, color: 'var(--dsw-alias-state-error-primary)' } },
            '必须先把云端仓库地址配好：否则推送/拉取脚本生成不出来（还原只动本机快照，仍可用）。')
          : null,
        missing && !remote.sshKeyExists
          ? h('div', { style: { ...S.hint, color: 'var(--dsw-alias-state-warn-primary)' } },
            '私钥没填也能用——认证会交给 .ssh\\config 或 Git 的默认选择；填了才写进脚本的 GIT_SSH_COMMAND。')
          : null,
        err ? h('div', { style: { ...S.hint, color: 'var(--dsw-alias-state-error-primary)' } }, `保存失败：${err}`) : null,
        msg ? h('div', { style: { ...S.hint, color: 'var(--dsw-alias-state-success-primary)' } }, msg) : null,
      )
    }

    /** 面板整页：左侧栏「配置同步」点开后看到的就是这个。 */
    /**
     * 自动同步卡：两个开关（默认关）+ 云端一致性状态。
     * 打开后：启动延迟检查一次；云端更新 → 系统确认框 → 退出后拉取（按设置自动重启）；
     * 本机领先 → 排队等 DSH 退出后推送。插件不自己退进程后干活，原因见宿主注释。
     */
    function AutoCard(props) {
      const auto = (props.data && props.data.auto) || {}
      const drift = auto.drift || null
      const [busy, setBusy] = react.useState('')
      const [err, setErr] = react.useState('')
      const [msg, setMsg] = react.useState('')

      const save = async (patch) => {
        setBusy('save'); setErr(''); setMsg('')
        try {
          await callSettings(patch)
          setMsg('已保存')
          if (typeof props.onSaved === 'function') props.onSaved()
        } catch (e) { setErr(String((e && e.message) || e)) } finally { setBusy('') }
      }

      const act = async (action, extra) => {
        setBusy(action); setErr(''); setMsg('')
        try {
          const res = await fetch('/config-sync/auto', {
            method: 'POST', cache: 'no-store', credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action, ...(extra || {}) }),
          })
          const text = await res.text()
          const body = text ? JSON.parse(text) : null
          if (!res.ok || !body || body.ok !== true) throw new Error((body && body.error) || `${res.status}`)
          if (action === 'check') {
            const d = body.drift
            setMsg(d ? `云端：落后 ${d.behind} 个提交，领先 ${d.ahead} 个提交` : (body.error || '读不到远端'))
          } else {
            setMsg(body.closeRequested
              ? '已排队：客户端马上关闭，退出后执行；拉取完成后按设置自动重开'
              : '已排队：退出 DSH 后自动执行')
          }
          if (typeof props.onSaved === 'function') props.onSaved()
        } catch (e) { setErr(String((e && e.message) || e)) } finally { setBusy('') }
      }

      const sw = (patchKey, stateKey, label, hintText) => {
        // 设置接口的字段名是 autoPull / autoPush，体检返回的是 auto.pull / auto.push，别拿混。
        const on = auto[stateKey] === true
        return h('div', { style: { ...S.kvRow, alignItems: 'flex-start' } },
          h('div', { style: { ...S.kvKey, display: 'flex', alignItems: 'center', gap: '8px' } },
            h('input', {
              type: 'checkbox', checked: on, disabled: Boolean(busy),
              onChange: (e) => save({ [patchKey]: e.target.checked }),
            }),
            label,
          ),
          h('div', { style: { ...S.kvVal, color: 'var(--dsw-alias-text-secondary)' } },
            `${on ? '已开启' : '已关闭'}　${hintText}`),
        )
      }

      const pending = auto.pending
      return h('div', { style: S.card },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } },
          h('div', { style: S.cardTitle }, '自动同步'),
          h('div', { style: { ...S.hint, flex: 1 } }, '两个开关默认关闭；不打开就完全保持手动流程（自己双击脚本）'),
        ),
        sw('autoPull', 'pull', '启动时自动拉取',
          '云端有新提交 → 弹确认框 → 退出 DSH 后拉取；失败会自动还原上一次的配置，然后照样重启并提示结果'),
        sw('autoPush', 'push', '退出时自动推送',
          '本机有未提交改动 / 新会话资料 / 未推送提交 → 每 2 分钟复查一次，命中就排队，等 DSH 完全退出后推送'),
        pending
          ? h('div', { style: { ...S.hint, color: 'var(--dsw-alias-state-warn-primary)' } },
            `已排队：退出后${pending.mode === 'pull' ? '拉取' + (pending.restart ? '并重启客户端' : '') : '推送'}`
            + `（${new Date(pending.at).toLocaleTimeString('zh-CN', { hour12: false })}`
            + `${pending.reason ? `，原因：${pending.reason}` : ''}）`)
          : null,
        !auto.script
          ? h('div', { style: { ...S.hint, color: 'var(--dsw-alias-state-warn-primary)' } },
            '插件与仓库里都找不到 post-exit.ps1：自动同步排不了队，重装一次插件即可（新包自带 runtime）')
          : null,
        h('div', { style: S.actions },
          h('button', { type: 'button', style: S.btnPrimary, disabled: Boolean(busy), onClick: () => act('pull-now') }, '立即拉取（会关闭 DSH）'),
          h('button', { type: 'button', style: S.btn, disabled: Boolean(busy), onClick: () => act('push-now') }, '退出后推送'),
          pending ? h('button', { type: 'button', style: S.btn, disabled: Boolean(busy), onClick: () => act('cancel') }, '取消排队') : null,
        ),
        msg ? h('div', { style: S.hint }, msg) : null,
        err ? h('div', { style: { ...S.hint, color: 'var(--dsw-alias-state-error-primary)' } }, err) : null,
      )
    }

    function ConfigSyncPanel() {
      const { data, err, busy, made, refresh, prepare } = useSync()
      const [note, setNote] = react.useState('')
      const [checking, setChecking] = react.useState(false)
      const [toast, setToast] = react.useState('')
      const [upd, setUpd] = react.useState(null)
      const [updBusy, setUpdBusy] = react.useState(false)
      // 「插件更新」卡里的配置编辑态：清单地址 + 只读令牌都放这一张卡，不散到云端仓库那去
      const [updEdit, setUpdEdit] = react.useState(false)
      const [updManifest, setUpdManifest] = react.useState('')
      const [updToken, setUpdToken] = react.useState('')
      const [updMsg, setUpdMsg] = react.useState('')
      const [updErr, setUpdErr] = react.useState('')
      // 定时器放 ref 里：数据每刷新一次 effect 就会重跑，若在 effect 里 return 清理函数，
      // 会把还没到点的"5 秒后消失"定时器一起清掉，提示就一直挂在屏幕上。
      const toastTimer = react.useRef(null)
      const summary = summarize(data)
      // 仓库没配好 = 生成按钮全禁用（宿主那边也会拒，界面这边先别让人白点）
      const noRepo = !data || !data.repo || !data.repo.exists
      // 云端仓库没配 = 推送/拉取禁用（还原只动本机快照，不拦）
      const noRemote = !data || !data.remote || !data.remote.configured

      // 插件版本：打开面板查一次，之后每 30 分钟复查（服务端自己也缓存，网络开销≈0）。
      // 老版本机器就是靠这一条知道云端发了新版本。
      react.useEffect(() => {
        let alive = true
        const run = async () => {
          try {
            const u = await callUpdate()
            if (alive) setUpd(u)
          } catch (e) {
            if (alive) setUpd({ ok: false, error: String((e && e.message) || e), checkedAt: Date.now() })
          }
        }
        run()
        const timer = setInterval(run, 30 * 60 * 1000)
        return () => { alive = false; clearInterval(timer) }
      }, [])

      const showToast = (text) => {
        setToast(text)
        if (toastTimer.current) clearTimeout(toastTimer.current)
        toastTimer.current = setTimeout(() => setToast(''), 5000)
      }

      const applyUpdate = async () => {
        setUpdBusy(true)
        try {
          const r = await callUpdate({ action: 'apply' })
          if (r && r.cancelled) showToast('已取消更新')
          else showToast(`正在更新到 ${(r.remote && r.remote.version) || '新版本'}：DSH 会先退出，下载安装完自动重启`)
        } catch (e) {
          showToast('更新失败：' + String((e && e.message) || e))
        } finally {
          setUpdBusy(false)
        }
      }

      const checkUpdateNow = async () => {
        setUpdBusy(true)
        try {
          setUpd(await callUpdate({ action: 'check' }))
        } catch (e) {
          setUpd({ ok: false, error: String((e && e.message) || e), checkedAt: Date.now() })
        } finally {
          setUpdBusy(false)
        }
      }

      const startEditUpd = () => {
        const cfg = (upd && upd.config) || {}
        setUpdManifest(cfg.manifestUrlIsDefault ? '' : (cfg.manifestUrl || ''))
        setUpdToken('')
        setUpdErr('')
        setUpdMsg('')
        setUpdEdit(true)
      }
      const cancelEditUpd = () => { setUpdEdit(false); setUpdErr(''); setUpdToken('') }
      const saveUpdConfig = async () => {
        setUpdBusy(true); setUpdErr(''); setUpdMsg('')
        try {
          const payload = { updateManifestUrl: updManifest.trim() }
          if (updToken.trim()) payload.updateToken = updToken.trim()
          await callSettings(payload)
          setUpdEdit(false)
          setUpdToken('')
          setUpdMsg('已保存')
          setUpd(await callUpdate({ action: 'check' }))
        } catch (e) {
          setUpdErr(String((e && e.message) || e))
        } finally { setUpdBusy(false) }
      }
      const clearUpdToken = async () => {
        setUpdBusy(true); setUpdErr(''); setUpdMsg('')
        try {
          await callSettings({ clearUpdateToken: true })
          setUpdMsg('已清除本机保存的更新令牌')
          setUpd(await callUpdate({ action: 'check' }))
        } catch (e) {
          setUpdErr(String((e && e.message) || e))
        } finally { setUpdBusy(false) }
      }

      // 打开面板就自动检查一次云端，之后每 2 分钟复查一次（只读，不改仓库、不动 profile）
      react.useEffect(() => {
        let alive = true
        const run = async () => {
          if (alive) setChecking(true)
          try {
            await callAuto({ action: 'check' })
          } catch { /* 检查失败不该挡住页面，状态行会显示失败原因 */ }
          if (alive) setChecking(false)
          if (alive && typeof refresh === 'function') refresh()
        }
        run()
        const timer = setInterval(run, 2 * 60 * 1000)
        return () => { alive = false; clearInterval(timer) }
      }, [])

      // 上次「退出后自动同步」的结果：15 分钟内、且没弹过，就弹 5 秒提示。
      // 判据与「启动即弹」共用 takeFreshResult（同一个 localStorage 键，不会弹两次）。
      react.useEffect(() => {
        const text = takeFreshResult(data && data.auto && data.auto.lastResult)
        if (!text) return
        setToast(text)
        if (toastTimer.current) clearTimeout(toastTimer.current)
        toastTimer.current = setTimeout(() => setToast(''), 5000)
      }, [data])

      // 云端一致性：和「一致 / 仓库与本机一致」同一个徽标样式，绿=一致、红=不一致，
      // 后面跟一句具体状态；全自动检查（挂载即查 + 每 2 分钟复查），不给手动按钮。
      const cloudLine = (() => {
        const auto = (data && data.auto) || {}
        if (auto.checking || checking) return { kind: 'idle', text: '云端检查中…' }
        const drift = auto.drift
        if (drift) {
          const same = drift.behind === 0 && drift.ahead === 0
          if (same) return { kind: 'ok', text: '云端已同步到最新，无需拉取' }
          const parts = []
          if (drift.behind > 0) parts.push(`落后 ${drift.behind} 个提交`)
          if (drift.ahead > 0) parts.push(`领先 ${drift.ahead} 个提交`)
          return { kind: 'error', text: `云端与本机不一致：${parts.join(' · ')}` }
        }
        if (auto.lastCheckAt) {
          return { kind: 'error', text: `云端检查失败：${auto.lastCheckError || '读不到远端'}` }
        }
        return { kind: 'idle', text: '云端检查中…' }
      })()

      const cloudLabel = cloudLine.kind === 'ok' ? '一致' : (cloudLine.kind === 'error' ? '不一致' : '检查中')

      // 插件更新卡：老版本机器进来第一眼就能看到"有新版本 x.y.z"和更新按钮；
      // 更新相关的配置（清单地址、只读令牌）也收在这张卡里，别散到「云端仓库」去。
      const updCard = (() => {
        const u = upd || {}
        const cfg = u.config || {}
        const local = (u.local && u.local.version) || '…'
        const remote = (u.remote && u.remote.version) || ''
        const has = u.hasUpdate === true
        const failed = !has && u.ok === false
        const kind = has ? 'warn' : (failed ? 'error' : 'ok')
        const label = has ? `有新版本 ${remote}` : (failed ? '检查失败' : (u.checkedAt ? '已是最新' : '检查中'))
        const text = has
          ? `当前 ${local} → 可更新到 ${remote}${(u.remote && u.remote.notes) ? ` · ${u.remote.notes}` : ''}`
          : (failed
            ? `读不到更新清单：${u.error || '未知原因'}`
            : (u.checkedAt ? `当前 ${local}，云端没有更新的版本` : '正在读云端版本清单…'))
        return h('div', { style: S.card },
          h('div', { style: S.cardTitle }, '插件更新'),
          h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' } },
            h('span', { style: chipStyle(kind) }, label),
            h('div', { style: { ...S.hint, flex: 1, minWidth: '200px' } }, text),
            has ? h('button', {
              type: 'button', style: S.btn, disabled: updBusy || !u.remote,
              onClick: applyUpdate,
            }, updBusy ? '更新中…' : `更新到 ${remote}`) : null,
            h('button', { type: 'button', style: S.btn, disabled: updBusy, onClick: checkUpdateNow }, '检查更新'),
            updEdit
              ? null
              : h('button', { type: 'button', style: S.btn, disabled: !u.local, onClick: startEditUpd }, '修改配置'),
          ),
          updEdit
            ? h('div', null,
              h('div', { style: S.kvRow },
                h('div', { style: S.kvKey }, '更新清单'),
                h('input', {
                  type: 'text', style: S.input, value: updManifest, spellCheck: false,
                  placeholder: cfg.manifestUrlIsDefault ? `留空 = 用内置默认（${cfg.manifestUrl || ''}）` : 'https://…/version.json',
                  onChange: (e) => setUpdManifest(e.target.value),
                }),
              ),
              h('div', { style: S.kvRow },
                h('div', { style: S.kvKey }, '更新令牌'),
                h('input', {
                  type: 'text', style: S.input, value: updToken, spellCheck: false,
                  placeholder: cfg.tokenSet ? '已配置；留空表示不改' : 'Gitee 私人令牌（私有库必填）',
                  onChange: (e) => setUpdToken(e.target.value),
                }),
              ),
              h('div', { style: S.actions },
                h('button', { type: 'button', style: S.btnPrimary, disabled: updBusy, onClick: saveUpdConfig }, updBusy ? '保存中…' : '保存'),
                h('button', { type: 'button', style: S.btn, disabled: updBusy, onClick: cancelEditUpd }, '取消'),
                cfg.tokenSet
                  ? h('button', { type: 'button', style: S.btn, disabled: updBusy, onClick: clearUpdToken }, '清除已存令牌')
                  : null,
              ),
            )
            : h('div', null,
              h(Kv, { k: '更新清单', v: cfg.manifestUrl ? `${cfg.manifestUrl}${cfg.manifestUrlIsDefault ? '（内置默认）' : ''}` : '…' }),
              h(Kv, { k: '更新令牌', v: cfg.tokenSet ? '已配置（只存本机）' : '未配置（私有库会读不到清单）' }),
            ),
          h('div', { style: S.hint },
            '清单只读几百字节、30 分钟查一次；点更新会先退出 DSH，再下载校验、备份旧版、覆盖安装并自动重启。'
            + '令牌只存本机设置文件，不进仓库。'),
          updErr ? h('div', { style: { ...S.hint, color: 'var(--dsw-alias-state-error-primary)' } }, `保存失败：${updErr}`) : null,
          updMsg ? h('div', { style: { ...S.hint, color: 'var(--dsw-alias-state-success-primary)' } }, updMsg) : null,
        )
      })()

      const versionCard = h('div', { style: S.card },
        h('div', { style: S.cardTitle }, '版本契约'),
        h(Kv, { k: '本机 app', v: data ? (data.version.local || '读不到') : '…' }),
        h(Kv, { k: '仓库契约', v: data ? (data.version.contract || '读不到') : '…' }),
        h(Kv, { k: 'Electron', v: data ? (data.version.electron || '读不到') : '…' }),
        data && data.version.local && data.version.contract && !data.version.match
          ? h('div', { style: { ...S.hint, color: 'var(--dsw-alias-state-warn-primary)' } },
            '两端版本不同：实验性 bundle（含 cot-translation）会被剔除。要么把较旧那台升级到同版本，要么 pull 时加 -AllowVersionDrift。')
          : null,
      )

      // 仓库路径可配：默认只读展示，点「修改」才编辑；没配过就强制停在编辑态（见 RepoCard）
      const repoCard = data ? h(RepoCard, { data, onSaved: refresh }) : h('div', { style: S.card },
        h('div', { style: S.cardTitle }, '本机仓库'),
        h(Kv, { k: '仓库路径', v: '…' }),
      )

      const healthCard = h('div', { style: S.card },
        h('div', { style: S.cardTitle }, '本机健康'),
        h(Kv, {
          k: 'bundle',
          v: !data ? '…' : `${data.bundles.total} 项` + (data.bundles.unresolved.length
            ? `，解析不到 ${data.bundles.unresolved.length} 项：${data.bundles.unresolved.join(', ')}`
            : '，全部可解析'),
        }),
        h(Kv, {
          k: '依赖',
          v: !data ? '…' : `${data.deps.total} 项` + (data.deps.missing.length
            ? `，缺失 ${data.deps.missing.length} 项：${data.deps.missing.join(', ')}`
            : '，无缺失'),
        }),
        data ? h(Advice, { items: data.advice }) : null,
      )

      const actionCard = h('div', { style: S.card },
        h('div', { style: S.cardTitle }, '生成退出后执行的脚本'),
        h('div', { style: S.hint },
          '推送 / 拉取不能在 DSH 运行时跑：抓取会读到正被写入的配置，落地结果会被退出时的回写覆盖。这里只把带本机参数的命令备好，退出 DSH 后双击执行。'),
        h('div', { style: { ...S.kvRow, alignItems: 'center' } },
          h('div', { style: S.kvKey }, '提交说明'),
          h('input', {
            type: 'text',
            style: S.input,
            value: note,
            placeholder: '可选：这次改了什么（生成推送脚本时写进提交信息，时间会自动附上）',
            spellCheck: false,
            onChange: (e) => setNote(e.target.value),
          }),
        ),
        h('div', { style: S.hint },
          data && data.backup && data.backup.latest
            ? `还原快照：${data.backup.latest}（共 ${data.backup.count} 份中的最新，含 ${data.backup.latestFiles} 个文件）`
            : '还原快照：还没有任何备份快照（还原将无从下手，需拉取或指定 -FromCommit）'),
        data && data.repo && !data.repo.exists
          ? h('div', { style: { ...S.hint, color: 'var(--dsw-alias-state-error-primary)' } },
            '仓库路径还没配置：先在上面「本机仓库」卡里设好并保存，否则这三份脚本生成不出来。')
          : null,
        data && data.remote && !data.remote.configured
          ? h('div', { style: { ...S.hint, color: 'var(--dsw-alias-state-error-primary)' } },
            '云端仓库地址还没配置：推送 / 拉取生成不了，先在「云端仓库」卡里填远端地址并保存（只生成还原不受影响）。')
          : null,
        data && data.repo && data.repo.ahead > 0
          ? h('div', { style: { ...S.hint, color: 'var(--dsw-alias-state-warn-primary)' } },
            `注意：本机领先远端 ${data.repo.ahead} 个提交。本机改动要推送才入库；拉取会用仓库版本覆盖本机配置，别点错。`)
          : null,
        h('div', { style: S.actions },
          h('button', { type: 'button', style: S.btnPrimary, disabled: busy || noRepo || noRemote, onClick: () => prepare('all', note) }, '一键生成 推送 / 拉取 / 还原'),
          h('button', { type: 'button', style: S.btn, disabled: busy || noRepo || noRemote, onClick: () => prepare('push', note) }, '只生成推送'),
          h('button', { type: 'button', style: S.btn, disabled: busy || noRepo || noRemote, onClick: () => prepare('pull') }, '只生成拉取'),
          h('button', { type: 'button', style: S.btn, disabled: busy || noRepo, onClick: () => prepare('restore') }, '只生成还原'),
          h('button', { type: 'button', style: S.btn, disabled: busy, onClick: refresh }, busy ? '检测中…' : '重新检测'),
        ),
        h(MadeNote, { made }),
      )

      const remoteCard = data ? h(RemoteCard, { data, onSaved: refresh }) : null
      const autoCard = data ? h(AutoCard, { data, onSaved: refresh }) : null

      return h('div', { style: S.page },
        h('div', { style: S.pageInner },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' } },
            h('div', { style: S.pageTitle }, TITLE),
            h('span', { style: chipStyle(summary.kind) }, chipLabel(summary.kind)),
            h('div', { style: { ...S.hint, flex: 1, minWidth: '160px' } }, summary.text),
            // 云端状态放标题行（和左边的「一致」同一个徽标样式：绿=一致、红=不一致），
            // 自动检查：挂载即查 + 每 2 分钟复查，不需要手动点
            h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', whiteSpace: 'nowrap' } },
              h('span', { style: chipStyle(cloudLine.kind) }, cloudLabel),
              h('div', { style: { ...S.hint, fontSize: '13px' } }, cloudLine.text),
            ),
          ),
          toast
            ? h('div', {
              style: {
                position: 'fixed', left: '50%', top: '24px', transform: 'translateX(-50%)', zIndex: 9999,
                padding: '10px 16px', borderRadius: '8px', fontSize: '13px', lineHeight: 1.5,
                maxWidth: '70vw', boxShadow: '0 6px 18px rgba(0,0,0,.18)',
                background: 'var(--dsw-alias-bg-panel, #fff)',
                border: '1px solid var(--dsw-alias-border-secondary, #ddd)',
              },
            }, toast)
            : null,
          h('p', { style: S.pageLead },
            '本页只做只读体检：读文件 + 只读 git 命令，不改仓库、不动 profile。同步动作由生成的脚本在 DSH 退出后执行。'),
          err ? h('div', { style: { ...S.hint, color: 'var(--dsw-alias-state-error-primary)' } }, `读取失败：${err}`) : null,
          // 按内容分区：信息类在上、配置类居中、动作类在下；每区内部网格并排（宽屏两列）
          Section('概览', '版本是否对齐、bundle 与依赖有没有缺', [versionCard, healthCard]),
          Section('同步目标', '仓库放哪、远端连哪，都是本机配置，改完立即生效', [repoCard, remoteCard].filter(Boolean)),
          Section('自动化与插件更新', '退出 DSH 后做什么、插件自己怎么升级', [autoCard, updCard].filter(Boolean)),
          Section('退出后执行', null, [actionCard]),
        ),
      )
    }

    /** 侧栏行的图标：两条反向箭头（同步）。宿主会按 id 处理点击与选中态。 */
    function SidebarIcon(owner) {
      const size = (owner && owner.size) || 16
      return h('svg', {
        width: size, height: size, viewBox: '0 0 16 16', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': 'true',
      },
        h('path', { d: 'M3 5.5h8.5' }),
        h('path', { d: 'M9.2 3.2 11.5 5.5 9.2 7.8' }),
        h('path', { d: 'M13 10.5H4.5' }),
        h('path', { d: 'M6.8 8.2 4.5 10.5 6.8 12.8' }),
      )
    }

    /** 设置 → 通用 里的一行摘要（保留入口，不重复大面板）。 */
    function ConfigSyncRow() {
      const { data, err, busy, made, refresh, prepare } = useSync()
      const [open, setOpen] = react.useState(false)
      const summary = summarize(data)

      const head = h('div', { style: S.head },
        h('div', { style: S.headText },
          h('div', { style: S.title }, TITLE),
          h('div', { style: S.sub }, busy ? '检测中…' : summary.text),
          data ? h('div', { style: S.sub }, `app ${data.version.local || '?'} / 契约 ${data.version.contract || '?'}`) : null,
        ),
        h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', flexShrink: 0 } },
          h('span', { style: chipStyle(summary.kind) }, chipLabel(summary.kind)),
          h('button', { type: 'button', style: S.btn, onClick: () => setOpen((v) => !v) }, open ? '收起' : '查看'),
          h('button', { type: 'button', style: S.btn, disabled: busy, onClick: refresh }, '刷新'),
        ),
      )

      if (!open) {
        return h('div', { style: S.row }, head,
          err ? h('div', { style: { ...S.hint, color: 'var(--dsw-alias-state-error-primary)' } }, `读取失败：${err}`) : null)
      }

      return h('div', { style: S.row },
        head,
        err ? h('div', { style: { ...S.hint, color: 'var(--dsw-alias-state-error-primary)' } }, `读取失败：${err}`) : null,
        h('div', { style: S.panel },
          data ? h(Kv, { k: '仓库', v: data.repo.exists ? `${data.repo.path}（${data.repo.branch || '?'} @ ${data.repo.head || '?'}）` : '还没配置（请到面板里设置）' }) : null,
          data ? h(Kv, {
            k: '远端',
            v: data.repo.behind === null ? '读不到' : `落后 ${data.repo.behind} · 领先 ${data.repo.ahead} · 未提交 ${data.repo.dirty}`,
          }) : null,
          data ? h(Kv, {
            k: 'bundle',
            v: `${data.bundles.total} 项，解析不到 ${data.bundles.unresolved.length} 项` + (data.bundles.unresolved.length ? `：${data.bundles.unresolved.join(', ')}` : ''),
          }) : null,
          data && data.remote ? h(Kv, { k: '远端地址', v: data.remote.url || '（未配置）' }) : null,
          data && data.remote ? h(Kv, { k: 'SSH 私钥', v: data.remote.sshKey || '（未配置）' }) : null,
          data ? h(Advice, { items: data.advice }) : null,
          h('div', { style: S.actions },
            h('button', { type: 'button', style: S.btnPrimary, disabled: busy || !data || !data.repo.exists, onClick: () => prepare('all') }, '一键生成 推送 / 拉取 / 还原'),
            h('button', { type: 'button', style: S.btn, disabled: busy || !data || !data.repo.exists, onClick: () => prepare('push') }, '只生成推送'),
            h('button', { type: 'button', style: S.btn, disabled: busy || !data || !data.repo.exists, onClick: () => prepare('pull') }, '只生成拉取'),
            h('button', { type: 'button', style: S.btn, disabled: busy || !data || !data.repo.exists, onClick: () => prepare('restore') }, '只生成还原'),
          ),
          h(MadeNote, { made }),
        ),
      )
    }

    /**
     * 上次自动同步的结果是否该弹：15 分钟内 + 这次进程没弹过。
     * 返回提示文案，不该弹就返回空串；命中后立刻记进 localStorage（同一条只弹一次）。
     */
    function takeFreshResult(last) {
      if (!last || !last.at) return ''
      const age = Date.now() - last.at
      if (age < 0 || age > 15 * 60 * 1000) return ''
      let seen = ''
      try { seen = window.localStorage.getItem('dsh-config-sync:lastResultAt') || '' } catch { }
      if (seen === String(last.at)) return ''
      try { window.localStorage.setItem('dsh-config-sync:lastResultAt', String(last.at)) } catch { }
      const who = last.mode === 'pull' ? '自动拉取' : '自动推送'
      return last.ok
        ? `${who}完成：${last.message}`
        : `${who}失败：${last.message}${last.log ? '（日志：' + last.log + '）' : ''}`
    }

    /**
     * 客户端一打开就弹上次同步结果 —— 以前只在「配置同步」面板里弹，
     * 用户关掉 DSH 让它推送完、再打开 DSH 看到的却是毫无提示的主界面，必须自己点进面板才知道。
     * 这里不依赖面板挂载：直接查一次 status，自己 append 一个浮层，5 秒后收回。
     */
    function showResultToast(text) {
      try {
        const box = document.createElement('div')
        box.textContent = text
        box.style.cssText = [
          'position:fixed', 'left:50%', 'top:24px', 'transform:translateX(-50%)',
          'z-index:2147483000', 'padding:10px 16px', 'border-radius:8px',
          'font-size:13px', 'line-height:1.5', 'max-width:70vw', 'word-break:break-all',
          'box-shadow:0 6px 18px rgba(0,0,0,.18)',
          'background:var(--dsw-alias-bg-panel, #fff)',
          'border:1px solid var(--dsw-alias-border-secondary, #ddd)',
          'color:var(--dsw-alias-label-primary, #111)', 'pointer-events:none',
        ].join('; ')
        document.body.appendChild(box)
        setTimeout(() => { try { box.remove() } catch { } }, 5000)
      } catch (error) {
        try { console.warn('[dsh-config-sync] 启动提示没弹出来：', error) } catch { }
      }
    }

    async function announceLastResult() {
      try {
        const res = await fetch('/config-sync/status', { cache: 'no-store', credentials: 'same-origin' })
        if (!res.ok) return
        const data = await res.json()
        const text = takeFreshResult(data && data.auto && data.auto.lastResult)
        if (text) showResultToast(text)
      } catch { /* 插件路由还没起好就静默跳过，面板里仍会显示同一结果 */ }
    }

    function apply(ctx) {
      // 侧栏行 + 配对面板：两个 slot 必须各自 inject（嵌套），再在作用域里成对 register。
      // 只 inject('main') 就向 sidebar.panellist 注册是无效的——区域还没被注入，注册落不下去。
      try {
        ctx.slots.inject('main', () => ctx.slots.inject('sidebar.panellist', () => {
          const offPanel = ctx.slots.register({ name: 'main', key: PANEL_ID }, ConfigSyncPanel)
          const offRow = ctx.slots.register({
            name: 'sidebar.panellist',
            id: PANEL_ID,
            order: 35,
            label: () => TITLE,
            locale: 'config-sync',
          }, SidebarIcon)
          return () => {
            if (typeof offRow === 'function') offRow()
            if (typeof offPanel === 'function') offPanel()
          }
        }))
      } catch (error) {
        // 老版本宿主没有 sidebar.panellist 就静默降级到设置页；但要把原因留在控制台
        try { console.warn('[dsh-config-sync] 侧栏入口注册失败：', error) } catch { }
      }

      try {
        ctx.slots.inject('settings.general.item', () => ctx.slots.register({
          name: 'settings.general.item',
          id: 'config-sync',
          order: 20,
        }, ConfigSyncRow))
      } catch (error) {
        try { console.warn('[dsh-config-sync] 设置页入口注册失败：', error) } catch { }
      }

      // 界面还没完全起来时 fetch 可能扑空，所以稍等一会儿再查；只查一次，不轮询。
      try { setTimeout(announceLastResult, 1500) } catch { }
    }

    exports.name = name
    exports.inject = inject
    exports.apply = apply
    return module.exports
  },
})
