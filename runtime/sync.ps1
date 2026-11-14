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

# 本动作的未同步清单从这里起算（pull 也要清：上一轮 push 的清单不能挂到这次拉取头上）
Reset-SyncNotices $DshHome $Action

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

# ---------- 冲突协调（pull 专用） ----------
<#
  pull 被本地文件挡住时，git 只甩一句 "would be overwritten by merge" 就 Aborting；
  旧做法是整仓库 reset 回拉取前 —— 但「失败 → 回滚 → 再失败」会原地打转
  （真实案例：B 机落后 8 个提交，每次快进上去又被回滚打回 84f05a0，十几轮都推不上去）。
  现在改成：不猜、不硬回滚，先把「谁跟云端撞了」算清楚 + 把本机那份备份好 + 写成清单，
  面板列出来让用户逐项选「用本机 / 用云端」；选完再跑一次 pull，由本脚本按选择落地。
#>

function Get-ConflictPath { return (Join-Path $DshHome 'sync-conflicts.json') }

function Read-ConflictFile {
  $p = Get-ConflictPath
  if (-not (Test-Path -LiteralPath $p)) { return $null }
  try { return (Get-Content -LiteralPath $p -Raw -Encoding utf8 | ConvertFrom-Json) } catch { return $null }
}

function Write-ConflictFile($obj) {
  $text = ((($obj | ConvertTo-Json -Depth 8) -replace "`r`n", "`n") + "`n")
  [IO.File]::WriteAllText((Get-ConflictPath), $text, (New-Object Text.UTF8Encoding($false, $false)))
}

<#
  git 在中文目录下的路径输出会被八进制转义（"workspace/DSH\347\240\264..."），
  PowerShell 捕获外部程序输出时还会再按 ANSI 转一次码 —— 直接读 $raw 得到的路径没法用来操作文件。
  所以凡是要「按路径干活」的查询，一律 core.quotepath=false + cmd 字节重定向到临时文件 + 按 UTF-8 读。
#>
function Read-GitLines([string]$ArgLine) {
  $tmp = Join-Path ([IO.Path]::GetTempPath()) ('dsh-sync-' + [guid]::NewGuid().ToString('N') + '.txt')
  $cmdLine = '"' + $git + '" -C "' + $RepoRoot + '" -c core.quotepath=false ' + $ArgLine + ' > "' + $tmp + '" 2>nul'
  & "$env:ComSpec" /c $cmdLine | Out-Null
  $code = $LASTEXITCODE
  $lines = @()
  if (Test-Path -LiteralPath $tmp) {
    try {
      $txt = [IO.File]::ReadAllText($tmp, (New-Object Text.UTF8Encoding($false, $false)))
      $lines = @($txt -split "`n" | ForEach-Object { $_.TrimEnd("`r") } | Where-Object { $_ -ne '' })
    } catch { $lines = @() }
    Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
  }
  return [pscustomobject]@{ Lines = $lines; Code = $code }
}

# 取云端某版本文件的内容（文本）；取不到返回 $null
function Get-BlobText([string]$Spec) {
  $tmp = Join-Path ([IO.Path]::GetTempPath()) ('dsh-blob-' + [guid]::NewGuid().ToString('N') + '.txt')
  $cmdLine = '"' + $git + '" -C "' + $RepoRoot + '" show "' + $Spec + '" > "' + $tmp + '" 2>nul'
  & "$env:ComSpec" /c $cmdLine | Out-Null
  $code = $LASTEXITCODE
  $text = $null
  if ($code -eq 0 -and (Test-Path -LiteralPath $tmp)) {
    try { $text = [IO.File]::ReadAllText($tmp, (New-Object Text.UTF8Encoding($false, $false))) } catch { $text = $null }
  }
  if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue }
  return $text
}

function Test-BinaryPath([string]$Path) {
  $ext = [IO.Path]::GetExtension($Path).ToLowerInvariant()
  return ($ext -in @('.zstd', '.zip', '.tgz', '.gz', '.png', '.jpg', '.jpeg', '.db', '.sqlite', '.bin', '.exe', '.dll', '.node', '.pdf', '.ico', '.wav', '.mp4'))
}

# ---------- 冲突备份目录：命名、本机/云端两份副本 ----------
# 目录名带中英说明，打开 ~\.dsh\backups 一眼能看出这份是什么；
# 本机版与云端版分目录存放，面板对两边都能单独还原。
$ConflictBackupSuffix = '拉取冲突-Pull-conflict'
$ConflictLocalDirName = '本机-Local'
$ConflictCloudDirName = '云端-Cloud'
$ConflictReadmeName = '说明-README.txt'
$ConflictSnapshotName = '清单-Conflicts.json'

function Get-LocalCopyDir([string]$BackupDir) {
  $new = Join-Path $BackupDir $ConflictLocalDirName
  if (Test-Path -LiteralPath $new) { return $new }
  $old = Join-Path $BackupDir 'files'   # 0.3.17 最早那版用的目录名
  if (Test-Path -LiteralPath $old) { return $old }
  return $new
}

function Get-CloudCopyDir([string]$BackupDir) {
  $new = Join-Path $BackupDir $ConflictCloudDirName
  if (Test-Path -LiteralPath $new) { return $new }
  $old = Join-Path $BackupDir 'files-cloud'
  if (Test-Path -LiteralPath $old) { return $old }
  return $new
}

<#
  把 git 里的某个 blob（ref:path）按字节原样落盘。
  不能用 Get-Content/Set-Content 中转 —— .zstd/.tgz 这类二进制会被转码写坏；
  这里走 cmd 的 > 重定向（与 Read-GitLines 同一套），写完核对字节数。
