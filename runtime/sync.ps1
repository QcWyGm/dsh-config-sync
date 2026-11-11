<#
DSH 配置同步 —— 一条命令入口（把原来的「capture + git add + commit + push」和「git pull + apply」各收成一次调用）

用法
  pwsh -File sync.ps1 status                                  # 看仓库状态、版本契约、bundle 数（不改任何东西）
  pwsh -File sync.ps1 push                                    # 本机 → 仓库 → 远端（改完插件/技能/配置后用这个）
  pwsh -File sync.ps1 pull                                    # 远端 → 本机（换机上工 / 另一台更新后同步用这个）

  pwsh -File sync.ps1 push -AppRoot "D:\DSH"                  # 客户端不在默认目录时必须显式传（两个子脚本都会收到）
  pwsh -File sync.ps1 push -Message "加了 xx 插件"            # 自定义提交信息（默认自动生成带机器名和时间）
  pwsh -File sync.ps1 pull -AllowVersionDrift                 # 两端客户端版本不同时，只同步配置（剔除实验性 bundle）
  pwsh -File sync.ps1 push -WorkspaceOnly                     # 只推工作区/会话
  pwsh -File sync.ps1 pull -SkipInstall                       # 只铺配置，不跑 pnpm install

设计要点
  - push 先跑 capture.ps1（本机 → 仓库），再 git add -A / commit / push，任何一步失败就停，不会带着半截状态继续。
  - pull 先 git pull --ff-only（有本地改动或冲突会直接失败，不去猜怎么合并），再跑 apply.ps1（含版本契约校验）。
  - 不动选项语义：所有开关原样透传给 capture.ps1 / apply.ps1，两个脚本仍可单独调用。
