# dsh-config-sync

中文 | [English](README.en.md)

DSH 插件：左侧栏加一行「配置同步」，点开是整页体检面板；「设置 → 通用」另留一行摘要。它**只做体检 + 备命令**，同步动作不在应用内跑（拉起客户端的自动同步除外）。

![panel](docs/panel.png)

> 截图取自 0.3.14，分区结构与现在一致；新版本里每张卡改成「只读 + 修改」，见下文「统一交互」。

面板与宿主返回的文案是双语的：跟随客户端语言（`zh-*` → 中文，其余 → 英文），没有面板内切换开关。只有生成的 `.cmd` 脚本内部文字保持中文（它是本机命令行工具）。

## 安装

插件本体是一份标准 DSH bundle，装到当前 profile 即可：

```sh
# 从最新的 release 包安装（无需构建，包内已含宿主/前端/runtime 脚本）
# 版本号换成 Releases 页里最新的那个：https://github.com/QcWyGm/dsh-config-sync/releases
dsh plugin add https://raw.githubusercontent.com/QcWyGm/dsh-config-sync/main/releases/dsh-config-sync-<版本>.tgz
```

或在 DSH 面板的官方「插件 → 发现 → 索引源」里添加本仓库的索引（做法见下文「作为插件市场的索引源」）。**第三方市场插件 dshmarket 不读这份索引**，原因见同一节。

装好后需要指向你自己的配置仓库（默认自动探测常见路径），并在「插件更新」卡里按需填写清单地址与令牌——**本仓库是公开的，从 GitHub 分发时不填令牌也能更新**。

`apply.ps1` 落地时做三件事：`local-plugins\dsh-config-sync-<版本>.tgz` 解压到 `<AppRoot>\dsh-config-sync-0.1.0`；`package.json` 加一条 `link:` 依赖与一条 `dsh.profile.bundles`；`cordis.patch.yml` 加 `config-sync` 行。

## 包含什么

| 路径 | 说明 |
|---|---|
| `index.js` | 宿主半身：`/config-sync/status`、`/prepare`、`/settings`、`/auto`、`/update` 路由 |
| `client.js` | 浏览器半身：侧栏行、面板、设置摘要行 |
| `cordis.patch.yml` | bundle 补丁层（`id: config-sync`） |
| `runtime/` | 退出后执行的六个 PowerShell 脚本 + `fix-session-cwd.mjs`，随包发布，装好即可生成脚本，不必先克隆配置仓库 |
| `tools/` | 自检脚本 `selftest.mjs`、前端结构检查 `clientcheck.mjs` |
| `version.json` / `releases/` | 自更新清单与安装包 |

## 入口挂在哪

| 入口 | slot | 说明 |
|---|---|---|
| 左侧栏一行 | `sidebar.panellist`（`id: config-sync`） | 与「插件 / 自动任务 / 技能市场 / 记忆系统」同一列，图标双向箭头 |
| 点开的面板 | `main`（`key: config-sync`） | 宿主按 id/key 绑定两者，两条 register 必须在**嵌套 inject** 里成对完成（只 inject `main` 就向 `sidebar.panellist` register 无效） |
| 设置摘要行 | `settings.general.item` | 一行四态 chip + 展开（仓库、远端、私钥） |

侧栏行的点击切换由宿主处理，契约抄自 `dshmarket` / `dsh-mnemon`。

## 面板显示什么

布局是「一行状态 + 一行指标 + 分区卡片」，读的顺序就是从上到下（0.3.14 起，见 `docs/panel.png`）：

**标题行**：`配置同步　本机 [一致/待推送/待拉取/有问题]　云端 [一致/不一致/待拉取]`，右端一个「重新检测」。两个徽标同一套配色——绿=一致、橙=待推送/待拉取、红=有问题；左侧只说本机（配置齐不齐、依赖缺不缺、有无未提交/未推送），云端那条**全自动**：打开面板查一次、之后每 2 分钟复查，**没有手动按钮**。

**元信息行**：`app 版本 / Electron 版本 · 分支 @ 短 HEAD`。原先是标题下的一整段导语，已删掉。

**指标条**：五格一眼看完——`本机 / 契约`（版本不一致转橙）、`bundle`（有解析不到的转红）、`依赖`（有缺失转红）、`备份快照`（份数）、`上次同步`（时间，后面 `(+N)` 表示之后又有几个文件写入）。表里有事才在下面出现一条「待办」，没事就没有这一块。

**分区**：概览（指标条 + 待办）→ 本机路径（0.3.30 起：跨机根确认与待确认清单；0.3.34 起只读展示 + 「修改」；0.3.37 起**平时整块不显示**，只在点标题行「本机路径」按钮时展开（有待处理项时那个按钮变橙并带上数量））→ 同步冲突（只在真有冲突时出现）→ 同步目标（本机仓库 / 云端仓库）→ 自动化与插件更新（自动同步 / 插件更新）→ 退出后执行 → 还原备份 → 同步内容 → 问题反馈（0.3.31 起）。宽屏两列并排，卡片内文字压成"一行值 + 一行灰字说明"，长解释不再堆在正文里。

**统一交互**：「本机路径 / 本机仓库 / 云端仓库 / 自动同步 / 插件更新 / 同步内容」这些卡都是**先只读、点「修改」才解锁**，改完点「保存」，点「取消」丢弃本次改动。只有"没配过"的卡（没设仓库、没设远端）会强制停在编辑态且不给「取消」——不先填好，推送/拉取/生成脚本都无从下手。本机路径卡没探测到任何根时同样强制编辑态。

**「待推送」不只看 git**：`git status` 干净时，新会话/新资料可能还躺在 `~\.dsh` 里没 capture。所以 `sync.ps1` 在 push / pull 成功后写 `~\.dsh\config-sync-state.json`（`lastSyncAt`/`mode`/`head`），`status` 多返回一段 `local`：stat `sessions`、`skills`、`.agent-presets`、`mnemon`、profile 五文件、登记的工作区目录，**mtime 晚于 `lastSyncAt`** 的计入 `local.pending`，徽标转橙「待推送」。只看 mtime、不读内容、不跑 capture；上限 20000 文件 / 1.5 秒；复制或另存也会算进来，误报只是多一句提示。

**「待拉取」= 本机仓库还是空目录**（0.3.26 起）：新机器把仓库路径指到一个空文件夹时，这是"等着从云端拉"的正常状态，**不报异常**——徽标橙色「待拉取」而不是红色「有问题」，待办里那句是「执行「拉取」会从云端把仓库内容拉到这里」。

**上次自动同步的结果**：`~\.dsh\auto-sync-result.json` 若是 15 分钟内的，**客户端一启动就弹**一条 5 秒浮层（`apply()` 里挂载后 1.5 秒查一次 `status`，自己 append 到 body、面板没打开也能显示；成功/失败 + 原因 + 失败带日志路径）。面板里那条提示与它共用一个判据和一个 localStorage 键，同一份结果只弹一次。

## 本机仓库 / 云端仓库（都可配，默认只读，没配就强制配）

