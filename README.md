# dsh-config-sync

中文 | [English](README.en.md)

DSH 插件：左侧栏加一行「配置同步」，点开是整页体检面板；「设置 → 通用」另留一行摘要。它**只做体检 + 备命令**，同步动作不在应用内跑。

![panel](docs/panel.png)

面板与宿主返回的文案是双语的：跟随客户端语言（`zh-*` → 中文，其余 → 英文），没有面板内切换开关。只有生成的 `.cmd` 脚本内部文字保持中文（它是本机命令行工具）。

## 安装

插件本体是一份标准 DSH bundle，装到当前 profile 即可：

```sh
# 从本仓库的 release 包安装（无需构建，包内已含宿主/前端/runtime 脚本）
dsh plugin add https://raw.githubusercontent.com/QcWyGm/dsh-config-sync/main/releases/dsh-config-sync-0.3.1.tgz
```

或在 DSH 面板「插件 → 插件市场」里搜索 `dsh-config-sync`（本仓库已将 `dsh-plugin`、`deepseek-harness` 写进包关键词，并声明了 `dsh.bundle.patch`）。

装好后需要指向你自己的配置仓库（默认自动探测常见路径），并在「插件更新」卡里按需填写清单地址与令牌——**本仓库是公开的，从 GitHub 分发时不填令牌也能更新**。

## 内容

| 路径 | 说明 |
|---|---|
| `index.js` | 宿主半身：`/config-sync/status`、`/prepare`、`/settings`、`/auto`、`/update` 路由 |
| `client.js` | 浏览器半身：侧栏行、面板、设置摘要行 |
| `cordis.patch.yml` | bundle 补丁层（`id: config-sync`） |
| `runtime/` | 退出后执行的六个 PowerShell 脚本 + `fix-session-cwd.mjs`，随包发布，装好即可生成脚本，不必先克隆配置仓库 |
| `tools/` | 自检脚本 `selftest.mjs`、前端结构检查 `clientcheck.mjs` |
| `version.json` / `releases/` | 自更新清单与安装包 |

## 自更新

面板「插件更新」卡读取 `version.json`（默认 `https://raw.githubusercontent.com/QcWyGm/dsh-config-sync/main/version.json`，30 分钟缓存），发现更高版本后：退出 DSH → 下载 tgz → 校验 sha256 → 备份旧目录到 `~\.dsh\backups\plugin-<旧版本>-<时间>` → 覆盖 → 重启。

## 作为插件市场的索引源

本仓库根目录的 `market-index.json` 就是一份可直接使用的 DSH 市场索引（`format: 1`，`source.type: git` + 40 位 commit，安装时从本仓库取包，无需构建）。索引地址：

```
https://raw.githubusercontent.com/QcWyGm/dsh-config-sync/main/market-index.json
```

在 DSH 里「插件 → 插件市场 / 发现 → 管理索引源 → 添加索引源」填入上面的 URL，即可在列表里看到「配置同步」，点安装即按该 commit 拉取本仓库。

升级流程：改代码 → 打包 `releases/dsh-config-sync-<版本>.tgz` → 更新 `version.json` 的 `version/sha256` → 把 `market-index.json` 里那条 `versions` 的 `version` 与 `commit` 换成新提交 → 推送。索引只引用 commit，所以旧版本也能随时装回。

`capture` 要读 `cordis.patch.yml`，DSH 运行时这个文件正被应用持有，抓到的是半截状态；`apply` 写完以后，DSH 退出时又会回写覆盖。所以边界固定为：判断该跑什么、把命令写好，退出 DSH 后双击跑。

同步机制、目录结构、换机与排障的完整说明在配置仓库根 `README.md`，本文只讲插件自身。

## 入口挂在哪