#>
function Save-BlobToFile([string]$Spec, [string]$DstPath, [int64]$ExpectSize = -1) {
  $dir = Split-Path -Parent $DstPath
  if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
  $cmdLine = '"' + $git + '" -C "' + $RepoRoot + '" cat-file blob "' + $Spec + '" > "' + $DstPath + '" 2>nul'
  & "$env:ComSpec" /c $cmdLine | Out-Null
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $DstPath)) { return $false }
  if ($ExpectSize -ge 0) {
    try { if ((Get-Item -LiteralPath $DstPath -Force).Length -ne $ExpectSize) { return $false } } catch { return $false }
  }
  return $true
}

function Write-ConflictReadme([string]$BackupDir, $Report) {
  $lines = @(
    'DSH 配置同步 —— 拉取冲突备份',
    'DSH config sync — pull conflict backup',
    '',
    ('生成时间 / Created at        : ' + $Report.at),
    ('仓库目录 / Repo directory    : ' + $Report.repo),
    ('同步前 HEAD / HEAD before    : ' + $Report.head),
    ('云端引用 / Remote ref        : ' + $Report.remote),
    ('云端 HEAD / Remote head      : ' + $Report.remoteHead),
    ('冲突条目 / Conflicting files : ' + @($Report.items).Count),
    '',
    '目录里有什么 / What is inside',
    ('  ' + $ConflictLocalDirName + '\      每个冲突文件的「本机版本」（冲突发生时工作区的原始内容）'),
    ('  ' + $ConflictCloudDirName + '\      每个冲突文件的「云端版本」（git show ' + $Report.remote + ':<路径>）'),
    ('  ' + $ConflictSnapshotName + '   本次冲突清单快照（JSON，含每项当时的选择）'),
    ('  说明-README.txt             本文件（中英双语）'),
    '',
    '两种副本都在这里，结构与本机仓库一一对应（相对路径相同）。',
    'Both copies are kept here, mirroring the repo layout (same relative paths).',
    '',
    '怎么还原 / How to restore',
    '  面板 / Panel：配置同步 → 同步冲突 → 展开任一项 → 「还原本机副本」或「还原云端副本」。',
    '                Config sync → Sync conflicts → expand a row → "Restore local copy" / "Restore cloud copy".',
    '  命令行 / CLI：把本目录里对应副本复制回仓库的同名路径即可。',
    '                Copy the corresponding file from this folder back to the same path in the repo.',
    '',
    '还原任意一份都不会删除另一份，也不改写 git 历史。',
    'Restoring one never deletes the other and never rewrites git history.',
    '',
    '条目明细 / Files'
  )
  foreach ($it in @($Report.items)) {
    $lines += ('  ' + $it.path + '  [' + $it.kind + ']  本机/Local ' + $it.localSize + 'B（备份 ' + $it.localSaved + '）  云端/Cloud ' + $it.remoteSize + 'B（备份 ' + $it.cloudSaved + '）')
  }
  $text = (($lines -join "`r`n") + "`r`n")
  [IO.File]::WriteAllText((Join-Path $BackupDir $ConflictReadmeName), $text, (New-Object Text.UTF8Encoding($false, $false)))
}

function Get-PreviewText([string]$Text, [int]$Max = 1500) {
  if ($null -eq $Text) { return '' }
  if ($Text.Length -eq 0) { return '' }
  # 二进制内容不往 JSON 里塞：含 NUL 就整体放弃预览
  if ($Text.IndexOf([char]0) -ge 0) { return '' }
  if ($Text.Length -gt $Max) { return ($Text.Substring(0, $Max) + "`n…[已截断，原文共 " + $Text.Length + " 字符]") }
  return $Text
}

<#
  算出「本地会被云端覆盖、因而挡住快进」的文件，落一份备份 + 清单 JSON，返回条目数（0 = 没冲突）。
  只认 ff 可行的场景：本地领先远端时不叫冲突，那是另一回事（pull --ff-only 会明确报 not possible to fast-forward）。