- 仓库判据：目录里同时有 `apply.ps1` 与 `profile\package.json`（再有 `sync.ps1` 才算能推拉）。
- 优先级：本机设置文件 → 插件配置 `repoPath` → `DSH_CONFIG_REPO` → 常见位置自动探测。**配置里填的空目录同样算有效答案**，不会被自动探测到的另一个仓库顶掉。
- 四种状态（`status` 里的 `repo.phase`）：`ok` 真仓库、`empty` 空目录/待首次拉取、`missing` 目录不存在、`unusable` 目录里有别的东西却不像仓库。`repo.pushAllowed` / `repo.pullAllowed` 就按它算，面板按钮和宿主接口共用这一套口径。
- **空目录 + 云端有内容 → 只允许拉取（0.3.26 起，0.3.35 起加"云端"这一维）**：路径指向空白文件夹、云端又有东西时，面板只放行「拉取」（+ 还原），推送按钮置灰并写明"先拉取"；宿主 `prepare(push)` 与 `auto(push-now)` 一律 400，「一键生成」自动降级成「拉取 / 还原」。拉取会把云端仓库整个拉下来：目录不存在就建，再 `git init` → 补 `origin` → `fetch` → `checkout -B <分支>`（用 init+fetch+checkout 而不是 clone，因为目录里可能已有插件生成的 `同步-*.cmd`）。
- **空目录 + 云端也空 → 只允许推送，而且就是「初始化推送」（0.3.35 起；0.3.42 起它真能跑完）**：面板把按钮改成「初始化推送」，拉取按钮置灰（没有东西可拉）。`status` 多了 `repo.remoteHeads`（云端分支数，`null`=判不了）、`repo.remoteEmpty` 与三态 `repo.mode`（`ok` / `await-pull` / `await-init`），宿主与面板都用它。执行时 `sync.ps1 push` 依次做：`git init` → 补 `origin` → **写仓库骨架**（把插件 runtime 的 `apply.ps1` / `capture.ps1` / `sync.ps1` / `restore.ps1` / `post-exit.ps1` / `dsh-sync-common.ps1` 拷进仓库根，外加 `tools\fix-session-cwd.mjs`）→ 写 `profile\host-contract.json`（本机客户端版本）→ `capture` 抓本机配置 → 提交 → `push -u origin main`。骨架必须一起带上，否则远端会变成"只有 settings、没有执行体"的半截仓库，另一台 pull 下来跑不起来。
- **0.3.42 修了两个让初始化推送跑到一半就停的坑**：一是 `capture.ps1` 根外路径体检里漏写了一个 `$`（`(v.Replace(...)` 被 PowerShell 当成命令 `v.Replace` 去执行），只在配置里有「自定义根」时才触发，日志里表现为 `无法将"v.Replace"项识别为 cmdlet`，整次 push 当场失败；二是 `sync.ps1` 把「仓库目录不是空的」直接当成「路径填错了」，可初始化推送时 `capture` 刚把 16 项配置写进仓库，于是它被自己的产物挡住、直接退出。现在判据换成「仓库里有本插件的脚本（`dsh-sync-common.ps1` / `sync.ps1` / `capture.ps1` 任一）就算这是同步仓库」，只有真填错路径（桌面、下载目录）才拦。
- 云端有没有内容是 `git ls-remote --heads <远端>`（15 秒超时）现算的：**探不到（离线/认证失败）就按老规矩只允许拉取**，不在盲状态下开推送。云端已经有分支、本机却还是空目录时，`push` 一律拒绝并提示先拉取 —— 硬推会把本机状态写进一份正在使用的历史。
- 只允许插件自己生成的 `同步-*.cmd` 与隐藏项（`.git` 等）算"空"；目录里已经有别的文件却不像仓库 → `unusable`，面板提示重新设路径，保存设置时也会拒。
- 云端：远端地址优先读 `git remote get-url origin`，没有才回落设置文件；SSH 私钥只存**路径**、可留空交给 `.ssh\config`。
- **没配过 = 强制设置**：卡片停在编辑态、不给「取消」，顶部红字、生成按钮禁用，宿主 `prepare` 也 400（远端缺失时 `还原` 不受影响）。
- 保存顺序：校验（地址只接受 `git@host:path` / `ssh://` / `https://`；私钥填了就必须存在）→ 写设置 → 有 `origin` 就 `set-url`、没有就 `remote add` → git 失败回滚设置文件，不留"面板显示 A、git 用 B"的错位。
- 设置里的路径后来失效（被移走/改名）：`status` 给 `repo.exists=false`、`phase='missing'`，面板回到"必须重设"，**不会**悄悄换成探测到的另一个仓库。
- 落在 `~\.dsh\dsh-config-sync.json`，跟本机走、不进仓库。

## 支持的云端平台（0.3.27 起写明）

插件本身不挑 git 托管平台：远端地址只校验「写法」，之后的 `fetch` / `push` / `pull` / `ls-remote` 全部交给 git。Gitee、GitHub、GitLab、自建 Gitea/Forgejo 走的是同一条路。

| 项 | 说明 |
|---|---|
| 地址写法 | `git@host:owner/repo.git`、`ssh://git@host:port/owner/repo.git`、`https://host/owner/repo.git` 三种 |
| 默认分支 | 先试 `main`，云端没有就取远端第一个分支（老仓库的 `master` 也行），拉取后自动建立 tracking |
| 认证 | SSH：填私钥路径（留空则交给 `.ssh\config` 或 Git 默认选择），生成的脚本用 `GIT_SSH_COMMAND` + `StrictHostKeyChecking=accept-new`；HTTPS：用 Git 凭据管理器里的账号/令牌，插件不保存任何密码 |
| 报错自检 | fetch/pull 失败时，提示里的主机名取自 `origin` 的真实地址（0.3.27 起），不再固定写 `git@gitee.com`；https 地址给的是 `ls-remote` 检查，不是 `ssh -T` |
| 单文件上限 | 100MB（Gitee 免费版、GitHub、GitLab 的默认硬限制都在这个量级），超过的文件不进仓库 |

私有库要注意两点：①用 SSH 地址最省事；②插件**自身的更新清单**默认指向作者的公开仓库，如果你把它改成自己的私有库，目前只有 Gitee 的 raw 链接会自动换成 API + token，GitHub/GitLab 私有库的 raw 匿名读会失败——这是已知限制。

## 同步后新会话落在默认工作区（0.3.28 起）

同步完成会顺手把 DSH 拉回来，客户端起来后会自己开一个新会话。这个新会话落在哪个工作区，由 `<DshHome>\storages\workspace.json` 里的 `global.defaultWorkspaceId` 决定——而这个值 DSH 只在本机**首次初始化**时写过一次，之后同步几轮就可能停在某个「上次用的工作区」上。

0.3.28 起，`post-exit.ps1` 在**客户端完全退出之后、重新拉起之前**把该值校正到默认工作区。写在此时机是必须的：客户端持有这份登记表并在退出时回写，早写会被盖掉。

| 项 | 说明 |
|---|---|
| 默认行为 | 自动找标题为 `default-workspace`、或路径以 `\deepseek-harness\default-workspace` 结尾的工作区，把 `defaultWorkspaceId` 指过去 |
| 指定别的 | 设置文件 `~\.dsh\dsh-config-sync.json` 的 `defaultWorkspace` 填工作区 ID 或绝对路径 |
| 关掉 | 同一字段填 `off`（或 `none`） |
| 安全阀 | 只在值真的不同时才写；写前原样备份为 `workspace.json.bak-<时间戳>`；写完回读校验 `defaultWorkspaceId` 与工作区条数；路径匹配不到工作区就跳过不动，不猜 |
| 副作用 | 你在 DSH 里手动切换的「默认工作区」会被下一次同步覆盖回 `default-workspace`——不想要这个效果就把它设成 `off` |
| 撤销 | 把 `workspace.json.bak-<时间戳>` 拷回 `workspace.json` 即可 |

## 一键生成的三份脚本

「一键生成 推送 / 拉取 / 还原」可一次写出三份，也可只生成其中一份；仓库还是空目录时只生成「拉取 / 还原」。文件名、按钮、脚本内文字全中文。