| 入口 | slot | 说明 |
|---|---|---|
| 左侧栏一行 | `sidebar.panellist`（`id: config-sync`） | 与「插件 / 自动任务 / 技能市场 / 记忆系统」同一列，图标双向箭头 |
| 点开的面板 | `main`（`key: config-sync`） | 宿主按 id/key 绑定两者，两条 register 必须在**嵌套 inject** 里成对完成（只 inject `main` 就向 `sidebar.panellist` register 无效） |
| 设置摘要行 | `settings.general.item` | 一行四态 chip + 展开（仓库、远端、私钥） |

侧栏行的点击切换由宿主处理，契约抄自 `dshmarket` / `dsh-mnemon`。

## 一键生成的三份脚本

「一键生成 推送 / 拉取 / 还原」可一次写出三份，也可只生成其中一份。文件名、按钮、脚本内文字全中文。

| 脚本 | 干什么 | 安全阀 |
|---|---|---|
| `同步-推送.cmd` | 退出后 capture 本机配置并推到远端 | 先查 `DeepSeek Harness.exe` 是否还在跑 |
| `同步-拉取.cmd` | 退出后从远端拉取并 apply 到本机 | 同上；**先写明"本机领先几个提交 / 几项未提交"，要输 `y`** —— 它会用仓库版本覆盖本机配置 |
| `同步-还原.cmd` | 退出后把 profile 退回某次 apply 前的快照 | 同上；**先 `-DryRun` 打印计划，按 `y` 才真写** |

三份都写死本机参数（仓库、AppRoot、`.dsh` 位置），双击即可。拉取与还原支持 `--yes` 免确认（给自动化/远控用）；没有确认时明说「没有收到确认（y），已退出：本机什么都没改」，不静默退出。

- **提交说明**：生成推送脚本时可填，以 `-Message "..."` 传进 `sync.ps1`，**时间由脚本执行那一刻自动追加**；留空用默认 `sync: capture <时间> @ <机器名>`。
- **还原快照怎么选**：生成时已有快照就明写进 `-BackupDir`（并显示时间、共几份、含多少文件）；还没有（新机器刚装插件）则**不写**，交给 `restore.ps1` 运行时取最新一份——否则脚本会咬住"生成那一刻没有快照"。运行时若最新那份是空快照，会自动往前找第一份含 `package.json` 的并提示。

## 本机仓库 / 云端仓库（都可配，默认只读，没配就强制配）

- 仓库判据：目录里同时有 `apply.ps1` 与 `profile\package.json`（再有 `sync.ps1` 才算能推拉）。
- 优先级：本机设置文件 → 插件配置 `repoPath` → `DSH_CONFIG_REPO` → 常见位置自动探测。
- 云端：远端地址优先读 `git remote get-url origin`，没有才回落设置文件；SSH 私钥只存**路径**、可留空交给 `.ssh\config`。
- **没配过 = 强制设置**：卡片停在编辑态、不给「取消」，顶部红字、三份生成按钮全禁用，宿主 `prepare` 也 400（远端缺失时 `还原` 不受影响）。
- 保存顺序：校验（地址只接受 `git@host:path` / `ssh://` / `https://`；私钥填了就必须存在）→ 写设置 → 有 `origin` 就 `set-url`、没有就 `remote add` → git 失败回滚设置文件，不留"面板显示 A、git 用 B"的错位。
- 设置里的路径后来失效：`status` 给 `repo.exists=false` 且来源仍是 `settings`，面板回到"必须重设"，**不会**悄悄换成探测到的另一个仓库。
- 落在 `~\.dsh\dsh-config-sync.json`，跟本机走、不进仓库。

## 面板显示什么

**标题行（一行看全）**：`配置同步　[一致/待推送/有问题]　一句话结论　　[一致/不一致]　云端状态说明`。两个徽标同一套配色——绿=一致、橙=待推送、红=有问题；左侧只说本机（配置齐不齐、依赖缺不缺、有无未提交/未推送），云端那条**全自动**：打开面板查一次、之后每 2 分钟复查，**没有手动按钮**。