#>
function New-ConflictReport([string]$RemoteRef, [string]$HeadBefore) {
  $cloud = @((Read-GitLines ('diff --name-only HEAD ' + $RemoteRef)).Lines)
  if ($cloud.Count -eq 0) { return 0 }
  $untracked = @((Read-GitLines 'ls-files --others --exclude-standard').Lines)
  $modified = @((Read-GitLines 'diff --name-only').Lines)
  $remoteHead = (Get-GitText ('rev-parse --short ' + $RemoteRef)).Text

  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $backupDir = Join-Path (Join-Path $DshHome 'backups') ('conflict-' + $stamp + '-' + $ConflictBackupSuffix)
  $localDir = Join-Path $backupDir $ConflictLocalDirName
  $cloudDir = Join-Path $backupDir $ConflictCloudDirName
  $items = @()
  foreach ($rel in $cloud) {
    $isUntracked = ($untracked -contains $rel)
    $isModified = ($modified -contains $rel)
    if (-not ($isUntracked -or $isModified)) { continue }
    $full = Join-Path $RepoRoot $rel
    $kind = 'modified'
    if ($isUntracked) { $kind = 'untracked' }
    $localSize = 0
    $localSaved = $false
    if (Test-Path -LiteralPath $full) {
      try { $localSize = (Get-Item -LiteralPath $full -Force).Length } catch { $localSize = 0 }
      $dst = Join-Path $localDir $rel
      New-Item -ItemType Directory -Path (Split-Path -Parent $dst) -Force | Out-Null
      Copy-Item -LiteralPath $full -Destination $dst -Force
      try { $localSaved = ((Get-Item -LiteralPath $dst -Force).Length -eq $localSize) } catch { $localSaved = $false }
      if (-not $localSaved) { Warn ('本机副本备份校验失败：' + $rel + '（这一项只能用云端副本）') }
    }
    $remoteSize = 0
    $sz = (Get-GitText ('cat-file -s "' + $RemoteRef + ':' + $rel + '"')).Text
    if ($sz -match '^\d+$') { $remoteSize = [int64]$sz }
    # 云端也留一份，且必须字节原样：Save-BlobToFile 走 cmd 重定向，不经 PowerShell 转码
    $cloudSaved = Save-BlobToFile ($RemoteRef + ':' + $rel) (Join-Path $cloudDir $rel) $remoteSize
    if (-not $cloudSaved) { Warn ('云端副本备份失败：' + $rel + '（这一项只能用本机副本）') }
    $binary = Test-BinaryPath $rel
    $localPreview = ''
    $remotePreview = ''
    if (-not $binary) {
      if (Test-Path -LiteralPath $full) {
        try { $localPreview = Get-PreviewText ([IO.File]::ReadAllText($full, (New-Object Text.UTF8Encoding($false, $false))) ) } catch { $localPreview = '' }
      }
      $remotePreview = Get-PreviewText (Get-BlobText ($RemoteRef + ':' + $rel))
    }
    $items += [ordered]@{
      path          = $rel
      kind          = $kind
      localSize     = $localSize
      remoteSize    = $remoteSize
      binary        = $binary
      localPreview  = $localPreview
      remotePreview = $remotePreview
      localSaved    = $localSaved
      cloudSaved    = $cloudSaved
      choice        = ''
    }
  }
  if ($items.Count -eq 0) { return 0 }
  $report = [ordered]@{
    at         = (Get-Date).ToString('o')
    repo       = $RepoRoot
    head       = $HeadBefore
    remote     = $RemoteRef
    remoteHead = $remoteHead
    backupDir  = $backupDir
    items      = $items
  }
  Write-ConflictFile $report
  Write-ConflictReadme $backupDir $report
  # 清单本身留一份在备份目录里，事后能核对「当时给了哪些选项、选了哪边」
  try { [IO.File]::Copy((Get-ConflictPath), (Join-Path $backupDir $ConflictSnapshotName), $true) } catch { }
  return $items.Count
}

<#
  按清单里的 choice 落地：
    cloud —— 删掉工作区那份（备份已在 conflict-<ts>\files），让云端版本能落地
    local —— 同样先删（已备份）；pull 成功后由 Restore-LocalKept 写回，成为本地改动，下次 push 带上
    ''    —— 没选，保持原样（这次 pull 仍会被它挡住）
  只删普通文件：目录/链接不动，避免误删整棵会话树。
#>
function Resolve-ConflictChoices($Report) {
  $cloud = 0; $local = 0; $pending = 0
  foreach ($it in @($Report.items)) {
    $choice = [string]$it.choice
    $full = Join-Path $RepoRoot $it.path
    if ($choice -eq 'cloud' -or $choice -eq 'local') {
      if (Test-Path -LiteralPath $full) {
        try {
          $info = Get-Item -LiteralPath $full -Force
          if (-not $info.PSIsContainer) { Remove-Item -LiteralPath $full -Force }
        } catch { Warn ('清不掉：' + $it.path + ' — ' + $_.Exception.Message) }
      }
      if ($choice -eq 'cloud') { $cloud++ } else { $local++ }
    } else { $pending++ }
  }
  return [pscustomobject]@{ Cloud = $cloud; Local = $local; Pending = $pending }
}