| 脚本 | 干什么 | 安全阀 |
|---|---|---|
| `同步-推送.cmd` | 退出后 capture 本机配置并推到远端 | 先查 `DeepSeek Harness.exe` 是否还在跑；本机仓库是空目录时直接拒绝 |
| `同步-拉取.cmd` | 退出后从远端拉取并 apply 到本机 | 同上；**先写明"本机领先几个提交 / 几项未提交"，要输 `y`** —— 它会用仓库版本覆盖本机配置 |
| `同步-还原.cmd` | 退出后把 profile 退回某次 apply 前的快照 | 同上；**先 `-DryRun` 打印计划，按 `y` 才真写** |
| `同步-还原-<快照名>.cmd` | 同上，但退回的是**指定那一份**（面板「还原备份」卡点某行生成） | 同上；文件名带快照名，多份可以并存互不覆盖 |

三份都写死本机参数（仓库、AppRoot、`.dsh` 位置），双击即可。拉取与还原支持 `--yes` 免确认（给自动化/远控用）；没有确认时明说「没有收到确认（y），已退出：本机什么都没改」，不静默退出。

- **提交说明**：生成推送脚本时可填，以 `-Message "..."` 传进 `sync.ps1`，**时间由脚本执行那一刻自动追加**；留空用默认 `sync: capture <时间> @ <机器名>`。
- **还原快照怎么选**：生成时已有快照就明写进 `-BackupDir`（并显示时间、共几份）；还没有（新机器刚装插件）则**不写**，交给 `restore.ps1` 运行时取最新一份——否则脚本会咬住"生成那一刻没有快照"。运行时若最新那份是空快照，会自动往前找第一份含 `package.json` 的并提示。面板「还原备份」卡点某一行时，走的是同一个生成器，只是把那一份的绝对路径作为 `-BackupDir` 明写进去、文件名带上快照名。

## 同步冲突（0.3.17 起，0.3.18 起两份副本都备份）

拉取被本机文件挡住时（同一路径本机也有一份、内容不一样），git 会整批 `Aborting`。旧做法是"失败就 `reset --hard` 回滚 + 用最新快照还原配置"——实测这条会把**已经快进成功**的 HEAD 又打回旧提交，于是永远差几个提交、反复失败。0.3.17 改成**不 reset**：