**「待推送」不只看 git**：`git status` 干净时，新会话/新资料可能还躺在 `~\.dsh` 里没 capture。所以 `sync.ps1` 在 push / pull 成功后写 `~\.dsh\config-sync-state.json`（`lastSyncAt`/`mode`/`head`），`status` 多返回一段 `local`：stat `sessions`、`skills`、`.agent-presets`、`mnemon`、profile 五文件、登记的工作区目录，**mtime 晚于 `lastSyncAt`** 的计入 `local.pending`，徽标转橙「待推送」，文案"本机有 N 个文件在上次同步后有更新"。只看 mtime、不读内容、不跑 capture；上限 20000 文件 / 1.5 秒；复制或另存也会算进来，误报只是多一句提示。

正文：仓库路径与来源、分支与 HEAD、落后/领先/未提交、**本机数据（上次同步时间 + 之后更新了几个文件）**；版本契约（本机 app 版本 ↔ 仓库 `host-contract.json`）；Electron 版本（`<AppRoot>\version`，注意不是 app 版本）；bundle 总数与解析不到的项；依赖该装/缺多少；最新快照份数与文件数；远端地址与私钥来源；最后收敛成几条待办建议。

**上次自动同步的结果**：`~\.dsh\auto-sync-result.json` 若是 15 分钟内的，**客户端一启动就弹**一条 5 秒浮层（`apply()` 里挂载后 1.5 秒查一次 `status`，自己 append 到 body、面板没打开也能显示；成功/失败 + 原因 + 失败带日志路径）。面板里那条提示与它共用一个判据和一个 localStorage 键，同一份结果只弹一次。

## 自动同步 / 自动推送（两个开关，默认关）

| 开关 | 行为 |
|---|---|
| 启动时自动拉取 | 启动 8 秒后只读 `git fetch` 比对；落后 > 0 → 系统确认框（是/否）→ 选"是"**当场把客户端整族退出**（实测 5 秒内进程归零）→ 可见窗口跑拉取 → 拉完自动重启 |
| 退出时自动推送 | **三个来源任意命中就排队**：本地领先提交、未提交改动、本机资料比上次同步新（新会话等）。启动后每 2 分钟复查，已排队不重复拉起；等 DSH 完全退出后才 push，推完自动重启 |

- 动手都由插件拉起 `runtime\post-exit.ps1 -Phase wait`（**隐藏**进程）盯客户端退出；真退了才由它用 `-WindowStyle Normal` 起 `-Phase run` 的**可见**窗口干活，标题「DSH 配置同步 · 拉取/推送」。**排队期间不弹窗** —— 否则从开机到关机会一直挂着一个挡视线的空窗口。
- **拉起方式踩过的坑**：`detached: true` 起 powershell 在 Windows 上会当场退出（日志一行都没有），改成短命 powershell 用 `Start-Process -PassThru` 起独立进程；`spawn()` 失败是异步的（只在 `error` 事件报），所以要等 launcher 退出码、拿不到 pid 就如实失败，并写 `~\.dsh\logs\auto-sync-launch.log`。
- **等退出不能只看 pid**：插件跑在子进程里，`process.pid` 不是客户端主进程 —— 按 pid 判断会出现"客户端在跑、等待进程以为它退了"，当场在运行期拉取。改成按进程名；另外「点了关闭但进程赖着不走」（实测 7 个进程 `hwnd=0` 存活 1 分钟以上）也认：活过 60 秒、无可见窗口持续 16 秒 → 结束残留进程再同步（`auto-sync-wait.log` 有记录）。
- **一个时刻只跑一次同步**：`~\.dsh\auto-sync.lock` 记 pid。启动首检排的 push 与用户确认的 pull 曾同时开工、并行改配置；现在后来者读锁：同种复用，不同种（手动优先）先结束那个还没开工的等待进程再改排。
- **退出客户端用整族结束**：`taskkill /PID <主进程>`（不带 `/F`）对 Electron 主进程无效（`This process can only be terminated forcefully`），改为 `/IM "DeepSeek Harness.exe"`，3.5 秒后再补 `/F`。
- **重启前清环境变量**：从插件链路起的客户端连续 3 次"起来就退"，干净 shell 跑同一个脚本却成功 —— 差在继承的 `ELECTRON_RUN_AS_NODE`（还有 `ELECTRON_NO_ATTACH_CONSOLE`/`NODE_OPTIONS`/`NODE_PATH`），清掉后一次成功；启动后还数进程、没活等 8 秒重试，最多 3 次。
- **拉取失败自动回滚**：`git reset --hard` 回原提交 → 用这次 apply 写盘前刚建的 `backups\config-<时间戳>` 跑 `restore.ps1` → 回滚成不成功都写日志，不完整会提示「请打开日志核对」。
- **拉取/推送都重启**：成功用新配置，失败用回滚后的原配置。重启成功后会刷新 `config-sync-state.json` 的 `lastSyncAt`，避免刚 apply 写过的文件被下一次首检误判成"待推送"。
- 退出码：`0` 完成、`2` 等待超时、`3` 缺 sync.ps1、`4` 重启失败、`5` 同步失败（pull 已尝试回滚）。
- 「取消排队」只撤插件里的排队记录；已拉起的外部等待进程仍会等你退出，要停就手动结束它（`auto-sync-wait.log` / launch 日志有 pid）。

