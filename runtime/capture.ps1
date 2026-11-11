<#
DSH 配置同步 —— 抓取脚本（把当前电脑的 DSH 配置收进仓库）

方向与 apply.ps1 相反：apply 是「仓库 → 本机」，capture 是「本机 → 仓库」。
改完插件/技能/预设后，先在本机跑一次 capture，再把仓库同步到另一台机器跑 apply。

用法
  pwsh -File capture.ps1                                  # 默认抓取（配置 + 全部工作区）
  pwsh -File capture.ps1 -AppRoot D:\DSH                  # 客户端不在 D:\DeepSeekHarness 时必须显式传
  pwsh -File capture.ps1 -PackLocalPlugins                # 同时把本地源码插件重新打包进 local-plugins
  pwsh -File capture.ps1 -NoMirrorSkills                  # 不删除仓库里本机已没有的 Skill（默认会镜像）
  pwsh -File capture.ps1 -WorkspaceOnly                   # 只抓工作区资料与登记表（不碰配置/插件/预设，无需本机装 DSH）
  pwsh -File capture.ps1 -SkipWorkspace                   # 跳过工作区同步（应急；默认全量同步所有工作区）
  pwsh -File capture.ps1 -NoMirrorWorkspace               # 不删除仓库里本机已没有的工作区/文件（默认镜像删除）
  pwsh -File capture.ps1 -WorkspaceHome "D:\其它\根"     # 非客户端目录下工作区根；capture 用它把这类路径归一成 {{WORKSPACE_HOME}}

工作区同步（默认开、全量）
  读 $DshHome\storages\workspace.json，把里面登记的**每一个**工作区都收进仓库的 workspace\<title>\ 分槽，
  同时写一份归一化登记表 workspace\workspace-registry.json：路径用 {{APP_ROOT}} / {{WORKSPACE_HOME}} 占位符，
  会话信息（sessionIds / 时间戳 / 归档与置顶会话）一并保留，ID/title 保留。资料用 Copy-Item 字节保真拷贝，
  绝不做 CRLF→LF 归一或 {{APP_ROOT}} 文本替换；工作区里的会话/日志/缓存目录按忽略清单过滤。
  B 机 apply 时按登记表把资料还原到展开后的路径，并按 ID 合并进本机 workspace.json（保留本机自建工作区）。

对话/会话数据同步（默认开、全量，随工作区一起；-SkipWorkspace 会连会话一起跳过）
  真正的工作区对话并不在工作区目录里，而在 $DshHome\sessions\、attachments\、
  storages\session_projcache\sessions\、storages\vision_router_session_policy\policies\ 四块，
  收进仓库的 conversations\ 下，全部字节保真（会话日志是 zstd 压缩流，绝不做文本替换）。
  sessions\ 的一级目录名原本是「工作区绝对路径」的编码（如 --D-DeepSeekHarness-Gitee~540C~6B65--），
  两台机器互推就会来回改名，所以仓库里改用**稳定名**：--ws-<工作区ID>--（ID 跨机不变）、im 固定 --im--，
  会话头 header 的 cwd 也归一成 {{APP_ROOT}} / {{WORKSPACE_HOME}} / {{DSH_HOME}} 占位符；
  换机器 apply 时按本机路径重新编码目录名并展开 cwd。目录名 ↔ 工作区ID 的对照仍记在
  conversations\session-index.json 里，旧的路径式目录名会在下次抓取时自动淘汰。

建议在 DSH 退出后执行，避免抓到写了一半的配置文件（-WorkspaceOnly 只碰工作区/会话，DSH 开着也能跑）。
#>
param(
  [string]$RepoRoot,
  [string]$DshHome = $(Join-Path $env:USERPROFILE '.dsh'),
  [string]$ProfileName = 'desktop',
  [string]$AppRoot = '',
  [switch]$PackLocalPlugins,
  [switch]$NoMirrorSkills,
  [switch]$WorkspaceOnly,
  [switch]$SkipWorkspace,
  [switch]$NoMirrorWorkspace,
  [string]$WorkspaceHome = $(Join-Path $env:USERPROFILE 'Documents\deepseek-harness')
)

$ErrorActionPreference = 'Stop'
if (-not $RepoRoot) { $RepoRoot = $PSScriptRoot }
. (Join-Path $PSScriptRoot 'dsh-sync-common.ps1')