#>
param(
  [Parameter(Position = 0)]
  [ValidateSet('status', 'push', 'pull')]
  [string]$Action = 'status',
  [string]$RepoRoot,
  [string]$DshHome = $(Join-Path $env:USERPROFILE '.dsh'),
  [string]$ProfileName = 'desktop',
  [string]$AppRoot = '',
  [string]$WorkspaceHome = $(Join-Path $env:USERPROFILE 'Documents\deepseek-harness'),
  [string]$Message,
  [switch]$WorkspaceOnly,
  [switch]$SkipWorkspace,
  [switch]$SkipInstall,
  [switch]$AllowVersionDrift,
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
if (-not $RepoRoot) { $RepoRoot = $PSScriptRoot }
. (Join-Path $PSScriptRoot 'dsh-sync-common.ps1')

# git 位置探测统一在 dsh-sync-common.ps1 里（Get-GitExe），这里只决定找不到时怎么报
$git = Get-GitExe
if (-not $git) { Die "找不到 git.exe。请先安装 Git 并加入 PATH。" }

# 客户端装哪个盘不是固定的（会被卸载重装到别处），所以 -AppRoot 传进来的值先校验，
# 对不上就按注册表/常见位置重新定位 —— 老脚本里写死的旧路径因此不会把整条链路带偏。
$AppRootWasFallback = $false
$resolvedRoot = Resolve-DshAppRoot $AppRoot
if (-not $resolvedRoot) {
  Die ("找不到 DSH 客户端目录（传进来的 -AppRoot 对不上，注册表与常见位置也没有）。" +
       "装上客户端后重跑，或显式传 -AppRoot `<客户端根>`（目录里有 resources\app.asar 或 resources\app\package.json）。")
}
if ($AppRoot -and ($resolvedRoot -ne $AppRoot.TrimEnd('\', '/'))) {
  Warn "参数里的 -AppRoot（$AppRoot）对不上，已自动改用：$resolvedRoot"
  $AppRootWasFallback = $true
}
$AppRoot = $resolvedRoot
Say ""
Say "== DSH 配置同步 / $Action =="
Say "仓库：$RepoRoot"

function Get-RepoState {
  $branch = (& $git -C $RepoRoot rev-parse --abbrev-ref HEAD 2>$null)
  $head = (& $git -C $RepoRoot log -1 --oneline 2>$null)
  $dirty = @(& $git -C $RepoRoot status --porcelain 2>$null)
  return [pscustomobject]@{ Branch = $branch; Head = $head; Dirty = $dirty.Count }
}

<#
  本脚本开着 $ErrorActionPreference='Stop'：native 命令只要往 stderr 写了东西就会变成终止错误。
  git 的很多"探询"命令（如查 upstream 不存在时）正是往 stderr 报 fatal，会直接把整个脚本打断。
  所以这类只想要结果的命令统一交给 cmd 转发，丢掉 stderr，只看退出码和标准输出。
#>
function Get-GitText([string]$ArgLine) {
  $cmdLine = '"' + $git + '" -C "' + $RepoRoot + '" ' + $ArgLine + ' 2>nul'
  $raw = & "$env:ComSpec" /c $cmdLine
  # 注意：命令没有输出时 $raw 是 AutomationNull，[string] 转出来是 $null 而不是 ""，
  # 后面 .Trim() 就崩。用数组 join 兜住。
  $text = (@($raw) -join '').Trim()
  return [pscustomobject]@{ Text = $text; Code = $LASTEXITCODE }
}

# 当前分支与它的上游（新机器上 origin 是插件后补的，upstream 可能不存在，push/pull 都要据此决定带不带 -u）
function Get-BranchUpstream {
  $b = (Get-GitText 'rev-parse --abbrev-ref HEAD').Text
  $u = Get-GitText 'rev-parse --abbrev-ref --symbolic-full-name "@{upstream}"'
  $up = if ($u.Code -eq 0 -and $u.Text) { $u.Text } else { $null }
  return [pscustomobject]@{ Branch = $b; Upstream = $up }
}

# 记下「上次与本仓库同步成功」的时刻，只写本机、不入库。
# 面板的「本机待推送」靠它当分水岭：会话/工作区资料写了新东西、但还没 capture 进仓库时，
# git status 是干净的，只看 git 会显示"一致"，把"本机有新内容没推"这件事藏起来。
function Write-SyncState([string]$Mode) {
  try {
    if (-not (Test-Path -LiteralPath $DshHome)) { New-Item -ItemType Directory -Path $DshHome -Force | Out-Null }
    $head = ''
    try { $head = ((& $git -C $RepoRoot log -1 --format='%h' 2>$null) | Out-String).Trim() } catch {}
    $state = [ordered]@{
      lastSyncAt = (Get-Date).ToString('o')
      mode       = $Mode
      repo       = $RepoRoot
      head       = $head
    }
    $text = ((($state | ConvertTo-Json -Depth 4) -replace "`r`n", "`n") + "`n")
    [IO.File]::WriteAllText((Join-Path $DshHome 'config-sync-state.json'), $text, (New-Object Text.UTF8Encoding($false, $false)))
  } catch {
    Warn ('写同步状态失败（不影响同步本身）：{0}' -f $_.Exception.Message)
  }
}

# git 的提交身份是**每台机器**一份：新机器上全局 user.name/email 往往是空的，
# 直接 commit 只会报 "Author identity unknown"，而 commit 的输出被 Out-Null 吞掉，
# 用户只看到「git commit 失败」，完全查不出原因（真实踩过）。
# 所以提交前先补仓库级身份：优先沿用已有配置，缺失才补一个能认出来的默认值。
function Initialize-CommitIdentity {
  $name = (Get-GitText 'config user.name').Text
  $mail = (Get-GitText 'config user.email').Text
  if ($name -and $mail) { return }
  $fallbackName = if ($env:COMPUTERNAME) { $env:COMPUTERNAME } else { 'dsh-config-sync' }
  if (-not $name) {
    & "$env:ComSpec" /c ('"' + $git + '" -C "' + $RepoRoot + '" config user.name "' + $fallbackName + '" 2>&1') | Out-Null
    Warn ("这台机器没设 git user.name，已给本仓库补上：{0}（只影响本仓库，可用 git config user.name 改）" -f $fallbackName)
  }
  if (-not $mail) {
    $fallbackMail = '{0}@localhost' -f ($fallbackName -replace '[^A-Za-z0-9\-_.]', '')
    & "$env:ComSpec" /c ('"' + $git + '" -C "' + $RepoRoot + '" config user.email "' + $fallbackMail + '" 2>&1') | Out-Null
    Warn ("这台机器没设 git user.email，已给本仓库补上：{0}" -f $fallbackMail)
  }
}

# ---------- status ----------
if ($Action -eq 'status') {
  $st = Get-RepoState
  Say "分支：$($st.Branch)"
  Say "HEAD：$($st.Head)"
  if ($st.Dirty -eq 0) { Ok "工作区干净" } else { Warn "工作区有 $($st.Dirty) 项未提交" }
  $app = Get-HostAppVersion $AppRoot
  $contract = $null
  $cp = Join-Path $RepoRoot 'profile\host-contract.json'
  if (Test-Path -LiteralPath $cp) {
    try { $contract = [string](Get-Content -LiteralPath $cp -Raw -Encoding utf8 | ConvertFrom-Json).appVersion } catch { $contract = $null }
  }
  if ($app -and $contract) {
    if ($app -eq $contract) { Ok "版本一致：app = $app" }
    else { Warn "版本不一致：本机 app = $app，仓库契约 = $contract（pull 会被拒绝，除非加 -AllowVersionDrift）" }
  } else {
    Warn ("版本信息不全：本机 app = {0}，仓库契约 = {1}" -f $app, $contract)
  }
  $pkg = Join-Path $RepoRoot 'profile\package.json'
  if (Test-Path -LiteralPath $pkg) {
    $b = @((Get-Content -LiteralPath $pkg -Raw -Encoding utf8 | ConvertFrom-Json).dsh.profile.bundles)
    Say "仓库 bundle 清单：$($b.Count) 项（其中实验性 $(@($b | Where-Object { $_ -like '@deepseek-ai/dsh-experimental-*' }).Count) 项）"
  }
  Say ""
  return
}

# ---------- 公共：判断 DSH 是否在跑（push 抓配置前提醒，pull 铺配置前必须退出） ----------
function Test-DshRunning {
  return [bool](Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue)
}

# ---------- 公共：仓库还没克隆时自己拉下来（新机器只装了插件的情况） ----------
<#
  插件在「本机仓库」里配的路径可能是新建的空目录、甚至还不存在（新机器还没 clone）。
  这里做首次初始化：建目录 → git init → 补 origin（地址取插件设置里的云端仓库）→ fetch → 切到 main。
  用 init+fetch+checkout 而不是 git clone，是因为目录里已经躺着插件生成的 同步-*.cmd，
  clone 会拒绝非空目录；这些 .cmd 不在版本库里，checkout 不会动它们。
#>
function Initialize-RepoIfNeeded {
  $gitDir = Join-Path $RepoRoot '.git'
  if ((Test-Path -LiteralPath $gitDir) -and (Test-Path -LiteralPath (Join-Path $RepoRoot 'sync.ps1'))) { return }
  $settingsFile = Join-Path $DshHome 'dsh-config-sync.json'
  $remote = ''
  if (Test-Path -LiteralPath $settingsFile) {
    try {
      $obj = Get-Content -LiteralPath $settingsFile -Raw -Encoding utf8 | ConvertFrom-Json
      if ($obj.remoteUrl) { $remote = [string]$obj.remoteUrl }
    } catch { }
  }
  if (-not (Test-Path -LiteralPath $RepoRoot)) { New-Item -ItemType Directory -Path $RepoRoot -Force | Out-Null }
  if (-not (Test-Path -LiteralPath $gitDir)) {
    if (-not $remote) { Die ("本机还没有仓库（$RepoRoot），也没读到云端仓库地址：" +
      "请先在插件面板「云端仓库」里填好地址并保存，再重跑本脚本。") }
    Say ""
    Say "== 首次初始化仓库 =="
    Say "  目录：$RepoRoot"
    Say "  云端：$remote"
    # 注意：本脚本 ErrorActionPreference=Stop，git 往 stderr 写的正常提示会被包成终止错误，
    # 所以每一步都交给 cmd 转发，只看退出码（和 Get-GitText 同一套做法）。
    $initLine = '"' + $git + '" -C "' + $RepoRoot + '" init --initial-branch=main 2>&1'
    & "$env:ComSpec" /c $initLine | Out-Null
    if ($LASTEXITCODE -ne 0) {
      & "$env:ComSpec" /c ('"' + $git + '" -C "' + $RepoRoot + '" init 2>&1') | Out-Null
      if ($LASTEXITCODE -ne 0) { Die "git init 失败：$RepoRoot" }
    }
    $originUrl = (@(& "$env:ComSpec" /c ('"' + $git + '" -C "' + $RepoRoot + '" remote get-url origin 2>nul')) -join '').Trim()
    if ($originUrl) {
      & "$env:ComSpec" /c ('"' + $git + '" -C "' + $RepoRoot + '" remote set-url origin "' + $remote + '" 2>&1') | Out-Null
    } else {
      & "$env:ComSpec" /c ('"' + $git + '" -C "' + $RepoRoot + '" remote add origin "' + $remote + '" 2>&1') | Out-Null
    }
    if ($LASTEXITCODE -ne 0) { Die "给仓库加 origin 失败：$remote" }
    Ok "已初始化空仓库并指向 origin"
  }
  Say ""
  Say "== 从云端拉取仓库内容 =="
  & "$env:ComSpec" /c ('"' + $git + '" -C "' + $RepoRoot + '" fetch origin 2>&1') | Write-Host
  if ($LASTEXITCODE -ne 0) { Die "git fetch 失败：连不上远端或认证有问题（先 ssh -T git@gitee.com 自检，再重跑）。" }
  $branchName = 'main'
  $heads = (@(& "$env:ComSpec" /c ('"' + $git + '" -C "' + $RepoRoot + '" ls-remote --heads origin 2>nul')) -join "`n")
  if ($heads -notmatch 'refs/heads/main') {
    $first = ($heads -split "`n" | Where-Object { $_ -match 'refs/heads/' } | Select-Object -First 1)
    if ($first -and $first -match 'refs/heads/(.+)$') { $branchName = $Matches[1].Trim() }
  }
  & "$env:ComSpec" /c ('"' + $git + '" -C "' + $RepoRoot + '" checkout -B ' + $branchName + ' origin/' + $branchName + ' 2>&1') | Write-Host
  if ($LASTEXITCODE -ne 0) { Die "从 origin/$branchName 检出失败（原因见上面的 git 输出）。" }
  Ok "仓库已就位：$RepoRoot（分支 $branchName）"
}

# ---------- push ----------
if ($Action -eq 'push') {
  Initialize-RepoIfNeeded
  if ((Test-DshRunning) -and (-not $Force)) {
    Warn "检测到 DeepSeek Harness 在运行：capture 可能抓到写了一半的配置"
    Warn "建议完全退出（含托盘）后重跑；确认要继续可加 -Force"
    Die "已停止（未抓取、未提交）。"
  }
  $captureArgs = @{ RepoRoot = $RepoRoot; DshHome = $DshHome; ProfileName = $ProfileName; AppRoot = $AppRoot; WorkspaceHome = $WorkspaceHome }
  if ($WorkspaceOnly) { $captureArgs['WorkspaceOnly'] = $true }
  if ($SkipWorkspace) { $captureArgs['SkipWorkspace'] = $true }
  & (Join-Path $PSScriptRoot 'capture.ps1') @captureArgs
  if ($LASTEXITCODE -ne 0) { Die "capture.ps1 未正常结束，已停止（未提交）。" }

  Say ""
  Say "== 提交 =="
  Initialize-CommitIdentity
  & $git -C $RepoRoot add -A
  $pending = @(& $git -C $RepoRoot diff --cached --name-only)
  if ($pending.Count -eq 0) {
    Ok "仓库与仓库文件一致，没有需要提交的改动"
  } else {
    if (-not $Message) {
      $Message = ("sync: capture {0} @ {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm'), $env:COMPUTERNAME)
    } elseif ($Message -notmatch '\d{1,2}:\d{2}') {
      # 面板/命令行给的是人写的说明：执行这一刻自动附上时间，免得写死在脚本里变成旧时间。
      $Message = ("{0} @ {1}" -f $Message.Trim(), (Get-Date -Format 'yyyy-MM-dd HH:mm'))
    }
    # 提交失败要把 git 的原话放出来（身份/钩子/索引锁都可能），别只报一句「commit 失败」。
    # 本脚本是 ErrorActionPreference=Stop，git 写 stderr 会被包成终止错误，所以临时放开。
    $eap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $commitOut = @(& $git -C $RepoRoot commit -m $Message 2>&1)
    $commitCode = $LASTEXITCODE
    $ErrorActionPreference = $eap
    $commitOut | ForEach-Object { if ($_ -and ([string]$_).Trim()) { Say ("  " + ([string]$_).Trim()) } }
    if ($commitCode -ne 0) {
      Die ("git commit 失败（退出码 {0}），原因见上面几行；改动已留在本地工作区，修好后重跑本脚本或手动 " +
           "git -C `"{1}`" commit。常见原因：没配 git user.name/user.email、有 .git/index.lock、pre-commit 钩子报错。" -f $commitCode, $RepoRoot)
    }
    Ok "已提交 $($pending.Count) 个文件：$Message"
  }

  Say ""
  Say "== 推送 =="
  # git push 的进度和 gitee 的 "remote: Powered by GITEE.COM" 横幅都走 stderr，
  # PowerShell 5.1 直接重定向会把这些行包成 NativeCommandError，明明成功却报失败。
  # 交给 cmd 转发，只看退出码，输出照原样显示。
  # 新机器的分支可能还没有 upstream（origin 是插件后补的），这时 push 要带 -u。
  $bs = Get-BranchUpstream
  $branch = $bs.Branch
  $upstream = $bs.Upstream
  if ($upstream) {
    $pushLine = '"' + $git + '" -C "' + $RepoRoot + '" push 2>&1'
  } else {
    Say "  当前分支 $branch 还没有 upstream，推送时一并建立 origin/$branch"
    $pushLine = '"' + $git + '" -C "' + $RepoRoot + '" push -u origin "' + $branch + '" 2>&1'
  }
  & "$env:ComSpec" /c $pushLine | Write-Host
  if ($LASTEXITCODE -ne 0) { Die "git push 失败（网络/认证）。改动已提交在本地，修好网络后重跑：git -C `"$RepoRoot`" push；若是 GIT_SSH_COMMAND 问题，先确认它第一个词是 ssh.exe 本体" }
  Ok "已推送：$(& $git -C $RepoRoot log -1 --oneline)"
  Write-SyncState 'push'
  Say "另一台机器执行：pwsh -File sync.ps1 pull"
  return
}

# ---------- pull ----------
Initialize-RepoIfNeeded
if ((Test-DshRunning) -and (-not $Force)) {
  Die "DeepSeek Harness 仍在运行。请完全退出（含托盘）后重跑，或加 -Force 强制继续。"
}
Say ""
Say "== 拉取 =="
# 新机器上 origin 可能是插件 later 补上的（remote add），这时分支没有 upstream，
# 裸 `git pull --ff-only` 会报 "There is no tracking information for the current branch"。
# 同时 git 的进度/提示都走 stderr，PowerShell 5.1 会包成 NativeCommandError 且 $LASTEXITCODE 不可靠，
# 所以和 push 一样交给 cmd 转发，只看退出码。
$bs = Get-BranchUpstream
$branch = $bs.Branch
$upstream = $bs.Upstream
if ($upstream) {
  $pullLine = '"' + $git + '" -C "' + $RepoRoot + '" pull --ff-only 2>&1'
} else {
  Say "  当前分支 $branch 还没有 upstream，按 origin/$branch 拉取并补上跟踪关系"
  $pullLine = '"' + $git + '" -C "' + $RepoRoot + '" pull --ff-only origin "' + $branch + '" 2>&1'
}
# 失败原因要分类再报：把「连不上远端/SSH 命令非法」说成「本地有改动」会把排查带偏
# （真实案例：GIT_SSH_COMMAND 少了 ssh.exe 本体，git 只说 Could not read from remote repository）。
$pullOut = (& "$env:ComSpec" /c $pullLine 2>&1 | Out-String)
Write-Host $pullOut.TrimEnd()
if ($LASTEXITCODE -ne 0) {
  if ($pullOut -match 'Could not read from remote|Permission denied|invalid option|Host key verification|publickey|Bad owner or permissions') {
    Die ("git pull 失败：连不上远端 / SSH 认证或命令有问题（不是本地改动）。先自检：" +
         "①GIT_SSH_COMMAND 第一个词必须是 ssh.exe 本体，可先 set GIT_SSH_COMMAND 什么都不设改用 .ssh\\config；" +
         "②私钥路径存在且无口令：ssh -T git@gitee.com；③再跑 git -C `"$RepoRoot`" ls-remote --heads origin 看退出码。")
  } elseif ($pullOut -match 'CONFLICT|not possible to fast-forward|Your local changes|overwritten by merge|would be overwritten') {
    Die ("git pull 失败：本地有未提交改动或与远端冲突。先处理（git -C `"$RepoRoot`" status / stash / 解决冲突）再重跑；" +
         "本脚本不会替你合并。")
  } else {
    Die "git pull 失败（原因见上面的 git 输出）。先把那几行原文看完再决定，别按「本地有改动」的思路瞎猜。"
  }
}
if (-not $upstream) {
  & "$env:ComSpec" /c ('"' + $git + '" -C "' + $RepoRoot + '" branch --set-upstream-to origin/' + $branch + ' 2>&1') | Out-Null
  if ($LASTEXITCODE -eq 0) { Ok "已把 $branch 的 upstream 设为 origin/$branch" }
}

Say ""
$applyArgs = @{ RepoRoot = $RepoRoot; DshHome = $DshHome; ProfileName = $ProfileName; AppRoot = $AppRoot; WorkspaceHome = $WorkspaceHome }
if ($WorkspaceOnly) { $applyArgs['WorkspaceOnly'] = $true }
if ($SkipWorkspace) { $applyArgs['SkipWorkspace'] = $true }
if ($SkipInstall) { $applyArgs['SkipInstall'] = $true }
if ($AllowVersionDrift) { $applyArgs['AllowVersionDrift'] = $true }
if ($Force) { $applyArgs['Force'] = $true }
& (Join-Path $PSScriptRoot 'apply.ps1') @applyArgs
# apply 成功才算这次拉取生效：记下同步时间，面板据此把「本机待推送」清零
if ($LASTEXITCODE -eq 0) { Write-SyncState 'pull' }
exit $LASTEXITCODE