## 插件更新（0.2.0 起）

面板的「插件更新」卡在「版本契约」卡后面，显示本地版本、云端版本和一行状态：

| 状态 | 含义 |
|---|---|
| 绿色「已是最新」 | 本地版本 ≥ 清单版本 |
| 橙色「有新版本 x.y.z」 | 清单版本更大，附一句新版本说明和「更新到 x.y.z」按钮 |
| 红色「检查失败」 | 清单读不到（网络 / 仓库没建 / 404），附「检查更新」可强制重查 |

- 清单与安装包都在配置仓库自己的 `plugin/dsh-config-sync/` 下：清单 `version.json`、安装包 `releases/dsh-config-sync-<版本>.tgz`，只读几百字节，不拉整包；服务端缓存 30 分钟，挂载时查一次、之后每 30 分钟复查。
- **私有库要填令牌**：`dsh-config` 是私有库，匿名 raw 一律 403。更新相关的配置都集中在「插件更新」卡里（点「修改配置」进入编辑态）：「更新清单」留空即用内置默认地址，也可指向自建清单；「更新令牌」填 Gitee 私人令牌后，清单和安装包都改走 API raw 端点（`/api/v5/repos/qcwygm/dsh-config/raw/<path>?ref=main&access_token=…`），分支用 `ref` 传、不能写进路径。「云端仓库」卡只保留仓库地址与 SSH 私钥，不再掺更新相关的东西。令牌只存本机设置文件，不进仓库；留空保存表示"不改动已存令牌"，另给「清除已存令牌」按钮。
- 点「更新到 x.y.z」会先弹系统确认框（Yes 才继续），确认后**退出 DSH** → 后台脚本下载 tgz、比 sha256、备份旧目录到 `~\.dsh\backups\plugin-<旧版本>-<时间>`、覆盖安装、重启客户端。任一步失败退出码 7，版本保持不变。
- 设置项 `updateManifestUrl` 可以把清单指到自建地址（留空即用内置地址），相对路径的 `tgz` 会相对**实际读到的那份清单**解析，换地址不会拼错域名。

## 接口与路径