1. `sync.ps1 pull` 先 `git fetch`，判定能否快进，再算交集：`git diff --name-only HEAD origin/x` ∩（本机未入库 ∪ 本机已修改）。命中就**逐文件把两边都备份**、写清单 `~\.dsh\sync-conflicts.json`（每项记 kind、两侧字节数、是否二进制、两侧预览各 1500 字、两份副本是否备份成功），然后 `exit 6` 停下。**仓库与配置都不动，HEAD 不回滚**。
   备份目录名带中英说明：`~\.dsh\backups\conflict-<时间>-拉取冲突-Pull-conflict\`，里面是
   - `本机-Local\<相对路径>` —— 本机版本（冲突发生时工作区里的原样内容）；
   - `云端-Cloud\<相对路径>` —— 云端同名版本（`git show origin/x:<路径>`；走 `git cat-file blob` + 重定向按字节落盘，`.zstd`/`.tgz` 这类二进制不会被转码）；
   - `说明-README.txt` —— 中英双语：生成时间、仓库目录、同步前 HEAD、云端 ref 与 sha、条目数、两个目录各是什么、两种还原方式；
   - `清单-Conflicts.json` —— 本次清单快照，事后能核对当时给了哪些选项、选了哪边。

   任何一侧写出来的字节数与源文件对不上，都会在终端警告、把该侧标记为未备份，面板上对应按钮自动置灰——不留"以为备份了其实没有"的坑。
2. `runtime\post-exit.ps1` 见到退出码 6 不走回滚分支，结果写成「拉取待处理」。
3. 重启客户端后，面板「概览」下方出现「同步冲突」卡（没有清单时不显示）：
   - 一行一个文件，**点整行**展开/收起两侧预览（没有单独的「明细」按钮）；
   - 每行右侧「用本机 / 用云端」，底部还有「全部用本机 / 全部用云端」；
   - 展开后两个按钮：「还原本机副本」「还原云端副本」——**两份副本都能单独写回工作区，互不覆盖，也不动 git 历史**；哪一份没备份成功，对应按钮置灰并写明原因；
   - 「保存选择」写回清单，「放弃清单」删掉清单（下次拉取重新算）。
4. 选完再点「立即拉取」：`sync.ps1` 读同一份清单，`用云端` 的删掉工作区副本、`用本机` 的也先删（让 git 能快进），快进成功后再把 `用本机` 的从备份写回工作区——它于是变成一次本地改动，下次推送带上。清单随即清除。

粒度只有「逐项 用本机 / 用云端」＋「单项从备份还原」，不做预览内编辑或手工合并：冲突基本都是"另一台机器也改了同名配置"，逐项选一边就够，真要合并直接改文件再推送。

接口：`GET/POST /config-sync/conflict`（GET 读清单，每项带 `localSaved`/`cloudSaved`；POST `{items:[{path,choice}]}` 存选择、`{action:'restore',path,side:'local'|'cloud'}` 单项还原（默认 local）、`{action:'reset'}` 放弃清单）。还原写到清单里记录的 `repo` 路径，所以事后改过 `repoPath` 也不会写错仓库。`status` 多返回 `conflicts: {exists,total,pending,at,backupDir}`。

## 还原备份（0.3.13 起；0.3.25 起改为「立即还原」+ 时点还原）

面板「还原备份」卡（排在「退出后执行」之后、「同步内容」之前）：上面一行是**备份目录**（默认 `~\.dsh\backups`，`apply.ps1` 每次拉取/落地之前都会往这里打一份快照），下面列出该目录下的**所有快照**——名称、时间（并带「3 分钟前 / 2 小时前」这样的相对时间）、装了多少插件、能不能还原。

- **列表不显示体积（0.3.41 起）**：每份快照都是整份 profile（几千个文件），旧版本每次刷新面板都要把这些快照的文件逐个 `stat` 数一遍——92 份 / 4.8 万文件实测要 7.7 秒，整次 `/config-sync/status` 拖到 11 秒，前端一次 fetch 撑不住就显示「读取失败」，要手动点「重新检测」。现在列表只给名称 / 时间 / 插件数 / 能否还原，体积交给资源管理器。同一次改动还做了两件事：远端探测改成「缓存 5 分钟 + 每次最多等 2.5 秒 + 插件装载时预热」，前端 status 请求带 15 秒超时和 3 次自动重试（文案会说「已自动重试 3 次」）。实测 status 从 8.0 秒降到 0.35 秒（中位，20 次）。

- **0.3.25 起和「立即拉取」是同一条流水线**：点某行的「立即还原」→ 面板先向宿主取一份**差异预览**，逐项列出「将撤走几个快照之后装上的插件」「将移走几个快照之后新增的文件」「将覆盖 / 写回哪些文件」「还原后要重装哪些插件」→ 点「确认还原」才排队 → 客户端正常退出 → `post-exit.ps1` 弹出可见进度窗口跑 `restore.ps1 -RollbackToPoint` → 结果写回 `auto-sync-result.json` → 自动重启客户端。不用再自己退客户端、双击 `.cmd`、输 `y`。
- **时点还原 = 回到那个时间点**，不只是把快照里的文件盖回去：快照之后新增的文件移进 `backups\manual-<时间戳>\rollback\files`；快照之后装上的插件，junction 只删链接（绝不穿进链接删实体目录）、实体目录移进 `rollback\plugins`；每一项都写进 `rollback\rollback-manifest.json`——全部可再还原，不做物理删除。动手前还会把当前配置整份另存 `manual-<时间戳>`。
- **谁算「快照之后装上的插件」**：以还原后 `package.json` 的 `dependencies` 为准，`node_modules` 里不在其中的直接子目录（含 `@scope/包`）会被撤走；退回去之后由 `pnpm install` 补齐快照里有、现在没有的插件。
- **地址可自己改**：点「修改」填一个绝对路径（例如 `D:\DSH备份`）保存后，卡片就改扫那个目录；点「恢复默认」清回 `~\.dsh\backups`。配置存在 `~\.dsh\dsh-config-sync.json` 的 `backupRoot`，留空=默认，跟本机走、不进仓库。
- **只认能用的快照**：快照里没有 `profile\package.json` 的（新机器首次拉取时本机无配置可备份，`apply` 会留下空快照）在列表里标「没有 profile 文件，不能还原」、「不可还原」置灰；宿主的 `restore-backup` / `restore-preview` / `restore-now` 都走同一套校验，会直接拒掉这类路径。
- **只在这个目录里选**：面板传来的必须是备份根之下真实存在的一份快照（越界、相对路径、含引号换行都直接报错），不会因为改了地址就把范围放宽到任意文件夹。
- **老路径仍在**：「退出后执行」卡里的「只生成还原脚本」照旧写 `<仓库>\同步-还原-<快照名>.cmd`（含 `-DryRun` 预览、输 `y` 确认、`manual-<时间戳>` 自保），给离线 / 远控 / 手动执行用；`restore.ps1` 的 `-BackupDir` 参数没变，新增的 `-RollbackToPoint` 由面板那条链路自动加上。

## 插件配置跟得走 + 跨机路径确认（0.3.30 起）

新机器同步完发现「配置没了」，多数不是拉取失败，而是**这些配置从来就没进过仓库**。0.3.30 把「插件配置」组从 4 个文件扩到 13 项：

| 仓库路径 | 本机来源 | 说明 |
|---|---|---|
| `settings\our-free-model.json` | `~\our-free-model\settings.json` | 免费模型中转设置（运行时字段已归一，不会每轮都「有改动」） |
| `settings\comfyui-workflows.json` | `~\data\dsh-comfyui\workflows.json` | ComfyUI 工作流库 |
| `settings\dsh-pet-main-config.jsonc` | `~\dsh-pet\main-config.jsonc` | 桌宠配置 |
| `settings\dsh-market-state.json` | `~\.dsh` 的 profile 下 `.dsh-market\state.json` | 插件市场状态 |
| `settings\dsh-pet-memory.json` | `~\dsh-pet\memory.json` | 桌宠记忆 |
| `settings\our-free-model-picks.json` | `~\our-free-model\picks.json` | 收藏 |
| `settings\dsh-im-interface-language.json` | `~\integrations\dsh-im\interface-language.json` | dsh-im 界面语言 |
| `settings\dsh-qq-config.json` | `~\integrations\dsh-qq\config.json` | QQ 集成配置 |
| `settings\dsh-qq-workspaces.json` | `~\integrations\dsh-qq\workspaces.json` | QQ 集成工作区 |
| `settings\redteam-preset-declare.json` | `~\redteam\preset-declare.json` | 红队预设声明 |
| `settings\task-board-ledger.json` | `~\task-board\ledger-v2.json` | 任务板台账 |
| `settings\task-board-scheduler.json` | `~\task-board\scheduler-v2.json` | 任务板调度 |
| `settings\dsh-workspaces.json` | `~\storages\workspace.json` | **DSH 工作区登记**（新机器「工作区不见了」就是它没同步） |

**仍然排除**：凭据与运行时状态不进仓库 —— `channel-pack`（含 `token-ledger.json`）、`workbuddy-vault`、`dsh-purge`、`stats` / `feed` / `catalog` / `availability`、`integrations\dsh-qq\bots\<bot>\state.json`、会话缓存。

### 带本机路径的配置：占位符 + 换机确认

两台机器的盘符几乎不可能一样（一台 `D:\DeepSeekHarness`，另一台放在别处），所以带绝对路径的配置不能原样搬过去：

| 占位符 | 含义 |
|---|---|
| `{{APP_ROOT}}` | 客户端安装目录（`DeepSeekHarness` 所在的那一层） |
| `{{DSH_HOME}}` | `.dsh` 配置目录（一般是 `%USERPROFILE%\.dsh`） |
| `{{WORKSPACE_HOME}}` | 工作区根目录 |
| `{{ROOT:<key>}}` | 用户自选目录（ComfyUI 模型目录、代理程序路径等），键值由用户在面板里定 |

- `capture.ps1` 写仓库**前**做归一：本机根 → 占位符。同一个路径在原文件里可能是 4 种写法（原样反斜杠 / JSON 双反斜杠 / 正斜杠 / JSON 转义斜杠），都会认；替换按根长度降序（工作区根在安装目录之下，先换长的才不会错位）。
- 仓库里一律**正斜杠**（`{{APP_ROOT}}/mnemon`），JSON 里不会出现反斜杠转义问题。
- `apply.ps1` 落地**前**展开：占位符 → 本机路径。

### 路径确认：拉取后由你选，选过就不再问

- 首次同步会在 `~\.dsh\config-sync-roots.json` 落一份本机根（探测值），**本机私有、不进仓库**。
- 某台机器缺某个根（展开不掉）时，`apply.ps1` **跳过那个文件不写**，把它记进 `~\.dsh\config-sync-pending-paths.json`（哪个 token、哪个文件、要选什么目录）。
- 面板「本机路径」卡把这些项列出来，填好本机路径 → 保存 → 重新拉取一次就写进去。
- 确认过的值优先于自动探测，之后不再问；根都对不上的情况下**宁可不写**——把 `{{ROOT:xxx}}` 字面量写进配置，插件读到会当真实路径，那种报错比「没写」难查得多。

### 两条体检：推送后看根外路径，拉取前看你改没改（0.3.36 起）

**推送之后（capture.ps1 末尾）**：扫一遍仓库里的 `settings\*.json`、`profile\*.yml`、`workspace\*.json`，把**不属于任何已确认根**的绝对路径抓出来——比如仓库里还写着 `F:\workspace-new`（本机根都在 `D:\` 下，这条换台机器就是死路径）。抓到就写 `~\.dsh\config-sync-absolute-paths.json`，面板「本机路径」卡列前几条，控制台也 `Warn` 一句。**不拦提交**：路径本来就可能是对的，只是提醒你它跨不了机器。要清掉就把那个目录加成「自选目录」（`{{ROOT:<key>}}`），再推送一次，占位符化之后就跟着机器走了。

**拉取之前（apply.ps1 写 settings 前）**：铺配置是整份 `WriteAllText` 覆盖，你改完路径没推送就点拉取，改动会被静默盖回去（备份是有的，但没人会去翻 `~\.dsh\backups\config-<时间戳>\settings\`）。所以现在覆盖前先比一次：本机现状（归一化成占位符、CRLF 拉平成 LF、`our-free-model.json` 的 `catalogSyncedAt/reloadedAt/reloadCount` 一起置 0 对齐 capture 的写法）跟仓库版本不一样，就记进 `~\.dsh\config-sync-overwrite.json`，面板提示「有 N 份配置被仓库版本覆盖（本机改动已先备份）」，每条带备份路径。想保住本机改动：**先推送，再拉取**，别反过来。

### 「本机路径」卡怎么用（0.3.34 起：只读 + 修改；0.3.37 起：平时不显示）

- **平时不进页面**：这一区（连同「本机路径」标题）整块不渲染——正常机器上路径本来就不用改。入口只有一个：页面标题行的 **「本机路径」** 按钮，点一下展开，再点变「收起本机路径」。
- **三类都算告警**：待确认路径、仓库里有根外绝对路径、上次拉取覆盖了本机配置——`status.localPaths.alert` 给三项合计，按钮变橙并显示「本机路径 · N 项告警」，点开就是明细。
- **默认只读**：三行根（`{{APP_ROOT}}` / `{{DSH_HOME}}` / `{{WORKSPACE_HOME}}`）用等宽字显示当前值，下面一行灰字是它对应的占位符；自选目录（`{{ROOT:<key>}}`）同样展示。
- 点右上「修改」才变成输入框，出现「保存」「取消」；保存成功后自动回到只读态（跟「本机仓库」「同步内容」等卡的操作方式一致）。
- 编辑态多三件事：每个根右边有「用探测值」（一键填回自动探测到的目录，填错了就靠它退回）；每个自选目录右边有「删除」；下面一行「新增目录」填键名 + 路径后点「添加」，用来补插件装在别处的根（键名只接受字母数字 `_ . -`）。
- 顶部徽标：有未确认项显示橙色「待确认 N 项」，全齐显示绿色「已确认」；「重新读取」始终可用，重新拉探测值不覆盖已保存的确认值。
- 强制编辑态：三个根一个都没探测到时停在编辑态，先填再保存。
- 这一卡的值**优先级最高**：保存过的根压过脚本命令行探测到的值（`Get-SyncRoots` 里 roots.json 优先、只补空值）。所以填错不是"没生效"，而是真的按错值展开、把配置写成死路径。

## 问题反馈：走 GitHub Issue（0.3.31 起，0.3.32 起免令牌读）

面板最下面「问题反馈」卡。**GitHub Issue 是唯一真源**，不再往配置仓库里塞 json：

1. 填标题 + 详情 → 直接 `POST /repos/QcWyGm/dsh-config-sync/issues`，label `feedback`，正文末尾自动附一段环境块（插件版本、机器名、时间、平台、安装目录、配置仓库路径），在 GitHub 上不用再追问；
2. 列表直接读 Issue：`GET /issues?state=all&labels=feedback`，open / closed 都在，点标题就是 GitHub 网页；
3. 点「已解决」→ `PATCH issue {state:'closed'}`，GitHub 上还是同一个线程，想继续讨论就在那边接着聊，想重开点一下又回来；
4. 面板顶上一行是连接状态，三态：`已用 xxx 登录（可提交、可关单）` / `令牌不属于所有者（只能读和提交）` / `匿名读取（提交走浏览器）`。

**读不需要令牌**（0.3.32 起）：这个仓库是公开的，Issue 列表匿名请求就能读（实测 HTTP 200，限额 60 次/小时·每 IP）。所以有令牌先带令牌读（自己的账号、5000 次/小时），令牌失效或压根没有就自动退回匿名读——新机器第一次打开面板就能看到已有反馈，不用先配令牌。

**没令牌也能提交**（0.3.32 起）：面板会把标题、正文和环境块预填进 GitHub 的新建 Issue 页面（`https://github.com/<repo>/issues/new?title=&body=&labels=feedback`），浏览器里登录着 GitHub 的话点一下 Submit 就成了，全程不需要 token。这条路只在没有令牌时启用；有令牌仍走 API 直发，才能进队列、能补发。