# 客户端可能被卸载重装到别的盘：-AppRoot 先校验，对不上就自动定位（注册表 → 常见位置）。
$resolvedRoot = Resolve-DshAppRoot $AppRoot
if (-not $resolvedRoot) {
  Die ("找不到 DSH 客户端目录（传进来的 -AppRoot 对不上，注册表与常见位置也没有）。" +
       "装好客户端后重跑，或显式传 -AppRoot `<客户端根>`（目录里有 resources\app.asar 或 resources\app\package.json）。")
}
if ($AppRoot -and ($resolvedRoot -ne $AppRoot.TrimEnd('\', '/'))) { Warn "参数里的 -AppRoot（$AppRoot）对不上，已自动改用：$resolvedRoot" }
$AppRoot = $resolvedRoot

# ---------- 工作区资料同步 ----------
# 用户资料必须字节保真：绝不走 NormalizeTree(CRLF→LF) 或 CopyTracked(占位符文本替换)，
# 一律 Copy-Item -LiteralPath 原样拷；.gitattributes 的 workspace/** -text 让 git 也别改字节。
# （$BS / $WorkspaceHomeToken / $wsSkip* / Test-WorkspaceIgnored 都在 dsh-sync-common.ps1 里，两个脚本共用）

function Get-SlotName([string]$title, [string]$id) {
  $s = $title
  if ([string]::IsNullOrWhiteSpace($s)) { $s = $id }
  $s = ($s -replace '[\\/:*?<>|]', '_').Trim().TrimEnd('.')
  if ([string]::IsNullOrWhiteSpace($s)) { $s = $id }
  return $s
}

function ConvertTo-WorkspaceToken([string]$path) {
  # 把本机绝对路径换成占位符前缀：客户端目录下→{{APP_ROOT}}，其余→{{WORKSPACE_HOME}}
  $p = $path.Replace($BS,'/')
  $ar = $AppRoot.Replace($BS,'/').TrimEnd('/')
  if ($p -ieq $ar -or $p.StartsWith($ar + '/', [System.StringComparison]::OrdinalIgnoreCase)) {
    return ($AppRootToken + '/' + $p.Substring($ar.Length).TrimStart('/'))
  }
  $wh = $WorkspaceHome.Replace($BS,'/').TrimEnd('/')
  if ($wh -and ($p -ieq $wh -or $p.StartsWith($wh + '/', [System.StringComparison]::OrdinalIgnoreCase))) {
    return ($WorkspaceHomeToken + '/' + $p.Substring($wh.Length).TrimStart('/'))
  }
  # 兜底：既不在 AppRoot 也不在 WorkspaceHome 之下，就把父目录整体当 {{WORKSPACE_HOME}}，只留末段
  $leaf = @($p.TrimEnd('/') -split '/')[-1]
  Warn ('工作区路径不在 -AppRoot / -WorkspaceHome 之下，按父目录归一：{0} → {1}/{2}' -f $path, $WorkspaceHomeToken, $leaf)
  return ($WorkspaceHomeToken + '/' + $leaf)
}

function Sync-WorkspaceCapture {
  $wsDir = Join-Path $RepoRoot 'workspace'
  if (-not (Test-Path -LiteralPath $wsDir)) { New-Item -ItemType Directory -Path $wsDir -Force | Out-Null }
  $registrySrc = Join-Path $DshHome 'storages/workspace.json'
  if (-not (Test-Path -LiteralPath $registrySrc)) {
    Warn ('本机没有 {0}，跳过工作区枚举（仓库里已有的 workspace/ 保持不动）' -f $registrySrc)
    return
  }
  $reg = Get-Content -LiteralPath $registrySrc -Raw -Encoding UTF8 | ConvertFrom-Json
  $table = $reg.tables.workspaces
  $entries = @()
  if ($table) {
    foreach ($prop in $table.PSObject.Properties) {
      $w = $prop.Value
      $title = if ($w.title) { [string]$w.title } else { $prop.Name }
      $entries += [pscustomobject]@{
        Id                 = $prop.Name
        Title              = $title
        LocalPath          = [string]$w.path
        Slot               = ''
        SessionIds         = @($w.sessionIds         | ForEach-Object { [string]$_ })
        ArchivedSessionIds = @($w.archivedSessionIds | ForEach-Object { [string]$_ })
        PinnedSessionIds   = @($w.pinnedSessionIds   | ForEach-Object { [string]$_ })
        CreatedAt          = [string]$w.createdAt
        UpdatedAt          = [string]$w.updatedAt
      }
    }
  }
  # 按 ID 排序，保证登记表稳定（反复 capture 不产生假 diff）
  $entries = @($entries | Sort-Object Id)
  $used = @{}
  foreach ($e in $entries) {
    $slot = Get-SlotName $e.Title $e.Id
    if ($used.ContainsKey($slot)) { $slot = Get-SlotName $e.Id $e.Id }
    $n = 1
    while ($used.ContainsKey($slot)) { $slot = (Get-SlotName $e.Title $e.Id) + '-' + $n; $n++ }
    $used[$slot] = $true
    $e.Slot = $slot
  }

  # 归一化登记表：路径用占位符；会话信息与时间戳一并保留（B 机工作台要能看到历史对话）
  $wsList = @()
  foreach ($e in $entries) {
    $wsList += [ordered]@{
      id                 = $e.Id
      title              = $e.Title
      slot               = $e.Slot
      path               = (ConvertTo-WorkspaceToken $e.LocalPath)
      sessionIds         = @($e.SessionIds)
      archivedSessionIds = @($e.ArchivedSessionIds)
      pinnedSessionIds   = @($e.PinnedSessionIds)
      createdAt          = $e.CreatedAt
      updatedAt          = $e.UpdatedAt
    }
  }
  $g = $reg.global
  $gDefault = if ($g) { [string]$g.defaultWorkspaceId } else { '' }
  $allIds = @($entries | ForEach-Object { $_.Id })
  $manifest = [ordered]@{}
  $manifest['unit'] = [ordered]@{ name = 'dsh-workspace-sync'; version = 1 }
  $manifest['workspaces'] = @($wsList)
  $manifest['global'] = [ordered]@{
    initialized        = $true
    defaultWorkspaceId = $gDefault
    workspaceIds       = $allIds
    archivedSessionIds = $(if ($g) { @($g.archivedSessionIds | ForEach-Object { [string]$_ }) } else { @() })
    pinnedSessionIds   = $(if ($g) { @($g.pinnedSessionIds   | ForEach-Object { [string]$_ }) } else { @() })
  }
  $manifestText = (($manifest | ConvertTo-Json -Depth 12) -replace "`r`n", "`n") + "`n"
  $manifestPath = Join-Path $wsDir 'workspace-registry.json'
  $old = $null
  if (Test-Path -LiteralPath $manifestPath) { $old = [IO.File]::ReadAllText($manifestPath) -replace "`r`n", "`n" }
  if ($old -cne $manifestText) {
    [IO.File]::WriteAllText($manifestPath, $manifestText, (New-Object Text.UTF8Encoding($false, $false)))
    $changed.Add('workspace/workspace-registry.json') | Out-Null
  }

  # 逐个同步资料（字节保真）
  $slotSet = @{}
  $nAdd = 0; $nDel = 0
  foreach ($e in $entries) {
    $slotSet[$e.Slot] = $true
    $srcRoot = $e.LocalPath
    $dstRoot = Join-Path $wsDir $e.Slot
    if (-not (Test-Path -LiteralPath $srcRoot)) {
      Warn ('工作区「{0}」目录不存在，跳过资料拷贝：{1}' -f $e.Title, $srcRoot)
      continue
    }
    if (-not (Test-Path -LiteralPath $dstRoot)) { New-Item -ItemType Directory -Path $dstRoot -Force | Out-Null }
    $srcFiles = @(Get-ChildItem -LiteralPath $srcRoot -Recurse -File -Force | Where-Object {
      $rel = Get-RelPath $srcRoot $_.FullName
      if (-not $rel) { return $false }
      if (Test-WorkspaceIgnored $rel) { return $false }
      # 超过 100MB 的（模型权重 / whl 安装包等）不进仓库：留在本机，同步只搬配置与资料
      if ($_.Length -gt $wsMaxFileBytes) {
        Warn ('文件过大（{0:N1} MB > 100 MB），不参与同步：{1}' -f ($_.Length / 1MB), $rel)
        return $false
      }
      return $true
    })
    $srcRels = @{}
    foreach ($f in $srcFiles) { $srcRels[(Get-RelPath $srcRoot $f.FullName)] = $f.FullName }
    foreach ($rel in @($srcRels.Keys)) {
      $s = $srcRels[$rel]
      $d = Join-Path $dstRoot $rel
      $dd = Split-Path -Parent $d
      if (-not (Test-Path -LiteralPath $dd)) { New-Item -ItemType Directory -Path $dd -Force | Out-Null }
      $need = $false
      if (-not (Test-Path -LiteralPath $d)) { $need = $true }
      elseif ((Get-FileHash -LiteralPath $s -Algorithm SHA256).Hash -ne (Get-FileHash -LiteralPath $d -Algorithm SHA256).Hash) { $need = $true }
      if ($need) {
        Copy-Item -LiteralPath $s -Destination $d -Force
        $changed.Add(('workspace/{0}/{1}' -f $e.Slot, $rel.Replace($BS,'/'))) | Out-Null
        $nAdd++
      }
    }
    if (-not $NoMirrorWorkspace -and $srcFiles.Count -gt 0) {
      foreach ($rf in @(Get-ChildItem -LiteralPath $dstRoot -Recurse -File -Force)) {
        $rel = Get-RelPath $dstRoot $rf.FullName
        if ($rel -and -not $srcRels.ContainsKey($rel)) {
          Remove-Item -LiteralPath $rf.FullName -Force
          $changed.Add(('workspace/{0}/{1}（删除）' -f $e.Slot, $rel.Replace($BS,'/'))) | Out-Null
          $nDel++
        }
      }
    }
  }
  # 镜像删除：仓库里本机已不存在的工作区槽（整目录）；空枚举时保护，避免登记表临时读不到就清空
  if (-not $NoMirrorWorkspace -and $entries.Count -gt 0) {
    foreach ($dir in @(Get-ChildItem -LiteralPath $wsDir -Directory -Force)) {
      if (-not $slotSet.ContainsKey($dir.Name)) {
        Remove-Item -LiteralPath $dir.FullName -Recurse -Force
        $changed.Add(('workspace/{0}（删除整个工作区）' -f $dir.Name)) | Out-Null
        Warn ('仓库中移除本机已不存在的工作区：{0}' -f $dir.Name)
        $nDel++
      }
    }
  }
  Ok ('工作区全量同步：{0} 个工作区，入库/更新 {1} 个文件、删除 {2} 个（字节保真，路径结构不变）' -f $entries.Count, $nAdd, $nDel)
}

# ---------- 对话/会话数据同步：常量与函数 ----------
# 会话日志是 zstd 压缩流、附件是内容寻址 blob、projcache/策略是 JSON，一律字节保真，
# 绝不做文本替换（zstd 流无法替换；projcache 按 sessionId 索引，cwd 只是历史记录，B 机可读）。
# sessions\ 一级目录名 = Get-SessionDirName(工作区绝对路径)；该编码不可逆，所以 capture 用
# 「已知工作区路径 → 编码 → 匹配目录名」建 dir ↔ workspaceId 映射，apply 再按本机路径重编码目录名。
function Get-SessionDirName([string]$path) {
  $sb = New-Object System.Text.StringBuilder
  [void]$sb.Append('--')
  foreach ($ch in $path.ToCharArray()) {
    $c = [int][char]$ch
    if ($c -eq 58) { continue }                                        # ':' 丢弃
    if ($c -eq 92 -or $c -eq 47) { [void]$sb.Append('-'); continue }     # \ / → -
    if ($c -lt 128) { [void]$sb.Append($ch) }
    else { [void]$sb.Append(('~{0:X4}' -f $c)) }                        # 非 ASCII → ~XXXX（连续 CJK 共享 ~ 串联）
  }
  [void]$sb.Append('--')
  return $sb.ToString()
}

<#
  仓库里会话目录用**稳定名**，不用本机路径编码。
  起因：目录名 = 工作区绝对路径编码（--D-DeepSeekHarness-SquadLink--），两台机器各自按自己的路径编码，
  交替 push 时云端目录名来回改名（实测一次 push 11 个 rename），git diff 全变成路径噪音。
  现在：已登记工作区 → --ws-<工作区ID>--（ID 跨机不变），im → --im--，对不上工作区的仍按原名。
  旧仓库里的路径式目录名会被镜像删除自动淘汰（它不是本机现有文件）。
#>
function Get-RepoSessionDirName([string]$kind, [string]$id, [string]$localDir) {
  if ($kind -eq 'ws' -and $id) {
    $safe = ($id -replace '[^A-Za-z0-9_.-]', '_')
    if ($safe) { return ('--ws-{0}--' -f $safe) }
  }
  if ($kind -eq 'im') { return '--im--' }
  return $localDir
}

function Sync-ConversationCapture {
  $convDir = Join-Path $RepoRoot 'conversations'
  if (-not (Test-Path -LiteralPath $convDir)) { New-Item -ItemType Directory -Path $convDir -Force | Out-Null }

  # 1) 建 sessions 一级目录名 → workspaceId / im / passthrough 映射
  $wsEncToId = @{}
  $wsPathById = @{}
  $regSrc = Join-Path $DshHome 'storages/workspace.json'
  if (Test-Path -LiteralPath $regSrc) {
    $reg = Get-Content -LiteralPath $regSrc -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($reg.tables.workspaces) {
      foreach ($prop in $reg.tables.workspaces.PSObject.Properties) {
        $wsEncToId[(Get-SessionDirName ([string]$prop.Value.path))] = $prop.Name
        $wsPathById[[string]$prop.Name] = [string]$prop.Value.path
      }
    }
  }
  $imEnc = Get-SessionDirName (Join-Path $DshHome 'im')
  $sessSrc = Join-Path $DshHome 'sessions'
  # im 目录名 = <home>\im 的编码。短路径（ADMINI~1）时和 DSH 自己写的长名对不上，
  # 所以先精确命中，否则在所有「以 -im-- 收尾」的目录里挑文件最多的那个（当次机器一定在用）。
  $imDirName = ''
  if (Test-Path -LiteralPath $sessSrc) {
    $cands = @(Get-ChildItem -LiteralPath $sessSrc -Directory -Force | Where-Object { $_.Name -eq $imEnc -or $_.Name -like '*-im--' })
    if ($imEnc -and ($cands | Where-Object { $_.Name -eq $imEnc })) { $imDirName = $imEnc }
    elseif ($cands.Count -gt 0) {
      $imDirName = ($cands | Sort-Object { @(Get-ChildItem -LiteralPath $_.FullName -Recurse -File -Force -ErrorAction SilentlyContinue).Count } -Descending | Select-Object -First 1).Name
    }
  }
  $idxEntries = @()
  $dirRemap = @{}      # 本机编码目录名 → 仓库稳定目录名
  $cwdToken = @{}      # 仓库稳定目录名 → 归一后的 cwd 占位符（让仓库内容与机器无关）
  if (Test-Path -LiteralPath $sessSrc) {
    foreach ($d in @(Get-ChildItem -LiteralPath $sessSrc -Directory -Force | Sort-Object Name)) {
      if (Test-DefaultWorkspaceDir $d.Name) {
        # 默认工作区不同步（见 dsh-sync-common.ps1 的说明）：不记映射，也不入仓库。
        Ok ('默认工作区不参与同步，跳过：{0}' -f $d.Name)
        continue
      }
      if ($wsEncToId.ContainsKey($d.Name)) {
        $repoDir = Get-RepoSessionDirName 'ws' $wsEncToId[$d.Name] $d.Name
        $dirRemap[$d.Name] = $repoDir
        $idxEntries += [ordered]@{ dir = $repoDir; workspaceId = $wsEncToId[$d.Name] }
      } elseif ($d.Name -eq $imDirName -and $imDirName) {
        $repoDir = Get-RepoSessionDirName 'im' '' $d.Name
        $dirRemap[$d.Name] = $repoDir
        $idxEntries += [ordered]@{ dir = $repoDir; special = 'im' }
      } else {
        $idxEntries += [ordered]@{ dir = $d.Name; passthrough = $true }
        Warn ('会话目录无法对应到已登记工作区，按原名保留（B 机不重编码）：{0}' -f $d.Name)
      }
    }
  }
  # 已登记工作区的 cwd 归一：本机绝对路径 → {{APP_ROOT}}/xxx 这类占位符，apply 时再展开成本机路径。
  # 不归一的话，仓库里这条 cwd 永远是「最后推上来的那台机器」的路径，两台机器互推时每次都改这批文件。
  $imRepoDirName = Get-RepoSessionDirName 'im' '' ''
  $cwdToken[$imRepoDirName] = ($DshHomeToken + '/im')
  foreach ($e in @($idxEntries)) {
    if (-not $e.workspaceId) { continue }
    $localCwd = $null
    foreach ($k in @($wsEncToId.Keys)) { if ($wsEncToId[$k] -eq $e.workspaceId) { $localCwd = $k; break } }
    if (-not $localCwd) { continue }
    $localPath = $null
    if ($wsPathById.ContainsKey([string]$e.workspaceId)) { $localPath = $wsPathById[[string]$e.workspaceId] }
    if ($localPath) { $cwdToken[[string]$e.dir] = (ConvertTo-WorkspaceToken $localPath) }
  }
  $index = [ordered]@{}
  $index['unit'] = [ordered]@{ name = 'dsh-session-sync'; version = 1 }
  $index['entries'] = @($idxEntries)
  $indexText = (($index | ConvertTo-Json -Depth 8) -replace "`r`n", "`n") + "`n"
  $indexPath = Join-Path $convDir 'session-index.json'
  $old = $null
  if (Test-Path -LiteralPath $indexPath) { $old = [IO.File]::ReadAllText($indexPath) -replace "`r`n", "`n" }
  if ($old -cne $indexText) {
    [IO.File]::WriteAllText($indexPath, $indexText, (New-Object Text.UTF8Encoding($false, $false)))
    $changed.Add('conversations/session-index.json') | Out-Null
  }

  # 2) 四块数据镜像，全部字节保真（SHA256 判差异，Copy-Item 原样拷）
  #    sessions 块的相对路径第一段是本机编码目录名，写进仓库前换成稳定名（见 Get-RepoSessionDirName）
  $blocks = @(
    @{ Src = (Join-Path $DshHome 'sessions');                                         Dst = 'sessions';                                         Remap = $true  },
    @{ Src = (Join-Path $DshHome 'attachments');                                      Dst = 'attachments';                                      Remap = $false },
    @{ Src = (Join-Path $DshHome 'storages\session_projcache\sessions');             Dst = 'session_projcache';                                Remap = $false },
    @{ Src = (Join-Path $DshHome 'storages\vision_router_session_policy\policies');  Dst = 'vision_router_session_policy';                     Remap = $false }
  )
  $nAdd = 0; $nDel = 0
  foreach ($b in $blocks) {
    $dstRoot = Join-Path $convDir $b.Dst
    if (-not (Test-Path -LiteralPath $b.Src)) { Warn ('本机没有会话数据块，跳过：{0}' -f $b.Src); continue }
    if (-not (Test-Path -LiteralPath $dstRoot)) { New-Item -ItemType Directory -Path $dstRoot -Force | Out-Null }
    $srcRels = @{}
    foreach ($f in @(Get-ChildItem -LiteralPath $b.Src -Recurse -File -Force)) {
      $rel = Get-RelPath $b.Src $f.FullName
      if (-not $rel) { continue }
      $parts = @($rel -split '\\')
      # 默认工作区的文件不入库（第一段就是那个 -default-workspace-- 目录名）。
      if (Test-DefaultWorkspaceDir $parts[0]) { continue }
      if ($b.Remap -and $dirRemap.ContainsKey($parts[0])) { $parts[0] = $dirRemap[$parts[0]] }
      $rel = ($parts -join '\')
      $srcRels[$rel] = $f.FullName
    }
    foreach ($rel in @($srcRels.Keys)) {
      $s = $srcRels[$rel]
      $d = Join-Path $dstRoot $rel
      $dd = Split-Path -Parent $d
      if (-not (Test-Path -LiteralPath $dd)) { New-Item -ItemType Directory -Path $dd -Force | Out-Null }
      $need = $false
      if (-not (Test-Path -LiteralPath $d)) { $need = $true }
      elseif ((Get-FileHash -LiteralPath $s -Algorithm SHA256).Hash -ne (Get-FileHash -LiteralPath $d -Algorithm SHA256).Hash) { $need = $true }
      if ($need) {
        Copy-Item -LiteralPath $s -Destination $d -Force
        $changed.Add(('conversations/{0}/{1}' -f $b.Dst, $rel.Replace($BS,'/'))) | Out-Null
        $nAdd++
      }
    }
    # 镜像删除：本机已删的会话文件，仓库里也删
    foreach ($rf in @(Get-ChildItem -LiteralPath $dstRoot -Recurse -File -Force)) {
      $rel = Get-RelPath $dstRoot $rf.FullName
      if ($rel -and -not $srcRels.ContainsKey($rel)) {
        Remove-Item -LiteralPath $rf.FullName -Force
        $changed.Add(('conversations/{0}/{1}（删除）' -f $b.Dst, $rel.Replace($BS,'/'))) | Out-Null
        $nDel++
      }
    }
  }
  Ok ('会话数据全量同步：{0} 个目录映射，入库/更新 {1} 个文件、删除 {2} 个（四块数据全部字节保真）' -f $idxEntries.Count, $nAdd, $nDel)

  # 3) 仓库副本的会话头 cwd 归一成占位符（只改首帧、幂等），让两台机器推上来的内容完全一致。
  #    对不上工作区的 passthrough 目录不动（那种目录在 B 机本来也认不出）。
  if ($cwdToken.Count -gt 0) {
    $spec = [ordered]@{ home = $convDir; dirs = $cwdToken } | ConvertTo-Json -Depth 4 -Compress
    $specPath = Join-Path ([IO.Path]::GetTempPath()) ('dsh-repo-cwd-{0}.json' -f $stamp)
    [IO.File]::WriteAllText($specPath, $spec, (New-Object Text.UTF8Encoding($false)))
    # 辅助脚本优先用「脚本自己旁边」的那份（仓库可能是个刚 clone 下来、还没铺 tools 的副本）
    $helper = Join-Path $PSScriptRoot 'tools\fix-session-cwd.mjs'
    if (-not (Test-Path -LiteralPath $helper)) { $helper = Join-Path $RepoRoot 'tools\fix-session-cwd.mjs' }
    if (Test-Path -LiteralPath $helper) {
      $nodeExe = Join-Path $AppRoot 'resources\runtime\primary-runtime\dependencies\node\bin\node.exe'
      if (-not (Test-Path -LiteralPath $nodeExe)) { $nodeExe = (Get-Command node -ErrorAction SilentlyContinue).Source }
      & $nodeExe $helper $specPath *>&1 | ForEach-Object { if ($_ -and ([string]$_).Trim()) { Say ('  ' + ([string]$_).Trim()) } }
      if ($LASTEXITCODE -ne 0) { Warn '仓库会话头 cwd 归一时有文件失败（上面有原因），那几个会话可能带着本机路径入库' }
    } else {
      Warn ('找不到 {0}，跳过仓库会话头归一（仓库里会继续存本机路径）' -f $helper)
    }
    Remove-Item -LiteralPath $specPath -Force -ErrorAction SilentlyContinue
    # 归一改过文件，需要重新统计进 changed 列表，交给调用方统一 git add -A 兜住
  }
}

# ---------- 客户端安装目录的路径归一化 ----------
# 捕获时把「客户端安装目录」的绝对路径一律写成 {{APP_ROOT}}/ 前缀，apply 时再展开成本机路径。
# 这是跨机器同步的关键：否则仓库里会同时存在 A 机的 D:\ 和 B 机的 G:\，lockfile 与 package.json 永远对不上。
#
# 关键修复（2026-11-10）：旧版正则把目录名写死成 DeepSeekHarness，客户端装在 D:\DSH 时归一化整体失效，
# 本机绝对路径会被原样写进仓库 → 另一台 apply 后 lock 与 package.json 错位 → 安装半装 → 启动崩。
# 现在先按本机 -AppRoot 的实际路径做字面替换（任意目录名、任意盘符），再用「末级目录名」正则兜底。
$AppRootPattern = Get-AppRootPattern $AppRoot

function Set-AppRootToken([string]$text) {
  return (Convert-AppRootText $text $AppRoot $AppRootToken)
}

Say "== DSH 配置同步 / capture =="

$ProfileDir = Join-Path $DshHome ("profiles\" + $ProfileName)
if (-not $WorkspaceOnly -and -not (Test-Path -LiteralPath $ProfileDir)) { Die "找不到 profile：$ProfileDir" }
foreach ($d in @('profile', 'prompt', 'skills', 'presets', 'local-plugins', 'storages-record', 'settings', 'mnemon', 'workspace', 'conversations')) {
  $p = Join-Path $RepoRoot $d
  if (-not (Test-Path -LiteralPath $p)) { New-Item -ItemType Directory -Path $p -Force | Out-Null }
}

$changed = New-Object System.Collections.Generic.List[string]

# -WorkspaceOnly：只抓工作区 + 会话（B 机没装 DSH 也能先还原资料），抓完直接给提交指引并结束
if ($WorkspaceOnly) {
  if ($SkipWorkspace) { Die "-WorkspaceOnly 与 -SkipWorkspace 不能同时使用" }
  Sync-WorkspaceCapture
  Sync-ConversationCapture
  Say ""
  if ($changed.Count -eq 0) {
    Ok "工作区 / 会话与仓库一致，无需提交"
  } else {
    Say "本次有 $($changed.Count) 处变更："
    $changed | ForEach-Object { Say "  - $_" }
    Say ""
    Say "接着执行："
    Say "  cd `"$RepoRoot`""
    Say "  git add -A ; git commit -m `"workspace + sessions sync`" ; git push"
    Say "另一台机器：git pull ; powershell -ExecutionPolicy Bypass -File .\apply.ps1 -WorkspaceOnly"
  }
  return
}
function Get-NormalizedHash($path) {
  # 文本文件按"去掉 CRLF/LF 差异后的内容"比较，避免换行转换制造假变更；归档文件按原始字节比较
  $ext = [IO.Path]::GetExtension($path).ToLower()
  if ($ext -in @('.tgz', '.zip')) {
    return (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash
  }
  $bytes = [IO.File]::ReadAllBytes($path)
  $text = [Text.Encoding]::UTF8.GetString($bytes)
  $norm = $text -replace "`r`n", "`n"
  $sha = [Security.Cryptography.SHA256]::Create()
  return [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($norm)))
}
function CopyNormalized($src, $dst) {
  # 二进制原样拷贝；文本统一写成 LF（与 .gitattributes 的 eol=lf 对齐），并保留原文件的 UTF-8 BOM
  $ext = [IO.Path]::GetExtension($src).ToLower()
  if ($ext -in @('.tgz', '.zip', '.png', '.jpg', '.jpeg', '.gif', '.ico', '.exe', '.dll', '.wasm')) {
    Copy-Item -LiteralPath $src -Destination $dst -Force
    return
  }
  $bytes = [IO.File]::ReadAllBytes($src)
  $hasBom = ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF)
  $text = [Text.Encoding]::UTF8.GetString($bytes)
  if ($hasBom -and $text.Length -gt 0 -and $text[0] -eq [char]0xFEFF) { $text = $text.Substring(1) }
  $text = $text -replace "`r`n", "`n"
  $enc = New-Object Text.UTF8Encoding($hasBom, $false)
  [IO.File]::WriteAllText($dst, $text, $enc)
}
function Get-RepoText([string]$path) {
  # 仓库里文件的现有文本：只去 BOM、统一 LF，不做占位符替换（用来判断是否真的需要重写）
  $bytes = [IO.File]::ReadAllBytes($path)
  $text = [Text.Encoding]::UTF8.GetString($bytes)
  if ($text.Length -gt 0 -and $text[0] -eq [char]0xFEFF) { $text = $text.Substring(1) }
  return ($text -replace "`r`n", "`n")
}
function Get-TrackedText([string]$path) {
  # 取「用于写进仓库的规范文本」：去掉 BOM、CRLF→LF、客户端安装目录→{{APP_ROOT}}
  $bytes = [IO.File]::ReadAllBytes($path)
  $hasBom = ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF)
  $text = [Text.Encoding]::UTF8.GetString($bytes)
  if ($hasBom -and $text.Length -gt 0 -and $text[0] -eq [char]0xFEFF) { $text = $text.Substring(1) }
  $text = $text -replace "`r`n", "`n"
  return @{ Text = (Set-AppRootToken $text); Bom = $hasBom }
}
function NormalizeTree($dir) {
  # 目录镜像后调用：把文本文件统一成 LF，并把客户端安装目录换成占位符，避免 git 因换行/盘符判成"有改动"
  if (-not (Test-Path -LiteralPath $dir)) { return }
  Get-ChildItem -LiteralPath $dir -Recurse -File -Force | ForEach-Object {
    $ext = $_.Extension.ToLower()
    if ($ext -in @('.tgz', '.zip', '.png', '.jpg', '.jpeg', '.gif', '.ico', '.exe', '.dll', '.wasm')) { return }
    $norm = Get-TrackedText $_.FullName
    $raw = [Text.Encoding]::UTF8.GetString([IO.File]::ReadAllBytes($_.FullName))
    if ($raw -ceq $norm.Text) { return }
    [IO.File]::WriteAllText($_.FullName, $norm.Text, (New-Object Text.UTF8Encoding($norm.Bom, $false)))
  }
}
function CopyTracked($src, $dst, $label) {
  $ext = [IO.Path]::GetExtension($src).ToLower()
  if ($ext -in @('.tgz', '.zip', '.png', '.jpg', '.jpeg', '.gif', '.ico', '.exe', '.dll', '.wasm')) {
    $isNew = -not (Test-Path -LiteralPath $dst)
    if (-not $isNew -and (Get-NormalizedHash $src) -eq (Get-NormalizedHash $dst)) {
      Say ("  =  " + $label + "（无变化）")
      return
    }
    CopyNormalized $src $dst
    $changed.Add($label) | Out-Null
    Ok ("更新 " + $label)
    return
  }
  # 文本：和仓库里「原样文本」比较（不能把仓库文本也先做占位符替换，否则盘符残留会被判成"无变化"）
  $mine = Get-TrackedText $src
  if (Test-Path -LiteralPath $dst) {
    if ((Get-RepoText $dst) -ceq $mine.Text) {
      Say ("  =  " + $label + "（无变化）")
      return
    }
  }
  [IO.File]::WriteAllText($dst, $mine.Text, (New-Object Text.UTF8Encoding($mine.Bom, $false)))
  $changed.Add($label) | Out-Null
  Ok ("更新 " + $label)
}

# 1) profile 配置
# package.json 里的 link: 指向的是「本机客户端的绝对路径」，入库存成 {{APP_ROOT}}/ 前缀。
# 这样 A 机 apply 后路径变成本机的、B 机再 capture 也不会把仓库改成自己的盘符，
# 更关键的是 pnpm-lock.yaml 与 package.json 的 specifier 始终一致，--frozen-lockfile 不会挂。
$pkgRaw = $null
$pkgSrc = Join-Path $ProfileDir 'package.json'
if (Test-Path -LiteralPath $pkgSrc) { $pkgRaw = Set-AppRootToken ([IO.File]::ReadAllText($pkgSrc)) }
foreach ($dirName in @('dsh-our-free-model-2.8.0', 'dsh-purge-1.1.92')) {
  $pattern = 'link:[^"]*' + [regex]::Escape($dirName)
  $pkgRaw = [regex]::Replace($pkgRaw, $pattern, ('link:' + $AppRootToken + '/' + $dirName), 'IgnoreCase')
}
if ($pkgRaw) {
  $norm = $pkgRaw -replace "`r`n", "`n"
  $dst = Join-Path $RepoRoot 'profile\package.json'
  $existing = $null
  if (Test-Path -LiteralPath $dst) { $existing = [IO.File]::ReadAllText($dst) -replace "`r`n", "`n" }
  if ($null -ne $existing -and $existing -eq $norm) {
    Say "  =  profile\package.json（无变化）"
  } else {
    [IO.File]::WriteAllText($dst, $norm, (New-Object Text.UTF8Encoding($false, $false)))
    $changed.Add('profile\package.json') | Out-Null
    Ok "更新 profile\package.json（link 路径已归一为 $AppRootToken）"
  }
}
foreach ($f in @('pnpm-lock.yaml', 'pnpm-workspace.yaml', 'cordis.yml', 'cordis.patch.yml')) {
  $src = Join-Path $ProfileDir $f
  if (Test-Path -LiteralPath $src) { CopyTracked $src (Join-Path $RepoRoot "profile\$f") "profile\$f" }
  elseif (Test-Path -LiteralPath (Join-Path $RepoRoot "profile\$f")) {
    Warn "本机缺少 profile\$f，仓库里保留的是上一次的副本（该机器 apply 时会把它铺过来）"
  }
}

# 1.5) 宿主版本契约：记下本机实测的 app 版本，另一台 apply 时据此比对，版本不一致就不铺实验性 bundle
# 只写 appVersion + electronVersion，不写机器名/日期（那两样会让每次 capture 都产生假 diff）。
# 已存在且版本不同 → 只告警不改写，避免「较旧的那台 capture 一次就把契约拉低」。
$hostAppVersion = Get-HostAppVersion $AppRoot
$contractPath = Join-Path $RepoRoot 'profile\host-contract.json'
if (-not $hostAppVersion) {
  Warn "读不到 app 版本（$AppRoot\resources\app\package.json），跳过 host-contract.json"
} else {
  $contractText = ("{`n  `"appVersion`": `"$hostAppVersion`",`n  `"electronVersion`": `"$(Get-HostElectronVersion $AppRoot)`"`n}`n")
  $existing = $null
  if (Test-Path -LiteralPath $contractPath) {
    try { $existing = [string](Get-Content -LiteralPath $contractPath -Raw -Encoding utf8 | ConvertFrom-Json).appVersion } catch { $existing = $null }
  }
  if ($existing -and ($existing -ne $hostAppVersion)) {
    Warn "仓库契约 app = $existing，本机 app = $hostAppVersion（不一致，契约保持不变；对齐后再 capture）"
  } else {
    $norm = $contractText -replace "`r`n", "`n"
    $now = if (Test-Path -LiteralPath $contractPath) { ([IO.File]::ReadAllText($contractPath) -replace "`r`n", "`n") } else { '' }
    if ($now -ceq $norm) {
      Say "  =  profile\host-contract.json（无变化）"
    } else {
      [IO.File]::WriteAllText($contractPath, $norm, (New-Object Text.UTF8Encoding($false, $false)))
      $changed.Add('profile\host-contract.json') | Out-Null
      Ok "写入 profile\host-contract.json（app = $hostAppVersion）"
    }
  }
}

# 2) 全局提示
foreach ($f in @('AGENTS.md', 'prompt-inject.md')) {
  $src = Join-Path $DshHome $f
  if (Test-Path -LiteralPath $src) { CopyTracked $src (Join-Path $RepoRoot "prompt\$f") "prompt\$f" }
  elseif (Test-Path -LiteralPath (Join-Path $RepoRoot "prompt\$f")) {
    Warn "本机缺少 prompt\$f，仓库里保留的是上一次的副本"
  }
}

# 3) Skills（镜像）
$skillsSrc = Join-Path $DshHome 'skills'
$skillsDst = Join-Path $RepoRoot 'skills'
if (Test-Path -LiteralPath $skillsSrc) {
  Get-ChildItem -LiteralPath $skillsSrc -Directory -Force | ForEach-Object {
    $dstDir = Join-Path $skillsDst $_.Name
    if (-not (Test-Path -LiteralPath $dstDir)) { $changed.Add("skills\$($_.Name)") | Out-Null }
    if (Test-Path -LiteralPath $dstDir) { Remove-Item -LiteralPath $dstDir -Recurse -Force }
    Copy-Item -LiteralPath $_.FullName -Destination $dstDir -Recurse -Force
    NormalizeTree $dstDir
  }
  $count = (Get-ChildItem -LiteralPath $skillsSrc -Directory -Force | Measure-Object).Count
  Ok "已抓取 $count 个 Skill"
  if (-not $NoMirrorSkills) {
    Get-ChildItem -LiteralPath $skillsDst -Directory -Force | Where-Object {
      -not (Test-Path -LiteralPath (Join-Path $skillsSrc $_.Name))
    } | ForEach-Object {
      Remove-Item -LiteralPath $_.FullName -Recurse -Force
      $changed.Add("skills\$($_.Name)（删除）") | Out-Null
      Warn "仓库中移除本机已不存在的 Skill：$($_.Name)"
    }
  }
}

# 4) Agent 预设
$presetSrc = Join-Path $DshHome '.agent-presets'
$presetDst = Join-Path $RepoRoot 'presets'
if (Test-Path -LiteralPath $presetSrc) {
  Get-ChildItem -LiteralPath $presetSrc -Directory -Force | ForEach-Object {
    $dstDir = Join-Path $presetDst $_.Name
    if (Test-Path -LiteralPath $dstDir) { Remove-Item -LiteralPath $dstDir -Recurse -Force }
    Copy-Item -LiteralPath $_.FullName -Destination $dstDir -Recurse -Force
    NormalizeTree $dstDir
  }
  Ok "已抓取 Agent 预设：$((Get-ChildItem -LiteralPath $presetSrc -Directory -Force | Select-Object -ExpandProperty Name) -join ', ')"
}

# 5) 技能市场台账
$dataDir = Join-Path $DshHome 'storages\@montersy123\dsh-skill-market\data'
foreach ($pair in @(@('installed.json', 'skill-market-installed.json'), @('panel.json', 'skill-market-panel.json'))) {
  $src = Join-Path $dataDir $pair[0]
  if (Test-Path -LiteralPath $src) { CopyTracked $src (Join-Path $RepoRoot ("storages-record\" + $pair[1])) ("storages-record\" + $pair[1]) }
}

# 5.5) 插件设置与工作流（跨机需要一致的那几个小文件）
$settingsMap = @(
  @{ Repo = 'settings\our-free-model.json';        Src = (Join-Path $DshHome 'our-free-model\settings.json');                          Label = 'our-free-model 插件设置' },
  @{ Repo = 'settings\comfyui-workflows.json';     Src = (Join-Path $DshHome 'data\dsh-comfyui\workflows.json');                    Label = 'ComfyUI 工作流库' },
  @{ Repo = 'settings\dsh-pet-main-config.jsonc';  Src = (Join-Path $DshHome 'dsh-pet\main-config.jsonc');                          Label = '桌宠配置' },
  @{ Repo = 'settings\dsh-market-state.json';      Src = (Join-Path $DshHome ("profiles\" + $ProfileName + '\.dsh-market\state.json')); Label = '插件市场状态' }
)
foreach ($m in $settingsMap) {
  if (-not (Test-Path -LiteralPath $m.Src)) {
    Warn ("本机没有 " + $m.Label + " 的源文件，跳过：" + $m.Src)
    continue
  }
  if ($m.Repo -eq 'settings\our-free-model.json') {
    # 这个文件里有插件自己每秒/每轮刷新的运行时字段，原样入库会导致每次 capture 都"有改动"
    $txt = [IO.File]::ReadAllText($m.Src)
    foreach ($k in @('catalogSyncedAt', 'reloadedAt', 'reloadCount')) {
      $txt = $txt -replace ('("' + $k + '"\s*:\s*)[0-9]+'), '${1}0'
    }
    $norm = $txt -replace "`r`n", "`n"
    $dstFile = Join-Path $RepoRoot $m.Repo
    $existing = $null
    if (Test-Path -LiteralPath $dstFile) { $existing = [IO.File]::ReadAllText($dstFile) -replace "`r`n", "`n" }
    if ($null -ne $existing -and $existing -eq $norm) {
      Say ("  =  " + $m.Repo + "（无变化）")
    } else {
      [IO.File]::WriteAllText($dstFile, $norm, (New-Object Text.UTF8Encoding($false, $false)))
      $changed.Add($m.Repo) | Out-Null
      Ok ("更新 " + $m.Repo)
    }
  } else {
    CopyTracked $m.Src (Join-Path $RepoRoot $m.Repo) $m.Repo
  }
}

# 6) 记忆插件数据目录 mnemon（与记忆插件配套，需要跨机一致）
$mnemonSrc = Join-Path $AppRoot 'mnemon'
$mnemonDst = Join-Path $RepoRoot 'mnemon'
if (Test-Path -LiteralPath $mnemonSrc) {
  $mnFiles = Get-ChildItem -LiteralPath $mnemonSrc -Recurse -File -Force
  foreach ($f in $mnFiles) {
    $rel = Get-RelPath $mnemonSrc $f.FullName
    if (-not $rel) { Warn "跳过（无法求相对路径）：$($f.FullName)"; continue }
    $dstFile = Join-Path $mnemonDst $rel
    $dstDir = Split-Path -Parent $dstFile
    if (-not (Test-Path -LiteralPath $dstDir)) { New-Item -ItemType Directory -Path $dstDir -Force | Out-Null }
    CopyTracked $f.FullName $dstFile ("mnemon\" + $rel)
  }
  # 镜像：仓库里本机已不存在的记忆文件要删掉，否则两台机器会对不上
  if (Test-Path -LiteralPath $mnemonDst) {
    Get-ChildItem -LiteralPath $mnemonDst -Recurse -File -Force | ForEach-Object {
      $rel = Get-RelPath $mnemonDst $_.FullName
      if ($rel -and -not (Test-Path -LiteralPath (Join-Path $mnemonSrc $rel))) {
        Remove-Item -LiteralPath $_.FullName -Force
        $changed.Add("mnemon\$rel（删除）") | Out-Null
        Warn "仓库中移除本机已不存在的记忆文件：$rel"
      }
    }
  }
  Ok "已抓取记忆数据（mnemon）：$($mnFiles.Count) 个文件"
} else {
  Warn "本机没有 $mnemonSrc（记忆插件的 -AppRoot 可能不同），跳过记忆数据"
}

# 6) 本地源码插件打包
if ($PackLocalPlugins) {
  $pkg = Get-Content -LiteralPath (Join-Path $ProfileDir 'package.json') -Raw -Encoding utf8 | ConvertFrom-Json
  foreach ($prop in $pkg.dependencies.PSObject.Properties) {
    if ($prop.Value -notmatch '^link:') { continue }
    $linkPath = $prop.Value.Substring(5) -replace '/', '\'
    if (-not (Test-Path -LiteralPath $linkPath)) { Warn "link 目标不存在，跳过：$linkPath"; continue }
    $dirName = Split-Path -Leaf $linkPath
    $zipPath = Join-Path $RepoRoot "local-plugins\$dirName.zip"
    $tgzPath = Join-Path $RepoRoot "local-plugins\$dirName.tgz"
    if (Test-Path -LiteralPath $tgzPath) { Remove-Item -LiteralPath $tgzPath -Force }
    if (Test-Path -LiteralPath $zipPath) { Remove-Item -LiteralPath $zipPath -Force }
    Compress-Archive -LiteralPath $linkPath -DestinationPath $zipPath -CompressionLevel Optimal -Force
    $changed.Add("local-plugins\$dirName.zip") | Out-Null
    $ver = '?'
    $p = Join-Path $linkPath 'package.json'
    if (Test-Path -LiteralPath $p) { $ver = (Get-Content -LiteralPath $p -Raw -Encoding utf8 | ConvertFrom-Json).version }
    Ok ("已打包 " + $dirName + "（version " + $ver + "，{0:N1} MB）" -f ((Get-Item -LiteralPath $zipPath).Length / 1MB))
    # 路径里若有版本号，和 package.json 的 version 对不上就提醒改名
    if ($dirName -match '([0-9]+\.[0-9]+\.[0-9]+)$' -and $ver -ne $Matches[1]) {
      Warn "目录名版本($($Matches[1])) 与插件实际版本($ver) 不一致，建议核对是否换了新版本"
    }
  }
}

# 7) 工作区 + 会话同步（默认全量；放在最后，前面的配置都抓完再抓资料）
if (-not $SkipWorkspace) {
  Sync-WorkspaceCapture
  Sync-ConversationCapture
} else {
  Warn "已指定 -SkipWorkspace，跳过全部工作区与会话同步"
}

Say ""
if ($changed.Count -eq 0) {
  Ok "本机配置与仓库一致，无需提交"
} else {
  Say "本次有 $($changed.Count) 处变更："
  $changed | ForEach-Object { Say "  - $_" }
  Say ""
  Say "接着执行（二选一）："
  Say "  powershell -File .\sync.ps1 push     # 抓取 + 提交 + 推送，一条命令"
  Say "  或手动：git add -A ; git commit -m `"sync from <机器名>`" ; git push"
  Say "另一台机器：powershell -File .\sync.ps1 pull"
}

exit 0