| 接口 | 说明 |
|---|---|
| `GET /config-sync/status` | 体检 JSON（含 `repo.source` / `repo.configured` / `remote.configured`、`local.{lastSyncAt,pending,sample}`、`auto.lastResult`） |
| `POST /config-sync/prepare` | `{action:'push'\|'pull'\|'restore'\|'all', message?}`，生成对应 `.cmd`；`all` 返回 `built: [...]` |
| `POST /config-sync/settings` | `{repoPath?, remoteUrl?, sshKey?, autoPull?, autoPush?, autoRestart?}`：校验 → 写设置 →（地址变了才动 git），失败回滚并 400 |
| `POST /config-sync/auto` | `{action:'check'\|'pull-now'\|'push-now'\|'cancel', closeNow?, restart?}`；`check` 只读 fetch 比对，`pull-now`/`push-now` 不带 `/F` 关闭客户端（走正常退出，配置能存下来）；`status` 里 `auto.pending` 带 `reason`（为什么排队） |

跨站请求 403。客户端只 `fetch` 这四条，不 import 任何 `@deepseek-ai/dsh-client-*`，样式只用 `--dsw-alias-*` token。

路径：仓库按上面的优先级；客户端根 `config.appRoot` 优先，留空则由插件自身位置推出（插件装在 `<AppRoot>\dsh-config-sync-0.1.0`），换机不用改；`.dsh` 为 `config.dshHome` → `%DSH_HOME%` → `~\.dsh`。同步状态文件 `~\.dsh\config-sync-state.json` 由 `sync.ps1` 写，插件只读。

## 生成器里已经堵掉的坑

都是**在新机器上真跑一遍**才暴露的：

| 坑 | 处理 |
|---|---|
| cmd 的 `echo` 吃 `< > \| & ^ %`，`echo ... config-<时间戳>` 被当重定向、那句还不打印 | 动态文案全过 `echoSafe()`：`%`→`%%`，特殊符号前加 `^` |
| `chcp 65001` 后 `set /p` 读不到重定向输入，自动化喂 `y` 时 `GO` 为空、"执行结束"却没做事、退出码还是 0 | `--yes` 免确认 + 无确认时明确回执 |
| 新机器分支没有 upstream，`pull --ff-only` 报 *There is no tracking information…*，PS 5.1 包成 NativeCommandError 后脚本继续走 | `sync.ps1` 先探 upstream，没有就 `pull --ff-only origin <branch>` 再 `set-upstream-to`；push 带 `-u` |
| `GIT_SSH_COMMAND` 少了 ssh.exe 本体 → `/usr/bin/sh: - : invalid option` | 四分支：有 `core.sshCommand` 照用；找到 `ssh.exe` 写完整命令；只有私钥没 ssh.exe 就**不设变量**；无私钥交给 `.ssh\config` |
| 客户端 asar 打包时按路径找 AppRoot 全落空、bundle 全误报缺失 | `isAppRoot` 认 `app\package.json` **或** `app.asar`；版本与 bundle 存在性从 asar 里定向取（PS 5.1 `ConvertFrom-Json` 2 MB 上限，5.7 MB 头只能按 entry 偏移直读），判不了就当"不知道" |
| 插件目录已存在就跳过部署，tgz 更新了本机还是旧代码 | `apply.ps1` 比较 tgz 与已部署目录最新文件时间，更新则改名 `.bak-<时间戳>` 备份后重新部署 |
| 开了"退出时自动推送"却什么都不发生（无日志、无结果文件） | 两个叠因：①排队判据只看 `ahead > 0`，新会话还没 capture 时恒为 0 → 改成三个来源都算 + 每 2 分钟复查；②`spawn` 假成功（`detached` 起 powershell 当场退出 / `spawn` 失败只在 `error` 事件报）→ 改用 `Start-Process` 起独立进程 + 等 launcher 退出码 + 写 `auto-sync-launch.log` |

会话 header `cwd`、空快照兜底、`Get-FileHash` 缺失这几类问题由仓库里的 `apply.ps1` / `restore.ps1` / `dsh-sync-common.ps1` 处理，细节见根 `README.md` 第 5、10 节。