**关单只有仓库所有者能点**（0.3.32 起）：改状态前服务端先用 `GET /user` 认令牌归属，`login` 和仓库所有者不一致就直接 403，面板上那个按钮同步灰掉显示「仅所有者」。所以别人的令牌即使填进面板也关不掉单——这条限制在服务端，不只是界面。

**令牌不用手填**：默认从本机 git 凭据取一次（`git credential fill`，平时 push 过就已经在里面），存进 `<dshHome>\config-sync-gh.json`（本机私有、**不进仓库**）。取不到（比如从没在这台机器 push 过）才需要粘一次，粘完立刻拿 `/repos/{repo}` 验一遍——验不过就不存。仓库和 label 也能改，跟令牌填在同一行。

**断网不丢**：建 Issue 失败时这条会进 `<dshHome>\config-sync-feedback-outbox.json`，面板显示「本机还有 N 条没发出去」，联网后点「补发」逐条建 Issue，成功的自动出队。这不是"另存一份"，只是待发队列——发出去了队列就空。

**筛选与查询**（0.3.33 起）：列表头上是 `未解决 / 已解决 / 全部` 三个按钮（各带实时条数，服务端一次拉全量后算 open/closed/total），右边一个搜索框，打字即筛——编号、标题、作者、正文都参与匹配，正文里那行环境块（机器名、版本）也能搜到。筛选全在本地做，切状态、敲键盘都不打接口，不占匿名限额。灰字实时回显「显示 N / 共 M 条（关键词 xxx）」，当前筛选下没匹配就给提示而不是空白。

## 卸载残留自动清理（0.3.29 起）

卸载插件是宿主做的：删安装目录、删 `package.json` 里的依赖、删 `cordis.patch.yml` 里的模块段。但它**不删 `profile\node_modules` 里那条 junction**——实测 `dsh-image-search` 卸载后目标目录 `D:\DeepSeekHarness\dsh-image-search-0.1.0` 已经没了、链接还指着它。这类断链 pnpm 也不管（平铺布局下它只按 lockfile 重装，而链接不是它建的），同步同样从不清，于是一直挂到下次重装。

所以 `apply.ps1` 每次落地都巡检一遍（第 9.6 段），只删**三条同时成立**的链接：

| 判据 | 说明 |
|---|---|
| 是链接 | `LinkType` 为 Junction / SymbolicLink，普通目录不碰 |
| 所有 Target 都不存在 | 只要有一个目标还在，就当正常软链留着 |
| 不在 `package.json` 的 dependencies 里 | 在用的 `link:` 插件一律跳过 |

删除用 `Directory.Delete`，只删链接本身、不顺着链接动目标；日志逐条写 `已清理孤儿链接（卸载残留）：xxx → 目标不存在 yyy`。

**顺手清插件备份**：同步每轮「旧目录先改名备份」会攒出 `<目录>.bak-<时间戳>`。与在用版本**相同**的备份是纯冗余（内容就是刚铺上去的那一份），直接删；版本不同的只留最新一份；主目录已不存在的备份保留（可能是唯一回滚点）。

**同时修掉一个误判**：0.3.29 之前部署判据比的是 mtime，而 `git checkout/fetch` 会把归档的 mtime 刷成当前时间 → 每轮同步都判「有新版本」，反复改名备份 + 重新解压（`dsh-purge-1.1.92` 与 `.bak-时间戳` 并存、每轮多搬一次目录就是这么来的）。现在比归档内 `package.json` 的 version 与已部署目录的 version，不同才算新版本；读不到版本时退回 mtime，并要求新 10 秒以上。
## 同步内容勾选（0.3.8 起）

面板「同步内容」卡（挂在面板最下面）：把云端同步的十组内容逐组列出来，**默认全勾**；点一下某一行就展开该组明细，再点一下收起（没有单独的「明细」按钮）；组和单项都能取消勾选 —— 取消后**推送不再抓、拉取不再还原**，重新勾上就继续同步（推送和拉取共用同一份勾选）。

- **先进只读态**：卡片打开时所有复选框是灰的，只展示当前勾选情况；点「修改」才解锁勾选，改完点「保存」才写进文件（点「取消」就丢弃这次改动、回到读到的状态）。避免误点一下就改掉同步范围。

| 组 | 云端目录 | 明细项（可单独排除） |
|---|---|---|
| 本机 profile | `profile/` | package.json / lock / cordis 等（整组开关，文件互相咬合，不支持单项） |
| 提示词 | `prompt/` | `AGENTS.md`、`prompt-inject.md` |
| 技能 | `skills/` | 每个技能目录 |
| 预设 | `presets/` | 每个预设 |
| 技能市场台账 | `storages-record/` | `skill-market-installed.json`、`skill-market-panel.json` |
| 插件配置 | `settings/` | 13 个配置文件（清单见上面「插件配置跟得走」一节），可单独排除 |
| 记忆 | `mnemon/` | 整目录（只有一项） |
| 本地插件 | `local-plugins/` | 每个 link 插件 |
| 工作区 | `workspace/` | 每个登记的工作区（登记表 `workspace-registry.json` 也只写勾选项） |
| 会话 | `conversations/` | 每个工作区对应的会话 |