function Restore-LocalKept($Report) {
  $n = 0
  foreach ($it in @($Report.items)) {
    if ([string]$it.choice -ne 'local') { continue }
    $src = Join-Path (Get-LocalCopyDir $Report.backupDir) $it.path
    if (-not (Test-Path -LiteralPath $src)) { continue }
    $dst = Join-Path $RepoRoot $it.path
    New-Item -ItemType Directory -Path (Split-Path -Parent $dst) -Force | Out-Null
    Copy-Item -LiteralPath $src -Destination $dst -Force
    $n++
  }
  return $n
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
# 云端地址：插件设置里那份（面板保存的就是它）。读不到返回空串，由调用方决定怎么报。
function Get-SettingsRemoteUrl {
  $settingsFile = Join-Path $DshHome 'dsh-config-sync.json'
  if (-not (Test-Path -LiteralPath $settingsFile)) { return '' }
  try {
    $obj = Get-Content -LiteralPath $settingsFile -Raw -Encoding utf8 | ConvertFrom-Json
    if ($obj.remoteUrl) { return [string]$obj.remoteUrl }
  } catch { }
  return ''
}

<#
  云端仓库有几个分支：0 = 空仓库（还没推过任何东西），-1 = 连不上/没配地址（判不了）。
  只服务一处判断：本机还是空目录时，云端到底有没有东西可拉 —— 没有就允许「初始化推送」。
  用 ls-remote 而不是 fetch：纯查询，不写本地 refs，失败也不留半截状态。
#>
function Get-RemoteHeads([string]$RemoteUrl) {
  if (-not $RemoteUrl) { return -1 }
  $line = '"' + $git + '" ls-remote --heads "' + $RemoteUrl + '" 2>&1'
  $out = (@(& "$env:ComSpec" /c $line) -join "`n")
  if ($LASTEXITCODE -ne 0) { return -1 }
  return @($out -split "`n" | Where-Object { $_ -match 'refs/heads/' }).Count
}

function Get-RemoteFileCount([string]$RemoteUrl, [int]$Heads = -2) {
  # 「云端有没有可拉的内容」不能看分支数：远端 main 还在、树被删空了，照样是个空仓库。
  # 真判据是分支树里的文件数。做法：临时 bare 仓库浅取一次再 ls-tree，探完删掉，不碰用户仓库。
  # 返回 -1 = 判不了（连不上/认证失败/没配地址）。
  if (-not $RemoteUrl) { return -1 }
  $h = if ($Heads -eq -2) { Get-RemoteHeads $RemoteUrl } else { $Heads }
  if ($h -lt 0) { return -1 }
  if ($h -eq 0) { return 0 }
  $tmp = Join-Path ([IO.Path]::GetTempPath()) ('dcs-probe-' + [Guid]::NewGuid().ToString('N').Substring(0, 10))
  try {
    & "$env:ComSpec" /c ('"' + $git + '" init --bare --quiet "' + $tmp + '" 2>&1') | Out-Null
    if ($LASTEXITCODE -ne 0) { return -1 }
    # 优先只取树对象（partial clone）；远端不认就退回普通浅取
    $line = '"' + $git + '" -C "' + $tmp + '" fetch --depth 1 --no-tags --filter=blob:none "' + $RemoteUrl + '" HEAD 2>&1'
    & "$env:ComSpec" /c $line | Out-Null
    if ($LASTEXITCODE -ne 0) {
      $line = '"' + $git + '" -C "' + $tmp + '" fetch --depth 1 --no-tags "' + $RemoteUrl + '" HEAD 2>&1'
      & "$env:ComSpec" /c $line | Out-Null
      if ($LASTEXITCODE -ne 0) { return -1 }
    }
    $treeLine = '"' + $git + '" -C "' + $tmp + '" ls-tree -r --name-only FETCH_HEAD 2>nul'
    $out = (@(& "$env:ComSpec" /c $treeLine) -join "`n")
    return @($out -split "`n" | Where-Object { $_ -and ([string]$_).Trim() }).Count
  } finally {
    if (Test-Path -LiteralPath $tmp) { try { Remove-Item -LiteralPath $tmp -Recurse -Force } catch { } }
  }
}

<#
  初始化推送：本机空目录 + 云端空仓库，把本机配置当作仓库的初始内容推上去。
  骨架要一起带进仓库 —— 历史仓库本来就有 apply.ps1 / capture.ps1 / dsh-sync-common.ps1 这几份副本，
  少拷了它们，远端就变成「只有 settings 没有执行体」的半截仓库，另一台 pull 下来跑不起来。
  profile\host-contract.json 用本机客户端版本生成（apply 靠它校验两端版本，缺了只会跳过校验）。
#>
function Initialize-EmptyRepo([string]$RemoteUrl) {
  if (-not $RemoteUrl) {
    Die ("本机仓库还是空的（$RepoRoot），也没读到云端仓库地址：" +
      "请先在面板「云端仓库」里填好地址并保存，再重跑本脚本。")
  }
  if (-not (Test-Path -LiteralPath $RepoRoot)) { New-Item -ItemType Directory -Path $RepoRoot -Force | Out-Null }
  Say ""
  Say "== 初始化仓库（首次推送） =="
  Say "  目录：$RepoRoot"
  Say "  云端：$RemoteUrl（空仓库）"
  if (-not (Test-Path -LiteralPath (Join-Path $RepoRoot '.git'))) {
    $initLine = '"' + $git + '" -C "' + $RepoRoot + '" init --initial-branch=main 2>&1'
    & "$env:ComSpec" /c $initLine | Out-Null
    if ($LASTEXITCODE -ne 0) {
      & "$env:ComSpec" /c ('"' + $git + '" -C "' + $RepoRoot + '" init 2>&1') | Out-Null
      if ($LASTEXITCODE -ne 0) { Die "git init 失败：$RepoRoot" }
    }
  }
  $originUrl = (@(& "$env:ComSpec" /c ('"' + $git + '" -C "' + $RepoRoot + '" remote get-url origin 2>nul')) -join '').Trim()
  if ($originUrl) {
    & "$env:ComSpec" /c ('"' + $git + '" -C "' + $RepoRoot + '" remote set-url origin "' + $RemoteUrl + '" 2>&1') | Out-Null
  } else {
    & "$env:ComSpec" /c ('"' + $git + '" -C "' + $RepoRoot + '" remote add origin "' + $RemoteUrl + '" 2>&1') | Out-Null
  }
  if ($LASTEXITCODE -ne 0) { Die "给仓库加 origin 失败：$RemoteUrl" }

  $copied = 0
  foreach ($n in @('apply.ps1', 'capture.ps1', 'sync.ps1', 'restore.ps1', 'post-exit.ps1', 'dsh-sync-common.ps1')) {
    $src = Join-Path $PSScriptRoot $n
    if (Test-Path -LiteralPath $src) {
      Copy-Item -LiteralPath $src -Destination (Join-Path $RepoRoot $n) -Force
      $copied++
    }
  }
  if ($copied -gt 0) { Ok "已写入仓库骨架：$copied 个执行体（apply / capture / sync / restore / post-exit / common）" }
  # tools\fix-session-cwd.mjs 也随仓库同步（apply 在没有插件副本时会用它修会话工作目录），
  # 初始化骨架漏掉它，配置仓库就永远缺这一份，自检的逐字节一致性断言也会一直红。
  $toolSrc = Join-Path (Join-Path $PSScriptRoot 'tools') 'fix-session-cwd.mjs'
  if (Test-Path -LiteralPath $toolSrc) {
    $toolDst = Join-Path $RepoRoot 'tools'
    if (-not (Test-Path -LiteralPath $toolDst)) { New-Item -ItemType Directory -Path $toolDst -Force | Out-Null }
    Copy-Item -LiteralPath $toolSrc -Destination (Join-Path $toolDst 'fix-session-cwd.mjs') -Force
    Ok "已写入仓库骨架：tools\fix-session-cwd.mjs"
  }

  $contractPath = Join-Path $RepoRoot 'profile\host-contract.json'
  if (-not (Test-Path -LiteralPath $contractPath)) {
    $ver = ''
    $pkg = Join-Path $AppRoot 'resources\app\package.json'
    if (Test-Path -LiteralPath $pkg) {
      try { $ver = [string](Get-Content -LiteralPath $pkg -Raw -Encoding utf8 | ConvertFrom-Json).version } catch { }
    }
    if (-not $ver) {
      $vf = Join-Path $AppRoot 'version'
      if (Test-Path -LiteralPath $vf) { $ver = (Get-Content -LiteralPath $vf -Raw -Encoding utf8).Trim() }
    }
    if ($ver) {
      $dir = Join-Path $RepoRoot 'profile'
      if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
      $obj = [ordered]@{
        appVersion  = $ver
        generatedAt = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')
        note        = '由 dsh-config-sync 首次推送生成（客户端版本契约）'
      }
      [IO.File]::WriteAllText($contractPath, ($obj | ConvertTo-Json -Depth 4), (New-Object Text.UTF8Encoding $false))
      Ok "已写入版本契约：$ver"
    } else {
      Warn "读不到本机客户端版本，跳过 profile\host-contract.json（另一台 pull 时会跳过版本校验）"
    }
  }
  Ok "已初始化空仓库并指向 origin"
}

function Initialize-RepoIfNeeded {
  $gitDir = Join-Path $RepoRoot '.git'
  if ((Test-Path -LiteralPath $gitDir) -and (Test-Path -LiteralPath (Join-Path $RepoRoot 'sync.ps1'))) { return }
  $remote = Get-SettingsRemoteUrl
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
  if ($LASTEXITCODE -ne 0) { Die ("git fetch 失败：连不上远端或认证有问题（" + (Get-RemoteAuthHint $remote) + "，再重跑）。") }
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
  # 推送的三种起点，判据统一成「本机有没有历史 + 云端有没有内容」：
  #   有仓库有历史            → 正常推送（老逻辑照旧）
  #   本机没内容、云端有内容   → 只能先拉取（硬推会把本机状态写进一份已经在用的历史）
  #   本机没内容、云端也空     → 初始化推送：本机配置就是仓库的初始内容（新需求）
  $hasGit = Test-Path -LiteralPath (Join-Path $RepoRoot '.git')
  # 远端地址：仓库里已有 origin 就以它为准（用户/历史可能已经 remote set-url 过），没有才回落设置文件
  $remoteUrlForPush = ''
  if ($hasGit) {
    $remoteUrlForPush = (@(& "$env:ComSpec" /c ('"' + $git + '" -C "' + $RepoRoot + '" remote get-url origin 2>nul')) -join '').Trim()
  }
  if (-not $remoteUrlForPush) { $remoteUrlForPush = Get-SettingsRemoteUrl }
  $hasCommit = $false
  $remoteHadEmptyBranch = $false
  if ($hasGit) {
    $probe = @(& "$env:ComSpec" /c ('"' + $git + '" -C "' + $RepoRoot + '" rev-parse --verify HEAD 2>nul'))
    $hasCommit = (($probe -join '').Trim().Length -gt 0)
  }
  if (-not $hasCommit) {
    # 目录里已经有别的东西（非空、也不是本插件生成的 同步-*.cmd）→ 多半填错路径，别往里写
    if (Test-Path -LiteralPath $RepoRoot) {
      $stray = @(Get-ChildItem -LiteralPath $RepoRoot -Force |
        Where-Object { -not $_.Name.StartsWith('.') -and $_.Name -notmatch '^同步-[\s\S]*\.cmd$' })
      if ($stray.Count -gt 0) {
        # 例外：配置仓库本身就带本插件的脚本（clone 下来的仓库里一直有 sync.ps1 / capture.ps1 /
        # dsh-sync-common.ps1）。初始化推送更常见——capture 刚把 16 项配置写进来，目录当然非空。
        # 真填错路径（桌面、下载目录）不会有这些脚本，所以拿它们当「这是同步仓库」的凭据。
        $isSyncRepo = (Test-Path -LiteralPath (Join-Path $RepoRoot 'dsh-sync-common.ps1')) -or
                      (Test-Path -LiteralPath (Join-Path $RepoRoot 'sync.ps1')) -or
                      (Test-Path -LiteralPath (Join-Path $RepoRoot 'capture.ps1'))
        if (-not $isSyncRepo) {
          Warn ("这个目录不是空的（{0} 项：{1}），也不像 dsh-config 仓库：{2}" -f `
            $stray.Count, (($stray | Select-Object -First 3 | ForEach-Object { $_.Name }) -join '、'), $RepoRoot)
          Die "已停止（未抓取、未提交、未推送）。请在面板「本机仓库」里重新设路径。"
        }
      }
    }
    $headsForPush = Get-RemoteHeads $remoteUrlForPush
    $remoteFiles = Get-RemoteFileCount $remoteUrlForPush $headsForPush
    if ($remoteFiles -lt 0) {
      Warn "连不上云端、或还没配云端地址（$remoteUrlForPush）：初始化推送要先确认云端是空仓库"
      Die "已停止（未抓取、未提交、未推送）。请先确认「云端仓库」里的地址能访问，再重跑。"
    }
    if ($remoteFiles -gt 0) {
      Warn "云端仓库已经有内容（$remoteFiles 个文件）：本机还是空的，应该先拉取，而不是推送"
      Warn "硬推会把本机状态写进一份正在使用的历史里；新机器请点「立即拉取」"
      Die "已停止（未抓取、未提交、未推送）。"
    }
    # 远端已经有分支、但树里一个文件都没有（历史被删空过）：这次推送要覆盖那个空分支。
    # 树是空的，没有任何数据可丢，所以用 --force-with-lease（仍带远端 ref 校验，比 --force 安全）。
    if ($headsForPush -gt 0) {
      $remoteHadEmptyBranch = $true
      Say ""
      Say ("  云端已有 $headsForPush 个分支，但里面没有任何文件（历史被删空）——本次推送会覆盖这个空分支，不丢数据")
    }
    Initialize-EmptyRepo $remoteUrlForPush
  } else {
    # 有历史但缺仓库骨架：说明这目录本来不是 dsh-config 仓库（老仓库被删过脚本），照老规矩拒推
    if (-not (Test-Path -LiteralPath (Join-Path $RepoRoot 'apply.ps1'))) {
      Warn "仓库目录缺 apply.ps1（$RepoRoot）：推送只用于把本机改动提交进一个已有的仓库。"
      Die "已停止（未抓取、未提交、未推送）。"
    }
    Initialize-RepoIfNeeded
  }
  if ((Test-DshRunning) -and (-not $Force)) {
    Warn "检测到 DeepSeek Harness 在运行：capture 可能抓到写了一半的配置"
    Warn "建议完全退出（含托盘）后重跑；确认要继续可加 -Force"
    Die "已停止（未抓取、未提交）。"
  }
  $captureArgs = @{ RepoRoot = $RepoRoot; DshHome = $DshHome; ProfileName = $ProfileName; AppRoot = $AppRoot; WorkspaceHome = $WorkspaceHome; NoResetNotices = $true }
  if ($WorkspaceOnly) { $captureArgs['WorkspaceOnly'] = $true }
  if ($SkipWorkspace) { $captureArgs['SkipWorkspace'] = $true }
  & (Join-Path $PSScriptRoot 'capture.ps1') @captureArgs
  if ($LASTEXITCODE -ne 0) { Die "capture.ps1 未正常结束，已停止（未提交）。" }

  Say ""
  Say "== 提交 =="
  Initialize-CommitIdentity
  & $git -C $RepoRoot add -A
  $pending = @(& $git -C $RepoRoot diff --cached --name-only)

  # ---------- 单文件上限预检（提交前） ----------
  # capture 已在源头挡掉 workspace 里 >100MB 的资料，但仓库目录里仍可能有别处来的大文件
  # （手工放的、旧版本留下的、其它插件写的），`git add -A` 会照样收进索引，然后 push 被
  # 服务端 pre-receive 拒掉 —— 而旧版把这种拒收统称成「网络/认证」，把排查带偏。
  # 这里在提交前把超限文件从索引撤回（文件留在磁盘不动），其余内容照常提交、照常推送。
  $pushHardLimit = 95MB   # 100MB 是 Gitee/GitHub/GitLab 的判定线，留 5MB 余量，别卡边界
  $pushWarnLimit = 50MB
  if ($pending.Count -gt 0) {
    $tooLarge = @()
    foreach ($rel in $pending) {
      $full = Join-Path $RepoRoot $rel
      if (-not (Test-Path -LiteralPath $full)) { continue }   # 删除项没有体积
      try { $len = [long](Get-Item -LiteralPath $full -Force).Length } catch { continue }
      if ($len -ge $pushHardLimit) { $tooLarge += [pscustomobject]@{ Rel = [string]$rel; Bytes = $len } }
      elseif ($len -ge $pushWarnLimit) {
        Warn ('文件偏大（{0:N1} MB，接近 100 MB 上限）：{1}' -f ($len / 1MB), $rel)
      }
    }
    if ($tooLarge.Count -gt 0) {
      $excludeFile = Join-Path $RepoRoot '.git\info\exclude'
      $excludeDir = Split-Path -Parent $excludeFile
      if (-not (Test-Path -LiteralPath $excludeDir)) { New-Item -ItemType Directory -Path $excludeDir -Force | Out-Null }
      foreach ($o in $tooLarge) {
        $relPath = [string]$o.Rel
        & $git -C $RepoRoot reset -q -- $relPath 2>$null
        $exLine = '/' + $relPath.Replace([string][char]92, '/')
        try {
          $cur = if (Test-Path -LiteralPath $excludeFile) { Get-Content -LiteralPath $excludeFile -Raw -Encoding utf8 } else { '' }
          if ($cur -notmatch [regex]::Escape($exLine)) {
            Add-Content -LiteralPath $excludeFile -Value $exLine -Encoding utf8
          }
        } catch { }
        Warn ('超过单文件上限（{0:N1} MB ≥ {1:N0} MB），已从本次提交剔除：{2}' -f ($o.Bytes / 1MB), ($pushHardLimit / 1MB), $relPath)
        Add-SyncNotice -Kind 'too-large' -Path $relPath -Bytes $o.Bytes -Reason ('{0:N1} MB ≥ 单文件上限 {1:N0} MB，未提交也未推送' -f ($o.Bytes / 1MB), ($pushHardLimit / 1MB))
      }
      Warn '这些文件仍留在磁盘，只是不进仓库；已写进 .git\info\exclude，下次 add 不会再收进来。'
      $pending = @(& $git -C $RepoRoot diff --cached --name-only)
    }
  }

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

  # ---------- 历史里已有的超限文件：只报告，不改写历史 ----------
  # 远端拒收看的是「这次要推上去的所有对象」，而不只是工作区。索引预检只能挡住本次新增的，
  # 早先某个提交已经把大文件写进历史时，怎么 add / reset 都没用 —— 必须先让用户知道这条死路。
  $histTooLarge = @()
  $eapHist = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  $treeOut = @(& $git -C $RepoRoot ls-tree -r -l HEAD 2>$null)
  $ErrorActionPreference = $eapHist
  foreach ($line in $treeOut) {
    if ($line -match '^\d+\s+blob\s+[0-9a-f]+\s+(\d+)\t(.+)$') {
      $sz = [long]$Matches[1]
      if ($sz -ge $pushHardLimit) { $histTooLarge += [pscustomobject]@{ Rel = [string]$Matches[2]; Bytes = $sz } }
    }
  }
  if ($histTooLarge.Count -gt 0) {
    Warn ('历史提交里有 {0} 个超限文件：远端会拒收整次推送（不是网络问题）' -f $histTooLarge.Count)
    foreach ($o in @($histTooLarge | Select-Object -First 5)) {
      Warn ('  - {0}（{1:N1} MB）' -f $o.Rel, ($o.Bytes / 1MB))
    }
    if ($histTooLarge.Count -gt 5) { Warn ('  …还有 {0} 个' -f ($histTooLarge.Count - 5)) }
    foreach ($o in $histTooLarge) {
      Add-SyncNotice -Kind 'history' -Path $o.Rel -Bytes $o.Bytes -Reason ('历史提交里已有（{0:N1} MB），远端会拒收整次推送' -f ($o.Bytes / 1MB))
    }
    Warn '处理办法：①面板「初始化推送」到一份新的空仓库（配置同步不需要旧历史，最省事）；'
    Warn '          ②git filter-repo 把大文件从历史里摘掉再推（改写历史，需 force）。'
  }

  # 覆盖「有分支但空树」的远端：本地是全新历史，和远端没有共同祖先，不加 force 会被 non-fast-forward 拒。
  $forceFlag = if ($remoteHadEmptyBranch) { ' --force-with-lease' } else { '' }
  if ($upstream) {
    $pushLine = '"' + $git + '" -C "' + $RepoRoot + '" push' + $forceFlag + ' 2>&1'
  } else {
    Say "  当前分支 $branch 还没有 upstream，推送时一并建立 origin/$branch"
    $pushLine = '"' + $git + '" -C "' + $RepoRoot + '" push' + $forceFlag + ' -u origin "' + $branch + '" 2>&1'
  }
  # 输出要捕获再打印：旧版直接 Write-Host 之后只看退出码，远端那句
  # 「File xxx is 123MB; this exceeds ... limit」被淹没，失败结论却写成「网络/认证」。
  $eapPush = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  $pushOut = (& "$env:ComSpec" /c $pushLine 2>&1 | Out-String)
  $pushCode = $LASTEXITCODE
  $ErrorActionPreference = $eapPush
  foreach ($l in ($pushOut -split "`r?`n")) {
    if ($l -and $l.Trim()) { Say ('  ' + $l.TrimEnd()) }
  }
  if ($pushCode -ne 0) {
    $remoteOversized = @()
    foreach ($l in ($pushOut -split "`r?`n")) {
      if ($l -match 'File\s+(.+?)\s+is\s+([\d.]+)\s*MB.*exceeds.*limit') {
        $remoteOversized += [pscustomobject]@{ Rel = [string]$Matches[1]; Mb = [double]$Matches[2] }
      }
    }
    foreach ($o in $remoteOversized) {
      Add-SyncNotice -Kind 'too-large' -Path $o.Rel -Bytes ([long]($o.Mb * 1MB)) -Reason ('远端拒收：{0} MB 超过单文件上限' -f $o.Mb)
    }
    $quotaHit = [bool]($pushOut -match 'exceeds .*quota|repository size|total repository size|仓库容量|容量上限')
    $networkHit = [bool]($pushOut -match 'Could not read from remote|Permission denied|publickey|Host key verification|Could not resolve host|timed out|Connection refused|Operation timed out')
    $rejectedHit = [bool]($pushOut -match '\[remote rejected\]|pre-receive hook declined')

    if ($remoteOversized.Count -gt 0 -or $histTooLarge.Count -gt 0) {
      # 有具体文件名（远端报的）或历史预检命中：这是「文件超限」，不是网络
      $names = if ($remoteOversized.Count -gt 0) { $remoteOversized } else { $histTooLarge }
      $list = @($names | Select-Object -First 5 | ForEach-Object {
          $mb = if ($_.Bytes) { $_.Bytes / 1MB } else { $_.Mb }
          '  - ' + $_.Rel + '（' + ('{0:N1}' -f $mb) + ' MB）'
        })
      $msg = ("git push 被远端拒绝：{0} 个文件超过单文件上限（不是网络/SSH 问题）。" -f $names.Count) +
             "`n" + ($list -join "`n") +
             "`n      处理：①面板「初始化推送」到一份新的空仓库（配置同步不需要旧历史，最省事）；" +
             "②git filter-repo 把这些文件从历史摘掉再推（改写历史，需 force）。" +
             "`n      这些文件本身不进仓库，本地原件不动。"
      Die $msg
    }
    if ($quotaHit) {
      Die ("git push 被远端拒绝：仓库总量超限（Gitee 免费仓库 1GB）。当前仓库里有过多大文件或历史提交。" +
           "`n      处理：面板「初始化推送」到新仓库，或按上面的历史清理办法瘦身。")
    }
    if ($rejectedHit) {
      Die ("git push 被远端拒绝（remote rejected / pre-receive hook declined），原因见上面 remote: 那几行。" +
           "`n      改动已提交在本地，处理完远端限制后重跑 git -C `"$RepoRoot`" push 即可。")
    }
    if ($networkHit) {
      Die "git push 失败（网络/认证）。改动已提交在本地，修好网络后重跑：git -C `"$RepoRoot`" push；若是 GIT_SSH_COMMAND 问题，先确认它第一个词是 ssh.exe 本体"
    }
    Die ("git push 失败（原因见上面 remote: 那几行，既不是文件超限也不是已知的网络/认证特征）。" +
         "改动已提交在本地，修好后再重跑。")
  }
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

# ---- 冲突协调：先把上一轮用户的选择落地，再决定这次能不能直接快进 ----
$branchNow = (Get-GitText 'rev-parse --abbrev-ref HEAD').Text
$remoteRef = 'origin/' + $branchNow
$headBeforePull = (Get-GitText 'rev-parse HEAD').Text
$report = Read-ConflictFile
if ($report) {
  $rc = Resolve-ConflictChoices $report
  Say ("  上一轮选择：用云端 {0} 项，用本机 {1} 项，未选 {2} 项" -f $rc.Cloud, $rc.Local, $rc.Pending)
  if ($rc.Pending -gt 0) {
    Write-ConflictFile $report
    Die ("还有 {0} 项冲突没选：打开面板「同步冲突」逐项选「用本机 / 用云端」，再点「立即拉取」。`n        清单：{1}" -f $rc.Pending, (Get-ConflictPath))
  }
} else {
  # 没有清单：先 fetch（让 origin/<branch> 是最新的），再算「谁挡路」。
  # 有冲突就生成清单并停下等用户选，绝不 reset 回滚 —— 回滚会把已经快进上去的提交又打回去，越拉越死。
  $fetchOut = (& "$env:ComSpec" /c ('"' + $git + '" -C "' + $RepoRoot + '" fetch origin --prune 2>&1') 2>&1 | Out-String)
  if ($LASTEXITCODE -ne 0) {
    Say $fetchOut.TrimEnd()
    Die ("git fetch 失败：连不上远端或认证有问题（" + (Get-RemoteAuthHint (Get-GitText 'remote get-url origin').Text) + "，再重跑）。")
  }
  $anc = (Get-GitText ('merge-base --is-ancestor HEAD ' + $remoteRef))
  if ($anc.Code -eq 0) {
    $conflictCount = New-ConflictReport $remoteRef $headBeforePull
    if ($conflictCount -gt 0) {
      $rp = Read-ConflictFile
      Say ""
      Say ("  [!] 有 {0} 个本机文件会被云端版本覆盖，已备份本机副本并生成冲突清单" -f $conflictCount)
      Say ("      清单：{0}" -f (Get-ConflictPath))
      Say ("      备份：{0}" -f $rp.backupDir)
      Say "      打开面板「同步冲突」逐项选「用本机 / 用云端」，再点「立即拉取」"
      exit 6
    }
  }
}

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
         "②" + (Get-RemoteAuthHint (Get-GitText 'remote get-url origin').Text) + "；③再跑 git -C `"$RepoRoot`" ls-remote --heads origin 看退出码。")
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

# 拉取成功：把「用本机」的条目写回工作区（成为本地改动，下次 push 带上），然后清掉清单
$reportAfter = Read-ConflictFile
if ($reportAfter) {
  $back = Restore-LocalKept $reportAfter
  if ($back -gt 0) { Ok ("已把 {0} 个「用本机」的文件写回工作区（下次推送会带上）" -f $back) }
  Remove-Item -LiteralPath (Get-ConflictPath) -Force -ErrorAction SilentlyContinue
  Ok ("冲突清单已清除：{0}" -f (Get-ConflictPath))
}

Say ""
$applyArgs = @{ RepoRoot = $RepoRoot; DshHome = $DshHome; ProfileName = $ProfileName; AppRoot = $AppRoot; WorkspaceHome = $WorkspaceHome; NoResetNotices = $true }
if ($WorkspaceOnly) { $applyArgs['WorkspaceOnly'] = $true }
if ($SkipWorkspace) { $applyArgs['SkipWorkspace'] = $true }
if ($SkipInstall) { $applyArgs['SkipInstall'] = $true }
if ($AllowVersionDrift) { $applyArgs['AllowVersionDrift'] = $true }
if ($Force) { $applyArgs['Force'] = $true }
& (Join-Path $PSScriptRoot 'apply.ps1') @applyArgs
# apply 成功才算这次拉取生效：记下同步时间，面板据此把「本机待推送」清零
if ($LASTEXITCODE -eq 0) { Write-SyncState 'pull' }
exit $LASTEXITCODE