## 安装与自检

`apply.ps1` 负责：`local-plugins\dsh-config-sync-0.1.0.tgz` 解压到 `<AppRoot>\dsh-config-sync-0.1.0`，`package.json` 加一条 `link:` 依赖与一条 `dsh.profile.bundles`，`cordis.patch.yml` 加 `config-sync` 行。

- `node tools\selftest.mjs <仓库路径>`：假 ctx 拉起宿主半身，打 status、生成脚本、断言 JSON 与落地文件；会先备份仓库根已有的同名 `同步-*.cmd`，断言完原样还原。**必须显式传仓库路径**。
- `node tools\clientcheck.mjs`：假 `__ModuleLoader__` + react 替身跑客户端半身，断言模块能加载、`apply()` 三处注册成功（侧栏行与 main 的 id/key 成对）、`inject` 返回回收函数、组件在无数据下渲染不抛。验的是契约与结构，UI 效果仍需重启后目视。

## 实测记录（2026-11-11，隔离环境）

假云端裸仓库 + 假客户端根 + 只有 `profiles\desktop` 的独立 `.dsh`，从 tgz 装插件，全程不碰主力机目录。

| 步骤 | 结果 |
|---|---|
| 装插件、开面板 | 三道路由都注册；未配置时 `repo.path` 为空不静默回退，推送被 400 拦 |
| 配仓库 / 云端 | 200，路径落进本机 `.dsh\dsh-config-sync.json`；无 origin → `git remote add` |
| 生成三份脚本 | 落在新机器仓库根，`-AppRoot` 指向该机客户端根，带 `--yes` 与 `y/N` 守卫 |
| 首次拉取 | 首次补 upstream → `Already up to date` → 备份 11 文件、铺 436 个 → `pnpm install` 21 个插件 → 25 个 bundle 全部可解析 |
| 工作区 / 会话 | 资料落在假客户端根；登记表路径展开成本机路径；空工作区被补建成空目录；会话目录名与本机路径重算的编码逐字一致，header `cwd` 由 `fix-session-cwd.mjs` 改写 |
| 推送 / 还原 | 推到假云端；还原先 `-DryRun` 出计划，`--yes` 后自保 `manual-<时间戳>` 再写回，测试标记被真抹掉 |
| 退出后同步 | `post-exit.ps1` 五个退出码（0/2/3/4/5）全部复现 |
| 本机待推送 | 真机：`git status` 干净，`~\.dsh\sessions` 有两个比上次同步新的会话，徽标转橙「待推送」，`local.pending = 15`（含 apply 刚重写的 profile 五文件） |
| 确认即退出 + 可见窗口 + 重启 | 真机 `{"action":"pull-now"}`：`DSH 7→0` 用 5 秒；+10 秒写着「拉取」的 PowerShell 窗口出现（排队期无窗口）；拉完自动 `0→4→7` |
| 点关闭即推送 + 可见窗口 + 重启 | 真机开 `autoPush`：排队为隐藏进程 → 点关闭后 7 个进程 `hwnd=0` 不退 → 16 秒后强制收尾 → 窗口「推送」→ 推送成功 → 自动重启 |
| 互斥 | 首检的 push 与手动 pull 同时命中：后者结束前者未开工的等待进程并改排，未再并行 |

**同步边界**：工作区资料与会话会跟着走，但**默认工作区（`default-workspace`）不同步**（目录名按各机 `WorkspaceHome` 编码，目标机认不出，只会留下"历史为空"的空工作区）；`models/`、`*.whl`、`*.safetensors` 与任何 >100 MB 的文件也不进仓库。细节见根 `README.md` 第 4、5 节。

上一轮复审发现的 6 条问题（git 身份、跨机会话目录互相改写、写死 `origin/main`、结束文案、重复逻辑、死代码）**已全部整改并验证**，对照表在根 `README.md` 第 12 节。