- 勾选记在 `~\.dsh\config-sync-scope.json`，**跟本机走、不进仓库**（另一台机器各自勾）；文件里只留与默认不同的项，删掉这个文件就等于恢复全勾。
- 跳过**两侧都生效**：`capture.ps1` 不抓（不再写进仓库）、`apply.ps1` 不还原（不动本机）。`-PruneSkills` 也不会把"你勾掉的本机技能"当成多出来的项删掉。
- 卡里另有一个开关「取消勾选时顺手删掉云端副本」，**默认关闭**：关着时取消勾选只是"这边不再管它"，云端那份留着，重新勾上立刻继续同步；打开后取消勾选会真的删掉仓库里的对应目录/子路径（推送时删、提交后另一台机器也拉不到），**删除不可恢复**。
- 点不动的明细项（profile 五个文件、mnemon）是刻意做成"整组开关"：lock 与 package.json 的 specifier 必须一致，单独排除会装不起来。
- **`本机 profile` 这一组是必需内容，不能取消勾选**（面板上显示「必需」、复选框是灰的）。它不是"可省的一项"，而是 `apply.ps1` 的前置条件：仓库里没有 `profile\package.json` 或 `profile\cordis.patch.yml` 时，拉取会直接 `[X] 仓库内容不完整` 退出；同一组的 `profile\host-contract.json` 还是两台机器的版本一致性校验，丢了它版本不一致也照铺，客户端可能起不来。手改 `config-sync-scope.json` 把这一组写成 `false` 也无效：`capture.ps1` / `apply.ps1` 与面板都按"开启"处理（`Test-SyncGroupEnabled` 里钉死）。

## 自动同步 / 自动推送（两个开关，默认关）

| 开关 | 行为 |
|---|---|
| 启动时自动拉取 | 启动 8 秒后只读 `git fetch` 比对；落后 > 0 → 系统确认框（是/否）→ 选"是"**当场把客户端整族退出**（实测 5 秒内进程归零）→ 可见窗口跑拉取 → 拉完自动重启 |
| 退出时自动推送 | **三个来源任意命中就排队**：本地领先提交、未提交改动、本机资料比上次同步新（新会话等）。启动后每 2 分钟复查，已排队不重复拉起；等 DSH 完全退出后才 push，推完自动重启 |

- 动手都由插件拉起 `runtime\post-exit.ps1 -Phase wait`（**隐藏**进程）盯客户端退出；真退了才由它用 `-WindowStyle Normal` 起 `-Phase run` 的**可见**窗口干活，标题「DSH 配置同步 · 拉取/推送」。**排队期间不弹窗** —— 否则从开机到关机会一直挂着一个挡视线的空窗口。
- 仓库还没就位（含空目录）时首检直接跳过，且不记成"检查失败"——空目录只是等着拉取。
- **拉起方式踩过的坑**：`detached: true` 起 powershell 在 Windows 上会当场退出（日志一行都没有），改成短命 powershell 用 `Start-Process -PassThru` 起独立进程；`spawn()` 失败是异步的（只在 `error` 事件报），所以要等 launcher 退出码、拿不到 pid 就如实失败，并写 `~\.dsh\logs\auto-sync-launch.log`。
- **等退出不能只看 pid**：插件跑在子进程里，`process.pid` 不是客户端主进程 —— 按 pid 判断会出现"客户端在跑、等待进程以为它退了"，当场在运行期拉取。改成按进程名；另外「点了关闭但进程赖着不走」（实测 7 个进程 `hwnd=0` 存活 1 分钟以上）也认：活过 60 秒、无可见窗口持续 16 秒 → 结束残留进程再同步（`auto-sync-wait.log` 有记录）。
- **一个时刻只跑一次同步**：`~\.dsh\auto-sync.lock` 记 pid。启动首检排的 push 与用户确认的 pull 曾同时开工、并行改配置；现在后来者读锁：同种复用，不同种（手动优先）先结束那个还没开工的等待进程再改排。
- **退出客户端用整族结束**：`taskkill /PID <主进程>`（不带 `/F`）对 Electron 主进程无效（`This process can only be terminated forcefully`），改为 `/IM "DeepSeek Harness.exe"`，3.5 秒后再补 `/F`。
- **重启前清环境变量**：从插件链路起的客户端连续 3 次"起来就退"，干净 shell 跑同一个脚本却成功 —— 差在继承的 `ELECTRON_RUN_AS_NODE`（还有 `ELECTRON_NO_ATTACH_CONSOLE`/`NODE_OPTIONS`/`NODE_PATH`），清掉后一次成功；启动后还数进程、没活等 8 秒重试，最多 3 次。
- **拉取失败自动回滚**：`git reset --hard` 回原提交 → 用这次 apply 写盘前刚建的 `backups\config-<时间戳>` 跑 `restore.ps1` → 回滚成不成功都写日志，不完整会提示「请打开日志核对」。
- **拉取/推送都重启**：成功用新配置，失败用回滚后的原配置。重启成功后会刷新 `config-sync-state.json` 的 `lastSyncAt`，避免刚 apply 写过的文件被下一次首检误判成"待推送"。
- **进度窗口收尾**：拉取/推送跑完后窗口**不自动关闭**（原来停 3 秒自己消失，结果一闪就没了，看不到失败原因），改成把「同步已完成 / 日志路径」留在屏幕上，按任意键或点右上角 × 才退出。客户端是**在这之前**由 `explorer.exe` 代启的，跟这个窗口没有父子/作业关系，所以窗口留多久、还是被点 × 直接结束，都不会把客户端带走。`update`（退出后安装那一路）同样保留窗口，横幅写「插件更新已完成」；只有 `relaunch`（纯重启，窗口里没有可看的结果）仍旧停 3 秒自动关。
- 退出码：`0` 完成、`2` 等待超时、`3` 缺 sync.ps1、`4` 重启失败、`5` 同步失败（pull 已尝试回滚）。
- 「取消排队」只撤插件里的排队记录；已拉起的外部等待进程仍会等你退出，要停就手动结束它（`auto-sync-wait.log` / launch 日志有 pid）。

## 插件自更新（0.2.0 起）

面板「插件更新」卡显示本地版本、云端版本和一行状态；清单与安装包都在这个公开仓库里（`version.json` + `releases/dsh-config-sync-<版本>.tgz`，只读几百字节，不拉整包），服务端缓存 30 分钟，挂载时查一次、之后每 30 分钟复查。

