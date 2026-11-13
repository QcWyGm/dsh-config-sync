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

    /**
     * 语言：跟随客户端。zh-* 走中文，其余一律英文。
     *
     * 判定顺序（DSH 自己切换界面语言时**不会**改 navigator.language，所以不能只看它）：
     *   1. document.documentElement.lang —— DSH 切语言时写在这里（en / zh-CN …）；
     *   2. 页面里 dsh 暴露的语言设置（若有的版本只存设置不改 html lang）；
     *   3. navigator.languages / navigator.language —— 系统语言兜底。
     * 每次调用现读，不缓存：用户在设置里切语言后不必重启客户端就能跟着变。
     */
    const readTags = () => {
      const tags = []
      try {
        const html = document.documentElement && document.documentElement.getAttribute('lang')
        if (html) tags.push(String(html))
      } catch { }
      try {
        for (const item of [document.body && document.body.getAttribute('lang'), document.body && document.body.getAttribute('data-lang')]) {
          if (item) tags.push(String(item))
        }
      } catch { }
      try {
        const list = (navigator.languages && navigator.languages.length) ? navigator.languages : [navigator.language || '']
        for (const item of list) if (item) tags.push(String(item))
      } catch { }
      return tags
    }
    const langIsZh = () => {
      const tags = readTags()
      for (const item of tags) {
        const tag = String(item || '').trim().toLowerCase()
        if (!tag) continue
        if (/^(zh|cn|chinese)/.test(tag)) return true
        if (/^(en|english)/.test(tag)) return false
      }
      return true
    }
    const M = (zh, en) => (langIsZh() ? zh : en)
    const localeNow = () => (langIsZh() ? 'zh-CN' : 'en-US')
    const langHeaders = () => ({ 'accept-language': langIsZh() ? 'zh-CN,zh;q=0.9' : 'en-US,en;q=0.9' })

    const S = {
      // 侧栏 / 设置摘要行
      row: { display: 'flex', flexDirection: 'column', gap: '6px', padding: '6px 0', width: '100%' },
      head: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', width: '100%' },
      headText: { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 },
      title: { fontSize: '14px', lineHeight: '20px', color: 'var(--dsw-alias-label-primary)' },
      sub: { fontSize: '12px', lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)', wordBreak: 'break-all' },
      chip: { fontSize: '12px', lineHeight: '18px', padding: '0 8px', borderRadius: '999px', whiteSpace: 'nowrap' },
      btn: {
        fontSize: '12px', lineHeight: '22px', padding: '3px 11px', borderRadius: '6px', cursor: 'pointer',
        border: '1px solid var(--dsw-alias-border-l2)', background: 'transparent',
        color: 'var(--dsw-alias-label-primary)',
      },
      btnPrimary: {
        fontSize: '12px', lineHeight: '22px', padding: '3px 13px', borderRadius: '6px', cursor: 'pointer',
        border: '1px solid var(--dsw-alias-button-primary-fill)',
        background: 'var(--dsw-alias-button-primary-fill)',
        color: 'var(--dsw-alias-label-primary-foreground)',
      },
      // 面板整页
      page: {
        height: '100%', overflowY: 'auto', boxSizing: 'border-box',
        padding: '18px 22px 28px', background: 'var(--dsw-alias-bg-base)',
        color: 'var(--dsw-alias-label-primary)',
      },
      pageInner: { maxWidth: '1120px', margin: '0 auto', display: 'flex', flexDirection: 'column', gap: '18px' },
      pageTitle: { fontSize: '18px', lineHeight: '26px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)' },
      pageLead: { fontSize: '12px', lineHeight: '19px', color: 'var(--dsw-alias-label-tertiary)', margin: 0 },
      // 标题下的一行元信息：小灰点分隔，只放"一眼要看"的事实，长句一律不进这里
      meta: {
        display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '6px 10px',
        fontSize: '12px', lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)',
      },
      metaSep: { color: 'var(--dsw-alias-label-quaternary, var(--dsw-alias-label-tertiary))', opacity: 0.6 },
      // 指标条：替代原来两张 Kv 卡，5 个小格子一行看完
      strip: {
        display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
        gap: '1px', borderRadius: '10px', overflow: 'hidden',
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-border-l1)',
      },
      metric: {
        display: 'flex', flexDirection: 'column', gap: '2px', padding: '9px 12px', minWidth: 0,
        background: 'var(--dsw-alias-settings-card-fill)',
      },
      metricLabel: { fontSize: '11px', lineHeight: '16px', color: 'var(--dsw-alias-label-tertiary)', whiteSpace: 'nowrap' },
      metricValue: {
        fontSize: '13px', lineHeight: '19px', color: 'var(--dsw-alias-label-primary)',
        fontFamily: 'Consolas, ui-monospace, monospace', wordBreak: 'break-all',
      },
      // 卡片标题行：标题 + 右侧状态/操作，统一成一行
      cardHead: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
      // 卡片底部的一行灰字（原先是整段解释，压缩成一句）
      footnote: { fontSize: '11px', lineHeight: '17px', color: 'var(--dsw-alias-label-tertiary)', overflowWrap: 'break-word' },
      // 卡片分组：每组一个小标题 + 自适应网格（宽屏两列，窄了自动回落单列，卡片等高）
      section: { display: 'flex', flexDirection: 'column', gap: '10px' },
      sectionHead: { display: 'flex', alignItems: 'baseline', gap: '8px', flexWrap: 'wrap' },
      sectionTitle: { fontSize: '13px', lineHeight: '20px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)' },
      sectionHint: { fontSize: '11px', lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' },
      grid: {
        display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(330px, 1fr))',
        gap: '10px', alignItems: 'stretch',
      },
      card: {
        display: 'flex', flexDirection: 'column', gap: '9px', padding: '13px 14px', minWidth: 0,
        border: '1px solid var(--dsw-alias-border-l1)', borderRadius: '10px',
        background: 'var(--dsw-alias-settings-card-fill)',
      },
      cardTitle: { fontSize: '13px', lineHeight: '18px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)' },
      kvRow: { display: 'flex', gap: '8px', fontSize: '12px', lineHeight: '18px', alignItems: 'flex-start', padding: '1px 0' },
      kvKey: { minWidth: '100px', width: '100px', flexShrink: 0, color: 'var(--dsw-alias-label-tertiary)' },
      kvVal: { flex: 1, minWidth: 0, color: 'var(--dsw-alias-label-secondary)', overflowWrap: 'break-word' },
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
        pull: 'var(--dsw-alias-state-warn-secondary)',
        init: 'var(--dsw-alias-state-warn-secondary)',
        error: 'var(--dsw-alias-state-error-secondary)',
        idle: 'var(--dsw-alias-fill-l1)',
      }
      return Object.assign({}, S.chip, {
        background: map[kind] || map.idle,
        color: 'var(--dsw-alias-label-primary)',
        fontWeight: 500,
      })
    }

    /** 一个分区：小标题 + 一句说明 + 内部网格。卡片少时自动单列，宽了并排两列。 */
    function Section(title, hint, cards) {
      const list = (cards || []).filter(Boolean)
      if (!list.length) return null
      return h('div', { style: S.section },
        h('div', { style: S.sectionHead },
          h('div', { style: S.sectionTitle }, title),
          hint ? h('span', { style: { ...S.sectionHint, opacity: 0.75 } }, `· `) : null,
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
      if (!data) return { kind: 'idle', text: M('尚未检测', 'Not checked yet') }
      const { repo, version, bundles, deps } = data
      if (!repo || (!repo.exists && !repo.empty)) return { kind: 'error', text: M('仓库路径未配置（见「本机仓库」卡）', 'Repo path not set (see the Local repo card)') }
      // 云端地址缺失只算"待处理"：云端有没有更新由右侧云端徽标讲，这里不重复报错
      if (!data.remote || !data.remote.configured) return { kind: 'warn', text: M('云端仓库地址未配置', 'Cloud remote not set') }
      if (bundles.unresolved.length || deps.missing.length) {
        return {
          kind: 'error',
          text: M(
            `${bundles.unresolved.length} 个 bundle 解析不到 · ${deps.missing.length} 个依赖缺失`,
            `${bundles.unresolved.length} bundle(s) unresolved · ${deps.missing.length} dependency(ies) missing`,
          ),
        }
      }
      // 本机自身问题优先报完之后，才轮到「仓库还没内容」——空目录只是初始状态，不是错误
      if (repo.empty || repo.phase === 'missing') {
        return repo.mode === 'await-init'
          ? { kind: 'init', text: M('本机与云端都还没有内容：待「初始化推送」', 'Local repo and cloud are both empty — Initialize push') }
          : { kind: 'pull', text: M('本机仓库还没有内容：待从云端「拉取」', 'Local repo has no content yet — pull it from the cloud') }
      }
      if (version.local && version.contract && !version.match) {
        return {
          kind: 'warn',
          text: M(
            `版本不一致（本机 ${version.local} ≠ 契约 ${version.contract}）`,
            `Version mismatch (local ${version.local} ≠ contract ${version.contract})`,
          ),
        }
      }
      if (repo.behind === null) return { kind: 'idle', text: M('读不到本机 git 状态（git 不可用或没 upstream）', 'Cannot read local git state (git missing or no upstream)') }
      if (repo.dirty > 0) return { kind: 'warn', text: M(`本机有 ${repo.dirty} 处未提交改动，建议推送`, `${repo.dirty} uncommitted change(s) — consider pushing`) }
      if (repo.ahead > 0) return { kind: 'warn', text: M(`本机有 ${repo.ahead} 个提交还没推送`, `${repo.ahead} local commit(s) not pushed yet`) }
      // git 干净不代表没东西要推：新会话/新资料还躺在 ~\.dsh 里，没 capture 之前仓库是完全干净的
      const local = data.local || {}
      if (local.known && local.pending > 0) {
        return {
          kind: 'warn',
          text: M(
            `本机有 ${local.pending} 个文件在上次同步后有更新，建议推送`,
            `${local.pending} local file(s) changed since the last sync — consider pushing`,
          ),
        }
      }
      return { kind: 'ok', text: M('仓库与本机一致', 'Repo matches this machine') }
    }

    function chipLabel(kind) {
      if (kind === 'ok') return M('一致', 'In sync')
      if (kind === 'error') return M('有问题', 'Problem')
      if (kind === 'pull') return M('待拉取', 'To pull')
      if (kind === 'init') return M('待初始化', 'To initialize')
      if (kind === 'warn') return M('待推送', 'To push')
      return M('未检测', 'Unchecked')
    }

    function badJson(res) { return new Error(M(`${res.status} 返回非 JSON`, `${res.status} returned non-JSON`)) }

    async function callStatus() {
      const res = await fetch('/config-sync/status', { cache: 'no-store', credentials: 'same-origin', headers: langHeaders() })
      const text = await res.text()
      let body
      try { body = text ? JSON.parse(text) : null } catch { throw badJson(res) }
      if (!res.ok || !body || body.ok !== true) throw new Error((body && body.error) || `${res.status}`)
      return body
    }

    /** 每个 POST 都带 accept-language：宿主的建议句/错误信息按它出中文或英文。 */
    const jsonHeaders = { 'content-type': 'application/json', ...langHeaders() }

    async function callPrepare(action, message, backupDir) {
      const res = await fetch('/config-sync/prepare', {
        method: 'POST',
        cache: 'no-store',
        credentials: 'same-origin',
        headers: jsonHeaders,
        body: JSON.stringify({ action, message: message || '', backupDir: backupDir || '' }),
      })
      const text = await res.text()
      let body
      try { body = text ? JSON.parse(text) : null } catch { throw badJson(res) }
      if (!res.ok || !body || body.ok !== true) throw new Error((body && body.error) || `${res.status}`)
      return body
    }

    async function callSettings(payload) {
      const res = await fetch('/config-sync/settings', {
        method: 'POST',
        cache: 'no-store',
        credentials: 'same-origin',
        headers: jsonHeaders,
        body: JSON.stringify(payload),
      })
      const text = await res.text()
      let body
      try { body = text ? JSON.parse(text) : null } catch { throw badJson(res) }
      if (!res.ok || !body || body.ok !== true) throw new Error((body && body.error) || `${res.status}`)
      return body
    }

    /** 自动同步接口：check / pull-now / push-now / cancel。 */
    async function callAuto(payload) {
      const res = await fetch('/config-sync/auto', {
        method: 'POST',
        cache: 'no-store',
        credentials: 'same-origin',
        headers: jsonHeaders,
        body: JSON.stringify(payload),
      })
      const text = await res.text()
      let body
      try { body = text ? JSON.parse(text) : null } catch { throw badJson(res) }
      if (!res.ok || !body || body.ok !== true) throw new Error((body && body.error) || `${res.status}`)
      return body
    }

    /**
     * 同步内容勾选：GET 取十组内容与当前勾选，POST 落盘 `<DshHome>\config-sync-scope.json`。
     * 落盘后 capture.ps1 / apply.ps1 立刻按它跳过未勾选的内容（推送与拉取两侧同时生效）。
     */
    async function callScope(payload) {
      const res = await fetch('/config-sync/scope', payload
        ? {
          method: 'POST',
          cache: 'no-store',
          credentials: 'same-origin',
          headers: jsonHeaders,
          body: JSON.stringify(payload),
        }
        : { cache: 'no-store', credentials: 'same-origin', headers: langHeaders() })
      const text = await res.text()
      let body
      try { body = text ? JSON.parse(text) : null } catch { throw badJson(res) }
      if (!res.ok || !body || body.ok !== true) throw new Error((body && body.error) || `${res.status}`)
      return body
    }

    /**
     * 同步冲突：GET 取清单（两侧预览 + 每项当前选择），POST 存选择 / 还原单项 / 放弃清单。
     * 落地由 sync.ps1 在下次拉取时按同一份 JSON 执行，这里只改文件不动仓库。
     */
    async function callConflict(payload) {
      const res = await fetch('/config-sync/conflict', payload
        ? {
          method: 'POST',
          cache: 'no-store',
          credentials: 'same-origin',
          headers: jsonHeaders,
          body: JSON.stringify(payload),
        }
        : { cache: 'no-store', credentials: 'same-origin', headers: langHeaders() })
      const text = await res.text()
      let body
      try { body = text ? JSON.parse(text) : null } catch { throw badJson(res) }
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
          headers: jsonHeaders,
          body: JSON.stringify(payload),
        }
        : { cache: 'no-store', credentials: 'same-origin', headers: langHeaders() })
      const text = await res.text()
      let body
      try { body = text ? JSON.parse(text) : null } catch { throw badJson(res) }
      if (!res.ok || !body) throw new Error((body && body.error) || `${res.status}`)
      return body
    }

    /** 本机路径根：GET 拿当前值 + 待确认清单，POST 存用户选的本机路径。 */
    async function callRoots(payload) {
      const res = await fetch('/config-sync/roots', payload
        ? {
          method: 'POST',
          cache: 'no-store',
          credentials: 'same-origin',
          headers: jsonHeaders,
          body: JSON.stringify(payload),
        }
        : { cache: 'no-store', credentials: 'same-origin', headers: langHeaders() })
      const text = await res.text()
      let body
      try { body = text ? JSON.parse(text) : null } catch { throw badJson(res) }
      if (!res.ok || !body || body.ok !== true) throw new Error((body && body.error) || `${res.status}`)
      return body
    }

    /** 问题反馈：GET 读 GitHub Issue 列表，POST 建 issue / 存令牌 / 补发队列，PATCH 改状态。 */
    async function callFeedback(payload, opts = {}) {
      const query = opts.query ? `?${new URLSearchParams(opts.query).toString()}` : ''
      const method = opts.method || (payload ? 'POST' : 'GET')
      const res = await fetch(`/config-sync/feedback${query}`, {
        method,
        cache: 'no-store',
        credentials: 'same-origin',
        headers: payload ? jsonHeaders : langHeaders(),
        body: payload ? JSON.stringify(payload) : undefined,
      })
      const text = await res.text()
      let body
      try { body = text ? JSON.parse(text) : null } catch { throw badJson(res) }
      if (!res.ok || !body || body.ok !== true) throw new Error((body && body.error) || `${res.status}`)
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

      const prepare = react.useCallback(async (action, message, backupDir) => {
        setBusy(true)
        setErr('')
        try { setMade(await callPrepare(action, message, backupDir)) } catch (e) { setErr(String((e && e.message) || e)) } finally { setBusy(false) }
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
      const LABEL = {
        push: M('推送', 'Push'),
        pull: M('拉取', 'Pull'),
        restore: M('还原', 'Restore'),
        'restore-backup': M('还原指定备份', 'Restore chosen backup'),
        all: M('全部', 'All'),
      }
      const backup = items.map((it) => it.backup).find((b) => b && b.dir)
      const when = backup && backup.at ? new Date(backup.at).toLocaleString(localeNow(), { hour12: false }) : ''
      const warnItems = items.flatMap((it) => (Array.isArray(it.warnings) ? it.warnings.map((w) => ({ action: it.action, w })) : []))
      const key = 'warn_' + (warnItems.length ? 1 : 0)
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
        items.map((it, i) => h('div', { key: i, style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
          h('div', { style: S.hint }, M(
            `已生成「${it.label || LABEL[it.action] || it.action}」：${it.path}`,
            `Generated "${it.label || it.action}": ${it.path}`,
          )),
          h('div', { style: S.code }, it.command),
        )),
        backup
          ? h('div', { style: S.hint }, M(
            `还原快照：${backup.dir}（${when}，共 ${backup.count} 份中的最新，含 ${backup.files} 个文件）`,
            `Restore snapshot: ${backup.dir} (${when}; newest of ${backup.count}, ${backup.files} files)`,
          ))
          : null,
        warnItems.length
          ? h('div', { key, style: { display: 'flex', flexDirection: 'column', gap: '2px' } },
            warnItems.map((x, i) => h('div', {
              key: i,
              style: { ...S.hint, color: 'var(--dsw-alias-state-warn-primary)' },
            }, `[${LABEL[x.action] || x.action}] ${x.w}`)))
          : null,
        h('div', { style: S.footnote }, M(
          '脚本已带进程检查：退出 DSH 后双击；拉取 / 还原会先要你输 y 确认。',
          'Scripts check for a running client: double-click after quitting DSH; pull/restore ask for y first.',
        )),
      )
    }

    /**
     * 本机仓库卡：仓库目录（哪台机器上那份 dsh-config）。
     * 默认只读；没配过就强制停在编辑态——不先指定仓库，推送/拉取/还原都无从生成。
     */
    function RepoCard(props) {
      const repo = (props.data && props.data.repo) || {}
      // 空目录不算「没配好」：它是新机器还没拉取的状态，不该把人按在编辑态
      const missing = Boolean(props.data) && !repo.exists && !repo.empty
      const [editing, setEditing] = react.useState(false)
      const [path, setPath] = react.useState(repo.path || '')
      const [busy, setBusy] = react.useState(false)
      const [err, setErr] = react.useState('')
      const [msg, setMsg] = react.useState('')
      const sourceLabel = (s) => s === 'settings' ? M('本机设置', 'Machine settings')
        : (s === 'config' ? M('插件配置（cordis.patch.yml）', 'Plugin config (cordis.patch.yml)')
          : (s === 'env' ? M('环境变量 DSH_CONFIG_REPO', 'Env var DSH_CONFIG_REPO')
            : (s === 'auto' ? M('自动探测', 'Auto-detected') : M('未配置', 'Not set'))))

      // 没配仓库 = 强制编辑态，且不允许「取消」回到只读
      const forced = missing
      const isEditing = editing || forced

      const startEdit = () => { setPath(repo.path || ''); setErr(''); setMsg(''); setEditing(true) }
      const cancelEdit = () => { setEditing(false); setErr(''); setMsg('') }
      const save = async () => {
        setBusy(true); setErr(''); setMsg('')
        try {
          const r = await callSettings({ repoPath: path })
          setMsg(M(
            `已保存仓库路径${(r.repo && r.repo.hasGit) ? '' : '（空目录：首次「拉取」会自动 git init + fetch + checkout，把它变成仓库；在那之前只允许拉取）'}`,
            `Repo path saved${(r.repo && r.repo.hasGit) ? '' : ' (empty folder: the first Pull runs git init + fetch + checkout to turn it into the repo; until then only pull is allowed)'}`,
          ))
          setEditing(false)
          if (typeof props.onSaved === 'function') props.onSaved()
        } catch (e) {
          setErr(String((e && e.message) || e))
        } finally { setBusy(false) }
      }

      const row = h('div', { style: S.kvRow },
        h('div', { style: S.kvKey }, M('仓库路径', 'Repo path')),
        isEditing
          ? h('input', {
            type: 'text', style: S.input, value: path, spellCheck: false,
            placeholder: M('D:\\dsh-config（那台机器上装仓库的目录）', 'D:\\dsh-config (directory holding the repo on this machine)'),
            onChange: (e) => setPath(e.target.value),
          })
          : h('div', { style: { ...S.kvVal, fontFamily: 'Consolas, ui-monospace, monospace' } }, repo.path || M('（未配置）', '(not set)')),
      )

      return h('div', { style: S.card },
        h('div', { style: S.cardHead },
          h('div', { style: S.cardTitle }, M('本机仓库', 'Local repo')),
          isEditing && forced
            ? h('div', { style: { ...S.hint, flex: 1 } }, M('先填好仓库目录才能生成脚本', 'Set the repo path first — scripts need it'))
            : null,
          h('div', { style: S.actions },
            isEditing
              ? h(react.Fragment, null,
                h('button', { type: 'button', style: S.btnPrimary, disabled: busy || !path.trim(), onClick: save }, busy ? M('保存中…', 'Saving…') : M('保存', 'Save')),
                forced ? null : h('button', { type: 'button', style: S.btn, disabled: busy, onClick: cancelEdit }, M('取消', 'Cancel')),
              )
              : h('button', { type: 'button', style: S.btn, disabled: !props.data, onClick: startEdit }, M('修改', 'Edit')),
          ),
        ),
        row,
        h(Kv, {
          k: M('路径来源', 'Path source'),
          v: sourceLabel(repo.source) + (repo.exists ? '' : (repo.empty ? M('（空目录，待首次拉取）', ' (empty folder, waiting for the first pull)') : M('（这个路径不可用）', ' (path unavailable)'))),
        }),
        h(Kv, {
          k: M('分支 / HEAD', 'Branch / HEAD'),
          v: repo.exists ? `${repo.branch || '?'} @ ${repo.head || '?'}` : (repo.empty ? M('（待首次拉取）', '(after the first pull)') : M('（不可用）', '(unavailable)')),
        }),
        h(Kv, {
          k: M('远端', 'Remote'),
          v: repo.exists
            ? M(
              `落后 ${repo.behind ?? '?'} · 领先 ${repo.ahead ?? '?'} · 未提交 ${repo.dirty ?? '?'}`,
              `behind ${repo.behind ?? '?'} · ahead ${repo.ahead ?? '?'} · dirty ${repo.dirty ?? '?'}`,
            )
            : (repo.empty ? M('（拉取之后才有得比）', '(available after the first pull)') : M('（不可用）', '(unavailable)')),
        }),
        (repo.empty || repo.phase === 'missing')
          ? h('div', { style: { ...S.hint, color: 'var(--dsw-alias-state-warn-primary)' } },
            repo.mode === 'await-init'
              ? M(
                '本机仓库和云端仓库都还没有内容：点「初始化推送」把本机配置作为初始内容写进仓库并推上去（自动 git init + 写仓库骨架 + capture + 提交 + 推送）。这时拉取没有东西可拉。',
                'Both the local repo and the cloud are empty: Initialize push writes this machine\'s config in as the initial content (git init + repo skeleton + capture + commit + push). There is nothing to pull yet.',
              )
              : M(
                '本机仓库还没有内容：点「拉取」会从云端把仓库内容拉到这个路径（自动 git init + fetch + checkout）；拉下来之前不支持推送。',
                'The local repo has no content yet: Pull fetches the whole repo into this path (git init + fetch + checkout). Push is disabled until then.',
              ))
          : null,
        h(Kv, { k: M('本机数据', 'Local data'), v: (() => {
          const local = props.data && props.data.local
          if (!local || !local.known) return M('还没同步过', 'Never synced yet')
          const when = local.lastSyncAt ? new Date(local.lastSyncAt).toLocaleString(localeNow(), { hour12: false }) : '?'
          const tail = local.pending > 0
            ? M(
              `有 ${local.pending} 个文件待推送${local.sample && local.sample.length ? `（如 ${local.sample.join('、')}）` : ''}`,
              `${local.pending} file(s) to push${local.sample && local.sample.length ? ` (e.g. ${local.sample.join(', ')})` : ''}`,
            )
            : M('没有新写入', 'nothing new')
          return M(
            `${tail} · 上次同步 ${when}${local.mode ? `（${local.mode}）` : ''}`,
            `${tail} · last sync ${when}${local.mode ? ` (${local.mode})` : ''}`,
          )
        })() }),
        h('div', { style: S.footnote }, M(
          '路径只存本机设置文件（~\\.dsh\\dsh-config-sync.json），不进仓库，各机器各配各的。',
          'The path lives only in the local settings file (~\\.dsh\\dsh-config-sync.json), never in the repo.',
        )),
        forced
          ? h('div', { style: { ...S.hint, color: 'var(--dsw-alias-state-error-primary)' } },
            M(
              '必须先把仓库目录配好：否则推送/拉取/还原三份脚本都无法生成，体检也只能看个空壳。',
              'Configure the repo directory first — otherwise push/pull/restore cannot be generated and the check has nothing to inspect.',
            ))
          : null,
        err ? h('div', { style: { ...S.hint, color: 'var(--dsw-alias-state-error-primary)' } }, M(`保存失败：${err}`, `Save failed: ${err}`)) : null,
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
      const sourceLabel = (s) => s === 'settings' ? M('本机设置', 'Machine settings')
        : (s === 'git' ? M('git 配置', 'git config')
          : (s === 'default' ? M('自动探测', 'Auto-detected') : M('未配置', 'Not set')))

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
          setMsg(M(
            `已保存${r.gitRemoteSet ? '，并已更新本机 git origin' : ''}`,
            `Saved${r.gitRemoteSet ? ' and updated the local git origin' : ''}`,
          ))
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
          : h('div', { style: { ...S.kvVal, fontFamily: 'Consolas, ui-monospace, monospace' } }, value || M('（未配置）', '(not set)')),
      )

      return h('div', { style: S.card },
        h('div', { style: S.cardHead },
          h('div', { style: S.cardTitle }, M('云端仓库', 'Cloud repo')),
          isEditing && missing
            ? h('div', { style: { ...S.hint, flex: 1 } }, M('先填远端地址才能生成推送/拉取', 'Set the remote URL to enable push/pull'))
            : null,
          isEditing
            ? h('div', { style: S.actions },
              h('button', { type: 'button', style: S.btnPrimary, disabled: busy || !url.trim(), onClick: save }, busy ? M('保存中…', 'Saving…') : M('保存', 'Save')),
              missing ? null : h('button', { type: 'button', style: S.btn, disabled: busy, onClick: cancelEdit }, M('取消', 'Cancel')),
            )
            : h('div', { style: S.actions },
              h('button', { type: 'button', style: S.btn, disabled: !props.data, onClick: startEdit }, M('修改', 'Edit')),
            ),
        ),
        field(M('远端地址', 'Remote URL'), isEditing ? url : (remote.url || ''), setUrl, 'git@<host>:you/dsh-config.git'),
        field(M('SSH 私钥', 'SSH key'), isEditing ? key : (remote.sshKey || ''), setKey, M('C:\\Users\\你\\.ssh\\id_ed25519', 'C:\\Users\\you\\.ssh\\id_ed25519')),
        h(Kv, {
          k: M('私钥来源', 'Key source'),
          v: `${sourceLabel(remote.sshKeyFrom)}${remote.sshKeyExists ? '' : M('（文件不存在）', ' (file missing)')}`,
        }),
        h(Kv, { k: M('地址来源', 'URL source'), v: sourceLabel(remote.urlSource) }),
        h(Kv, { k: M('设置文件', 'Settings file'), v: remote.settingsPath || M('（未知）', '(unknown)') }),
        missing && !remote.sshKeyExists
          ? h('div', { style: S.footnote }, M(
            '私钥可留空：认证交给 .ssh\\config 或 Git 默认选择；填了才写进脚本的 GIT_SSH_COMMAND。',
            'The key is optional — auth falls back to .ssh\\config or Git defaults; fill it only to write GIT_SSH_COMMAND into scripts.',
          ))
          : null,
        err ? h('div', { style: { ...S.footnote, color: 'var(--dsw-alias-state-error-primary)' } }, M(`保存失败：${err}`, `Save failed: ${err}`)) : null,
        msg ? h('div', { style: { ...S.footnote, color: 'var(--dsw-alias-state-success-primary)' } }, msg) : null,
        h('div', { style: S.footnote }, M(
          '远端地址支持任意 git 托管平台（Gitee / GitHub / GitLab / 自建 Gitea）：'
          + 'git@host:owner/repo.git、ssh://、https:// 三种写法都行；'
          + '例：git@gitee.com:you/dsh-config.git、git@github.com:you/dsh-config.git、https://gitlab.com/you/dsh-config.git。'
          + 'SSH 地址用下面的私钥/ssh config 走认证，https 地址用 Git 凭据管理器里的账号或令牌。',
          'Any git host works (Gitee / GitHub / GitLab / self-hosted Gitea): '
          + 'git@host:owner/repo.git, ssh:// and https:// are all accepted; '
          + 'e.g. git@gitee.com:you/dsh-config.git, git@github.com:you/dsh-config.git, https://gitlab.com/you/dsh-config.git. '
          + 'SSH URLs authenticate with the key or ssh config below; https URLs use the account or token in Git Credential Manager.',
        )),
        h('div', { style: S.footnote }, M(
          '只存私钥路径不存内容；保存远端地址会同步更新本机 git origin，git 失败则整套回滚。',
          'Only the key path is stored; saving also updates the local git origin, rolling everything back if git fails.',
        )),
      )
    }

    /**
     * 「还原备份」卡：先看备份目录在哪（默认 <DshHome>\backups，可改成别的绝对路径），
     * 再把该目录下的快照逐份列出来（时间 / 相对时间 / 文件数 / 大小 / 插件数 / 能不能拿来还原）。
     *
     * 「立即还原」= 和「立即拉取」同一条流水线：点快照 → 弹确认框（服务端现算差异：会撤走哪些插件、
     * 会覆盖/写回哪些文件、会移走哪些快照之后新增的文件）→ 确认后排队 auto-sync，客户端退出后
     * 由 post-exit.ps1 弹可见窗口跑 restore.ps1 -RollbackToPoint → 完成后自动重启客户端。
     *
     * 为什么不能"点了就直接覆盖"：profile 文件在 DSH 运行时被客户端持有，边跑边覆盖会被退出时的
     * 回写再盖回去，甚至把 profile 弄坏。所以仍然必须走"退出后执行"，只是不再让用户自己双击 .cmd。
     * 需要生成脚本的老路径（用于手动/离线执行）仍保留在「动作」卡里。
     */
    function RestoreCard(props) {
      const backup = (props.data && props.data.backup) || {}
      const remote = (props.data && props.data.remote) || {}
      const snapshots = Array.isArray(backup.snapshots) ? backup.snapshots
        : (Array.isArray(backup.candidates) ? backup.candidates : [])
      const defaultRoot = backup.defaultRoot || remote.backupRoot || ''
      const [editing, setEditing] = react.useState(false)
      const [root, setRoot] = react.useState(remote.backupRoot || defaultRoot)
      const [busy, setBusy] = react.useState(false)
      const [err, setErr] = react.useState('')
      const [msg, setMsg] = react.useState('')
      const [made, setMade] = react.useState(null)
      const [confirm, setConfirm] = react.useState(null)   // { snap, preview }：确认环节
      const [queued, setQueued] = react.useState(null)     // restore-now 的排队结果

      const startEdit = () => { setRoot(remote.backupRootCustom ? (remote.backupRoot || '') : ''); setErr(''); setMsg(''); setEditing(true) }
      const cancelEdit = () => { setEditing(false); setErr(''); setMsg('') }

      const save = async (payload) => {
        setBusy(true); setErr(''); setMsg('')
        try {
          const r = await callSettings(payload)
          setMsg(payload.clearBackupRoot
            ? M('已恢复默认备份目录', 'Backup folder reset to the default')
            : M(`已保存备份目录：${(r.remote && r.remote.backupRoot) || ''}`, `Backup folder saved: ${(r.remote && r.remote.backupRoot) || ''}`))
          setEditing(false)
          if (typeof props.onSaved === 'function') props.onSaved()
        } catch (e) {
          setErr(String((e && e.message) || e))
        } finally { setBusy(false) }
      }

      /**
       * 第一步：点「立即还原」不是直接动手，先向服务端要一份差异预览 ——
       * 会撤走哪些插件、会覆盖哪些文件、会移走哪些快照之后新增的文件，全部摆出来让人确认。
       */
      const askRestore = async (snap) => {
        setBusy(true); setErr(''); setMsg(''); setQueued(null)
        try {
          const r = await callAuto({ action: 'restore-preview', backupDir: snap.dir })
          setConfirm({ snap, preview: (r && r.preview) || {} })
        } catch (e) { setErr(String((e && e.message) || e)) } finally { setBusy(false) }
      }

      /** 第二步：确认之后才排队「退出后还原」，随后请求客户端正常关闭（和立即拉取同一条流水线）。 */
      const doRestore = async () => {
        if (!confirm) return
        setBusy(true); setErr('')
        try {
          const r = await callAuto({ action: 'restore-now', backupDir: confirm.snap.dir })
          setQueued({ snap: confirm.snap, resp: r })
          setConfirm(null)
        } catch (e) { setErr(String((e && e.message) || e)) } finally { setBusy(false) }
      }

      const when = (at) => (at ? new Date(at).toLocaleString(localeNow(), { hour12: false }) : '?')
      /** 相对时间：备份列表里"3 分钟前"比一串年月日更好判断新旧，具体时刻仍保留在旁边 */
      const rel = (at) => {
        if (!at) return '?'
        const diff = Date.now() - Number(at)
        if (diff < 0 || diff < 60000) return M('刚刚', 'just now')
        const min = Math.floor(diff / 60000)
        if (min < 60) return M(`${min} 分钟前`, `${min} min ago`)
        const hr = Math.floor(min / 60)
        if (hr < 24) return M(`${hr} 小时前`, `${hr} h ago`)
        const day = Math.floor(hr / 24)
        if (day < 30) return M(`${day} 天前`, `${day} d ago`)
        return M(`${Math.floor(day / 30)} 个月前`, `${Math.floor(day / 30)} mo ago`)
      }
      const size = (n) => {
        const v = Number(n) || 0
        if (v >= 1048576) return `${(v / 1048576).toFixed(1)} MB`
        if (v >= 1024) return `${(v / 1024).toFixed(1)} KB`
        return `${v} B`
      }

      const rows = snapshots.length
        ? h('div', { style: { maxHeight: '260px', overflowY: 'auto', display: 'flex', flexDirection: 'column' } },
          snapshots.map((s) => h('div', {
            key: s.dir || s.name,
            style: {
              display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap',
              padding: '7px 2px',
              borderTop: '1px solid var(--dsw-alias-border-l1)',
            },
          },
          h('div', { style: { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0, flex: 1 } },
            h('div', {
              style: { fontSize: '12px', lineHeight: '18px', color: 'var(--dsw-alias-label-primary)', fontFamily: 'Consolas, ui-monospace, monospace', wordBreak: 'break-all' },
            }, s.name),
            h('div', { style: S.hint },
              M(
                `${when(s.at)} · ${rel(s.at)} · ${s.files || 0} 个文件 · ${size(s.bytes)}${s.plugins ? ` · ${s.plugins} 个插件` : ''}${s.usable === false ? ' · 没有 profile 文件，不能还原' : ''}`,
                `${when(s.at)} · ${rel(s.at)} · ${s.files || 0} files · ${size(s.bytes)}${s.plugins ? ` · ${s.plugins} plugins` : ''}${s.usable === false ? ' · no profile files, cannot restore' : ''}`,
              )),
          ),
          s.usable === false
            ? h('button', { type: 'button', style: { ...S.btn, opacity: 0.5, cursor: 'not-allowed' }, disabled: true }, M('不可还原', 'Unusable'))
            : h('button', { type: 'button', style: S.btn, disabled: busy, onClick: () => askRestore(s) }, M('立即还原', 'Restore now')),
          )))
        : h('div', { style: S.hint }, backup.exists
          ? M('这个备份目录下还没有快照（apply.ps1 每次拉取/落地之前都会打一份）', 'No snapshots in this backup folder yet (apply.ps1 makes one before every pull/apply)')
          : M(`备份目录不存在：${backup.root || defaultRoot}`, `Backup folder does not exist: ${backup.root || defaultRoot}`))

      /**
       * 确认环节 + 排队回执 + 上次还原结果。
       * 三个块都直接挂在卡片里（不是弹窗），这样确认时能同时看到快照列表做对照。
       */
      const listBox = (title, items, tone) => (items && items.length)
        ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: '2px' } },
          h('div', { style: { ...S.hint, color: tone || 'var(--dsw-alias-label-secondary)' } }, title),
          h('div', {
            style: {
              ...S.hint, fontFamily: 'Consolas, ui-monospace, monospace',
              maxHeight: '110px', overflowY: 'auto', wordBreak: 'break-all',
            },
          }, items.join('  ·  ')))
        : null

      const pv = (confirm && confirm.preview) || {}
      const pvRemovePlugins = pv.pluginsRemove || []
      const pvInstallPlugins = pv.pluginsInstall || []
      const pvRemoveFiles = pv.willRemove || []
      const pvOverwrite = pv.willOverwrite || []
      const pvWrite = pv.willWrite || []

      const confirmBlock = confirm
        ? h('div', {
          style: {
            display: 'flex', flexDirection: 'column', gap: '5px',
            padding: '9px 11px', borderRadius: '8px',
            border: '1px solid var(--dsw-alias-border-l1)',
            background: 'var(--dsw-alias-bg-module-platform)',
          },
        },
        h('div', { style: { ...S.cardTitle, fontSize: '13px' } },
          M(`确认还原到 ${confirm.snap.name}？`, `Restore to ${confirm.snap.name}?`)),
        h('div', { style: S.hint }, M(
          `快照时间 ${when(confirm.snap.at)}（${rel(confirm.snap.at)}）· ${confirm.snap.files || 0} 个文件 · ${size(confirm.snap.bytes)} · ${confirm.snap.plugins || 0} 个插件`,
          `Snapshot ${when(confirm.snap.at)} (${rel(confirm.snap.at)}) · ${confirm.snap.files || 0} files · ${size(confirm.snap.bytes)} · ${confirm.snap.plugins || 0} plugins`,
        )),
        listBox(
          M(`将撤走 ${pvRemovePlugins.length} 个快照之后装上的插件`, `Removing ${pvRemovePlugins.length} plugin(s) installed after this snapshot`),
          pvRemovePlugins, 'var(--dsw-alias-state-error-primary)',
        ),
        listBox(
          M(`将移走 ${pvRemoveFiles.length} 个快照之后新增的文件`, `Moving out ${pvRemoveFiles.length} file(s) created after this snapshot`),
          pvRemoveFiles, 'var(--dsw-alias-state-error-primary)',
        ),
        listBox(
          M(`将覆盖 ${pvOverwrite.length} 个、写回 ${pvWrite.length} 个文件`, `Overwriting ${pvOverwrite.length}, writing back ${pvWrite.length} file(s)`),
          [].concat(pvOverwrite, pvWrite),
        ),
        listBox(
          M(`还原后要重新安装 ${pvInstallPlugins.length} 个插件`, `Re-installing ${pvInstallPlugins.length} plugin(s) afterwards`),
          pvInstallPlugins,
        ),
        h('div', { style: S.hint }, M(
          '动手前会把当前配置整份存到 backups\\manual-<时间戳>；撤走的东西另有 rollback 清单，随时能再还原回来。',
          'The current config is copied to backups\\manual-<timestamp> first, and everything removed is listed in a rollback manifest — both can be restored later.',
        )),
        h('div', { style: { ...S.hint, color: 'var(--dsw-alias-state-warning-primary)' } }, M(
          '确认后：客户端正常退出 → 弹出进度窗口执行还原 → 完成后自动重启客户端。',
          'After confirming: the client closes normally, a progress window runs the restore, then the client restarts automatically.',
        )),
        h('div', { style: S.actions },
          h('button', { type: 'button', style: S.btnPrimary, disabled: busy, onClick: doRestore },
            busy ? M('排队中…', 'Queuing…') : M('确认还原', 'Confirm restore')),
          h('button', { type: 'button', style: S.btn, disabled: busy, onClick: () => setConfirm(null) }, M('取消', 'Cancel')),
        ),
        )
        : null

      const queuedBlock = queued
        ? h('div', { style: { ...S.footnote, color: 'var(--dsw-alias-state-success-primary)' } },
          M(
            `已排队：还原到 ${queued.snap.name}。客户端即将退出，退出后会弹出进度窗口；完成后自动重启。`,
            `Queued: restoring to ${queued.snap.name}. The client will close, a progress window will run it, then it restarts.`,
          ))
        : null

      const lastRes = props.data && props.data.auto && props.data.auto.lastResult
      const lastRestoreBlock = (lastRes && lastRes.mode === 'restore')
        ? h('div', { style: { ...S.footnote, color: lastRes.ok ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-state-error-primary)' } },
          M(
            `上次还原：${lastRes.ok ? '成功' : '失败'} · ${when(lastRes.at)} · ${lastRes.message || ''}${lastRes.log ? ` · 日志 ${lastRes.log}` : ''}`,
            `Last restore: ${lastRes.ok ? 'ok' : 'failed'} · ${when(lastRes.at)} · ${lastRes.message || ''}${lastRes.log ? ` · log ${lastRes.log}` : ''}`,
          ))
        : null

      return h('div', { style: S.card },
        h('div', { style: S.cardHead },
          h('div', { style: S.cardTitle }, M('还原备份', 'Restore backup')),
          h('span', { style: { ...S.footnote, fontFamily: 'Consolas, ui-monospace, monospace' } },
            backup.exists ? M(`${backup.count || 0} 份快照`, `${backup.count || 0} snapshot(s)`) : M('目录不存在', 'folder missing')),
          h('div', { style: { flex: 1 } }, null),
          h('div', { style: S.actions },
            editing
              ? h(react.Fragment, null,
                h('button', { type: 'button', style: S.btnPrimary, disabled: busy, onClick: () => save({ backupRoot: root.trim() }) }, busy ? M('保存中…', 'Saving…') : M('保存', 'Save')),
                h('button', { type: 'button', style: S.btn, disabled: busy, onClick: () => save({ clearBackupRoot: true }) }, M('恢复默认', 'Use default')),
                h('button', { type: 'button', style: S.btn, disabled: busy, onClick: cancelEdit }, M('取消', 'Cancel')),
              )
              : h('button', { type: 'button', style: S.btn, disabled: !props.data || busy, onClick: startEdit }, M('修改', 'Edit')),
          ),
        ),
        h('div', { style: S.kvRow },
          h('div', { style: S.kvKey }, M('备份目录', 'Backup folder')),
          editing
            ? h('input', {
              type: 'text', style: S.input, value: root, spellCheck: false,
              placeholder: defaultRoot || M('留空 = 默认 <用户目录>\\.dsh\\backups', 'Empty = default <home>\\.dsh\\backups'),
              onChange: (e) => setRoot(e.target.value),
            })
            : h('div', { style: { ...S.kvVal, fontFamily: 'Consolas, ui-monospace, monospace' } },
              `${remote.backupRoot || backup.root || defaultRoot}${(remote.backupRootCustom ? M('（本机设置）', ' (machine setting)') : M('（默认）', ' (default)'))}`),
        ),
        rows,
        confirmBlock,
        queuedBlock,
        lastRestoreBlock,
        made
          ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
            h('div', { style: { ...S.footnote, color: 'var(--dsw-alias-state-success-primary)' } },
              M(`已生成：${made.path}`, `Generated: ${made.path}`)),
            h('div', { style: S.code }, made.command || ''),
            h('div', { style: S.footnote }, M(
              '完全退出 DSH 后双击这份 .cmd：先打印计划，输 y 才真正写（写前自动备份当前状态）。',
              'Quit DSH, then double-click the .cmd: it prints the plan and only writes after y (backing up the current state first).',
            )),
          )
          : null,
        err ? h('div', { style: { ...S.footnote, color: 'var(--dsw-alias-state-error-primary)' } }, M(`操作失败：${err}`, `Failed: ${err}`)) : null,
        msg ? h('div', { style: { ...S.footnote, color: 'var(--dsw-alias-state-success-primary)' } }, msg) : null,
        h('div', { style: S.footnote }, M(
          '留空 = 默认 ~\\.dsh\\backups；只能选该目录下的快照。「立即还原」= 回到该时间点：配置写回，快照之后新增的文件与插件一并撤走（移进 backups\\manual-<时间戳> 的 rollback 备份，可再还原）。',
          'Empty = default ~\\.dsh\\backups; only snapshots inside it are offered. "Restore now" rolls back to that point: config is written back and anything added afterwards is moved into the rollback folder under backups\\manual-<timestamp>, so it can be restored again.',
        )),
      )
    }

    /**
     * 「同步冲突」卡：拉取被本机文件挡住时，sync.ps1 会先备份本机副本、再写一份冲突清单
     * （<DshHome>\sync-conflicts.json，含两侧预览）。
     * 这里逐项列出，点行展开看两边内容，选「用本机 / 用云端」，保存后由 sync.ps1 在下次拉取时落地：
     *   用云端 = 丢掉本机那份（备份里留着，随时可「还原」）
     *   用本机 = 先让云端版本落地，再把本机那份写回工作区，下次推送带上
     * 没冲突时这张卡不出现（不占版面）。
     */
    function ConflictCard(props) {
      const [state, setState] = react.useState(null)
      const [open, setOpen] = react.useState({})
      const [busy, setBusy] = react.useState(false)
      const [err, setErr] = react.useState('')
      const [msg, setMsg] = react.useState('')

      const load = async () => {
        try { setState(await callConflict()) } catch (e) { setErr(String((e && e.message) || e)) }
      }
      react.useEffect(() => { load() }, [])

      const size = (n) => {
        const v = Number(n) || 0
        if (v >= 1048576) return `${(v / 1048576).toFixed(1)} MB`
        if (v >= 1024) return `${(v / 1024).toFixed(1)} KB`
        return `${v} B`
      }

      if (!state) {
        return h('div', { style: S.card },
          h('div', { style: S.cardTitle }, M('同步冲突', 'Sync conflicts')),
          h('div', { style: S.hint }, err
            ? M(`读取失败：${err}`, `Read failed: ${err}`)
            : M('正在读取冲突清单…', 'Loading conflicts…')),
        )
      }
      if (!state.exists) return null

      const items = Array.isArray(state.items) ? state.items : []
      const pending = items.filter((it) => !it.choice).length
      const chosen = items.length - pending

      const setChoice = (path, choice) => {
        setMsg('')
        setState({ ...state, items: items.map((it) => (it.path === path ? { ...it, choice } : it)) })
      }
      const setAll = (choice) => {
        setMsg('')
        setState({ ...state, items: items.map((it) => ({ ...it, choice })) })
      }
      const save = async () => {
        setBusy(true); setErr(''); setMsg('')
        try {
          const r = await callConflict({ items: items.map((it) => ({ path: it.path, choice: it.choice || '' })) })
          setMsg(r.pending
            ? M(`已保存：${r.chosen}/${r.total} 项已选，还有 ${r.pending} 项没选（选完才能拉取）`, `Saved: ${r.chosen}/${r.total} chosen, ${r.pending} still unset (a pull needs them all)`)
            : M(`已保存：${r.chosen}/${r.total} 项都选好了，去点「立即拉取」`, `Saved: all ${r.chosen}/${r.total} chosen — now click "Pull now"`))
          if (typeof props.onSaved === 'function') props.onSaved()
        } catch (e) { setErr(String((e && e.message) || e)) } finally { setBusy(false) }
      }
      const restore = async (path, side) => {
        setBusy(true); setErr(''); setMsg('')
        try {
          await callConflict({ action: 'restore', path, side })
          setMsg(side === 'cloud'
            ? M(`已从备份把云端副本还原到：${path}`, `Cloud copy restored from backup: ${path}`)
            : M(`已从备份把本机副本还原到：${path}`, `Local copy restored from backup: ${path}`))
        } catch (e) { setErr(String((e && e.message) || e)) } finally { setBusy(false) }
      }
      const discard = async () => {
        setBusy(true); setErr(''); setMsg('')
        try {
          await callConflict({ action: 'reset' })
          setState({ exists: false })
          if (typeof props.onSaved === 'function') props.onSaved()
        } catch (e) { setErr(String((e && e.message) || e)) } finally { setBusy(false) }
      }

      const preview = (title, text, empty) => h('div', { style: { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 } },
        h('div', { style: S.hint }, title),
        h('pre', {
          style: {
            margin: 0, padding: '6px 8px', maxHeight: '180px', overflow: 'auto',
            fontSize: '11px', lineHeight: '16px', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
            fontFamily: 'Consolas, ui-monospace, monospace',
            border: '1px solid var(--dsw-alias-border-l1)', borderRadius: '6px',
            background: 'var(--dsw-alias-bg-base)', color: 'var(--dsw-alias-label-secondary, var(--dsw-alias-label-primary))',
          },
        }, text || empty),
      )

      const rows = items.map((it) => {
        const expanded = open[it.path] === true
        return h('div', {
          key: it.path,
          style: { borderTop: '1px solid var(--dsw-alias-border-l1)', paddingTop: '6px', paddingBottom: '2px' },
        },
          h('div', {
            style: { display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' },
            onClick: () => setOpen({ ...open, [it.path]: !expanded }),
          },
            h('span', { style: { flexShrink: 0, width: '10px', fontSize: '11px', color: 'var(--dsw-alias-label-tertiary)' } }, expanded ? '▾' : '▸'),
            h('div', { style: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: '1px' } },
              h('div', {
                style: { fontSize: '12px', lineHeight: '18px', fontFamily: 'Consolas, ui-monospace, monospace', wordBreak: 'break-all' },
              }, it.path),
              h('div', { style: S.hint },
                M(
                  `${it.kind === 'untracked' ? '本机未入库' : '本机已修改'} · 本机 ${size(it.localSize)} vs 云端 ${size(it.remoteSize)}${it.binary ? ' · 二进制，只看大小' : ''}`,
                  `${it.kind === 'untracked' ? 'untracked' : 'modified'} · local ${size(it.localSize)} vs cloud ${size(it.remoteSize)}${it.binary ? ' · binary, size only' : ''}`,
                )),
            ),
            h('div', { style: { display: 'flex', gap: '4px', flexShrink: 0 } },
              h('button', {
                type: 'button',
                style: it.choice === 'local' ? S.btnPrimary : S.btn,
                onClick: (e) => { e.stopPropagation(); setChoice(it.path, 'local') },
              }, M('用本机', 'Keep local')),
              h('button', {
                type: 'button',
                style: it.choice === 'cloud' ? S.btnPrimary : S.btn,
                onClick: (e) => { e.stopPropagation(); setChoice(it.path, 'cloud') },
              }, M('用云端', 'Use cloud')),
            ),
          ),
          expanded
            ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px', marginLeft: '18px', marginTop: '6px' } },
              h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' } },
                preview(M('本机版本（工作区）', 'Local (working tree)'), it.localPreview,
                  M('（空文件 / 无法预览）', '(empty or not previewable)')),
                preview(M('云端版本（远端提交）', 'Cloud (remote commit)'), it.remotePreview,
                  M('（空文件 / 无法预览）', '(empty or not previewable)')),
              ),
              h('div', { style: { display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' } },
                h('button', {
                  type: 'button',
                  style: S.btn,
                  disabled: busy || !it.localSaved,
                  onClick: () => restore(it.path, 'local'),
                }, M('还原本机副本', 'Restore local copy')),
                h('button', {
                  type: 'button',
                  style: S.btn,
                  disabled: busy || !it.cloudSaved,
                  onClick: () => restore(it.path, 'cloud'),
                }, M('还原云端副本', 'Restore cloud copy')),
                h('span', { style: S.footnote },
                  M(
                    (it.localSaved ? '本机副本已备份' : '本机副本备份缺失') + ' · ' + (it.cloudSaved ? '云端副本已备份' : '云端副本备份缺失（旧清单或备份失败）'),
                    (it.localSaved ? 'local copy saved' : 'local copy MISSING') + ' · ' + (it.cloudSaved ? 'cloud copy saved' : 'cloud copy MISSING (older list or backup failed)'),
                  )),
              ),
              h('div', { style: S.footnote },
                M('备份目录：' + (state.backupDir || '?'), 'Backup folder: ' + (state.backupDir || '?')),
              ),
            )
            : null,
        )
      })

      return h('div', { style: S.card },
        h('div', { style: S.cardHead },
          h('div', { style: S.cardTitle }, M('同步冲突', 'Sync conflicts')),
          h('span', { style: { ...S.footnote } },
            M(`${items.length} 个文件挡住拉取`, `${items.length} file(s) blocking the pull`)),
          h('div', { style: { flex: 1 } }, null),
          h('button', { type: 'button', style: S.btn, disabled: busy, onClick: load }, M('刷新', 'Refresh')),
        ),
        h('div', { style: S.hint },
          M(
            '这些文件本机有、云端也有同名版本，git 不肯直接覆盖。逐项选：用云端 = 丢弃本机那份；用本机 = 先让云端落地、再把本机版写回，下次推送带上。两份副本都会存进备份目录，展开后哪一份都能还原。',
            'These paths exist both locally and in the cloud, so git refuses to overwrite them. Pick per file: Cloud = drop the local copy; Local = apply the cloud version, then write the local one back so the next push carries it. Both copies are saved in the backup folder and either one can be restored.',
          )),
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: '2px', maxHeight: '420px', overflowY: 'auto' } }, rows),
        h('div', { style: { display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap', marginTop: '4px' } },
          h('span', { style: S.hint },
            M(`已选 ${chosen}/${items.length}${pending ? `，${pending} 项未选` : ''}`, `${chosen}/${items.length} chosen${pending ? `, ${pending} unset` : ''}`)),
          h('div', { style: { flex: 1 } }, null),
          h('button', { type: 'button', style: S.btn, disabled: busy, onClick: () => setAll('cloud') }, M('全部用云端', 'All cloud')),
          h('button', { type: 'button', style: S.btn, disabled: busy, onClick: () => setAll('local') }, M('全部用本机', 'All local')),
          h('button', { type: 'button', style: S.btnPrimary, disabled: busy, onClick: save }, busy ? M('保存中…', 'Saving…') : M('保存选择', 'Save')),
          h('button', { type: 'button', style: S.btn, disabled: busy, onClick: discard }, M('放弃清单', 'Discard')),
        ),
        err ? h('div', { style: { ...S.footnote, color: 'var(--dsw-alias-state-error-primary)' } }, M(`操作失败：${err}`, `Failed: ${err}`)) : null,
        msg ? h('div', { style: { ...S.footnote, color: 'var(--dsw-alias-state-success-primary)' } }, msg) : null,
        h('div', { style: S.footnote },
          M(
            '保存后点「立即拉取」：脚本按选择先移走被挡的文件、快进到云端，再把「用本机」的写回。清单与备份都留在本机。',
            'After saving, click "Pull now": the script clears the blocked files, fast-forwards, then writes back the local ones. The list and backup stay on this machine.',
          )),
      )
    }

    /** 面板整页：左侧栏「配置同步」点开后看到的就是这个。 */
    /**
     * 「同步内容」卡：把云端同步的十组内容逐组列出，点行即可展开看明细，明细项也能单独取消。
     * 默认全勾；取消勾选后推送不再抓、拉取不再还原（两侧共用 <DshHome>\config-sync-scope.json）。
     * deleteCloud（默认关）是唯一的破坏性选项：打开后取消勾选会顺手删掉仓库里的副本。
     * 只读优先：进卡先只看不改，点「修改」才解锁勾选，改完点「保存」才落盘（取消=丢弃这次改动）。
     */
    function ScopeCard() {
      const [state, setState] = react.useState(null)
      const [open, setOpen] = react.useState({})
      const [busy, setBusy] = react.useState(false)
      const [editing, setEditing] = react.useState(false)
      const [msg, setMsg] = react.useState('')
      const [err, setErr] = react.useState('')

      const load = async () => {
        try {
          const r = await callScope()
          setState({ deleteCloud: r.deleteCloud === true, path: r.path || '', groups: r.groups || [] })
          setErr('')
        } catch (e) {
          setErr(String((e && e.message) || e))
        }
      }
      react.useEffect(() => { load() }, [])

      const save = async (next) => {
        setBusy(true); setErr(''); setMsg('')
        try {
          const groups = {}
          for (const g of next.groups || []) {
            const excluded = (g.items || []).filter((i) => i.enabled === false).map((i) => i.id)
            groups[g.id] = { enabled: g.enabled !== false, excluded }
          }
          await callScope({ deleteCloud: next.deleteCloud === true, groups })
          setState(next)
          setEditing(false)
          const offGroups = (next.groups || []).filter((g) => g.enabled === false).length
          const offItems = (next.groups || []).reduce((n, g) => n + (g.items || []).filter((i) => i.enabled === false).length, 0)
          setMsg(offGroups || offItems
            ? M(`已保存：整组不同步 ${offGroups} 组、组内排除 ${offItems} 项`, `Saved: ${offGroups} group(s) off, ${offItems} item(s) excluded`)
            : M('已保存：云端同步全部内容', 'Saved: everything is synced'))
        } catch (e) {
          setErr(String((e && e.message) || e))
        } finally { setBusy(false) }
      }

      // 勾选只改本次编辑的草稿，不落盘；「保存」才发请求，「取消」直接 reload 丢弃
      const toggleGroup = (id) => {
        if (!state || !editing) return
        const g0 = state.groups.find((x) => x.id === id)
        if (g0 && g0.required === true) return   // 必需组钉死，点也点不动
        setState({ ...state, groups: state.groups.map((g) => (g.id === id ? { ...g, enabled: g.enabled === false } : g)) })
        setMsg('')
      }
      const toggleItem = (gid, iid) => {
        if (!state || !editing) return
        setState({
          ...state,
          groups: state.groups.map((g) => (g.id === gid
            ? { ...g, items: g.items.map((i) => (i.id === iid ? { ...i, enabled: i.enabled === false } : i)) }
            : g)),
        })
        setMsg('')
      }
      const toggleDeleteCloud = () => {
        if (!state || !editing) return
        setState({ ...state, deleteCloud: state.deleteCloud !== true })
        setMsg('')
      }
      const cancelEdit = () => { setMsg(''); setErr(''); setEditing(false); load() }

      if (!state) {
        return h('div', { style: S.card },
          h('div', { style: S.cardTitle }, M('同步内容', 'Sync content')),
          h('div', { style: S.hint }, err ? M(`读取失败：${err}`, `Read failed: ${err}`) : M('正在读取同步范围…', 'Loading sync scope…')),
        )
      }

      const total = state.groups.reduce((n, g) => n + (g.items || []).length, 0)
      const checked = state.groups.reduce((n, g) => (g.enabled === false ? n : n + (g.items || []).filter((i) => i.enabled !== false).length), 0)

      return h('div', { style: S.card },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } },
          h('div', { style: S.cardTitle }, M('同步内容', 'Sync content')),
          h('div', { style: { ...S.hint, flex: 1, minWidth: '160px' } },
            editing
              ? M(`改完点「保存」才生效（当前 ${checked}/${total} 项参与同步）`, `Click Save to apply (${checked}/${total} items currently active)`)
              : M(`只读：点「修改」后才能取消勾选（当前 ${checked}/${total} 项参与同步）`, `Read-only: click Edit to change the selection (${checked}/${total} items currently active)`)),
          editing
            ? h('button', { type: 'button', style: S.btnPrimary, disabled: busy, onClick: () => save(state) }, busy ? M('保存中…', 'Saving…') : M('保存', 'Save'))
            : null,
          editing
            ? h('button', { type: 'button', style: S.btn, disabled: busy, onClick: cancelEdit }, M('取消', 'Cancel'))
            : null,
          editing
            ? null
            : h('button', { type: 'button', style: S.btn, disabled: busy, onClick: () => { setMsg(''); setErr(''); setEditing(true) } }, M('修改', 'Edit')),
          h('button', { type: 'button', style: S.btn, disabled: busy, onClick: load }, M('刷新', 'Refresh')),
        ),
        h('label', { style: { display: 'flex', gap: '8px', alignItems: 'flex-start', cursor: editing ? 'pointer' : 'default' } },
          h('input', {
            type: 'checkbox', checked: state.deleteCloud === true, disabled: busy || !editing,
            onChange: toggleDeleteCloud, style: { marginTop: '2px', flexShrink: 0 },
          }),
          h('div', { style: { minWidth: 0 } },
            h('div', { style: { fontSize: '12px', lineHeight: '18px', color: 'var(--dsw-alias-label-primary)' } },
              M('取消勾选时顺手删掉云端副本', 'Also delete the cloud copy when unchecked')),
            h('div', { style: S.footnote },
              M(
                '默认关闭：云端保留，重新勾上即继续同步；打开后删除不可恢复。',
                'Off by default: the cloud copy is kept and re-checking resumes it; when on, deletion is permanent.',
              )),
          ),
        ),
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: '2px', maxHeight: '340px', overflowY: 'auto' } },
          state.groups.map((g) => {
            const items = g.items || []
            const excluded = items.filter((i) => i.enabled === false).length
            const expanded = open[g.id] === true
            const groupOn = g.enabled !== false
            const canExpand = items.length > 0
            return h('div', {
              style: { borderTop: '1px solid var(--dsw-alias-border-l1)', paddingTop: '6px', paddingBottom: '2px' },
            },
              // 整行可点：点一下展开明细，再点收起（不再单独放「明细」按钮）
              h('div', {
                style: { display: 'flex', alignItems: 'center', gap: '8px', cursor: canExpand ? 'pointer' : 'default' },
                onClick: canExpand ? () => setOpen({ ...open, [g.id]: !expanded }) : undefined,
              },
                canExpand
                  ? h('span', {
                    style: { flexShrink: 0, width: '10px', fontSize: '11px', color: 'var(--dsw-alias-label-tertiary)' },
                  }, expanded ? '▾' : '▸')
                  : h('span', { style: { flexShrink: 0, width: '10px' } }),
                h('input', {
                  type: 'checkbox', checked: groupOn, disabled: busy || !editing || g.required === true,
                  title: g.required === true
                    ? M('必需内容：取消会让另一台机器拉取时直接报错', 'Required: unchecking it makes the other machine fail on pull')
                    : (editing ? '' : M('只读：先点「修改」', 'Read-only: click Edit first')),
                  onClick: (e) => e.stopPropagation(),   // 勾选别当成"点行展开"
                  onChange: () => toggleGroup(g.id), style: { flexShrink: 0 },
                }),
                h('div', { style: { flex: 1, minWidth: 0, display: 'flex', alignItems: 'baseline', gap: '6px', flexWrap: 'wrap' } },
                  h('div', {
                    style: {
                      fontSize: '12.5px', lineHeight: '18px',
                      color: groupOn ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-tertiary)',
                      textDecoration: groupOn ? 'none' : 'line-through',
                    },
                  }, g.required === true ? `${g.title} · ${M('必需', 'required')}` : g.title),
                  g.desc
                    ? h('div', { style: S.footnote },
                      g.required === true
                        ? `${g.desc} · ${M('必需内容：取消后拉取会直接报错', 'Required content: unchecking makes pull fail')}`
                        : g.desc)
                    : null,
                ),
                h('span', { style: S.hint }, items.length ? `${items.length - excluded}/${items.length}` : M('无明细', 'no items')),
              ),
              expanded
                ? h('div', {
                  style: {
                    display: 'flex', flexDirection: 'column', gap: '2px',
                    marginLeft: '26px', marginTop: '4px', maxHeight: '180px', overflowY: 'auto',
                  },
                },
                  items.map((i) => h('label', {
                    style: {
                      display: 'flex', gap: '8px', alignItems: 'center', fontSize: '12px',
                      cursor: editing ? 'pointer' : 'default', opacity: groupOn ? 1 : 0.6,
                    },
                  },
                    h('input', {
                      type: 'checkbox', checked: i.enabled !== false, disabled: busy || !editing,
                      title: editing ? '' : M('只读：先点「修改」', 'Read-only: click Edit first'),
                      onChange: () => toggleItem(g.id, i.id), style: { flexShrink: 0 },
                    }),
                    h('span', { style: { wordBreak: 'break-all' } }, i.label),
                  )),
                )
                : null,
            )
          }),
        ),
        msg ? h('div', { style: S.footnote }, msg) : null,
        err ? h('div', { style: { ...S.footnote, color: 'var(--dsw-alias-state-error-primary)' } }, M(`保存失败：${err}`, `Save failed: ${err}`)) : null,
        h('div', { style: S.footnote },
          M(
            `勾选记在本机 ${state.path || 'config-sync-scope.json'}（不进仓库），推送与拉取共用。`,
            `Choices live on this machine in ${state.path || 'config-sync-scope.json'} (never committed); push and pull share them.`,
          )),
      )
    }

    /**
     * 自动同步卡：两个开关（默认关）+ 云端一致性状态。
     * 打开后：启动延迟检查一次；云端更新 → 系统确认框 → 退出后拉取（按设置自动重启）；
     * 本机领先 → 排队等 DSH 退出后推送。插件不自己退进程后干活，原因见宿主注释。
     */
    function AutoCard(props) {
      const auto = (props.data && props.data.auto) || {}
      const repo = (props.data && props.data.repo) || {}
      // 门禁由后端算（repo.pushAllowed / pullAllowed）；这里只管有没有路径、按钮要不要强调
      const pushAllowed = repo.pushAllowed === true
      const canPullNow = repo.pullAllowed === true
      // 两边都空：这次推送就是「初始化推送」，按钮换个说法，别让人以为在推一个已有仓库
      const initMode = repo.mode === 'await-init'
      const drift = auto.drift || null
      const [busy, setBusy] = react.useState('')
      const [err, setErr] = react.useState('')
      const [msg, setMsg] = react.useState('')

      const save = async (patch) => {
        setBusy('save'); setErr(''); setMsg('')
        try {
          await callSettings(patch)
          setMsg(M('已保存', 'Saved'))
          if (typeof props.onSaved === 'function') props.onSaved()
        } catch (e) { setErr(String((e && e.message) || e)) } finally { setBusy('') }
      }

      const act = async (action, extra) => {
        setBusy(action); setErr(''); setMsg('')
        try {
          const res = await fetch('/config-sync/auto', {
            method: 'POST', cache: 'no-store', credentials: 'same-origin',
            headers: jsonHeaders,
            body: JSON.stringify({ action, ...(extra || {}) }),
          })
          const text = await res.text()
          const body = text ? JSON.parse(text) : null
          if (!res.ok || !body || body.ok !== true) throw new Error((body && body.error) || `${res.status}`)
          if (action === 'check') {
            const d = body.drift
            setMsg(d
              ? M(`云端：落后 ${d.behind} 个提交，领先 ${d.ahead} 个提交`, `Cloud: ${d.behind} commit(s) behind, ${d.ahead} ahead`)
              : (body.error || M('读不到远端', 'Cannot read the remote')))
          } else {
            setMsg(body.closeRequested
              ? M('已排队：客户端马上关闭，退出后执行；拉取完成后按设置自动重开', 'Queued: the client closes now and the sync runs after exit; it relaunches per your settings when pulling finishes')
              : M('已排队：退出 DSH 后自动执行', 'Queued: runs automatically after DSH exits'))
          }
          if (typeof props.onSaved === 'function') props.onSaved()
        } catch (e) { setErr(String((e && e.message) || e)) } finally { setBusy('') }
      }

      const sw = (patchKey, stateKey, label, hintText) => {
        // 设置接口的字段名是 autoPull / autoPush，体检返回的是 auto.pull / auto.push，别拿混。
        const on = auto[stateKey] === true
        return h('div', {
          style: {
            display: 'flex', flexDirection: 'column', gap: '2px', padding: '7px 0',
            borderTop: '1px solid var(--dsw-alias-border-l1)',
          },
        },
        h('label', {
          style: {
            display: 'flex', alignItems: 'center', gap: '8px', cursor: busy ? 'default' : 'pointer',
            fontSize: '12.5px', lineHeight: '18px', color: 'var(--dsw-alias-label-primary)',
          },
        },
        h('input', {
          type: 'checkbox', checked: on, disabled: Boolean(busy),
          onChange: (e) => save({ [patchKey]: e.target.checked }),
        }),
        h('span', null, label),
        h('span', {
          style: {
            ...S.footnote, marginLeft: 'auto',
            color: on ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-label-tertiary)',
          },
        }, on ? M('已开启', 'On') : M('已关闭', 'Off')),
        ),
        h('div', { style: { ...S.footnote, paddingLeft: '22px' } }, hintText),
        )
      }

      const pending = auto.pending
      // 后台调度拿不到请求语言，宿主把原因中英各存一份，这里按当前界面语言挑
      const pendingReason = pending ? (langIsZh() ? (pending.reasonZh || pending.reason) : (pending.reasonEn || pending.reason)) : ''
      return h('div', { style: S.card },
        h('div', { style: S.cardHead },
          h('div', { style: S.cardTitle }, M('自动同步', 'Auto sync')),
          h('div', { style: { ...S.footnote, flex: 1 } }, M('默认关闭；不开就是纯手动', 'Off by default — leaving them off keeps it manual')),
        ),
        sw('autoPull', 'pull', M('启动时自动拉取', 'Pull on startup'),
          M('云端有新提交 → 弹确认 → 退出后拉取，失败自动还原上次配置',
            'New commits upstream → confirm → pull after exit; failures roll back to the previous config')),
        sw('autoPush', 'push', M('退出时自动推送', 'Push on exit'),
          M('有改动 / 新资料 / 未推送提交 → 每 2 分钟复查，退出后推送',
            'Changes / new data / unpushed commits → re-checked every 2 min, pushed after exit')),
        pending
          ? h('div', { style: { ...S.hint, color: 'var(--dsw-alias-state-warn-primary)' } },
            M(
              `已排队：退出后${pending.mode === 'pull' ? '拉取' + (pending.restart ? '并重启客户端' : '') : '推送'}`
              + `（${new Date(pending.at).toLocaleTimeString(localeNow(), { hour12: false })}`
              + `${pendingReason ? M(`，原因：${pendingReason}`, `, reason: ${pendingReason}`) : ''}）`,
              `Queued: ${pending.mode === 'pull' ? 'pull' + (pending.restart ? ' and relaunch the client' : '') : 'push'} after exit `
              + `(${new Date(pending.at).toLocaleTimeString(localeNow(), { hour12: false })}`
              + `${pendingReason ? `, reason: ${pendingReason}` : ''})`,
            ))
          : null,
        !auto.script
          ? h('div', { style: { ...S.hint, color: 'var(--dsw-alias-state-warn-primary)' } },
            M('插件与仓库里都找不到 post-exit.ps1：自动同步排不了队，重装一次插件即可（新包自带 runtime）',
              'post-exit.ps1 is missing from both the plugin and the repo, so auto sync cannot queue — reinstall the plugin (the current package ships runtime/)'))
          : null,
        h('div', { style: S.actions },
          h('button', {
            type: 'button',
            style: canPullNow ? S.btnPrimary : { ...S.btnPrimary, opacity: 0.5, cursor: 'not-allowed' },
            disabled: Boolean(busy) || !canPullNow,
            title: canPullNow ? '' : M('云端还是空的：没有内容可拉，先「初始化推送」', 'The cloud is still empty — nothing to pull, initialize push first'),
            onClick: () => act('pull-now'),
          }, M('立即拉取（会关闭 DSH）', 'Pull now (closes DSH)')),
          h('button', {
            type: 'button',
            style: pushAllowed ? S.btnPrimary : { ...S.btnPrimary, opacity: 0.5, cursor: 'not-allowed' },
            disabled: Boolean(busy) || !pushAllowed,
            title: pushAllowed ? '' : M('云端已有内容：本机还是空的，先拉取', 'The cloud already has content — pull first'),
            onClick: () => act('push-now'),
          }, initMode
            ? M('初始化推送（会关闭 DSH）', 'Initialize push (closes DSH)')
            : M('立即推送（会关闭 DSH）', 'Push now (closes DSH)')),
          pending ? h('button', { type: 'button', style: S.btn, disabled: Boolean(busy), onClick: () => act('cancel') }, M('取消排队', 'Cancel queue')) : null,
        ),
        initMode
          ? h('div', { style: { ...S.hint, color: 'var(--dsw-alias-state-warn-primary)' } },
            M(
              '本机仓库和云端仓库都还是空的：点「初始化推送」会把本机配置当作仓库的初始内容推上去（自动 git init + 写仓库骨架 + capture + 提交 + 推送）。这时没有东西可拉，拉取按钮是灰的。',
              'Both the local repo and the cloud are empty: Initialize push uploads this machine\'s config as the repo\'s initial content (git init + repo skeleton + capture + commit + push). There is nothing to pull yet, so Pull stays disabled.',
            ))
          : null,
        (!pushAllowed || !canPullNow)
          ? h('div', { style: { ...S.hint, color: 'var(--dsw-alias-state-warn-primary)' } },
            !pushAllowed && !initMode
              ? (repo.empty || repo.remoteEmpty === false
                ? M(
                  '本机仓库还是空目录、云端已有内容：先「立即拉取」把云端仓库拉下来，之后才能推送。',
                  'The local repo is empty while the cloud has content: run Pull first; push unlocks after that.',
                )
                : M(
                  '本机仓库不可用：先在「本机仓库」卡里设好路径，才能推送。',
                  'The local repo is unusable: set the path in the Local repo card before pushing.',
                ))
              : null)
          : null,
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
      // 门禁分三条：有路径就能生成还原脚本；拉取允许「真仓库 or 空目录」；推送只允许真仓库。
      // 空目录 = 新机器还没拉过，面板只放行「拉取」，推送按钮直接禁掉（后端也会再拦一次）。
      const hasRepoPath = Boolean(data && data.repo && data.repo.path)
      // 门禁统一由后端算好（repo.pullAllowed / pushAllowed），面板只做呈现：
      //   真仓库 → 推拉都行；本机空 + 云端有内容 → 只拉；本机空 + 云端也空 → 只「初始化推送」。
      const canPull = Boolean(data && data.repo && data.repo.pullAllowed === true)
      const canPush = Boolean(data && data.repo && data.repo.pushAllowed === true)
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

      // 「下载更新」= 只下载，不动插件目录（宿主 action: prepare）：
      // 下到 <DshHome>\update-staging\ 并校验 sha256。插件文件一个字节都没改，
      // 所以宿主不会重建插件树，当前这个页面不会跳走。
      const downloadUpdate = async () => {
        setUpdBusy(true)
        setUpdMsg(M('正在下载更新包（不改动插件目录，页面不会跳走）…', 'Downloading the package (the plugin directory stays untouched)…'))
        try {
          const r = await callUpdate({ action: 'prepare' })
          setUpd(r)
          const v = (r && r.prepared && r.prepared.version) || (r && r.remote && r.remote.version) || ''
          const kb = Math.round(((r && r.prepared && r.prepared.size) || 0) / 1024)
          setUpdMsg(M(`已下载 ${v}${kb ? `（${kb} KB）` : ''}，点「重启并安装」生效`, `Downloaded ${v}${kb ? ` (${kb} KB)` : ''} — click "Restart & install" to apply`))
          showToast(M(`更新包已下载（${v}），点「重启并安装」生效`, `Update package downloaded (${v}) — click "Restart & install" to apply`))
        } catch (e) {
          const msg = String((e && e.message) || e)
          setUpdMsg(M('下载失败：', 'Download failed: ') + msg)
          showToast(M('下载失败：', 'Download failed: ') + msg)
        } finally {
          setUpdBusy(false)
        }
      }

      // 「重启并安装」= 退出 DSH，退出后的脚本用已下好的本地包覆盖安装，然后自动拉起新版本。
      // 覆盖发生在 DSH 退出之后，所以不会打断你正在看的页面；全程只需这一次重启。
      const restartAndInstall = async () => {
        setUpdBusy(true)
        setUpdMsg(M('DSH 即将退出，退出后安装并自动重启…', 'DSH will exit; the package is installed afterwards and DSH relaunches…'))
        try {
          await callUpdate({ action: 'install-restart' })
          showToast(M('DSH 即将退出并自动安装、重启…', 'DSH will exit, install, and relaunch…'))
        } catch (e) {
          const msg = String((e && e.message) || e)
          setUpdMsg(M('安装失败：', 'Install failed: ') + msg)
          showToast(M('安装失败：', 'Install failed: ') + msg)
          setUpdBusy(false)
        }
      }

      // 老路径遗留（install-live 装好了但没重启）：只重启，不装东西
      const restartDsh = async () => {
        setUpdBusy(true)
        try {
          await callUpdate({ action: 'restart' })
          showToast(M('DSH 即将退出并自动重启…', 'DSH will exit and relaunch…'))
        } catch (e) {
          showToast(M('重启失败：', 'Restart failed: ') + String((e && e.message) || e))
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
          setUpdMsg(M('已保存', 'Saved'))
          setUpd(await callUpdate({ action: 'check' }))
        } catch (e) {
          setUpdErr(String((e && e.message) || e))
        } finally { setUpdBusy(false) }
      }
      const clearUpdToken = async () => {
        setUpdBusy(true); setUpdErr(''); setUpdMsg('')
        try {
          await callSettings({ clearUpdateToken: true })
          setUpdMsg(M('已清除本机保存的更新令牌', 'Cleared the update token stored on this machine'))
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
        const repo = (data && data.repo) || {}
        // 本机还没内容时后端会把 check 短路掉（不算错误），这里也先判一次，
        // 免得落到下面「lastCheckAt 有值但 lastCheckError 为空」的分支，被误显示成检查失败
        if (repo.empty || repo.phase === 'missing') {
          return repo.mode === 'await-init'
            ? { kind: 'init', text: M('本机与云端都还没有内容：初始化推送一次就能和云端比对', 'Local repo and cloud are both empty — initialize push once to compare') }
            : { kind: 'pull', text: M('本机仓库还没有内容：拉取一次就能和云端比对', 'Local repo has no content yet — pull once to compare') }
        }
        if (auto.checking || checking) return { kind: 'idle', text: M('云端检查中…', 'Checking the cloud…') }
        const drift = auto.drift
        if (drift) {
          const same = drift.behind === 0 && drift.ahead === 0
          if (same) return { kind: 'ok', text: M('云端已同步到最新，无需拉取', 'Cloud is up to date — nothing to pull') }
          const parts = []
          if (drift.behind > 0) parts.push(M(`落后 ${drift.behind} 个提交`, `${drift.behind} commit(s) behind`))
          if (drift.ahead > 0) parts.push(M(`领先 ${drift.ahead} 个提交`, `${drift.ahead} ahead`))
          return { kind: 'error', text: M(`云端与本机不一致：${parts.join(' · ')}`, `Cloud differs from this machine: ${parts.join(' · ')}`) }
        }
        if (auto.lastCheckAt) {
          return { kind: 'error', text: M(`云端检查失败：${auto.lastCheckError || '读不到远端'}`, `Cloud check failed: ${auto.lastCheckError || 'cannot read the remote'}`) }
        }
        return { kind: 'idle', text: M('云端检查中…', 'Checking the cloud…') }
      })()

      const cloudLabel = cloudLine.kind === 'ok' ? M('一致', 'In sync')
        : (cloudLine.kind === 'error' ? M('不一致', 'Out of sync')
          : (cloudLine.kind === 'pull' ? M('待拉取', 'To pull') : M('检查中', 'Checking')))

      // 插件更新卡：老版本机器进来第一眼就能看到"有新版本 x.y.z"和更新按钮；
      // 更新相关的配置（清单地址、只读令牌）也收在这张卡里，别散到「云端仓库」去。
      const updCard = (() => {
        const u = upd || {}
        const cfg = u.config || {}
        const local = (u.local && u.local.version) || '…'
        const remote = (u.remote && u.remote.version) || ''
        const has = u.hasUpdate === true
        const installed = u.installed || null
        const restartRequired = u.restartRequired === true
        // 0.3.7 主路径：包已经下到暂存目录（插件目录没动），等一次「重启并安装」
        const prepared = u.prepared || null
        const preparedReady = !!(prepared && prepared.ready)
        const preparedKb = Math.round((prepared && prepared.size ? prepared.size : 0) / 1024)
        const failed = !has && u.ok === false && !restartRequired
        const kind = (restartRequired || preparedReady || has) ? 'warn' : (failed ? 'error' : 'ok')
        const notesText = (u.remote && (langIsZh() ? (u.remote.notes || u.remote.notesEn) : (u.remote.notesEn || u.remote.notes))) || ''
        // 检查失败时把每个源的失败原因摆出来，别只给一句 aborted
        const badSources = (Array.isArray(u.sources) ? u.sources : []).filter((x) => x && x.ok === false)
        const sourceNote = badSources.length
          ? M(
            `（${badSources.map((x) => `${x.host || x.url}: ${x.error || '失败'}`).join('；')}）`,
            ` (${badSources.map((x) => `${x.host || x.url}: ${x.error || 'failed'}`).join('; ')})`,
          )
          : ''
        const label = restartRequired
          ? M('已安装，待重启', 'Installed, restart pending')
          : (preparedReady
            ? M('已下载，待安装', 'Downloaded, install pending')
            : (has
              ? M(`有新版本 ${remote}`, `New version ${remote}`)
              : (failed ? M('检查失败', 'Check failed') : (u.checkedAt ? M('已是最新', 'Up to date') : M('检查中', 'Checking')))))
        const text = restartRequired
          ? M(
            `已装好 ${(installed && installed.version) || remote}，当前进程还是 ${local}；点「重启 DSH」后生效`,
            `Installed ${(installed && installed.version) || remote}; this process still runs ${local} — click "Restart DSH" to apply`,
          )
          : (preparedReady
            ? M(
              `已下载 ${prepared.version}${preparedKb ? `（${preparedKb} KB）` : ''} · 点「重启并安装」退出后装好并自动重开`,
              `Downloaded ${prepared.version}${preparedKb ? ` (${preparedKb} KB)` : ''} — "Restart & install" exits, installs and relaunches`,
            )
            : (has
              ? M(
                `当前 ${local} → 可更新到 ${remote}${notesText ? ` · ${notesText}` : ''}`,
                `Current ${local} → can update to ${remote}${notesText ? ` · ${notesText}` : ''}`,
              )
              : (failed
                ? M(`读不到更新清单：${u.error || '未知原因'}${sourceNote}`, `Cannot read the manifest: ${u.error || 'unknown reason'}${sourceNote}`)
                : (u.checkedAt ? M(`当前 ${local}，云端没有更新的版本`, `Current ${local}; no newer version upstream`) : M('正在读云端版本清单…', 'Reading the cloud manifest…')))))
        return h('div', { style: S.card },
          h('div', { style: S.cardHead },
            h('div', { style: S.cardTitle }, M('插件更新', 'Plugin update')),
            h('span', { style: chipStyle(kind) }, label),
            h('div', { style: { flex: 1, minWidth: '8px' } }, null),
            h('div', { style: S.actions },
              restartRequired
                ? h('button', {
                  type: 'button', style: S.btnPrimary, disabled: updBusy,
                  onClick: restartDsh,
                }, updBusy ? M('重启中…', 'Restarting…') : M('重启 DSH', 'Restart DSH'))
                : (preparedReady
                  ? h('button', {
                    type: 'button', style: S.btnPrimary, disabled: updBusy,
                    onClick: restartAndInstall,
                  }, updBusy ? M('安装中…', 'Installing…') : M('重启并安装', 'Restart & install'))
                  : (has ? h('button', {
                    type: 'button', style: S.btnPrimary, disabled: updBusy || !u.remote,
                    onClick: downloadUpdate,
                  }, updBusy ? M('下载中…', 'Downloading…') : M(`下载更新 ${remote}`, `Download ${remote}`)) : null)),
              h('button', { type: 'button', style: S.btn, disabled: updBusy, onClick: checkUpdateNow }, M('检查更新', 'Check for updates')),
              updEdit
                ? null
                : h('button', { type: 'button', style: S.btn, disabled: !u.local, onClick: startEditUpd }, M('修改配置', 'Edit config')),
            ),
          ),
          h('div', { style: S.hint }, text),
          updEdit
            ? h('div', null,
              h('div', { style: S.kvRow },
                h('div', { style: S.kvKey }, M('更新清单', 'Manifest')),
                h('input', {
                  type: 'text', style: S.input, value: updManifest, spellCheck: false,
                  placeholder: cfg.manifestUrlIsDefault
                    ? M(`留空 = 用内置默认（${cfg.manifestUrl || ''}）`, `Leave empty = built-in default (${cfg.manifestUrl || ''})`)
                    : 'https://…/version.json',
                  onChange: (e) => setUpdManifest(e.target.value),
                }),
              ),
              h('div', { style: S.kvRow },
                h('div', { style: S.kvKey }, M('更新令牌', 'Token')),
                h('input', {
                  type: 'text', style: S.input, value: updToken, spellCheck: false,
                  placeholder: cfg.tokenSet
                    ? M('已配置；留空表示不改', 'Already set; leave empty to keep it')
                    : M('Gitee 私人令牌（私有库必填）', 'Gitee personal token (required for private repos)'),
                  onChange: (e) => setUpdToken(e.target.value),
                }),
              ),
              h('div', { style: S.actions },
                h('button', { type: 'button', style: S.btnPrimary, disabled: updBusy, onClick: saveUpdConfig }, updBusy ? M('保存中…', 'Saving…') : M('保存', 'Save')),
                h('button', { type: 'button', style: S.btn, disabled: updBusy, onClick: cancelEditUpd }, M('取消', 'Cancel')),
                cfg.tokenSet
                  ? h('button', { type: 'button', style: S.btn, disabled: updBusy, onClick: clearUpdToken }, M('清除已存令牌', 'Clear stored token'))
                  : null,
              ),
            )
            : h('div', null,
              h(Kv, {
                k: M('更新清单', 'Manifest'),
                v: cfg.manifestUrlIsDefault
                  ? M('内置默认（jsDelivr → GitHub raw 依次尝试）', 'Built-in default (jsDelivr → GitHub raw in order)')
                  : (cfg.manifestUrl || '…'),
              }),
              h(Kv, {
                k: M('更新源', 'Source'),
                v: u.sourceUsed
                  ? u.sourceUsed
                  : M('本次检查还没读到清单', 'No source reached yet'),
              }),
              h(Kv, {
                k: M('更新令牌', 'Token'),
                v: cfg.tokenSet
                  ? M('已配置（只存本机）', 'Set (stored on this machine only)')
                  : M('未配置（私有库会读不到清单）', 'Not set (private repos cannot be read)'),
              }),
            ),
          h('div', { style: S.footnote },
            M(
              '下载只写 update-staging 并校验 sha256，插件目录不动；「重启并安装」在退出后覆盖安装并自动重开，失败自动回滚。令牌只存本机。',
              'Download only writes to update-staging and verifies sha256; "Restart & install" overwrites after exit and relaunches, rolling back on failure. The token stays local.',
            )),
          updErr ? h('div', { style: { ...S.footnote, color: 'var(--dsw-alias-state-error-primary)' } }, M(`保存失败：${updErr}`, `Save failed: ${updErr}`)) : null,
          updMsg ? h('div', { style: { ...S.footnote, color: 'var(--dsw-alias-state-success-primary)' } }, updMsg) : null,
        )
      })()

      // 概览不再用两张 Kv 卡：压成一行指标条（5 格）+ 只在有事时才出现的「待办」。
      // 明细（Electron 版本、未解析项名字）挪到标题下的元信息行，避免正文堆字。
      const metric = (label, value, kind) => h('div', { style: S.metric },
        h('div', { style: S.metricLabel }, label),
        h('div', {
          style: {
            ...S.metricValue,
            color: kind === 'error' ? 'var(--dsw-alias-state-error-primary)'
              : (kind === 'warn' ? 'var(--dsw-alias-state-warn-primary)' : 'var(--dsw-alias-label-primary)'),
          },
        }, value),
      )
      const versionText = !data ? '…'
        : `${data.version.local || '?'} / ${data.version.contract || '?'}`
      const metrics = h('div', { style: S.strip },
        metric(M('本机 / 契约', 'App / contract'), versionText,
          data && data.version.local && data.version.contract && !data.version.match ? 'warn' : 'ok'),
        metric('bundle',
          !data ? '…' : (data.bundles.unresolved.length
            ? M(`缺 ${data.bundles.unresolved.length} / ${data.bundles.total}`, `${data.bundles.unresolved.length} missing / ${data.bundles.total}`)
            : M(`全部可解析 ${data.bundles.total}`, `all ${data.bundles.total} resolvable`)),
          data && data.bundles.unresolved.length ? 'error' : 'ok'),
        metric(M('依赖', 'Dependencies'),
          !data ? '…' : (data.deps.missing.length
            ? M(`缺 ${data.deps.missing.length} / ${data.deps.total}`, `${data.deps.missing.length} missing / ${data.deps.total}`)
            : M(`齐全 ${data.deps.total}`, `all ${data.deps.total} present`)),
          data && data.deps.missing.length ? 'error' : 'ok'),
        metric(M('备份快照', 'Snapshots'),
          !data ? '…' : (data.backup && data.backup.count ? M(`${data.backup.count} 份`, `${data.backup.count}`) : M('还没有', 'none')),
          data && data.backup && data.backup.count ? 'ok' : 'warn'),
        metric(M('上次同步', 'Last sync'), (() => {
          const local = data && data.local
          if (!local || !local.known) return M('从未', 'never')
          const when = local.lastSyncAt ? new Date(local.lastSyncAt) : null
          const base = when
            ? `${when.getMonth() + 1}/${when.getDate()} ${String(when.getHours()).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')}`
            : '?'
          return local.pending > 0 ? M(`${base}（+${local.pending}）`, `${base} (+${local.pending})`) : base
        })(), data && data.local && data.local.pending > 0 ? 'warn' : 'ok'),
      )
      const overview = h('div', { style: { gridColumn: '1 / -1', display: 'flex', flexDirection: 'column', gap: '8px' } },
        metrics,
        data && Array.isArray(data.advice) && data.advice.length
          ? h('div', { style: { ...S.card, gap: '4px', padding: '10px 13px' } },
            h('div', { style: S.cardTitle }, M('待办', 'To-do')),
            h(Advice, { items: data.advice }))
          : null,
      )

      // 仓库路径可配：默认只读展示，点「修改」才编辑；没配过就强制停在编辑态（见 RepoCard）
      const repoCard = data ? h(RepoCard, { data, onSaved: refresh }) : h('div', { style: S.card },
        h('div', { style: S.cardTitle }, M('本机仓库', 'Local repo')),
        h(Kv, { k: M('仓库路径', 'Repo path'), v: '…' }),
      )

      const actionCard = h('div', { style: S.card },
        h('div', { style: S.cardHead },
          h('div', { style: S.cardTitle }, M('生成退出后执行的脚本', 'Generate post-exit scripts')),
        ),
        h('div', { style: { ...S.kvRow, alignItems: 'center' } },
          h('div', { style: S.kvKey }, M('提交说明', 'Commit note')),
          h('input', {
            type: 'text',
            style: S.input,
            value: note,
            placeholder: M('可选：这次改了什么（生成推送脚本时写进提交信息，时间会自动附上）', 'Optional: what changed (written into the push commit message; the timestamp is added automatically)'),
            spellCheck: false,
            onChange: (e) => setNote(e.target.value),
          }),
        ),
        h('div', { style: S.footnote },
          data && data.backup && data.backup.latest
            ? M(
              `还原快照：${data.backup.latest}（共 ${data.backup.count} 份中的最新，含 ${data.backup.latestFiles} 个文件）`,
              `Restore snapshot: ${data.backup.latest} (newest of ${data.backup.count}, ${data.backup.latestFiles} files)`,
            )
            : M('还原快照：还没有任何备份快照（还原将无从下手，需拉取或指定 -FromCommit）', 'Restore snapshot: no backups yet (restore has nothing to fall back to — pull first, or pass -FromCommit)')),
        data && data.repo && !data.repo.exists && !data.repo.empty
          ? h('div', { style: { ...S.footnote, color: 'var(--dsw-alias-state-error-primary)' } },
            M('仓库路径还没配置：先在「本机仓库」卡里设好，否则脚本生成不出来。',
              'Repo path is not set: configure it in the Local repo card, otherwise scripts cannot be generated.'))
          : null,
        data && data.repo && (data.repo.phase === 'empty' || data.repo.phase === 'missing')
          ? h('div', { style: { ...S.footnote, color: 'var(--dsw-alias-state-warn-primary)' } },
            data.repo.mode === 'await-init'
              ? M('本机与云端都还没有内容：现在只生成「推送」（推送时自动初始化仓库并写骨架），拉取没有东西可拉。',
                'Both the local repo and the cloud are empty: only Push can be generated (push initializes the repo and writes the skeleton); there is nothing to pull.')
              : M('本机仓库还没有内容：现在只生成「拉取」（顺带可生成还原）。拉取会把云端仓库整个拉到这个路径，之后推送按钮才会放开。',
                'The local repo has no content yet: only Pull (plus Restore) can be generated now. Pull brings the whole cloud repo into this path; push unlocks after that.'))
          : null,
        data && data.remote && !data.remote.configured
          ? h('div', { style: { ...S.footnote, color: 'var(--dsw-alias-state-error-primary)' } },
            M('云端仓库地址未配置：推送 / 拉取不可用（还原照常可生成）。',
              'Cloud remote not set: push/pull unavailable (restore still works).'))
          : null,
        data && data.repo && data.repo.ahead > 0
          ? h('div', { style: { ...S.footnote, color: 'var(--dsw-alias-state-warn-primary)' } },
            M(`本机领先远端 ${data.repo.ahead} 个提交：改动要推送才入库；拉取会用仓库版本覆盖本机配置。`,
              `${data.repo.ahead} local commit(s) not pushed: pushing publishes them, pulling overwrites local config.`))
          : null,
        h('div', { style: S.actions },
          h('button', { type: 'button', style: S.btnPrimary, disabled: busy || (!canPull && !canPush) || noRemote, onClick: () => prepare('all', note) },
            canPush && canPull ? M('一键生成 推送 / 拉取 / 还原', 'Generate push / pull / restore')
              : (canPush ? M('一键生成 推送 / 还原', 'Generate push / restore') : M('一键生成 拉取 / 还原', 'Generate pull / restore'))),
          h('button', { type: 'button', style: S.btn, disabled: busy || !canPush || noRemote, onClick: () => prepare('push', note) }, M('只生成推送', 'Push only')),
          h('button', { type: 'button', style: S.btn, disabled: busy || !canPull || noRemote, onClick: () => prepare('pull') }, M('只生成拉取', 'Pull only')),
          h('button', { type: 'button', style: S.btn, disabled: busy || !hasRepoPath, onClick: () => prepare('restore') }, M('只生成还原', 'Restore only')),
        ),
        h(MadeNote, { made }),
        h('div', { style: S.footnote },
          M('推送 / 拉取要等 DSH 完全退出后跑：生成脚本 → 退出 → 双击。',
            'Push/pull must run after DSH fully exits: generate, quit, then double-click.')),
      )

      const remoteCard = data ? h(RemoteCard, { data, onSaved: refresh }) : null
      const autoCard = data ? h(AutoCard, { data, onSaved: refresh }) : null
      // 「还原备份」自己拿 status 里的 backup 段（快照列表），改动后让父层 refresh 重新读
      const restoreCard = data ? h(RestoreCard, { data, onSaved: refresh }) : null
      // 「同步内容」卡自己拉 /config-sync/scope，不依赖 status（status 读的是仓库与本机，跟勾选无关）
      const scopeCard = h(ScopeCard, {})
      // 「本机路径」与「问题反馈」自己持有数据（roots 文件是本机私有，feedback 在仓库里）
      const rootsCard = h(RootsCard, { onRootsSaved: refresh })
      const feedbackCard = h(FeedbackCard, {})
      // 冲突卡只在真有清单时才出现：没冲突就不占版面
      const conflictCard = data && data.conflicts && data.conflicts.exists
        ? h(ConflictCard, { data, onSaved: refresh })
        : null

      return h('div', { style: S.page },
        h('div', { style: S.pageInner },
          h('div', { style: S.cardHead },
            h('div', { style: S.pageTitle }, M('配置同步', 'Config Sync')),
            h('span', { style: { ...S.footnote, marginLeft: '6px' } }, M('本机', 'local')),
            h('span', { style: chipStyle(summary.kind) }, chipLabel(summary.kind)),
            // 云端状态也放在标题行：跟左边同一个徽标样式（绿=一致、红=不一致），
            // 自动检查：挂载即查 + 每 2 分钟复查，不需要手动点
            h('span', { style: { ...S.footnote, marginLeft: '4px' } }, M('云端', 'cloud')),
            h('span', { style: chipStyle(cloudLine.kind) }, cloudLabel),
            h('div', { style: { flex: 1, minWidth: '8px' } }, null),
            h('button', { type: 'button', style: S.btn, disabled: busy, onClick: refresh },
              busy ? M('检测中…', 'Checking…') : M('重新检测', 'Re-check')),
          ),
          // 一行元信息：版本与仓库位置。状态说明交给上面的两个徽标和下面的指标条，这里不再重复。
          h('div', { style: S.meta },
            data ? [
              h('span', { key: 'app' }, `app ${data.version.local || '?'} / Electron ${data.version.electron || '?'}`),
              data.repo && data.repo.exists
                ? [
                  h('span', { key: 's2', style: S.metaSep }, '·'),
                  h('span', { key: 'repo' }, `${data.repo.branch || '?'} @ ${(data.repo.head || '').split(' ')[0] || '?'}`),
                ]
                : null,
            ] : h('span', null, summary.text),
          ),
          h('div', { style: S.pageLead },
            M('配置在本机、仓库、云端三处流转：改完立即生效；写入与还原的脚本统一在退出客户端后执行。',
              'Configs flow between this machine, the repo and the cloud. Changes take effect at once; write and restore scripts run after the client quits.')),
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
          err ? h('div', { style: { ...S.hint, color: 'var(--dsw-alias-state-error-primary)' } }, M(`读取失败：${err}`, `Read failed: ${err}`)) : null,
          // 按内容分区：状态在上、配置居中、动作在下；每区内部网格并排（宽屏两列）
          Section(M('概览', 'Overview'), M('版本、依赖、快照一眼看完', 'Versions, dependencies and snapshots at a glance'), [overview]),
          conflictCard
            ? Section(M('同步冲突', 'Sync conflicts'), M('这些文件挡住了拉取：逐项选完保存，再点「立即拉取」', 'These files block the pull: pick per file, save, then pull'), [conflictCard])
            : null,
          Section(M('本机路径', 'Local paths'), M('每台机器只确认一次：仓库里的配置用占位符，落地时按这里的路径展开', 'Confirm once per machine: repo configs use placeholders, expanded with these paths'), [rootsCard]),
          Section(M('同步目标', 'Sync targets'), M('仓库与远端都是本机配置，改完立即生效', 'Repo and remote are local settings, applied at once'), [repoCard, remoteCard].filter(Boolean)),
          Section(M('自动化与插件更新', 'Automation & plugin update'), M('退出后自动做什么、插件自己怎么升级', 'What runs automatically after exit, and how the plugin upgrades'), [autoCard, updCard].filter(Boolean)),
          Section(M('退出后执行', 'After exit'), M('生成脚本 → 退出客户端后跑一遍；写回、推送、重开窗口都在这一步', 'Generate the script → it runs once the client quits; writing back, pushing and reopening live here'), [actionCard]),
          // 「还原备份」跟在动作卡之后：先看怎么生成脚本，再挑具体退回到哪份快照
          Section(M('还原备份', 'Restore backup'), M('点快照 → 确认差异 → 排队还原（退出客户端后执行）', 'Pick a snapshot → confirm the diff → queued restore (runs after the client quits)'), [restoreCard].filter(Boolean)),
          // 「同步内容」放在整页最下面：它是"细项配置"，看清前面的状态与动作后才会来调整
          Section(M('同步内容', 'Sync content'), M('十组内容，默认全勾；必需组锁定', 'Ten groups, all checked; required groups are locked'), [scopeCard]),
          // 反馈放在最后一区：查完状态、调完配置，才轮到「有问题要报」
          Section(M('问题反馈', 'Feedback'), M('提交即建 GitHub Issue（label feedback），跨机器共用同一份；离线先进本机队列', 'Each report becomes a GitHub Issue (label feedback), shared across machines; offline ones queue locally first'), [feedbackCard]),
        ),
      )
    }

    /**
     * 本机路径确认卡。
     * 仓库里存的配置不写死盘符：{{APP_ROOT}} / {{DSH_HOME}} / {{WORKSPACE_HOME}} / {{ROOT:<key>}}，
     * 落地前要换成这台机器的真实路径。以前只靠脚本自动探测，换机器就猜；现在探测值先填好给你改，
     * 确认过的存进 <dshHome>\config-sync-roots.json，下次不再问。
     */
    function RootsCard(props) {
      const [data, setData] = react.useState(null)
      const [busy, setBusy] = react.useState(false)
      const [err, setErr] = react.useState('')
      const [msg, setMsg] = react.useState('')
      const [editing, setEditing] = react.useState(false)
      const [draft, setDraft] = react.useState(null)
      const [newKey, setNewKey] = react.useState('')
      const [newPath, setNewPath] = react.useState('')

      const snap = (r) => ({
        appRoot: (r && r.roots && r.roots.appRoot) || '',
        dshHome: (r && r.roots && r.roots.dshHome) || '',
        workspaceHome: (r && r.roots && r.roots.workspaceHome) || '',
        custom: { ...((r && r.roots && r.roots.custom) || {}) },
      })

      const load = async () => {
        setBusy(true); setErr(''); setMsg('')
        try {
          const r = await callRoots()
          setData(r)
          if (editing) setDraft(snap(r))
        } catch (e) {
          setErr(String((e && e.message) || e))
        } finally { setBusy(false) }
      }
      react.useEffect(() => { load() }, [])

      // 只读优先：进卡先只看不改，点「修改」才解锁；没探测到任何根时强制停在编辑态
      const detected = snap(data)
      const forced = !!data && !(detected.appRoot || detected.dshHome || detected.workspaceHome)
      const isEditing = editing || forced

      const startEdit = () => { setDraft(snap(data)); setErr(''); setMsg(''); setEditing(true) }
      const cancelEdit = () => { setEditing(false); setDraft(null); setNewKey(''); setNewPath(''); setErr(''); setMsg('') }
      const setField = (k, v) => setDraft((f) => ({ ...(f || {}), [k]: v }))
      const setCustom = (k, v) => setDraft((f) => ({ ...(f || {}), custom: { ...((f && f.custom) || {}), [k]: v } }))
      const delCustom = (k) => setDraft((f) => {
        const c = { ...((f && f.custom) || {}) }
        delete c[k]
        return { ...(f || {}), custom: c }
      })
      const addCustom = () => {
        const k = newKey.trim()
        const p = newPath.trim()
        if (!k || !p) return
        setDraft((f) => ({ ...(f || {}), custom: { ...((f && f.custom) || {}), [k]: p } }))
        setNewKey(''); setNewPath('')
      }
      const save = async () => {
        if (!draft) return
        setBusy(true); setErr(''); setMsg('')
        try {
          const r = await callRoots({ roots: draft })
          setMsg([r.note, ...((r.warns || []).map((w) => `⚠ ${w}`))].filter(Boolean).join(' '))
          setEditing(false)
          setDraft(null)
          await load()
          if (props && typeof props.onRootsSaved === 'function') props.onRootsSaved()
        } catch (e) {
          setErr(String((e && e.message) || e))
        } finally { setBusy(false) }
      }

      const missing = (data && data.missing) || []
      const rootRows = [
        { key: 'appRoot', label: M('客户端安装目录', 'Client install root'), token: '{{APP_ROOT}}', ph: 'D:\\DeepSeekHarness' },
        { key: 'dshHome', label: M('.dsh 目录', '.dsh folder'), token: '{{DSH_HOME}}', ph: 'C:\\Users\\<user>\\.dsh' },
        { key: 'workspaceHome', label: M('工作区根', 'Workspace root'), token: '{{WORKSPACE_HOME}}', ph: 'D:\\DeepSeekHarness\\workspace' },
      ]
      const shown = isEditing ? draft : detected
      const customKeys = shown ? Object.keys(shown.custom || {}) : []
      const mono = { fontFamily: 'Consolas, ui-monospace, monospace', wordBreak: 'break-all' }

      const rootRow = (row) => h('div', { key: row.key, style: S.kvRow },
        h('div', { style: S.kvKey }, row.label),
        isEditing
          ? h('input', {
            type: 'text', style: S.input, value: ((shown && shown[row.key]) || ''), spellCheck: false,
            placeholder: row.ph,
            onChange: (e) => setField(row.key, e.target.value),
          })
          : h('div', { style: S.kvVal },
            h('div', { style: { ...mono, color: (shown && shown[row.key]) ? 'inherit' : 'var(--dsw-alias-text-tertiary, #888)' } },
              (shown && shown[row.key]) || M('（没探测到，点「修改」填一个）', '(not detected - click Edit and fill one in)')),
            h('div', { style: S.footnote }, row.token)),
      )


      return h('div', { style: S.card },
        h('div', { style: S.cardHead },
          h('div', { style: S.cardTitle }, M('本机路径', 'Local paths')),
          h('div', { style: { flex: 1 } }, null),
          missing.length
            ? h('span', { style: { ...S.chip, color: 'var(--dsw-alias-state-warn-primary)' } },
              M(`待确认 ${missing.length} 项`, `${missing.length} to confirm`))
            : (data
              ? h('span', { style: { ...S.chip, color: 'var(--dsw-alias-state-success-primary, #2e7d32)' } }, M('已确认', 'Confirmed'))
              : null),
          isEditing && forced
            ? h('div', { style: { ...S.hint, flex: 1 } }, M('没探测到路径，先填好再保存', 'Nothing detected - fill these in first'))
            : null,
          h('div', { style: S.actions },
            isEditing
              ? h(react.Fragment, null,
                h('button', { type: 'button', style: S.btnPrimary, disabled: busy || !draft, onClick: save },
                  busy ? M('保存中…', 'Saving…') : M('保存', 'Save')),
                forced ? null : h('button', { type: 'button', style: S.btn, disabled: busy, onClick: cancelEdit }, M('取消', 'Cancel')),
              )
              : h('button', { type: 'button', style: S.btn, disabled: !data || busy, onClick: startEdit }, M('修改', 'Edit')),
            h('button', { type: 'button', style: S.btn, disabled: busy, onClick: load },
              busy ? M('读取中…', 'Loading…') : M('重新读取', 'Reload')),
          ),
        ),
        missing.length
          ? h('div', { style: { ...S.panel, gap: '4px' } },
            h('div', { style: { ...S.hint, color: 'var(--dsw-alias-state-warn-primary)' } },
              M('上次拉取时有配置没写进去：它们引用的目录这台机器还没确认。填好下面的路径再保存，之后重新拉取一次即可。',
                'Some configs were skipped during the last pull: the folders they reference are not confirmed on this machine. Fill in the paths below, save, then pull again.')),
            missing.slice(0, 20).map((m, i) => h('div', { key: i, style: S.hint },
              `· ${m.token || '?'} — ${m.label || m.file || ''}${m.hint ? `：${m.hint}` : ''}`)))
          : null,
        shown
          ? rootRows.map(rootRow)
          : h('div', { style: S.hint }, M('读取中…', 'Loading…')),
        shown && customKeys.length
          ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
            h('div', { style: S.footnote }, M('自选目录（插件装在别处时要指定）', 'Custom folders (needed when plugins live elsewhere)')),
            customKeys.map((k) => h('div', { key: `c-${k}`, style: S.kvRow },
              h('div', { style: S.kvKey }, `ROOT:${k}`),
              isEditing
                ? h('div', { style: { display: 'flex', gap: '8px', alignItems: 'flex-start' } },
                  h('input', {
                    type: 'text', style: S.input, value: (shown.custom && shown.custom[k]) || '', spellCheck: false,
                    placeholder: M('这台机器上对应的绝对路径', 'Absolute path on this machine'),
                    onChange: (e) => setCustom(k, e.target.value),
                  }),
                  h('button', { type: 'button', style: S.btn, disabled: busy, onClick: () => delCustom(k) }, M('删除', 'Remove')),
                )
                : h('div', { style: S.kvVal },
                  h('div', { style: mono }, (shown.custom && shown.custom[k]) || M('（空）', '(empty)')),
                  h('div', { style: S.footnote }, `{{ROOT:${k}}}`)),
            )))
          : null,
        isEditing
          ? h('div', { style: S.kvRow },
            h('div', { style: S.kvKey }, M('新增目录', 'Add folder')),
            h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' } },
              h('input', {
                type: 'text', style: { ...S.input, maxWidth: '160px' }, value: newKey, spellCheck: false,
                placeholder: M('键名，如 comfyui', 'key, e.g. comfyui'),
                onChange: (e) => setNewKey(e.target.value.replace(/[^A-Za-z0-9_.-]/g, '')),
              }),
              h('input', {
                type: 'text', style: { ...S.input, maxWidth: '320px' }, value: newPath, spellCheck: false,
                placeholder: M('这台机器上的绝对路径', 'Absolute path on this machine'),
                onChange: (e) => setNewPath(e.target.value),
              }),
              h('button', { type: 'button', style: S.btn, disabled: !newKey.trim() || !newPath.trim(), onClick: addCustom }, M('添加', 'Add')),
            ))
          : null,
        data && data.detected && !isEditing
          ? h('div', { style: S.footnote },
            M(
              `自动探测：安装目录 ${data.detected.appRoot || '（没找到）'}；.dsh ${data.detected.dshHome || '?'}；工作区根 ${data.detected.workspaceHome || '（从工作区登记表推不出来）'}`,
              `Detected: app root ${data.detected.appRoot || '(not found)'}; .dsh ${data.detected.dshHome || '?'}; workspace root ${data.detected.workspaceHome || '(could not infer from the workspace registry)'}`,
            ))
          : null,
        data && data.file
          ? h('div', { style: S.footnote }, M(`存在：${data.file}（本机私有，不进仓库）`, `Stored at: ${data.file} (local only, never committed)`))
          : null,
        msg ? h('div', { style: S.hint }, msg) : null,
        err ? h('div', { style: { ...S.hint, color: 'var(--dsw-alias-state-error-primary)' } }, M(`失败：${err}`, `Failed: ${err}`)) : null,
      )
    }

    /**
     * 问题反馈卡：写进仓库的 feedback\ 目录并推到云端，另一台机器拉取后同样能看到。
     * 推送失败不算失败：文件已经留在本机仓库里，下次推送会一起上去。
     */
    /** 问题反馈：提交即建 GitHub Issue（label feedback），列表读 Issue，点「已解决」就关单。 */
    function FeedbackCard() {
      const empty = { connected: false, repo: '', label: 'feedback', items: [], counts: { open: 0, closed: 0, total: 0 }, outbox: [], error: '', ghFile: '', version: '', owner: '', login: '', canClose: false, readAnon: false, note: '' }
      const [st, setSt] = react.useState(empty)
      const [title, setTitle] = react.useState('')
      const [text, setText] = react.useState('')
      const [token, setToken] = react.useState('')
      const [askToken, setAskToken] = react.useState(false)
      const [busy, setBusy] = react.useState(false)
      const [msg, setMsg] = react.useState('')
      const [err, setErr] = react.useState('')
      // 筛选：状态走本地过滤（一次拉全量、计数才准），关键词也本地过，输入即筛，不打接口
      const [filter, setFilter] = react.useState('open')
      const [kw, setKw] = react.useState('')

      const load = async () => {
        try {
          const r = await callFeedback(null)
          setSt({ ...empty, ...r })
          setErr(String(r.error || ''))
        } catch (e) {
          setErr(String((e && e.message) || e))
        }
      }
      react.useEffect(() => { load() }, [])

      const submit = async () => {
        setBusy(true); setErr(''); setMsg('')
        try {
          const r = await callFeedback({ title, body: text })
          if (r && r.needToken && r.fallbackUrl) {
            // 没有令牌：把这单交给浏览器——预填好标题/正文/环境块，登录状态下点一下就建好了
            try { window.open(r.fallbackUrl, '_blank', 'noopener') } catch { }
            setMsg(M('没有令牌，已打开浏览器里的新建 issue 页面（标题和正文都填好了），点一下提交即可。', 'No token: opened the prefilled new-issue page in the browser - press submit there.'))
          } else if (r && r.number) {
            setMsg(M(`已建 Issue #${r.number}，列表里能看到，网页上也点得开。`, `Issue #${r.number} created; it shows in the list and opens in the browser.`))
            setTitle('')
            setText('')
          } else {
            setMsg(M(`没连上 GitHub（${(r && r.error) || '网络不通'}），已存进本机待发队列（${r ? r.remaining : 0} 条），联网后点「补发」。`,
              `Could not reach GitHub (${(r && r.error) || 'network'}). Saved to the local queue (${r ? r.remaining : 0} item(s)); press Flush when online.`))
          }
          await load()
        } catch (e) {
          setErr(String((e && e.message) || e))
        } finally { setBusy(false) }
      }

      const saveToken = async () => {
        setBusy(true); setErr(''); setMsg('')
        try {
          await callFeedback({ token }, { query: { action: 'token' } })
          setToken('')
          setAskToken(false)
          setMsg(M('令牌已存到本机（不进仓库），连接正常。', 'Token saved locally (never committed); connection works.'))
          await load()
        } catch (e) {
          setErr(String((e && e.message) || e))
        } finally { setBusy(false) }
      }

      const flush = async () => {
        setBusy(true); setErr(''); setMsg('')
        try {
          const r = await callFeedback({}, { query: { action: 'flush' } })
          setMsg(M(`补发 ${(r.sent || []).length} 条，还剩 ${r.remaining || 0} 条。`, `Flushed ${(r.sent || []).length}, ${r.remaining || 0} left.`))
          await load()
        } catch (e) {
          setErr(String((e && e.message) || e))
        } finally { setBusy(false) }
      }

      const setState = async (number, next) => {
        setBusy(true); setErr('')
        try {
          await callFeedback({ state: next }, { query: { number }, method: 'PATCH' })
          await load()
        } catch (e) {
          setErr(String((e && e.message) || e))
        } finally { setBusy(false) }
      }

      const fmt = (s) => {
        if (!s) return '?'
        try { return new Date(s).toLocaleString(localeNow(), { hour12: false }) } catch { return s }
      }

      const dot = (color) => h('span', {
        style: { display: 'inline-block', width: '7px', height: '7px', borderRadius: '50%', background: color, marginRight: '6px', verticalAlign: 'middle' },
      }, null)

      const open = st.counts.open
      const closed = st.counts.closed
      const total = st.counts.total || st.items.length

      // 关键词：编号、标题、作者、正文都算（正文是 Issue 的 body，含环境块）
      const shown = st.items.filter((it) => {
        if (filter === 'open' && it.state !== 'open') return false
        if (filter === 'closed' && it.state !== 'closed') return false
        const q = kw.trim().toLowerCase()
        if (!q) return true
        const hay = `${it.number} ${it.title || ''} ${it.user || ''} ${it.body || ''}`.toLowerCase()
        return hay.includes(q)
      })

      const seg = (key, label) => h('button', {
        key,
        type: 'button',
        style: filter === key ? S.btnPrimary : S.btn,
        onClick: () => setFilter(key),
      }, label)

      return h('div', { style: S.card },
        h('div', { style: S.cardHead },
          h('div', { style: S.cardTitle }, M('问题反馈', 'Feedback')),
          h('div', { style: { flex: 1 } }, null),
          h('span', { style: S.chip }, M(`${open} 待处理 / 共 ${total}`, `${open} open / ${total} total`)),
          h('button', { type: 'button', style: S.btn, disabled: busy, onClick: load }, M('刷新', 'Refresh')),
        ),
        h('div', { style: S.kvRow },
          h('div', { style: S.kvKey }, M('连接', 'Connect')),
          h('div', { style: S.kvVal },
            h('div', null,
              dot(st.canClose ? 'var(--dsw-alias-state-success-primary, #35a854)' : (st.items.length ? 'var(--dsw-alias-state-warning-primary, #d97706)' : 'var(--dsw-alias-state-error-primary)')),
              st.canClose
                ? M(`GitHub ${st.repo} · 已用 ${st.login} 登录（可提交、可关单）`, `GitHub ${st.repo} · signed in as ${st.login} (can submit and close)`)
                : st.connected
                  ? M(`GitHub ${st.repo} · 令牌属于 ${st.login || '?'}，不是仓库所有者，只能读和提交`, `GitHub ${st.repo} · token belongs to ${st.login || '?'}, not the repo owner: read and submit only`)
                  : st.readAnon
                    ? M(`GitHub ${st.repo} · 匿名读取（公开仓库，不需要令牌；提交走浏览器）`, `GitHub ${st.repo} · anonymous read (public repo, no token; submit via browser)`)
                    : M('还没连上 GitHub（令牌没取到或网络不通）', 'Not connected to GitHub (no token or no network)'),
            ),
            h('div', { style: S.footnote },
              st.note || (st.ghFile ? M(`令牌/仓库记在 ${st.ghFile}（本机私有，不进仓库）`, `Token and repo live in ${st.ghFile} (local only, never committed)`) : null)),
          ),
        ),
        (askToken || !st.connected)
          ? h('div', { style: S.kvRow },
            h('div', { style: S.kvKey }, M('令牌', 'Token')),
            h('div', { style: { ...S.kvVal, display: 'flex', gap: '8px' } },
              h('input', {
                type: 'password', style: S.input, value: token, spellCheck: false, autoComplete: 'off',
                placeholder: M('粘贴 GitHub 令牌（只需一次；留空则自动读本机 git 凭据）', 'Paste a GitHub token (once); leave empty to reuse the local git credential'),
                onChange: (e) => setToken(e.target.value),
              }),
              h('button', { type: 'button', style: S.btnPrimary, disabled: busy || !token.trim(), onClick: saveToken }, M('保存', 'Save')),
            ),
          )
          : null,
        h('div', { style: S.kvRow },
          h('div', { style: S.kvKey }, M('标题', 'Title')),
          h('input', {
            type: 'text', style: S.input, value: title, spellCheck: false,
            placeholder: M('一句话说清是什么问题（例如：拉取后桌宠配置没跟着过来）', 'One line about the problem (e.g. pet config did not come over after a pull)'),
            onChange: (e) => setTitle(e.target.value),
          }),
        ),
        h('div', { style: S.kvRow },
          h('div', { style: S.kvKey }, M('详情', 'Details')),
          h('textarea', {
            style: { ...S.input, minHeight: '64px', resize: 'vertical', fontFamily: 'inherit' },
            value: text, spellCheck: false, rows: 3,
            placeholder: M('现象、期望、怎么复现（版本、机器、时间会自动附在末尾）', 'What happened, what you expected, how to reproduce (version, machine and time are appended automatically)'),
            onChange: (e) => setText(e.target.value),
          }),
        ),
        h('div', { style: S.actions },
          h('button', { type: 'button', style: S.btnPrimary, disabled: busy || !title.trim(), onClick: submit },
            busy ? M('提交中…', 'Submitting…') : M('提交到 GitHub', 'Submit to GitHub')),
          h('button', { type: 'button', style: S.btn, disabled: busy, onClick: () => setAskToken(!askToken) },
            M(askToken ? '收起令牌' : '换令牌', askToken ? 'Hide token' : 'Change token')),
          st.outbox.length
            ? h('button', { type: 'button', style: S.btn, disabled: busy, onClick: flush }, M(`补发 ${st.outbox.length} 条`, `Flush ${st.outbox.length}`))
            : null,
          h('div', { style: S.footnote }, M('反馈是 GitHub Issue，另一台机器打开面板看到的是同一份', 'Each report is a GitHub Issue; the other machine sees the same list')),
        ),
        msg ? h('div', { style: S.hint }, msg) : null,
        err ? h('div', { style: { ...S.hint, color: 'var(--dsw-alias-state-error-primary)' } }, M(`失败：${err}`, `Failed: ${err}`)) : null,
        st.outbox.length
          ? h('div', { style: S.hint }, M(`本机还有 ${st.outbox.length} 条没发出去（网络恢复后点「补发」）`, `${st.outbox.length} item(s) still queued locally (press Flush when the network is back)`))
          : null,
        st.items.length
          ? h('div', { style: { ...S.panel, gap: '8px' } },
            h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' } },
              seg('open', M(`未解决 ${open}`, `Open ${open}`)),
              seg('closed', M(`已解决 ${closed}`, `Closed ${closed}`)),
              seg('all', M(`全部 ${total}`, `All ${total}`)),
              h('div', { style: { flex: 1 } }, null),
              h('input', {
                type: 'text', style: { ...S.input, maxWidth: '260px' }, value: kw, spellCheck: false,
                placeholder: M('搜索：编号 / 标题 / 内容', 'Search: number / title / body'),
                onChange: (e) => setKw(e.target.value),
              }),
              kw ? h('button', { type: 'button', style: S.btn, onClick: () => setKw('') }, M('清空', 'Clear')) : null,
            ),
            h('div', { style: S.footnote },
              M(`显示 ${shown.length} / ${filter === 'all' ? total : (filter === 'open' ? open : closed)} 条${kw ? `（关键词「${kw}」）` : ''}；列表最多读 50 条，更早的请点 GitHub 页`,
                `${shown.length} of ${filter === 'all' ? total : (filter === 'open' ? open : closed)} shown${kw ? ` (keyword "${kw}")` : ''}; at most 50 read, older ones on the GitHub page`)),
            shown.length
              ? shown.slice(0, 20).map((it) => h('div', { key: it.number, style: S.kvRow },
                h('div', { style: { ...S.kvKey, width: '42px', minWidth: '42px' } }, `#${it.number}`),
                h('div', { style: S.kvVal },
                  h('a', {
                    href: it.url, target: '_blank', rel: 'noreferrer',
                    style: { color: 'inherit', textDecoration: 'none', cursor: 'pointer' },
                  }, it.title || '(无标题)'),
                  h('div', { style: S.footnote },
                    `${it.state} · ${fmt(it.createdAt)}${it.user ? ` · ${it.user}` : ''}${it.comments ? ` · ${it.comments} 条评论` : ''}`)),
                h('button', {
                  type: 'button',
                  style: S.btn,
                  disabled: busy || !st.canClose,
                  title: st.canClose ? '' : M('只有仓库所有者能关单', 'Only the repo owner can close issues'),
                  onClick: () => setState(it.number, it.state === 'closed' ? 'open' : 'closed'),
                }, !st.canClose ? M('仅所有者', 'Owner only') : (it.state === 'closed' ? M('重开', 'Reopen') : M('已解决', 'Resolve'))),
              ))
              : h('div', { style: S.footnote }, kw ? M('没有匹配的反馈，换个关键词或清空搜索。', 'Nothing matches; try another keyword or clear the search.') : M('这个状态下没有反馈。', 'No feedback in this state.')),
          )
          : h('div', { style: S.footnote }, M('还没有反馈记录。', 'No feedback yet.')),
        h('div', { style: S.footnote },
          M('读列表不需要令牌（公开仓库，匿名 60 次/小时）；提交和关单要令牌，且只有仓库所有者能关单。没有令牌时提交会打开浏览器里预填好的新建 issue 页面。',
            'Reading needs no token (public repo, 60 anonymous requests/hour); submitting and closing do, and only the repo owner can close. Without a token, submitting opens a prefilled new-issue page in the browser.')),
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
          h('div', { style: S.title }, M('配置同步', 'Config Sync')),
          h('div', { style: S.sub }, busy ? M('检测中…', 'Checking…') : summary.text),
          data ? h('div', { style: S.sub }, `app ${data.version.local || '?'} / ${M('契约', 'contract')} ${data.version.contract || '?'}`) : null,
        ),
        h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', flexShrink: 0 } },
          h('span', { style: chipStyle(summary.kind) }, chipLabel(summary.kind)),
          h('button', { type: 'button', style: S.btn, onClick: () => setOpen((v) => !v) }, open ? M('收起', 'Collapse') : M('查看', 'View')),
          h('button', { type: 'button', style: S.btn, disabled: busy, onClick: refresh }, M('刷新', 'Refresh')),
        ),
      )

      if (!open) {
        return h('div', { style: S.row }, head,
          err ? h('div', { style: { ...S.hint, color: 'var(--dsw-alias-state-error-primary)' } }, M(`读取失败：${err}`, `Read failed: ${err}`)) : null)
      }

      return h('div', { style: S.row },
        head,
        err ? h('div', { style: { ...S.hint, color: 'var(--dsw-alias-state-error-primary)' } }, M(`读取失败：${err}`, `Read failed: ${err}`)) : null,
        h('div', { style: S.panel },
          data ? h(Kv, {
            k: M('仓库', 'Repo'),
            v: data.repo.exists
              ? `${data.repo.path} (${data.repo.branch || '?'} @ ${data.repo.head || '?'})`
              : M('还没配置（请到面板里设置）', 'Not configured (set it in the panel)'),
          }) : null,
          data ? h(Kv, {
            k: M('远端', 'Remote'),
            v: data.repo.behind === null
              ? M('读不到', 'Unavailable')
              : M(
                `落后 ${data.repo.behind} · 领先 ${data.repo.ahead} · 未提交 ${data.repo.dirty}`,
                `behind ${data.repo.behind} · ahead ${data.repo.ahead} · dirty ${data.repo.dirty}`,
              ),
          }) : null,
          data ? h(Kv, {
            k: 'bundle',
            v: M(
              `${data.bundles.total} 项，解析不到 ${data.bundles.unresolved.length} 项` + (data.bundles.unresolved.length ? `：${data.bundles.unresolved.join(', ')}` : ''),
              `${data.bundles.total} total, ${data.bundles.unresolved.length} unresolved` + (data.bundles.unresolved.length ? `: ${data.bundles.unresolved.join(', ')}` : ''),
            ),
          }) : null,
          data && data.remote ? h(Kv, { k: M('远端地址', 'Remote URL'), v: data.remote.url || M('（未配置）', '(not set)') }) : null,
          data && data.remote ? h(Kv, { k: M('SSH 私钥', 'SSH key'), v: data.remote.sshKey || M('（未配置）', '(not set)') }) : null,
          data ? h(Advice, { items: data.advice }) : null,
          h('div', { style: S.actions },
            h('button', { type: 'button', style: S.btnPrimary, disabled: busy || !data || !data.repo.exists, onClick: () => prepare('all') }, M('一键生成 推送 / 拉取 / 还原', 'Generate push / pull / restore')),
            h('button', { type: 'button', style: S.btn, disabled: busy || !data || !data.repo.exists, onClick: () => prepare('push') }, M('只生成推送', 'Push only')),
            h('button', { type: 'button', style: S.btn, disabled: busy || !data || !data.repo.exists, onClick: () => prepare('pull') }, M('只生成拉取', 'Pull only')),
            h('button', { type: 'button', style: S.btn, disabled: busy || !data || !data.repo.exists, onClick: () => prepare('restore') }, M('只生成还原', 'Restore only')),
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
      const who = last.mode === 'pull' ? M('自动拉取', 'Auto pull') : M('自动推送', 'Auto push')
      return last.ok
        ? M(`${who}完成：${last.message}`, `${who} finished: ${last.message}`)
        : M(
          `${who}失败：${last.message}${last.log ? '（日志：' + last.log + '）' : ''}`,
          `${who} failed: ${last.message}${last.log ? ' (log: ' + last.log + ')' : ''}`,
        )
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
        try { console.warn('[dsh-config-sync] startup toast failed:', error) } catch { }
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
            label: () => M('配置同步', 'Config Sync'),
            locale: 'config-sync',
          }, SidebarIcon)
          return () => {
            if (typeof offRow === 'function') offRow()
            if (typeof offPanel === 'function') offPanel()
          }
        }))
      } catch (error) {
        // 老版本宿主没有 sidebar.panellist 就静默降级到设置页；但要把原因留在控制台
        try { console.warn('[dsh-config-sync] sidebar entry registration failed:', error) } catch { }
      }

      try {
        ctx.slots.inject('settings.general.item', () => ctx.slots.register({
          name: 'settings.general.item',
          id: 'config-sync',
          order: 20,
        }, ConfigSyncRow))
      } catch (error) {
        try { console.warn('[dsh-config-sync] settings entry registration failed:', error) } catch { }
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