| 状态 | 含义 |
|---|---|
| 绿色「已是最新」 | 本地版本 ≥ 清单版本 |
| 橙色「有新版本 x.y.z」 | 清单版本更大，附一句新版本说明和「下载更新 x.y.z」按钮 |
| 橙色「已下载，待安装」 | 包已经下到 `~\.dsh\update-staging\`（插件目录一个字节都没改），点「重启并安装」生效 |
| 橙色「已安装，待重启」 | 只出现在老路径上（运行中安装过但还没重启），点「重启 DSH」生效 |
| 红色「检查失败」 | 清单读不到（网络 / 仓库没建 / 404），附「检查更新」可强制重查，并逐个列出每个源的失败原因 |

- **清单有多个源，按顺序试**：内置候选是 `gh-proxy.com` → `ghfast.top` → GitHub raw，前两个是实时反代（实测 1 秒内拿到最新清单，tgz 也能从同一前缀拉下来）。国内直连 `raw.githubusercontent.com` 经常不通，而宿主的 `fetch` 是 Node 内置实现、**不读系统代理**，超时一到就被掐断（面板上一句 `This operation was aborted` 就是这么来的）。下载安装包同样按「读到清单的那个源 → 其余源」依次试，清单通不等于包也能从同一个域名下来。单次 30 秒超时。
- **别拿 jsDelivr 当清单源**：它把 `@main` 这类分支别名缓存很久，实测发版后仍返回上一版 `version.json`（`purge.jsdelivr.net` 也没立刻刷新生效），会让「有新版本」晚几个小时才出现，比读不到更误导。包体是按版本号命名的、不受这个缓存影响，但清单会被拖住。
- **私有库要填令牌**：如果把 `dsh-config` 私有库当清单源，匿名 raw 一律 403。更新相关的配置都集中在「插件更新」卡里（点「修改配置」进入编辑态）：「更新清单」留空即用内置候选，也可指向自建清单（**填了就只用你填的那个，不掺镜像**）；「更新令牌」填 Gitee 私人令牌后，清单和安装包都改走 API raw 端点（`/api/v5/repos/qcwygm/dsh-config/raw/<path>?ref=main&access_token=…`），分支用 `ref` 传、不能写进路径。令牌只存本机设置文件，不进仓库；留空保存表示"不改动已存令牌"，另给「清除已存令牌」按钮。相对路径的 `tgz` 会相对**实际读到的那份清单**解析，换地址不会拼错域名。
- 更新分两段（0.3.7 起）：**下载与安装分开**。点「下载更新 x.y.z」只把 tgz 下到 `~\.dsh\update-staging\dsh-config-sync-<版本>.tgz` 并校验 sha256，宿主不碰插件目录 —— 所以 DSH 不会重新同步插件树，你正在看的「配置同步」页面不会跳走。下载完按钮换成「重启并安装」，点它才退出：`spawnWatcher(-Mode update -UpdateTgz <本地包> -UpdateSha256 …)` → 关 DSH → 退出后的脚本备份旧目录（`~\.dsh\backups\plugin-<旧版本>-<时间>`）、覆盖安装、自动拉起新版本（`runtime\post-exit.ps1` 的 update 段，失败会用备份回滚）。安装发生在退出之后，全程只重启一次。
- 为什么不再运行中安装：0.3.4–0.3.6 是「DSH 不退出，直接覆盖插件目录」。实测这一步会让宿主把当前面板卸载掉 —— 用户看到的就是"更新到一半页面自己跳走了，得点回来才能按重启"。三步日志能对上：`11:41:55 覆盖安装` → `11:42:10 已启动 relaunch`，中间可见 15 秒空档。`POST {action:'install-live'}` 仍保留给 CLI/脚本，界面不再用；`POST {action:'apply'}`（退出后再下载安装）也保留。

## 作为插件市场的索引源

本仓库根目录的 `market-index.json` 就是一份可直接使用的 DSH 市场索引（`format: 1`，`source.type: git` + 40 位 commit，安装时从本仓库取包，无需构建）。索引地址：

```
https://raw.githubusercontent.com/QcWyGm/dsh-config-sync/main/market-index.json
```

在 DSH 里「插件 → 发现 → 索引源」填入上面的 URL，即可在列表里看到「配置同步」，点安装即按该 commit 拉取本仓库。

- **前提**：这是**宿主官方发现页**（`@deepseek-ai/dsh-plugin-market`）的索引源，需要 profile 启用官方 `@deepseek-ai/dsh-experimental-plugin-market-bundle` 组合包；没启用时「发现」页与索引源入口都不存在。
- **dshmarket 里搜不到，是正常的**：第三方市场插件 dshmarket 的列表只来自它自己的精选目录（`awesome-dsh-plugin.com/plugins.json`，国内走 npm 上的 `dsh-plugin-catalog`），源码里没有自定义索引源这条路（`lib/registry.js` 每次只从 region 路由表拉那一份目录，`lib/sources.js` 只解析该目录的条目），而且它的安装被限定在「该目录里列出的来源」，其它来源一律拒绝。所以自建索引再怎么标准，也不会出现在 dshmarket 的搜索结果里。要出现在那里，只能向 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 仓库提 PR 收录（它的 README 明确写着：别对 dshmarket 仓库提插件条目）。
- **国内取索引**：`raw.githubusercontent.com` 时通时不通，可以换 `https://gh-proxy.com/` 或 `https://ghfast.top/` 前缀；jsDelivr 的 `https://cdn.jsdelivr.net/gh/QcWyGm/dsh-config-sync@main/market-index.json` 也能用，但它对 `@main` 这类分支别名有缓存，发布后可能几小时才读到新版本。
- **只想自己装**：不必绕市场，直接 `dsh plugin add` 那份 tgz 就是最省事的路径（见上面的安装段）。

升级流程：改代码 → `pwsh -File tools\pack-plugin.ps1` 打包 `releases/dsh-config-sync-<版本>.tgz`（脚本会按 `package.json` 的 `files` 收内容，并自动把 sha256 回填进 `version.json`）→ 手动改 `version.json` 的 `version`（以及 `notes`）→ 把 `market-index.json` 里那条 `versions` 的 `version` 与 `commit` 换成新提交 → 推送。索引只引用 commit，所以旧版本也能随时装回。打完包先跑 `node tools\selftest.mjs <仓库路径>` + `node tools\clientcheck.mjs` 自检。

## 接口与路径

| 接口 | 说明 |
|---|---|
| `GET /config-sync/status` | 体检 JSON（含 `repo.source` / `repo.configured` / `repo.phase` / `repo.empty` / `repo.remoteHeads` / `repo.remoteFiles` / `repo.pushAllowed` / `repo.pullAllowed`、`remote.configured`、`remote.backupRoot` / `remote.backupRootCustom`、`backup.{root,defaultRoot,custom,count,latest,latestFiles,snapshots:[{name,dir,at,files,bytes,usable,plugins,bundles}]}`、`local.{lastSyncAt,pending,sample}`、`auto.lastResult`） |
| `POST /config-sync/prepare` | `{action:'push'\|'pull'\|'restore'\|'restore-backup'\|'all', message?, backupDir?}`，生成对应 `.cmd`；`all` 返回 `built: [...]`（本机仓库为空时按云端文件数分流：都空 → `['push','restore']`、云端有内容 → `['pull','restore']`，另一个进 `skipped`）；空目录上 `push` 只在云端 0 文件时放行（那次就是初始化推送），`pull` 也只在云端有文件时放行；`restore-backup` 必须给 `backupDir`（须是备份根之下、含 `profile\package.json` 的一份快照） |
| `POST /config-sync/settings` | `{repoPath?, remoteUrl?, sshKey?, autoPull?, autoPush?, autoRestart?, backupRoot?, clearBackupRoot?}`：校验 → 写设置 →（地址变了才动 git），失败回滚并 400；`backupRoot` 留空/`clearBackupRoot` = 回默认 `~\.dsh\backups`；空目录可以存，只有"有别的文件又不像仓库"才拒 |
| `POST /config-sync/auto` | `{action:'check'\|'pull-now'\|'push-now'\|'restore-preview'\|'restore-now'\|'cancel', backupDir?, closeNow?, restart?}`；`check` 只读 fetch 比对（本机仓库为空时短路返回 `pendingPull: true` 而不是报错），`pull-now`/`push-now`/`restore-now` 都不带 `/F` 关闭客户端（走正常退出，配置能存下来）；`push-now` 在空目录上 400；`restore-preview` 只读算差异（`pluginsRemove` / `pluginsInstall` / `willRemove` / `willOverwrite` / `willWrite`），`restore-now` 才是排队「退出后时点还原」；`status` 里 `auto.pending` 带 `reason`（为什么排队） |
| `GET/POST /config-sync/update` | `{action:'check'\|'install-live'\|'restart'\|'apply'}`：`check` 重新读清单（多源依次试）；`install-live` 运行中下载+校验+覆盖安装（不退出 DSH，回 `installed` 与 `restartRequired`）；`restart` 排队 relaunch 后关闭 DSH；`apply` 是「退出 DSH 后再安装」的兜底 |
| `GET/POST /config-sync/scope` | GET 回十组同步范围（每组 `{id,title,desc,enabled,items:[{id,label,enabled,excludable}]}` + `deleteCloud` + 本机文件 `path`）；POST `{deleteCloud?, groups:{id:{enabled?,excluded?}}}` 只落与默认不同的项（全勾的组不写文件），不存在的排除项会被清掉 |

跨站请求 403。客户端只 `fetch` 这几条，不 import 任何 `@deepseek-ai/dsh-client-*`，样式只用 `--dsw-alias-*` token。

路径：仓库按上面的优先级；客户端根 `config.appRoot` 优先，留空则由插件自身位置推出（插件装在 `<AppRoot>\dsh-config-sync-0.1.0`），换机不用改；`.dsh` 为 `config.dshHome` → `%DSH_HOME%` → `~\.dsh`。同步状态文件 `~\.dsh\config-sync-state.json` 由 `sync.ps1` 写，插件只读。本机私有文件：`config-sync-roots.json`（已确认的路径根）、`config-sync-pending-paths.json`（缺根跳过的项）、`config-sync-absolute-paths.json`（0.3.36：推送后扫出的根外绝对路径）、`config-sync-overwrite.json`（0.3.36：拉取覆盖了哪些本机配置 + 备份路径）。

**边界**：`capture` 要读 `cordis.patch.yml`，DSH 运行时这个文件正被应用持有，抓到的是半截状态；`apply` 写完以后，DSH 退出时又会回写覆盖。所以边界固定为：判断该跑什么、把命令写好，退出 DSH 后双击跑。同步机制、目录结构、换机与排障的完整说明在配置仓库根 `README.md`，本文只讲插件自身。

## 生成器里已经堵掉的坑

都是**在新机器上真跑一遍**才暴露的：

| 坑 | 处理 |
|---|---|
| cmd 的 `echo` 吃 `< > \| & ^ %`，`echo ... config-<时间戳>` 被当重定向、那句还不打印 | 动态文案全过 `echoSafe()`：`%`→`%%`，特殊符号前加 `^` |
| `chcp 65001` 后 `set /p` 读不到重定向输入，自动化喂 `y` 时 `GO` 为空、"执行结束"却没做事、退出码还是 0 | `--yes` 免确认 + 无确认时明确回执 |
| 新机器分支没有 upstream，`pull --ff-only` 报 *There is no tracking information…*，PS 5.1 包成 NativeCommandError 后脚本继续走 | `sync.ps1` 先探 upstream，没有就 `pull --ff-only origin <branch>` 再 `set-upstream-to`；push 带 `-u` |
| `GIT_SSH_COMMAND` 少了 ssh.exe 本体 → `/usr/bin/sh: - : invalid option` | 四分支：有 `core.sshCommand` 照用；找到 `ssh.exe` 写完整命令；只有私钥没 ssh.exe 就**不设变量**；无私钥交给 `.ssh\config` |
| 客户端 asar 打包时按路径找 AppRoot 全落空、bundle 全误报缺失 | `isAppRoot` 认 `app\package.json` **或** `app.asar`；版本与 bundle 存在性从 asar 里定向取（PS 5.1 `ConvertFrom-Json` 2 MB 上限，5.7 MB 头只能按 entry 偏移直读），判不了就当"不知道" |
| 插件目录已存在就跳过部署，tgz 更新了本机还是旧代码 | `apply.ps1` 比归档内 `package.json` 的 version 与已部署目录的 version（0.3.29 起；之前比 mtime，被 git checkout 刷时间害得每轮误判），不同才改名 `.bak-<时间戳>` 备份后重新部署 |
| 开了"退出时自动推送"却什么都不发生（无日志、无结果文件） | 两个叠因：①排队判据只看 `ahead > 0`，新会话还没 capture 时恒为 0 → 改成三个来源都算 + 每 2 分钟复查；②`spawn` 假成功（`detached` 起 powershell 当场退出 / `spawn` 失败只在 `error` 事件报）→ 改用 `Start-Process` 起独立进程 + 等 launcher 退出码 + 写 `auto-sync-launch.log` |
| 空目录被当成"仓库坏了"，面板红字 + 推送按钮可点但必失败 | 0.3.26 起按 `repo.phase` 分四态：空目录只放行拉取，`prepare(push)` / `push-now` / `sync.ps1 push` 三层都拦住 |
| 「云端到底有没有东西可拉」看分支数 → 远端 `main` 还在、树被删空了仍被判「有内容，只许拉取」，拉下来是空目录、状态不动，初始化推送入口永不出现（死循环，实测 Gitee 上就是这情形：98 个提交、最后 12 个全是"删除文件"、最新树 0 文件） | 0.3.36 起判据换成**分支树里的文件数**：`ls-remote --heads` 先数分支（0 个直接算空），有分支才临时 bare 仓库 `fetch --depth 1 --filter=blob:none` + `ls-tree -r` 数文件，探完删目录；`remoteFiles===0` 一律算「两边都空」→ 只放行推送，且 `sync.ps1` 用 `--force-with-lease` 覆盖那个空分支（树是空的，不丢数据） |
| 拉取整份覆盖 settings，改完路径没推送就拉取 → 刚改的值被静默盖回去（只有备份目录，没有提示） | 0.3.36 起覆盖前比对（归一化成占位符 + CRLF 拉平 + `our-free-model.json` 三个时间戳字段一起置 0），不同就写 `config-sync-overwrite.json` 并在面板/控制台说「有 N 份被覆盖、本机改动已先备份」 |

会话 header `cwd`、空快照兜底、`Get-FileHash` 缺失这几类问题由仓库里的 `apply.ps1` / `restore.ps1` / `dsh-sync-common.ps1` 处理，细节见根 `README.md` 第 5、10 节。

## 自检

- `node tools\selftest.mjs <仓库路径>`：假 ctx 拉起宿主半身，打 status、生成脚本、断言 JSON 与落地文件；会先备份仓库根已有的同名 `同步-*.cmd`，断言完原样还原。**必须显式传仓库路径**。
- `node tools\clientcheck.mjs`：假 `__ModuleLoader__` + react 替身跑客户端半身，断言模块能加载、`apply()` 三处注册成功（侧栏行与 main 的 id/key 成对）、`inject` 返回回收函数、组件在无数据下渲染不抛。验的是契约与结构，UI 效果仍需重启后目视。
- `pwsh -File tools\pack-plugin.ps1`：打包并把 sha256 回填 `version.json`。**必须用 PowerShell 7 跑**（脚本是无 BOM 的 UTF-8，5.1 按 GBK 读会把中文认错）。

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
| 空目录语义（0.3.26） | 隔离环境实测：`repoPhase` 八种形态判定全对（含 8.3 短名路径）；空目录跑 `sync.ps1 push` 被拦（退出码 1、未生成 `.git`）；同一目录跑 `pull` 自动 `init → fetch → checkout main`，`apply.ps1` 随包就位 |

**同步边界**：工作区资料与会话会跟着走，但**默认工作区（`default-workspace`）不同步**（目录名按各机 `WorkspaceHome` 编码，目标机认不出，只会留下"历史为空"的空工作区）；`models/`、`*.whl`、`*.safetensors` 与任何 >100 MB 的文件也不进仓库。细节见根 `README.md` 第 4、5 节。

上一轮复审发现的 6 条问题（git 身份、跨机会话目录互相改写、写死 `origin/main`、结束文案、重复逻辑、死代码）**已全部整改并验证**，对照表在根 `README.md` 第 12 节。