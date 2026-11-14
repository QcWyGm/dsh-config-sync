<#
DSH 配置同步 —— 应用脚本（把本仓库的配置还原到当前电脑）

用法
  pwsh -File apply.ps1                                  # 默认：铺配置 + 全量还原所有工作区
  pwsh -File apply.ps1 -AppRoot D:\DSH                   # 客户端装在别的目录（{{APP_ROOT}} 展开到这里，B 机必传）
  pwsh -File apply.ps1 -DshHome C:\Users\bob\.dsh -ProfileName desktop
  pwsh -File apply.ps1 -SkipInstall                      # 只铺配置文件和技能，不跑 pnpm install
  pwsh -File apply.ps1 -PruneSkills                      # 额外删除本机 skills 目录下仓库里没有的 Skill（默认不动）
  pwsh -File apply.ps1 -SkipMnemon                       # 不还原记忆插件数据（<AppRoot>\mnemon）
  pwsh -File apply.ps1 -WorkspaceOnly                    # 只还原工作区资料与登记表（不碰配置/插件/预设，无需退出 DSH、无需本机装 profile）
  pwsh -File apply.ps1 -SkipWorkspace                    # 跳过工作区还原（应急；默认全量还原所有工作区）
  pwsh -File apply.ps1 -PruneWorkspace                   # 额外删除本机工作区里仓库没有的文件（默认留着并提示）
  pwsh -File apply.ps1 -ReplaceWorkspaceRegistry         # 整份覆盖本机 workspace.json（默认按 ID 合并、同路径去重，保留本机自建工作区）
  pwsh -File apply.ps1 -WorkspaceHome "D:\其它\根"      # B 机上 {{WORKSPACE_HOME}} 展开到哪个根（默认 %USERPROFILE%\Documents\deepseek-harness）
  pwsh -File apply.ps1 -Force                            # 检测到 DSH 仍在运行时强制继续（不推荐）

工作区还原（默认开、全量）
  读仓库里的 workspace\workspace-registry.json，把每个工作区的资料按字节还原到占位符展开后的路径，
  再按 ID 把登记表合并进 $DshHome\storages\workspace.json（本机自建工作区保留，workspaceIds 取并集，
  sessionIds 取「仓库 + 本机」并集）。合并完还会按 path 去重：DSH 启动时校验 duplicate paths，
  同一路径留两条会让整张登记表打不开（工作区列表全空、会话也读不出），换机时本机自建的
  default-workspace 与仓库那条 ID 不同正好会撞，所以同路径只保留一条、其余条目的会话并入。
  {{APP_ROOT}} 用 -AppRoot 展开，{{WORKSPACE_HOME}} 用 -WorkspaceHome
  展开，所以 A/B 机盘符不同也能落地。

对话/会话数据还原（默认开、全量，随工作区一起；-SkipWorkspace 会连会话一起跳过）
  读仓库里的 conversations\session-index.json，把每块会话数据字节保真还原到 $DshHome 对应位置。
  sessions\ 的一级目录名按「占位符路径 → 本机路径 → 重新编码」重算，否则 B 机换了 -AppRoot 认不出会话；
  登记表里的 sessionIds 会写回本机 workspace.json，工作台能直接看到并打开历史对话。会话是增量数据，
  还原只做覆盖/新增，不删本机多出的会话文件。

前置条件：执行前必须完全退出 DeepSeek Harness（窗口 + 托盘图标都要退），
否则配置文件写入后会被运行中的进程覆盖，插件也不会重新加载。
-WorkspaceOnly 只还原工作区与会话，不需要退出 DSH，也不需要本机装过客户端。
#>
param(
  [string]$RepoRoot,
  [string]$DshHome = $(Join-Path $env:USERPROFILE '.dsh'),
  [string]$ProfileName = 'desktop',
  [string]$AppRoot = '',
  [switch]$SkipInstall,
  [switch]$PruneSkills,
  [switch]$SkipMnemon,
  [switch]$PruneMnemon,
  [switch]$Force,
  [switch]$WorkspaceOnly,
  [switch]$SkipWorkspace,
  [switch]$PruneWorkspace,
  [switch]$ReplaceWorkspaceRegistry,
  [switch]$AllowVersionDrift,
  [switch]$ForceBundles,
  [string]$WorkspaceHome = $(Join-Path $env:USERPROFILE 'Documents\deepseek-harness'),
  # sync.ps1 调起本脚本时必须传，否则会抹掉父进程已攒下的未同步清单
  [switch]$NoResetNotices
)

$ErrorActionPreference = 'Stop'
if (-not $RepoRoot) { $RepoRoot = $PSScriptRoot }
. (Join-Path $PSScriptRoot 'dsh-sync-common.ps1')

if (-not $NoResetNotices) { Reset-SyncNotices $DshHome 'pull' }

# 客户端可能被卸载重装到别的盘：传进来的 -AppRoot 先校验，对不上就自动定位（注册表 → 常见位置）。
$resolvedRoot = Resolve-DshAppRoot $AppRoot
if (-not $resolvedRoot) {
  Die ("找不到 DSH 客户端目录（传进来的 -AppRoot 对不上，注册表与常见位置也没有）。" +
       "装好客户端后重跑，或显式传 -AppRoot `<客户端根>`（目录里有 resources\app.asar 或 resources\app\package.json）。")
}
if ($AppRoot -and ($resolvedRoot -ne $AppRoot.TrimEnd('\', '/'))) { Warn "参数里的 -AppRoot（$AppRoot）对不上，已自动改用：$resolvedRoot" }
$AppRoot = $resolvedRoot

# ---------- 客户端安装目录的路径归一化 ----------
# 仓库里凡是「客户端安装目录」的绝对路径，一律存成 {{APP_ROOT}}/ 前缀。
# 展开规则由 dsh-sync-common.ps1 的 Convert-AppRootText 提供：按本机 -AppRoot 的实际目录名匹配，
# 不再写死 DeepSeekHarness（装在 D:\DSH 这类目录也能正确展开）。
$AppRootPattern = Get-AppRootPattern $AppRoot

function Expand-AppRoot([string]$text, [string]$rootFwd) {
  # 先把占位符换成本机路径（漏了这一步会把裸 {{APP_ROOT}} 写进 cordis.patch.yml，
  # 宿主解析 YAML 直接 fatal；pnpm-lock.yaml 也会和 package.json 的 specifier 对不上）
  if ($text.Contains($AppRootToken)) { $text = $text.Replace($AppRootToken, $rootFwd) }
  if ($text.Contains($WorkspaceHomeToken)) {
    $wsFwd = $WorkspaceHome.Replace('\\', '/').TrimEnd('/')
    $text = $text.Replace($WorkspaceHomeToken, $wsFwd)
  }
  # 再兜底老仓库里没迁移过的盘符绝对路径
  return (Convert-AppRootText $text $AppRoot $rootFwd)
}

function Expand-AppRootFile([string]$path, [string]$rootFwd) {
  $raw = Read-TextPreserveBom $path
  if ($raw.Contains($AppRootToken) -or $raw -match $AppRootPattern) {
    Write-TextPreserveBom $path (Expand-AppRoot $raw $rootFwd)
    return $true
  }
  return $false
}

function Expand-AppRootTree([string]$dir, [string]$rootFwd) {
  # 目录里所有文本文件都做一次占位符展开（mnemon 记忆库、插件设置这类被整目录复制的内容）
  if (-not (Test-Path -LiteralPath $dir)) { return }
  Get-ChildItem -LiteralPath $dir -Recurse -File -Force -ErrorAction SilentlyContinue |
    Where-Object { $_.Extension -in @('.json', '.jsonc', '.yaml', '.yml', '.md', '.txt') } |
    ForEach-Object { Expand-AppRootFile $_.FullName $rootFwd | Out-Null }
}

# ---------- 工作区资料同步 ----------
# 仓库里的 workspace/ 是用户资料，必须字节保真：不走 Expand-AppRootTree（会改文本），
# 一律 Copy-Item -LiteralPath 原样拷；登记表里的路径占位符在这里展开成本机绝对路径。
# （$BS / $WorkspaceHomeToken / $wsSkip* / Test-WorkspaceIgnored 都在 dsh-sync-common.ps1 里，两个脚本共用）

function Sync-WorkspaceApply {
  $wsDir = Join-Path $RepoRoot 'workspace'
  $manifestPath = Join-Path $wsDir 'workspace-registry.json'
  if (-not (Test-Path -LiteralPath $manifestPath)) {
    Warn ('仓库里没有 {0}，跳过工作区还原（仓库里没有工作区资料）' -f $manifestPath)
    return
  }
  $mf = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
  $appRootFwd = $AppRoot.Replace($BS,'/').TrimEnd('/')
  $wsHomeFwd  = $WorkspaceHome.Replace($BS,'/').TrimEnd('/')

  # 先算好每个工作区的本机落点：{{APP_ROOT}} / {{WORKSPACE_HOME}} → 本机绝对路径
  # 同时带上仓库里的会话与时间戳：B 机工作台要靠这些 sessionIds 才能列出/打开历史对话
  $plan = @()
  foreach ($w in @($mf.workspaces)) {
    $p = ([string]$w.path).Replace($BS,'/')
    $p = $p.Replace($AppRootToken, $appRootFwd).Replace($WorkspaceHomeToken, $wsHomeFwd)
    $localPath = $p.TrimEnd('/').Replace('/', $BS)
    $plan += [pscustomobject]@{
      Id                 = [string]$w.id
      Title              = [string]$w.title
      Slot               = [string]$w.slot
      LocalPath          = $localPath
      SessionIds         = @($w.sessionIds         | ForEach-Object { [string]$_ })
      ArchivedSessionIds = @($w.archivedSessionIds | ForEach-Object { [string]$_ })
      PinnedSessionIds   = @($w.pinnedSessionIds   | ForEach-Object { [string]$_ })
      CreatedAt          = [string]$w.createdAt
      UpdatedAt          = [string]$w.updatedAt
    }
  }

  # 同步内容勾选：未勾选的工作区不还原资料、也不并进本机 workspace.json（本机原有登记原样保留）
  $skippedPlan = @($plan | Where-Object { -not (Test-SyncItemEnabled $Scope 'workspace' $_.Id) })
  foreach ($s in $skippedPlan) { Warn ('跳过（未勾选同步）工作区：{0}' -f $s.Title) }
  $plan = @($plan | Where-Object { Test-SyncItemEnabled $Scope 'workspace' $_.Id })

  # 1) 资料还原（字节保真，覆盖前先备份本机现有文件）
  $nAdd = 0; $nDel = 0; $nBk = 0
  foreach ($e in $plan) {
    $srcRoot = Join-Path $wsDir $e.Slot
    if (-not (Test-Path -LiteralPath $srcRoot)) {
      Warn ('登记表里工作区「{0}」没有对应资料目录，跳过资料还原：{1}' -f $e.Title, $srcRoot)
      continue
    }
    $repoRels = @{}
    foreach ($f in @(Get-ChildItem -LiteralPath $srcRoot -Recurse -File -Force)) {
      $rel = Get-RelPath $srcRoot $f.FullName
      if (-not $rel) { continue }
      # 老仓库里可能还留着模型权重/whl 这类大文件：不铺到本机（本机自己那份才是原件）
      if (Test-WorkspaceIgnored $rel) { continue }
      if ($f.Length -gt $wsMaxFileBytes) {
        Warn ('仓库里这个文件过大，跳过不还原：{0}' -f $rel)
        Add-SyncNotice -Kind 'too-large' -Path $rel -Bytes ([long]$f.Length) -Reason ('仓库里这份 {0:N1} MB > 100 MB，未还原到本机' -f ($f.Length / 1MB))
        continue
      }
      $repoRels[$rel] = $f.FullName
    }
    # 备份本机现有资料（覆盖前的完整快照）
    # 但排除「不参与同步」的东西（models/、*.whl、>100MB 之类）：备份它们会把磁盘写满，
    # 而且它们本来就不会被覆盖，没有备份价值（真实事故：13.8GB 模型被备份进 ~\.dsh\backups，C 盘直接满）。
    if (Test-Path -LiteralPath $e.LocalPath) {
      $bk = Join-Path $BackupDir ("workspace\" + $e.Slot)
      foreach ($lf in @(Get-ChildItem -LiteralPath $e.LocalPath -Recurse -File -Force -ErrorAction SilentlyContinue)) {
        $rel = Get-RelPath $e.LocalPath $lf.FullName
        if (-not $rel) { continue }
        if (Test-WorkspaceIgnored $rel) { continue }
        if ($lf.Length -gt $wsMaxFileBytes) { continue }
        $bd = Join-Path $bk $rel
        $bdd = Split-Path -Parent $bd
        if (-not (Test-Path -LiteralPath $bdd)) { New-Item -ItemType Directory -Path $bdd -Force | Out-Null }
        Copy-Item -LiteralPath $lf.FullName -Destination $bd -Force
        $nBk++
      }
    }
    if (-not (Test-Path -LiteralPath $e.LocalPath)) { New-Item -ItemType Directory -Path $e.LocalPath -Force | Out-Null }
    foreach ($rel in @($repoRels.Keys)) {
      $s = $repoRels[$rel]
      $d = Join-Path $e.LocalPath $rel
      $dd = Split-Path -Parent $d
      if (-not (Test-Path -LiteralPath $dd)) { New-Item -ItemType Directory -Path $dd -Force | Out-Null }
      $need = $false
      if (-not (Test-Path -LiteralPath $d)) { $need = $true }
      elseif ((Get-FileHash -LiteralPath $s -Algorithm SHA256).Hash -ne (Get-FileHash -LiteralPath $d -Algorithm SHA256).Hash) { $need = $true }
      if ($need) { Copy-Item -LiteralPath $s -Destination $d -Force; $nAdd++ }
    }
    # 本机多出的文件：默认不动只提示，加 -PruneWorkspace 才删
    $extra = @()
    foreach ($lf in @(Get-ChildItem -LiteralPath $e.LocalPath -Recurse -File -Force -ErrorAction SilentlyContinue)) {
      $rel = Get-RelPath $e.LocalPath $lf.FullName
      if ($rel -and -not $repoRels.ContainsKey($rel) -and -not (Test-WorkspaceIgnored $rel)) { $extra += $lf.FullName }
    }
    if ($extra.Count -gt 0) {
      if ($PruneWorkspace) {
        foreach ($x in $extra) { Remove-Item -LiteralPath $x -Force; $nDel++ }
      } else {
        Warn ('工作区「{0}」本机另有 {1} 个仓库里没有的文件（未动，加 -PruneWorkspace 才删）：{2}' -f $e.Title, $extra.Count, (($extra | Select-Object -First 3) -join '、'))
      }
    }
    Ok ('已还原工作区「{0}」→ {1}（{2} 个文件，字节保真）' -f $e.Title, $e.LocalPath, $repoRels.Count)
  }

  # 2) 登记表合并进本机 workspace.json（默认按 ID 合并，保留本机自建工作区）
  $registryDst = Join-Path $DshHome 'storages/workspace.json'
  $regObj = $null
  if (Test-Path -LiteralPath $registryDst) {
    Copy-Item -LiteralPath $registryDst -Destination (Join-Path $BackupDir 'workspace-registry-before.json') -Force
    $regObj = Get-Content -LiteralPath $registryDst -Raw -Encoding UTF8 | ConvertFrom-Json
  }
  $localTable = [ordered]@{}
  $localGlobal = [ordered]@{}
  $unitObj = $null
  if ($regObj) {
    if ($regObj.unit) { $unitObj = $regObj.unit }
    if ($regObj.global) {
      foreach ($p in $regObj.global.PSObject.Properties) { $localGlobal[$p.Name] = $p.Value }
    }
    if ($regObj.tables -and $regObj.tables.workspaces) {
      foreach ($p in $regObj.tables.workspaces.PSObject.Properties) {
        $e2 = [ordered]@{}
        foreach ($q in $p.Value.PSObject.Properties) { $e2[$q.Name] = $q.Value }
        $localTable[$p.Name] = $e2
      }
    }
  }
  if (-not $unitObj) { $unitObj = [ordered]@{ name = 'workspace'; version = 2 } }
  if ($ReplaceWorkspaceRegistry) {
    $localTable = [ordered]@{}
    $localGlobal = [ordered]@{}
  }
  # 记下「合并前本机登记表里已有的工作区 ID」。同一路径被两台机器各自建过工作区时，
  # 两边 ID 必然不同；这时要保留**当前机器在用的那个 ID**，否则本机的 defaultWorkspaceId
  # 会指向一个被丢掉的 ID，登记表校验不过、工作区列表和会话一起读不出来。
  $localIdSet = @{}
  foreach ($k in @($localTable.Keys)) { $localIdSet[[string]$k] = $true }
  # 全局归档/置顶会话：取「仓库 + 本机」并集（-ReplaceWorkspaceRegistry 时本机已清空，只剩仓库）
  # 注意：$null 在管道里会被当成一个元素流过 ForEach-Object，[string]$null 就是 ""，
  # 于是缺失的字段会变成 @("") 写进 json。"" 不是合法会话 id，这里统一滤掉。
  $gArchAll = @(); $gPinAll = @()
  if ($mf.global) {
    $gArchAll += @($mf.global.archivedSessionIds | ForEach-Object { [string]$_ } | Where-Object { $_ -ne '' })
    $gPinAll  += @($mf.global.pinnedSessionIds   | ForEach-Object { [string]$_ } | Where-Object { $_ -ne '' })
  }
  if ($localGlobal.Contains('archivedSessionIds')) { $gArchAll += @($localGlobal['archivedSessionIds'] | ForEach-Object { [string]$_ } | Where-Object { $_ -ne '' }) }
  if ($localGlobal.Contains('pinnedSessionIds'))   { $gPinAll  += @($localGlobal['pinnedSessionIds']   | ForEach-Object { [string]$_ } | Where-Object { $_ -ne '' }) }

  foreach ($e in $plan) {
    # 运行时字段取「仓库 + 本机」并集：既把 A 机历史会话带过来，也不丢 B 机自建会话
    $repoSess = @($e.SessionIds)
    $repoArch = @($e.ArchivedSessionIds)
    $repoPin  = @($e.PinnedSessionIds)
    $created = $e.CreatedAt; $updated = $e.UpdatedAt
    if ($localTable.Contains($e.Id)) {
      $prev = $localTable[$e.Id]
      foreach ($k in @('sessionIds','archivedSessionIds','pinnedSessionIds')) {
        if ($prev.Contains($k)) {
          if     ($k -eq 'sessionIds')         { $repoSess += @($prev[$k] | ForEach-Object { [string]$_ } | Where-Object { $_ -ne '' }) }
          elseif ($k -eq 'archivedSessionIds') { $repoArch += @($prev[$k] | ForEach-Object { [string]$_ } | Where-Object { $_ -ne '' }) }
          else                                  { $repoPin  += @($prev[$k] | ForEach-Object { [string]$_ } | Where-Object { $_ -ne '' }) }
        }
      }
      if ($prev.Contains('createdAt')) { $created = [string]$prev['createdAt'] }
      if ($prev.Contains('updatedAt')) { $updated = [string]$prev['updatedAt'] }
    }
    $entry = [ordered]@{
      path               = $e.LocalPath
      title              = $e.Title
      sessionIds         = @($repoSess | Where-Object { $_ -ne '' } | Sort-Object -Unique)
      archivedSessionIds = @($repoArch | Where-Object { $_ -ne '' } | Sort-Object -Unique)
      pinnedSessionIds   = @($repoPin  | Where-Object { $_ -ne '' } | Sort-Object -Unique)
      createdAt          = $created
      updatedAt          = $updated
    }
    $localTable[$e.Id] = $entry
  }
  # 同一路径只能登记一个工作区：DSH 启动时会校验 duplicate paths，一张表里出现重复即
  # 整张登记表打不开（表现为左侧工作区列表全空、会话列表也一起读不出来）。
  # 换机时本机自建的 default-workspace 与仓库里同名工作区 ID 不同，按 ID 合并必然撞车，
  # 所以这里按 path 收敛成一条，其余条目的会话并入保留者。
  $pathGroups = [ordered]@{}
  foreach ($id in @($localTable.Keys)) {
    $p = [string]$localTable[$id]['path']
    if (-not $p) { continue }
    $key = $p.Replace('/', '\').TrimEnd('\').ToLowerInvariant()
    if (-not $pathGroups.Contains($key)) { $pathGroups[$key] = @() }
    $pathGroups[$key] += $id
  }
  $mfIdSet = @{}
  foreach ($e in $plan) { $mfIdSet[$e.Id] = $true }
  $dropped = @{}
  foreach ($key in @($pathGroups.Keys)) {
    $group = @($pathGroups[$key])
    if ($group.Count -le 1) { continue }
    # 保留哪一个：优先**本机原有的 ID**（当前机器在用的那个，defaultWorkspaceId 指向它），
    # 本机没有这个路径时才用仓库的 ID，最后退到会话最多的那个。
    # 早先版本反着来（优先仓库 ID），换机 pull 后本机 ID 被丢掉，defaultWorkspaceId 随之悬空。
    $keeper = @($group | Where-Object { $localIdSet.ContainsKey($_) }) | Select-Object -First 1
    if (-not $keeper) {
      $keeper = @($group | Where-Object { $mfIdSet.ContainsKey($_) }) | Select-Object -First 1
    }
    if (-not $keeper) {
      $keeper = @($group | Sort-Object -Property @{ Expression = { @($localTable[$_]['sessionIds']).Count } } -Descending) | Select-Object -First 1
    }
    foreach ($other in @($group | Where-Object { $_ -ne $keeper })) {
      $localTable[$keeper]['sessionIds']         = @(@($localTable[$keeper]['sessionIds'])         + @($localTable[$other]['sessionIds'])         | Where-Object { $_ -ne '' } | Sort-Object -Unique)
      $localTable[$keeper]['archivedSessionIds'] = @(@($localTable[$keeper]['archivedSessionIds']) + @($localTable[$other]['archivedSessionIds']) | Where-Object { $_ -ne '' } | Sort-Object -Unique)
      $localTable[$keeper]['pinnedSessionIds']   = @(@($localTable[$keeper]['pinnedSessionIds'])   + @($localTable[$other]['pinnedSessionIds'])   | Where-Object { $_ -ne '' } | Sort-Object -Unique)
      Warn ('同一路径撞了两个工作区，已合并为一条：{0}（ID {1} 的会话并入 ID {2}）' -f $localTable[$keeper]['path'], $other, $keeper)
      $dropped[$other] = $true
      $localTable.Remove($other)
    }
  }
  $ids = @($localTable.Keys | ForEach-Object { [string]$_ } | Where-Object { -not $dropped.ContainsKey($_) })
  $mfDefault = if ($mf.global) { [string]$mf.global.defaultWorkspaceId } else { '' }
  $localDefault = if ($localGlobal.Contains('defaultWorkspaceId')) { [string]$localGlobal['defaultWorkspaceId'] } else { '' }
  # defaultWorkspaceId 一律以「当前机器」为准：本机原来那个只要还在表里就原样保留；
  # 只有在它已经不存在（被合并掉/首次迁移）时才退到仓库值，再不行取第一条。
  # 悬空的 defaultWorkspaceId 会让 DSH 的登记表校验失败，症状是工作区列表空、会话全读不出。
  if (-not ($localDefault -and ($ids -contains $localDefault))) {
    if ($mfDefault -and ($ids -contains $mfDefault)) { $localGlobal['defaultWorkspaceId'] = $mfDefault }
    elseif ($ids.Count -gt 0) { $localGlobal['defaultWorkspaceId'] = $ids[0] }
    else { $localGlobal['defaultWorkspaceId'] = '' }
  }
  elseif (-not $localGlobal.Contains('defaultWorkspaceId')) { $localGlobal['defaultWorkspaceId'] = $localDefault }
  $localGlobal['initialized'] = $true
  $localGlobal['workspaceIds'] = $ids
  $localGlobal['archivedSessionIds'] = @($gArchAll | Sort-Object -Unique)
  $localGlobal['pinnedSessionIds']   = @($gPinAll  | Sort-Object -Unique)
  $newReg = [ordered]@{}
  $newReg['unit'] = $unitObj
  $newReg['global'] = $localGlobal
  $newReg['tables'] = [ordered]@{ workspaces = $localTable }
  $regText = (($newReg | ConvertTo-Json -Depth 12) -replace "`r`n", "`n") + "`n"
  $regParent = Split-Path -Parent $registryDst
  if (-not (Test-Path -LiteralPath $regParent)) { New-Item -ItemType Directory -Path $regParent -Force | Out-Null }
  [IO.File]::WriteAllText($registryDst, $regText, (New-Object Text.UTF8Encoding($false, $false)))
  Ok ('工作区登记表已' + $(if ($ReplaceWorkspaceRegistry) { '整份覆盖' } else { '按 ID 合并' }) + " → $registryDst（$($plan.Count) 个工作区）")

  # 登记了工作区、但仓库里没有它的资料目录时（例如「Gitee同步」这种空工作区），
  # 目录本身不会被上面那段铺出来。登记表里却写了这个路径，DSH 打开工作区就会指向一个不存在的目录
  # （表现为工作区点不开/新建会话报错）。所以这里按刚写出的登记表把缺的目录补出来。
  # 读文件而不是读内存里的 $localTable：那份还是占位符形态，直接 New-Item 会报 "path's format is not supported"。
  $written = Get-Content -LiteralPath $registryDst -Raw -Encoding UTF8 | ConvertFrom-Json
  foreach ($w in @($written.tables.workspaces.PSObject.Properties)) {
    $wp = [string]$w.Value.path
    if (-not $wp) { continue }
    if (-not (Test-Path -LiteralPath $wp)) {
      New-Item -ItemType Directory -Path $wp -Force | Out-Null
      Ok ('已补建空工作区目录：{0}' -f $wp)
    }
  }

  Ok ('工作区全量还原：{0} 个工作区，写入/更新 {1} 个文件、备份 {2} 个、删除 {3} 个' -f $plan.Count, $nAdd, $nBk, $nDel)
}

# ---------- 对话/会话数据还原：常量与函数 ----------
# sessions\ 一级目录名 = Get-SessionDirName(工作区绝对路径)。编码不可逆，所以 capture
# 在 conversations\session-index.json 里记了「目录名 ↔ 工作区 ID」；apply 按本机
# -AppRoot / -WorkspaceHome 展开后的路径重新编码目录名，B 机才能认出这些会话。
function Get-SessionDirName([string]$path) {
  $sb = New-Object System.Text.StringBuilder
  [void]$sb.Append('--')
  foreach ($ch in $path.ToCharArray()) {
    $c = [int][char]$ch
    if ($c -eq 58) { continue }                                        # ':' 丢弃
    if ($c -eq 92 -or $c -eq 47) { [void]$sb.Append('-'); continue }    # \ / → -
    if ($c -lt 128) { [void]$sb.Append($ch) }
    else { [void]$sb.Append(('~{0:X4}' -f $c)) }                        # 非 ASCII → ~XXXX（连续 CJK 共享 ~ 串联）
  }
  [void]$sb.Append('--')
  return $sb.ToString()
}

function Sync-ConversationApply {
  $convDir = Join-Path $RepoRoot 'conversations'
  $indexPath = Join-Path $convDir 'session-index.json'
  if (-not (Test-Path -LiteralPath $convDir)) {
    Warn ('仓库里没有 {0}，跳过会话还原' -f $convDir)
    return
  }

  # 1) 读工作区登记表，建 workspaceId → 本机绝对路径（占位符展开后）映射
  $appRootFwd = $AppRoot.Replace($BS,'/').TrimEnd('/')
  $wsHomeFwd  = $WorkspaceHome.Replace($BS,'/').TrimEnd('/')
  $idToLocal = @{}
  $mfPath = Join-Path $RepoRoot 'workspace\workspace-registry.json'
  if (Test-Path -LiteralPath $mfPath) {
    $mf = Get-Content -LiteralPath $mfPath -Raw -Encoding UTF8 | ConvertFrom-Json
    foreach ($w in @($mf.workspaces)) {
      $p = ([string]$w.path).Replace($BS,'/')
      $p = $p.Replace($AppRootToken, $appRootFwd).Replace($WorkspaceHomeToken, $wsHomeFwd)
      $idToLocal[[string]$w.id] = $p.TrimEnd('/').Replace('/', $BS)
    }
  }

  # 2) 目录名重映射：A 机目录名 → B 机目录名；同时记下 B 机这条目录应对应的 cwd
  #    （会话文件 header 里的 cwd 必须与目录名编码一致，否则 DSH 判 corrupt）
  $dirMap = @{}
  $cwdMap = @{}
  $skipConvDirs = @{}   # 被“同步内容”取消勾选的工作区会话目录（不铺回本机）
  $imLocal = Join-Path $DshHome 'im'
  if (Test-Path -LiteralPath $indexPath) {
    $idx = Get-Content -LiteralPath $indexPath -Raw -Encoding UTF8 | ConvertFrom-Json
    foreach ($e in @($idx.entries)) {
      $oldDir = [string]$e.dir
      if ($e.workspaceId -and -not (Test-SyncItemEnabled $Scope 'conversations' ([string]$e.workspaceId))) {
        $skipConvDirs[$oldDir] = $true
        Warn ('跳过（未勾选同步）该工作区的会话：{0}' -f $oldDir)
        continue
      }
      if ($e.workspaceId -and $idToLocal.ContainsKey([string]$e.workspaceId)) {
        $localPath = $idToLocal[[string]$e.workspaceId]
        $newDir = Get-SessionDirName $localPath
        $dirMap[$oldDir] = $newDir
        $cwdMap[$newDir] = $localPath
      } elseif ($e.special -eq 'im') {
        $newDir = Get-SessionDirName $imLocal
        $dirMap[$oldDir] = $newDir
        $cwdMap[$newDir] = $imLocal
      } else {
        $dirMap[$oldDir] = $oldDir   # passthrough / 对应不到的工作区，原名保留
        Warn ('会话目录 {0} 对应不到本机工作区，目录名与文件头 cwd 都无法重算，DSH 可能把它判为损坏：请在本机重新打开该工作区后再同步' -f $oldDir)
      }
    }
  }
  # 2b) 兜底：仓库里出现 --ws-<工作区ID>-- 但 session-index.json 没记（索引缺失/被清）时，直接按 ID 映射
  $repoSessions = Join-Path $convDir 'sessions'
  if (Test-Path -LiteralPath $repoSessions) {
    foreach ($d in @(Get-ChildItem -LiteralPath $repoSessions -Directory -Force)) {
      if ($dirMap.ContainsKey($d.Name)) { continue }
      if ($d.Name -match '^--ws-(?<id>.+)--$') {
        $id = $Matches['id']
        $hit = $null
        foreach ($k in @($idToLocal.Keys)) {
          $safeId = ($k -replace '[^A-Za-z0-9_.-]', '_')
          if ($safeId -eq $id) { $hit = $k; break }
        }
        if ($hit) {
          if (-not (Test-SyncItemEnabled $Scope 'conversations' $hit)) {
            $skipConvDirs[$d.Name] = $true
            Warn ('跳过（未勾选同步）该工作区的会话：{0}' -f $d.Name)
            continue
          }
          $localPath = $idToLocal[$hit]
          $newDir = Get-SessionDirName $localPath
          $dirMap[$d.Name] = $newDir
          $cwdMap[$newDir] = $localPath
        }
      }
    }
  }

  # 3) 四块数据字节还原（覆盖前备份同名文件；sessions 一级目录按 dirMap 改名）
  #    前置校验：会话文件头部的 cwd 必须展开成本机路径，否则 DSH 判 corrupt，整层会话
  #    都不登记（症状：工作区还在、会话一个都看不到）。这一步只能靠 Node 解 zstd。
  #    找不到 Node / 缺 helper 时**宁可不铺**：铺进去的是 {{APP_ROOT}} 占位符文件，比不铺更糟。
  $cwdHelper = Join-Path $PSScriptRoot 'tools\fix-session-cwd.mjs'
  if (-not (Test-Path -LiteralPath $cwdHelper)) { $cwdHelper = Join-Path $RepoRoot 'tools\fix-session-cwd.mjs' }
  $nodeRunner = Get-HostNodeRunner $AppRoot
  # projcache 也要按「本机的工作区落点」对齐：它的文件名是 sessionId，
  # 登记表里每个工作区带着 sessionIds，所以能直接反查到本机路径。
  # 不换的话 B 机打开这些会话时 cwd 仍指 A 机目录，历史对话回不到正确工作区。
  $projMap = @{}
  if ($mf -and (Test-Path -LiteralPath (Join-Path $DshHome 'storages\session_projcache\sessions'))) {
    foreach ($w in @($mf.workspaces)) {
      $wid = [string]$w.id
      if (-not $idToLocal.ContainsKey($wid)) { continue }
      $lid = $idToLocal[$wid]
      foreach ($sid in @($w.sessionIds)) { if ($sid) { $projMap[[string]$sid] = $lid } }
    }
  }
  if ($cwdMap.Count -gt 0 -or $projMap.Count -gt 0) {
    if (-not (Test-Path -LiteralPath $cwdHelper)) {
      Warn ('缺少会话头部修正脚本 {0}，本次跳过会话还原（铺进去的会话 DSH 会判为损坏）' -f $cwdHelper)
      return
    }
    if (-not $nodeRunner) {
      Warn '这台机器既没有 Node，也找不到客户端本体，本次跳过会话还原（会话文件里的 {{APP_ROOT}} 占位符无法展开，铺进去 DSH 会全部不登记）'
      Warn '本机配置与工作区资料不受影响；装一个 Node 后重新拉取即可'
      return
    }
  }
  $blocks = @(
    @{ Repo = 'sessions';                     Dst = (Join-Path $DshHome 'sessions');                                         Remap = $true  },
    @{ Repo = 'attachments';                  Dst = (Join-Path $DshHome 'attachments');                                      Remap = $false },
    @{ Repo = 'session_projcache';            Dst = (Join-Path $DshHome 'storages\session_projcache\sessions');             Remap = $false },
    @{ Repo = 'vision_router_session_policy'; Dst = (Join-Path $DshHome 'storages\vision_router_session_policy\policies');  Remap = $false }
  )
  $nAdd = 0; $nBk = 0
  foreach ($b in $blocks) {
    $srcRoot = Join-Path $convDir $b.Repo
    if (-not (Test-Path -LiteralPath $srcRoot)) { continue }
    if (-not (Test-Path -LiteralPath $b.Dst)) { New-Item -ItemType Directory -Path $b.Dst -Force | Out-Null }
    foreach ($f in @(Get-ChildItem -LiteralPath $srcRoot -Recurse -File -Force)) {
      $rel = Get-RelPath $srcRoot $f.FullName
      if (-not $rel) { continue }
      if ($b.Remap) {
        # 相对路径第一段是 A 机的编码目录名，换成 B 机重编码后的名字
        $parts = @($rel -split '\\')
        # 默认工作区不同步（见 dsh-sync-common.ps1）：老仓库里可能还留着这条，直接跳过不铺。
        if (Test-DefaultWorkspaceDir $parts[0]) { continue }
        # 该工作区的会话被取消勾选：不铺回本机（否则等于把未勾选的内容写回来了）
        if (-not $dirMap.ContainsKey($parts[0]) -and $skipConvDirs.ContainsKey($parts[0])) { continue }
        if ($dirMap.ContainsKey($parts[0])) { $parts[0] = $dirMap[$parts[0]] }
        $dstRel = ($parts -join '\')
      } else {
        $dstRel = $rel
      }
      $d = Join-Path $b.Dst $dstRel
      $dd = Split-Path -Parent $d
      if (-not (Test-Path -LiteralPath $dd)) { New-Item -ItemType Directory -Path $dd -Force | Out-Null }
      $need = $false
      if (-not (Test-Path -LiteralPath $d)) { $need = $true }
      elseif ((Get-FileHash -LiteralPath $f.FullName -Algorithm SHA256).Hash -ne (Get-FileHash -LiteralPath $d -Algorithm SHA256).Hash) { $need = $true }
      if ($need) {
        # 覆盖前备份本机已有文件
        if (Test-Path -LiteralPath $d) {
          $bd = Join-Path $BackupDir ("conversations\" + $b.Repo + "\" + $dstRel)
          $bdd = Split-Path -Parent $bd
          if (-not (Test-Path -LiteralPath $bdd)) { New-Item -ItemType Directory -Path $bdd -Force | Out-Null }
          Copy-Item -LiteralPath $d -Destination $bd -Force
          $nBk++
        }
        Copy-Item -LiteralPath $f.FullName -Destination $d -Force
        $nAdd++
      }
    }
  }
  # 会话是增量数据：只覆盖/新增，不删本机多出的会话文件
  # 4) 会话文件头部的 cwd 必须改成本机路径，否则 DSH 判 corrupt、整个会话层起不来
  #    projcache 也要一起改：只按 $cwdMap 判断会让「仓库里只有 projcache、没有 sessions」的
  #    情况整段跳过（隔离环境实测：工作区还原了，会话 cwd 仍指源机）。两处任一有活就得跑。
  if ($cwdMap.Count -gt 0 -or $projMap.Count -gt 0) {
    $specPath = Join-Path ([IO.Path]::GetTempPath()) ('dsh-session-cwd-{0}.json' -f $stamp)
    $specJson = [ordered]@{ home = $DshHome; dirs = $cwdMap; projcache = $projMap } | ConvertTo-Json -Depth 4 -Compress
    [IO.File]::WriteAllText($specPath, $specJson, (New-Object Text.UTF8Encoding($false)))
    $helper = $cwdHelper
    # 结果落文件而不是抓 stdout：执行器可能是客户端自带的 Electron（GUI 子系统，stdout 抓不到）
    $resultPath = Join-Path ([IO.Path]::GetTempPath()) ('dsh-session-cwd-{0}.out.json' -f $stamp)
    $oldRunAsNode = $env:ELECTRON_RUN_AS_NODE
    if ((Test-Path -LiteralPath $helper) -and $nodeRunner) {
      try {
        if ($nodeRunner.Electron) { $env:ELECTRON_RUN_AS_NODE = '1' }
        else { Remove-Item Env:\ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue }
        & $nodeRunner.Exe $helper $specPath $resultPath | Out-Null
        if (-not (Test-Path -LiteralPath $resultPath)) { throw '执行器没有产出结果文件（可能不是 Node/Electron）' }
        $line = ([IO.File]::ReadAllText($resultPath)).Trim()
        $r = $line | ConvertFrom-Json -ErrorAction Stop
        if (@($r.failed).Count -gt 0) {
          foreach ($fe in @($r.failed)) {
            Warn ('会话头部修正失败：{0}（{1}）' -f $fe.file, $fe.error)
            Add-SyncNotice -Kind 'failed' -Path ([string]$fe.file) -Reason ('会话头部修正失败：' + [string]$fe.error)
          }
          Warn ('有 {0} 个会话文件没能修正，DSH 里这些会话可能显示为损坏' -f @($r.failed).Count)
        }
        if (@($r.projFailed).Count -gt 0) {
          foreach ($fe in @($r.projFailed)) {
            Warn ('会话 projcache 的 cwd 没改成：{0}（{1}）' -f $fe.file, $fe.error)
            Add-SyncNotice -Kind 'failed' -Path ([string]$fe.file) -Reason ('会话 projcache 的 cwd 未修正：' + [string]$fe.error)
          }
        }
        Ok ('会话头部 cwd 已对齐本机路径：修正 {0} 个、本就正确 {1} 个（目录 {2} 个）' -f $r.fixed, $r.alreadyOk, $cwdMap.Count)
        Ok ('会话 projcache 的 cwd 已对齐本机路径：修正 {0} 个、本就正确 {1} 个（会话 {2} 个）' -f ([int]$r.projFixed), ([int]$r.projAlreadyOk), $projMap.Count)
      } catch {
        Warn ('会话头部修正执行失败：{0}' -f $_.Exception.Message)
        Warn '未修正的会话会在 DSH 里被判为损坏，导致工作区/会话列表为空，请先跑一次拉取再还原'
      } finally {
        if ($null -eq $oldRunAsNode) { Remove-Item Env:\ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue }
        else { $env:ELECTRON_RUN_AS_NODE = $oldRunAsNode }
        Remove-Item -LiteralPath $specPath -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $resultPath -Force -ErrorAction SilentlyContinue
      }
    } else {
      Warn ('没找到可用于修正会话头部的执行器（Node / 客户端 Electron 都没找到，AppRoot={0}），本次未修正' -f $AppRoot)
    }
  }
  Ok ('会话数据全量还原：{0} 个目录映射，写入/更新 {1} 个文件、备份 {2} 个（四块数据字节保真，会话只增不删）' -f $dirMap.Count, $nAdd, $nBk)
}

Say "== DSH 配置同步 / apply =="
Say "仓库：$RepoRoot"
Say "DSH home：$DshHome"
Say "客户端：$AppRoot"
Say ""

# 同步内容勾选（面板「同步内容」卡写在本机 ~\.dsh\config-sync-scope.json）：未勾选的组不还原，本机数据原地不动
$Scope = Get-SyncScope $DshHome

# 备份目录统一在脚本开头建立（工作区覆盖前的快照也放这里）
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$BackupDir = Join-Path $DshHome "backups\config-$stamp"
New-Item -ItemType Directory -Path $BackupDir -Force | Out-Null

# -WorkspaceOnly：只还原工作区 + 会话（B 机没装 DSH 也能先落地资料），做完直接结束
if ($WorkspaceOnly) {
  if ($SkipWorkspace) { Die "-WorkspaceOnly 与 -SkipWorkspace 不能同时使用" }
  if (Test-SyncGroupEnabled $Scope 'workspace') { Sync-WorkspaceApply } else { Warn '跳过（未勾选同步）：工作区资料' }
  if (Test-SyncGroupEnabled $Scope 'conversations') { Sync-ConversationApply } else { Warn '跳过（未勾选同步）：会话记录' }
  Say ""
  Say "== 完成（仅工作区 + 会话）=="
  Say "如需回滚：把 $BackupDir 里的 workspace\ / conversations\ 拷回原位置。"
  return
}

# ---------- 0. 前置检查 ----------
$proc = Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue
if ($proc -and -not $Force) {
  Die "检测到 DeepSeek Harness 仍在运行（PID: $(($proc.Id) -join ',')）。请完全退出（含托盘）后重新执行，或加 -Force 强制继续。"
}
foreach ($p in @("$RepoRoot\profile\package.json", "$RepoRoot\profile\cordis.patch.yml")) {
  if (-not (Test-Path -LiteralPath $p)) {
    if (Test-SyncGroupEnabled $Scope 'profile') { Die "仓库内容不完整，缺少：$p" }
    Warn ("仓库里没有 " + $p + "（本机未勾选同步 profile，按跳过处理）")
  }
}
$ProfileDir = Join-Path $DshHome ("profiles\" + $ProfileName)
if (-not (Test-Path -LiteralPath $ProfileDir)) {
  Warn "目标 profile 不存在：$ProfileDir（本机还没装过 DSH？）"
  Die "请先在当前电脑安装同版本 DSH 客户端，启动一次让它生成 profile 目录，再跑本脚本。"
}

# 需要跨机一致的插件设置 / 工作流：仓库路径 → 本机路径
# 0.3.30 起扩到各插件自己的配置；文件里存的是占位符，落到本机前统一展开
$settingsMap = @(
  @{ Repo = 'settings\our-free-model.json';        Src = (Join-Path $DshHome 'our-free-model\settings.json');                    Label = 'our-free-model 插件设置' },
  @{ Repo = 'settings\comfyui-workflows.json';     Src = (Join-Path $DshHome 'data\dsh-comfyui\workflows.json');                  Label = 'ComfyUI 工作流库' },
  @{ Repo = 'settings\dsh-pet-main-config.jsonc';  Src = (Join-Path $DshHome 'dsh-pet\main-config.jsonc');                        Label = '桌宠配置' },
  @{ Repo = 'settings\dsh-market-state.json';      Src = (Join-Path $ProfileDir '.dsh-market\state.json');                       Label = '插件市场状态' },
  @{ Repo = 'settings\dsh-pet-memory.json';        Src = (Join-Path $DshHome 'dsh-pet\memory.json');                              Label = '桌宠记忆' },
  @{ Repo = 'settings\our-free-model-picks.json';  Src = (Join-Path $DshHome 'our-free-model\picks.json');                        Label = 'our-free-model 收藏' },
  @{ Repo = 'settings\dsh-im-interface-language.json'; Src = (Join-Path $DshHome 'integrations\dsh-im\interface-language.json'); Label = 'dsh-im 界面语言' },
  @{ Repo = 'settings\dsh-qq-config.json';         Src = (Join-Path $DshHome 'integrations\dsh-qq\config.json');                  Label = 'QQ 集成配置' },
  @{ Repo = 'settings\dsh-qq-workspaces.json';     Src = (Join-Path $DshHome 'integrations\dsh-qq\workspaces.json');              Label = 'QQ 集成工作区' },
  @{ Repo = 'settings\redteam-preset-declare.json'; Src = (Join-Path $DshHome 'redteam\preset-declare.json');                      Label = '红队预设声明' },
  @{ Repo = 'settings\task-board-ledger.json';     Src = (Join-Path $DshHome 'task-board\ledger-v2.json');                        Label = '任务板台账' },
  @{ Repo = 'settings\task-board-scheduler.json';  Src = (Join-Path $DshHome 'task-board\scheduler-v2.json');                     Label = '任务板调度' },
  @{ Repo = 'settings\dsh-workspaces.json';        Src = (Join-Path $DshHome 'storages\workspace.json');                          Label = 'DSH 工作区登记' }
)

# ---------- 0.5 宿主版本契约（一切动作之前先校验） ----------
# 为什么要在最前面校验：
#   仓库的 bundle 清单里有 @deepseek-ai/dsh-experimental-* 这类「宿主自带、按版本强绑定」的项
#   （例如 cot-translation 需要主进程同版本的 typert 服务）。它们不经过 pnpm、不在 dependencies 里，
#   目标机的客户端构建只要不同，启动期就会在 entry loading 阶段抛错，整个应用起不来。
#   旧脚本对此毫无校验：清单整表覆盖、自检只数数量，故障要等双击图标才暴露。
#   现在的规则：版本对不上 → 直接拒绝（可显式 -AllowVersionDrift 放行，但实验性 bundle 一律剔除），
#   拒绝发生在备份、还原、写文件之前。
$contractPath = Join-Path $RepoRoot 'profile\host-contract.json'
$hostAppVersion = Get-HostAppVersion $AppRoot
$contractVersion = $null
if (Test-Path -LiteralPath $contractPath) {
  try { $contractVersion = [string](Get-Content -LiteralPath $contractPath -Raw -Encoding utf8 | ConvertFrom-Json).appVersion } catch { $contractVersion = $null }
}
$versionDrift = $false
if (-not $hostAppVersion) {
  Warn "读不到客户端 app 版本（$AppRoot\resources\app\package.json 与 resources\app.asar 都没读到）——无法做版本校验"
} elseif (-not $contractVersion) {
  Warn "仓库缺少 profile\host-contract.json（或里面没有 appVersion）——跳过版本校验"
} elseif ($hostAppVersion -ne $contractVersion) {
  $versionDrift = $true
  Warn "宿主版本不一致：本机 app = $hostAppVersion，仓库契约 = $contractVersion"
  if (-not $AllowVersionDrift) {
    Die ("两端客户端不是同一版，未改动任何文件。请先把两台升到同一版；" +
         "或加 -AllowVersionDrift 只同步配置/技能/资料（会剔除全部实验性 bundle，避免启动期崩溃）。")
  }
  Warn "已加 -AllowVersionDrift：继续同步，但剔除实验性 bundle"
} else {
  Ok "宿主版本一致（app = $hostAppVersion）"
}

# ---------- 1. 备份现有配置（$BackupDir 已在脚本开头统一建立） ----------
$backedUp = 0
foreach ($f in @('package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'cordis.yml', 'cordis.patch.yml')) {
  $src = Join-Path $ProfileDir $f
  if (Test-Path -LiteralPath $src) { Copy-Item -LiteralPath $src -Destination (Join-Path $BackupDir $f) -Force; $backedUp++ }
}
foreach ($f in @('AGENTS.md', 'prompt-inject.md')) {
  $src = Join-Path $DshHome $f
  if (Test-Path -LiteralPath $src) { Copy-Item -LiteralPath $src -Destination (Join-Path $BackupDir $f) -Force; $backedUp++ }
}
foreach ($m in $settingsMap) {
  if (Test-Path -LiteralPath $m.Src) {
    $bc = Join-Path $BackupDir 'settings'
    if (-not (Test-Path -LiteralPath $bc)) { New-Item -ItemType Directory -Path $bc -Force | Out-Null }
    Copy-Item -LiteralPath $m.Src -Destination (Join-Path $bc (Split-Path -Leaf $m.Src)) -Force
    $backedUp++
  }
}
if ($backedUp -gt 0) {
  Ok "已备份 $backedUp 个文件到 $BackupDir"
} else {
  Ok "本机还没有这些配置文件（全新机器），无需备份；快照目录 $BackupDir 会是空的，还原脚本会自动跳过它"
}

# Skill / 预设目录同样会被覆盖（同名）或删除（-PruneSkills），覆盖前一并备份
foreach ($pair in @(@{ Local = (Join-Path $DshHome 'skills');         Repo = (Join-Path $RepoRoot 'skills');  Name = 'skills' },
                    @{ Local = (Join-Path $DshHome '.agent-presets');  Repo = (Join-Path $RepoRoot 'presets'); Name = 'presets' })) {
  if (-not (Test-Path -LiteralPath $pair.Local)) { continue }
  $names = @(Get-ChildItem -LiteralPath $pair.Local -Directory -Force | Where-Object {
      $PruneSkills -or (Test-Path -LiteralPath (Join-Path $pair.Repo $_.Name))
    } | Select-Object -ExpandProperty Name)
  if ($names.Count -eq 0) { continue }
  $bk = Join-Path $BackupDir $pair.Name
  New-Item -ItemType Directory -Path $bk -Force | Out-Null
  foreach ($n in $names) { Copy-Item -LiteralPath (Join-Path $pair.Local $n) -Destination (Join-Path $bk $n) -Recurse -Force }
  Ok "已备份 $($names.Count) 个将被覆盖的$($pair.Name) 目录到 $bk"
}

# ---------- 1.5 工作区 + 会话还原（默认开、全量；在铺配置文件之前单独跑） ----------
if (-not $SkipWorkspace) {
  if (Test-SyncGroupEnabled $Scope 'workspace') { Sync-WorkspaceApply } else { Warn '跳过（未勾选同步）：工作区资料' }
  if (Test-SyncGroupEnabled $Scope 'conversations') { Sync-ConversationApply } else { Warn '跳过（未勾选同步）：会话记录' }
} else {
  Warn "已指定 -SkipWorkspace，跳过全部工作区与会话还原"
}

# ---------- 2. 铺 profile 配置（把 {{APP_ROOT}} 展开成本机客户端路径） ----------
$appRootFwd = ($AppRoot -replace '\\', '/').TrimEnd('/')
if (Test-SyncGroupEnabled $Scope 'profile') {
foreach ($f in @('cordis.yml', 'cordis.patch.yml', 'pnpm-workspace.yaml', 'pnpm-lock.yaml')) {
  $src = Join-Path $RepoRoot "profile\$f"
  if (-not (Test-Path -LiteralPath $src)) { Warn "仓库里没有 profile\$f，跳过"; continue }
  # 必须读→替换→写。直接 Copy-Item 会把仓库里的 {{APP_ROOT}} 或别的机器的盘符原样带过来，
  # 进而让 pnpm-lock.yaml 与 package.json 对不上，--frozen-lockfile 必挂。
  $raw = Expand-AppRoot (Read-TextPreserveBom $src) $appRootFwd
  # 写完就地核对：占位符没展开会让 cordis.patch.yml 变成非法 YAML（宿主启动直接 fatal），
  # 也会让 pnpm-lock.yaml 的 specifier 与 package.json 对不上。宁可在这里停，也不要把坏文件铺下去。
  if ($raw.Contains($AppRootToken) -or $raw.Contains($WorkspaceHomeToken)) {
    Die "展开占位符失败：$f 里仍有 {{APP_ROOT}}/{{WORKSPACE_HOME}}（-AppRoot=$AppRoot）"
  }
  Write-TextPreserveBom (Join-Path $ProfileDir $f) $raw
}
Ok "已写入 cordis.yml / cordis.patch.yml / pnpm-workspace.yaml / pnpm-lock.yaml（路径指向 $appRootFwd）"

$pkgRaw = Expand-AppRoot (Read-TextPreserveBom (Join-Path $RepoRoot 'profile\package.json')) $appRootFwd


# 实验性 bundle 门控：@deepseek-ai/dsh-experimental-* 由宿主自带、按 app 版本强绑定，不满足就不写进本机
$bundlesInRepo = @()
try { $bundlesInRepo = @(($pkgRaw | ConvertFrom-Json).dsh.profile.bundles) }
catch { Die "仓库 profile\package.json 不是合法 JSON：$($_.Exception.Message)" }

$dropped = @()
foreach ($b in $bundlesInRepo) {
  if ($b -notlike '@deepseek-ai/dsh-experimental-*') { continue }
  $why = $null
  if ($versionDrift) {
    $why = "本机 app 版本不同（$hostAppVersion ≠ $contractVersion）"
  } else {
    # 宿主自带 bundle 的落点因构建而异：解包版在 resources\app\dsh\node_modules，
    # 打包版整包塞在 app.asar 里（磁盘上没有目录）——所以交给 Test-HostBundle 统一判断，别只查路径。
    $bv = $null
    $bundlePkg = $null
    foreach ($hostModules in (Get-HostDshNodeModules $AppRoot)) {
      $probe = Join-Path $hostModules ((($b -replace '/', '\')) + '\package.json')
      if (Test-Path -LiteralPath $probe) { $bundlePkg = $probe; break }
    }
    if ($bundlePkg) {
      try { $bv = [string](Get-Content -LiteralPath $bundlePkg -Raw -Encoding utf8 | ConvertFrom-Json).version } catch { $bv = $null }
      if ($bv -and $hostAppVersion -and ($bv -ne $hostAppVersion)) {
        $why = "该 bundle 版本 $bv 与宿主 $hostAppVersion 不一致"
      }
    } elseif (-not (Test-HostBundle $AppRoot $b)) {
      $why = "客户端自带包里没有这一项"
    }
  }
  if ($why) { $dropped += $b; Warn "剔除实验性 bundle：$b（$why）" }
}

foreach ($b in $dropped) {
  $pkgRaw = [regex]::Replace($pkgRaw, '(?m)^[ \t]*"' + [regex]::Escape($b) + '"[ \t]*,?[ \t]*\r?\n', '')
}
# 删掉末项后可能留下数组尾逗号，JSON 会因此不合法
$pkgRaw = [regex]::Replace($pkgRaw, ',[ \t]*(\r?\n[ \t]*\])', '$1')
try { $finalBundles = @(($pkgRaw | ConvertFrom-Json).dsh.profile.bundles) }
catch { Die "剔除实验性 bundle 后 package.json 不再是合法 JSON（请手动核对 profile\package.json）" }
if ($dropped.Count -gt 0) { Ok "已剔除 $($dropped.Count) 个实验性 bundle，清单剩 $($finalBundles.Count) 项" }

$localPluginMap = [ordered]@{
  'dsh-our-free-model-2.8.0' = 'dsh-our-free-model'
  'dsh-purge-1.1.92'         = 'dsh-purge'
  'dsh-config-sync-0.1.0'    = 'dsh-config-sync'
}
foreach ($dirName in $localPluginMap.Keys) {
  $pattern = 'link:[^"]*' + [regex]::Escape($dirName)
  $pkgRaw = [regex]::Replace($pkgRaw, $pattern, ('link:' + $appRootFwd + '/' + $dirName), 'IgnoreCase')
}
Write-TextPreserveBom (Join-Path $ProfileDir 'package.json') $pkgRaw
Ok "已写入 package.json（link 路径指向 $appRootFwd）"
} else { Warn '跳过（未勾选同步）：profile 配置（package.json / lock / cordis 保持本机现状）' }

# ---------- 4. 铺全局提示 ----------
if (Test-SyncGroupEnabled $Scope 'prompt') {
foreach ($f in @('AGENTS.md', 'prompt-inject.md')) {
  if (-not (Test-SyncItemEnabled $Scope 'prompt' $f)) { continue }
  $src = Join-Path $RepoRoot "prompt\$f"
  if (Test-Path -LiteralPath $src) { Copy-Item -LiteralPath $src -Destination (Join-Path $DshHome $f) -Force; Ok "已写入 $f" }
}
} else { Warn '跳过（未勾选同步）：全局提示（AGENTS.md / prompt-inject.md）' }

# ---------- 5. 铺 Skills ----------
if (Test-SyncGroupEnabled $Scope 'skills') {
$skillsSrc = Join-Path $RepoRoot 'skills'
$skillsDst = Join-Path $DshHome 'skills'
if (Test-Path -LiteralPath $skillsSrc) {
  New-Item -ItemType Directory -Path $skillsDst -Force | Out-Null
  $n = 0
  Get-ChildItem -LiteralPath $skillsSrc -Directory -Force | ForEach-Object {
    if (-not (Test-SyncItemEnabled $Scope 'skills' $_.Name)) { return }
    $dstDir = Join-Path $skillsDst $_.Name
    if (Test-Path -LiteralPath $dstDir) { Remove-Item -LiteralPath $dstDir -Recurse -Force }
    Copy-Item -LiteralPath $_.FullName -Destination $dstDir -Recurse -Force
    $n++
  }
  Ok "已铺 $n 个 Skill 到 $skillsDst"
  if ($PruneSkills) {
    Get-ChildItem -LiteralPath $skillsDst -Directory -Force | Where-Object {
      (-not (Test-Path -LiteralPath (Join-Path $skillsSrc $_.Name))) -and (Test-SyncItemEnabled $Scope 'skills' $_.Name)
    } | ForEach-Object {
      Remove-Item -LiteralPath $_.FullName -Recurse -Force
      Warn "已按 -PruneSkills 移除本机多余的 Skill：$($_.Name)"
    }
  } else {
    $extraSkills = @(Get-ChildItem -LiteralPath $skillsDst -Directory -Force | Where-Object {
        -not (Test-Path -LiteralPath (Join-Path $skillsSrc $_.Name))
      } | Select-Object -ExpandProperty Name)
    if ($extraSkills.Count -gt 0) {
      Warn ("本机另有 " + $extraSkills.Count + " 个仓库里没有的 Skill（未动，加 -PruneSkills 才删：" + ($extraSkills -join ', ') + "）")
    }
  }
}
} else { Warn '跳过（未勾选同步）：Skills（本机 skills 目录保持现状）' }

# ---------- 6. 铺 Agent 预设 ----------
if (Test-SyncGroupEnabled $Scope 'presets') {
$presetSrc = Join-Path $RepoRoot 'presets'
$presetDst = Join-Path $DshHome '.agent-presets'
if (Test-Path -LiteralPath $presetSrc) {
  New-Item -ItemType Directory -Path $presetDst -Force | Out-Null
  Get-ChildItem -LiteralPath $presetSrc -Directory -Force | ForEach-Object {
    if (-not (Test-SyncItemEnabled $Scope 'presets' $_.Name)) { return }
    $dstDir = Join-Path $presetDst $_.Name
    if (Test-Path -LiteralPath $dstDir) { Remove-Item -LiteralPath $dstDir -Recurse -Force }
    Copy-Item -LiteralPath $_.FullName -Destination $dstDir -Recurse -Force
  }
  Ok "已铺 Agent 预设：$((Get-ChildItem -LiteralPath $presetSrc -Directory -Force | Select-Object -ExpandProperty Name) -join ', ')"
}
} else { Warn '跳过（未勾选同步）：Agent 预设' }

# ---------- 7. 还原技能市场台账 ----------
if (Test-SyncGroupEnabled $Scope 'storages-record') {
$ledgerSrc = Join-Path $RepoRoot 'storages-record\skill-market-installed.json'
$ledgerDir = Join-Path $DshHome 'storages\@montersy123\dsh-skill-market\data'
if ((Test-Path -LiteralPath $ledgerSrc) -and (Test-SyncItemEnabled $Scope 'storages-record' 'skill-market-installed.json')) {
  # 新机器上这个目录由插件首次运行时创建，apply 先跑就得自己建，否则台账会被静默丢掉
  if (-not (Test-Path -LiteralPath $ledgerDir)) { New-Item -ItemType Directory -Path $ledgerDir -Force | Out-Null }
  Copy-Item -LiteralPath $ledgerSrc -Destination (Join-Path $ledgerDir 'installed.json') -Force
  $panelSrc = Join-Path $RepoRoot 'storages-record\skill-market-panel.json'
  if ((Test-Path -LiteralPath $panelSrc) -and (Test-SyncItemEnabled $Scope 'storages-record' 'skill-market-panel.json')) {
    Copy-Item -LiteralPath $panelSrc -Destination (Join-Path $ledgerDir 'panel.json') -Force
  }
  Ok "已还原技能市场安装台账"
} else {
  Warn "仓库里没有技能市场台账，跳过"
}
} else { Warn '跳过（未勾选同步）：技能市场台账' }

# ---------- 7.6. 还原插件设置与工作流 ----------
# 仓库里存的是占位符（{{APP_ROOT}} / {{DSH_HOME}} / {{WORKSPACE_HOME}} / {{ROOT:<key>}}），
# 先展开成本机路径再写。展开完还剩占位符的，说明这台机器还没确认过那个根 —— 宁可不写：
# 把 {{ROOT:xxx}} 字面量写进配置，插件读到会当成真实路径，报错比不写更难查。
$roots = Get-SyncRoots $DshHome $AppRoot $WorkspaceHome
$pendingItems = New-Object System.Collections.ArrayList
# 覆盖前体检（0.3.36 起）：这一步是「整份覆盖」本机文件，本机若改了路径还没推送，改完会被盖回去。
# 所以覆盖前把「本机现状（归一化）」和「仓库版本」比一次，不同的记成清单 —— 备份早就有，
# 缺的一直是「告知」：不让人事后翻备份目录才发现自己刚改的东西没了。
$overwriteItems = New-Object System.Collections.ArrayList
if (Test-SyncGroupEnabled $Scope 'settings') {
foreach ($m in $settingsMap) {
  if (-not (Test-SyncItemEnabled $Scope 'settings' ($m.Repo -replace '^settings\\', ''))) { continue }
  $srcRepo = Join-Path $RepoRoot $m.Repo
  if (-not (Test-Path -LiteralPath $srcRepo)) { Warn ("仓库里没有 " + $m.Repo + "，跳过"); continue }
  $txt = [IO.File]::ReadAllText($srcRepo)
  $expanded = Expand-TokenText $txt $roots
  $missing = @(Get-MissingTokens $expanded)
  if ($missing.Count -gt 0) {
    # 缺什么就别写什么：写进去的是占位符字面量，插件读到会当成真实路径
    foreach ($k in $missing) {
      $pendingItems.Add([pscustomobject][ordered]@{ token = $k; file = $m.Repo; label = $m.Label; hint = (Get-TokenHint $k) }) | Out-Null
    }
    Warn ("跳过 " + $m.Repo + "：需要先确认路径 " + ($missing -join '、'))
    continue
  }
  # 本机已有这份文件、且归一化后与仓库版本不同 → 本次会盖掉本机改动
  if (Test-Path -LiteralPath $m.Src) {
    $localRaw = ''
    try { $localRaw = [IO.File]::ReadAllText($m.Src) } catch { $localRaw = '' }
    if ($localRaw) {
      $localNorm = ConvertTo-TokenText $localRaw $roots
      if ($m.Repo -eq 'settings\our-free-model.json') {
        foreach ($k in @('catalogSyncedAt', 'reloadedAt', 'reloadCount')) {
          $localNorm = $localNorm -replace ('("' + $k + '"\s*:\s*)[0-9]+'), '${1}0'
        }
      }
      $localNorm = ($localNorm -replace "`r`n", "`n").TrimEnd()
      $repoNorm = ($txt -replace "`r`n", "`n").TrimEnd()
      if ($localNorm -ne $repoNorm) {
        $bkFile = Join-Path (Join-Path $BackupDir 'settings') (Split-Path -Leaf $m.Src)
        [void]$overwriteItems.Add([pscustomobject][ordered]@{ repo = $m.Repo; src = $m.Src; label = $m.Label; backup = $bkFile })
      }
    }
  }
  $dir = Split-Path -Parent $m.Src
  if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
  [IO.File]::WriteAllText($m.Src, $expanded, (New-Object Text.UTF8Encoding($false)))
}
Ok "已还原插件设置 / 工作流 / 各插件配置"
} else { Warn '跳过（未勾选同步）：插件设置 / 工作流 / 各插件配置' }
if ($pendingItems.Count -gt 0) {
  $pf = Write-PendingPaths $DshHome $pendingItems
  Warn ("有 " + $pendingItems.Count + " 项配置等待确认路径，本次未写入。已记到 " + $pf + "，到面板「本机路径」选好目录，之后再拉取一次即可。")
} elseif (Test-SyncGroupEnabled $Scope 'settings') {
  Clear-PendingPaths $DshHome
}
# 覆盖报告：本机这些文件在本次拉取里被仓库版本整份盖掉了（备份路径一并写进去，方便回退）
$overwriteReport = Join-Path $DshHome 'config-sync-overwrite.json'
if ($overwriteItems.Count -gt 0) {
  $ovObj = [ordered]@{
    at    = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')
    total = $overwriteItems.Count
    items = @($overwriteItems)
  }
  [IO.File]::WriteAllText($overwriteReport, ($ovObj | ConvertTo-Json -Depth 5), (New-Object Text.UTF8Encoding($false)))
  Warn ("有 " + $overwriteItems.Count + " 份配置被仓库版本覆盖（本机改动已先备份）：")
  foreach ($it in @($overwriteItems | Select-Object -First 5)) { Warn ("  - " + $it.label + "：" + $it.repo + "（备份 " + $it.backup + "）") }
  if ($overwriteItems.Count -gt 5) { Warn ("  …还有 " + ($overwriteItems.Count - 5) + " 份，清单：" + $overwriteReport) }
  Warn "  想保留本机改动就先「推送」再「拉取」，别反过来。"
} else {
  if (Test-Path -LiteralPath $overwriteReport) { try { Remove-Item -LiteralPath $overwriteReport -Force } catch { } }
}

# ---------- 7.5. 还原记忆插件数据目录 mnemon ----------
$mnemonSrc = Join-Path $RepoRoot 'mnemon'
$mnemonDst = Join-Path $AppRoot 'mnemon'
if (-not (Test-SyncGroupEnabled $Scope 'mnemon')) {
  Warn '跳过（未勾选同步）：记忆数据（mnemon）'
} elseif ($SkipMnemon) {
  Warn "已指定 -SkipMnemon，跳过记忆数据（mnemon）还原"
} elseif ((Test-Path -LiteralPath $mnemonSrc) -and ((Get-ChildItem -LiteralPath $mnemonSrc -Recurse -File -Force | Measure-Object).Count -gt 0)) {
  if (Test-Path -LiteralPath $mnemonDst) {
    # 目标不存在时 Copy-Item 才按目录名落地，不会再套一层 mnemon\mnemon
    $mnBackup = Join-Path $BackupDir 'mnemon-old'
    Copy-Item -LiteralPath $mnemonDst -Destination $mnBackup -Recurse -Force
    Ok "已备份现有 mnemon 到 $mnBackup"
  } else {
    New-Item -ItemType Directory -Path $mnemonDst -Force | Out-Null
  }
  # 逐个子项合并复制：-LiteralPath 不展开 '*' 万用符，且目标已有同名子目录时 -Recurse 会套娃
  CopyMerge $mnemonSrc $mnemonDst
  # 记忆库里存着 holographic store 的绝对路径（D:\\DeepSeekHarness\\mnemon\\...），必须换成本机路径
  Expand-AppRootTree $mnemonDst $appRootFwd
  # 本机有、仓库没有的记忆文件：默认保留并提示（它可能是本机新写的、还没 capture 的记忆）
  $extra = @()
  Get-ChildItem -LiteralPath $mnemonDst -Recurse -File -Force | ForEach-Object {
    $rel = Get-RelPath $mnemonDst $_.FullName
    if ($rel -and -not (Test-Path -LiteralPath (Join-Path $mnemonSrc $rel))) { $extra += $rel }
  }
  if ($extra.Count -gt 0) {
    if ($PruneMnemon) {
      $extra | ForEach-Object { Remove-Item -LiteralPath (Join-Path $mnemonDst $_) -Force }
      Warn ("已按 -PruneMnemon 删除本机多出的 " + $extra.Count + " 个记忆文件：" + ($extra -join ', '))
    } else {
      Warn ("本机另有 " + $extra.Count + " 个仓库里没有的记忆文件（未动，建议稍后在主力机 capture：" + ($extra -join ', ') + "）")
    }
  }
  $mnCount = (Get-ChildItem -LiteralPath $mnemonDst -Recurse -File -Force | Measure-Object).Count
  Ok "已还原记忆数据（mnemon）$mnCount 个文件到 $mnemonDst"
} else {
  Warn "仓库里没有 mnemon 数据，跳过记忆目录还原"
}

# ---------- 7.6. 还原插件数据（plugin-data）与额外路径（extra） ----------
# capture 时文本已经占位符化，写回前统一展开成本机路径；落盘前把目标侧旧文件留底，
# 万一拉错了还能从 $BackupDir 里捞回来。
function Expand-TokenTree([string]$dir, $roots) {
  if (-not (Test-Path -LiteralPath $dir)) { return }
  $binExt = @('.tgz', '.zip', '.png', '.jpg', '.jpeg', '.gif', '.ico', '.bmp', '.webp', '.exe', '.dll', '.wasm', '.pdf', '.dat', '.woff', '.woff2', '.ttf', '.otf')
  Get-ChildItem -LiteralPath $dir -Recurse -File -Force -ErrorAction SilentlyContinue | ForEach-Object {
    if ($_.Extension.ToLower() -in $binExt) { return }
    $raw = Read-TextPreserveBom $_.FullName
    if ($raw -match '\{\{(APP_ROOT|DSH_HOME|WORKSPACE_HOME|ROOT:[A-Za-z0-9_.\-]+)\}\}') {
      Write-TextPreserveBom $_.FullName (Expand-TokenText $raw $roots)
    }
  }
}

function Copy-TreeInto([string]$srcRoot, [string]$dstRoot, [string]$backupRoot) {
  # 逐文件合并：目标已有同名文件先备份到 backupRoot，再覆盖（-Recurse 到已存在目录会套娃，所以不用它）
  $n = 0
  if (-not (Test-Path -LiteralPath $srcRoot)) { return 0 }
  Get-ChildItem -LiteralPath $srcRoot -Recurse -File -Force -ErrorAction SilentlyContinue | ForEach-Object {
    $rel = Get-RelPath $srcRoot $_.FullName
    if (-not $rel) { return }
    $dst = Join-Path $dstRoot $rel
    $dstParent = Split-Path -Parent $dst
    if (-not (Test-Path -LiteralPath $dstParent)) { New-Item -ItemType Directory -Path $dstParent -Force | Out-Null }
    if (Test-Path -LiteralPath $dst) {
      $bk = Join-Path $backupRoot $rel
      $bkParent = Split-Path -Parent $bk
      if (-not (Test-Path -LiteralPath $bkParent)) { New-Item -ItemType Directory -Path $bkParent -Force | Out-Null }
      Copy-Item -LiteralPath $dst -Destination $bk -Force
    }
    Copy-Item -LiteralPath $_.FullName -Destination $dst -Force
    $n++
  }
  return $n
}

$pdRoots = Get-SyncRoots $DshHome $AppRoot $WorkspaceHome

if (-not (Test-SyncGroupEnabled $Scope 'plugin-data')) {
  Warn '跳过（未勾选同步）：插件数据（plugin-data）'
} else {
  $pdSrc = Join-Path $RepoRoot 'plugin-data'
  $pdMf = Join-Path $pdSrc 'manifest.json'
  if (-not (Test-Path -LiteralPath $pdMf)) {
    Warn '仓库里没有 plugin-data\manifest.json，跳过插件数据还原'
  } else {
    $pdManifest = Get-Content -LiteralPath $pdMf -Raw -Encoding utf8 | ConvertFrom-Json
    $pdDone = 0
    foreach ($slot in @($pdManifest.slots)) {
      if (-not $slot.id -or -not $slot.src) { continue }
      if (-not (Test-SyncItemEnabled $Scope 'plugin-data' $slot.id)) { Warn ('跳过（已排除）：插件数据 ' + $slot.id); continue }
      $slotSrc = Join-Path $pdSrc $slot.id
      if (-not (Test-Path -LiteralPath $slotSrc)) { continue }
      $expanded = Expand-TokenText ([string]$slot.src) $pdRoots
      $miss = @(Get-MissingTokens $expanded)
      if ($miss.Count -gt 0) { Warn ('插件数据 ' + $slot.id + ' 的目标路径展开后仍有未配置占位符：' + ($miss -join ',')); continue }
      $dst = $expanded.Replace('/', $BS)
      if (-not $dst) { continue }
      if (-not (Test-Path -LiteralPath $dst)) { New-Item -ItemType Directory -Path $dst -Force | Out-Null }
      $bk = Join-Path $BackupDir ('plugin-data-' + $slot.id)
      $n = Copy-TreeInto $slotSrc $dst $bk
      Expand-TokenTree $dst $pdRoots
      $pdDone++
      Ok ('已还原插件数据 ' + $slot.id + '：' + $n + ' 个文件 → ' + $dst)
    }
    if ($pdDone -eq 0) { Warn '插件数据：没有可还原的槽（仓库里没有内容或都被排除）' }
  }
}

if (-not (Test-SyncGroupEnabled $Scope 'extra')) {
  Warn '跳过（未勾选同步）：额外路径（extra）'
} else {
  $exSrc = Join-Path $RepoRoot 'extra'
  $exMf = Join-Path $exSrc 'manifest.json'
  if (-not (Test-Path -LiteralPath $exMf)) {
    Warn '仓库里没有 extra\manifest.json，跳过额外路径还原'
  } else {
    $exManifest = Get-Content -LiteralPath $exMf -Raw -Encoding utf8 | ConvertFrom-Json
    foreach ($it in @($exManifest.items)) {
      if (-not $it.id -or -not $it.src) { continue }
      if (-not (Test-SyncItemEnabled $Scope 'extra' $it.id)) { Warn ('跳过（已排除）：额外路径 ' + $it.id); continue }
      $expanded = Expand-TokenText ([string]$it.src) $pdRoots
      $miss = @(Get-MissingTokens $expanded)
      if ($miss.Count -gt 0) { Warn ('额外路径 ' + $it.id + ' 的目标路径展开后仍有未配置占位符：' + ($miss -join ',')); continue }
      $dst = $expanded.Replace('/', $BS)
      if (-not $dst) { continue }
      if ($it.kind -eq 'dir') {
        $itemSrc = Join-Path $exSrc $it.id
        if (-not (Test-Path -LiteralPath $itemSrc)) { continue }
        if (-not (Test-Path -LiteralPath $dst)) { New-Item -ItemType Directory -Path $dst -Force | Out-Null }
        $bk = Join-Path $BackupDir ('extra-' + $it.id)
        $n = Copy-TreeInto $itemSrc $dst $bk
        Expand-TokenTree $dst $pdRoots
        Ok ('已还原额外路径 ' + $it.id + '：' + $n + ' 个文件 → ' + $dst)
      } else {
        $leaf = Split-Path -Leaf ([string]$it.src)
        $itemSrc = Join-Path $exSrc ($it.id + (Split-Path -Extension $dst))
        if (-not (Test-Path -LiteralPath $itemSrc)) {
          $itemSrc = Join-Path $exSrc $it.id
          if (-not (Test-Path -LiteralPath $itemSrc)) { continue }
        }
        $dstParent = Split-Path -Parent $dst
        if ($dstParent -and -not (Test-Path -LiteralPath $dstParent)) { New-Item -ItemType Directory -Path $dstParent -Force | Out-Null }
        if (Test-Path -LiteralPath $dst) {
          $bk = Join-Path $BackupDir ('extra-' + $leaf)
          $bkParent = Split-Path -Parent $bk
          if ($bkParent -and -not (Test-Path -LiteralPath $bkParent)) { New-Item -ItemType Directory -Path $bkParent -Force | Out-Null }
          Copy-Item -LiteralPath $dst -Destination $bk -Force
        }
        Copy-Item -LiteralPath $itemSrc -Destination $dst -Force
        # 只展开这一个文件（整目录展开会改到用户同目录下的其他文件）
        if ((Split-Path -Extension $dst).ToLower() -notin @('.tgz', '.zip', '.png', '.jpg', '.jpeg', '.gif', '.ico', '.exe', '.dll', '.wasm', '.pdf')) {
          $raw = Read-TextPreserveBom $dst
          if ($raw -match '\{\{(APP_ROOT|DSH_HOME|WORKSPACE_HOME|ROOT:[A-Za-z0-9_.\-]+)\}\}') { Write-TextPreserveBom $dst (Expand-TokenText $raw $pdRoots) }
        }
        Ok ('已还原额外路径 ' + $it.id + '：单个文件 → ' + $dst)
      }
    }
  }
}


# 读归档里的插件版本：tgz 里是 package/package.json，zip 里是 <目录名>/package.json 或根 package.json。
# 读不出来返回 $null，调用方回退到 mtime 判据（不因为读不到就盲目重铺）。
function Get-ArchivePluginVersion([string]$archPath, [string]$dirName) {
  try {
    if ($archPath -like '*.tgz' -or $archPath -like '*.tar.gz') {
      $tar = Join-Path $env:SystemRoot 'System32\tar.exe'
      if (-not (Test-Path -LiteralPath $tar)) { return $null }
      $json = & $tar -xzf $archPath -O package/package.json 2>$null
      if ($LASTEXITCODE -ne 0 -or -not $json) { return $null }
      return [string]((($json -join "`n")) | ConvertFrom-Json).version
    }
    if ($archPath -like '*.zip') {
      try { Add-Type -AssemblyName System.IO.Compression.FileSystem -ErrorAction Stop } catch { }
      $zip = [IO.Compression.ZipFile]::OpenRead($archPath)
      try {
        $entry = $zip.Entries | Where-Object { $_.FullName -match ("(^|/)" + [regex]::Escape($dirName) + "/package\.json$") } | Select-Object -First 1
        if (-not $entry) { $entry = $zip.Entries | Where-Object { $_.FullName -match '^(package/)?package\.json$' } | Select-Object -First 1 }
        if (-not $entry) { return $null }
        $sr = New-Object IO.StreamReader($entry.Open())
        try { return [string](($sr.ReadToEnd()) | ConvertFrom-Json).version } finally { $sr.Dispose() }
      } finally { $zip.Dispose() }
    }
  } catch { return $null }
  return $null
}

# ---------- 8. 就位本地插件（link: 依赖） ----------
if (Test-SyncGroupEnabled $Scope 'local-plugins') {
$needExtract = @()
foreach ($dirName in $localPluginMap.Keys) {
  if (-not (Test-SyncItemEnabled $Scope 'local-plugins' $dirName)) { continue }
  $target = Join-Path $AppRoot $dirName
  if (Test-Path -LiteralPath $target) {
    # 已部署的目录不会被覆盖，否则插件升级永远到不了本机（仓库里的 tgz 更新了也没用）。
    # 判据改成比版本号：归档里的 package.json version vs 已部署目录的 version，不同才算新版本。
    # 以前比 mtime，而 git checkout/fetch 会把归档的 mtime 刷成当前时间 → 每轮同步都误判「有新版本」，
    # 于是反复改名备份 + 重新解压（实测 dsh-purge-1.1.92 与 .bak-时间戳 并存、每轮多搬一次目录就是这么来的）。
    $arch = Join-Path $RepoRoot "local-plugins\$dirName.tgz"
    if (-not (Test-Path -LiteralPath $arch)) { $arch = Join-Path $RepoRoot "local-plugins\$dirName.zip" }
    $archVer = if (Test-Path -LiteralPath $arch) { Get-ArchivePluginVersion $arch $dirName } else { $null }
    $depVer = $null
    $depPkgFile = Join-Path $target 'package.json'
    if (Test-Path -LiteralPath $depPkgFile) {
      try { $depVer = [string]((Get-Content -LiteralPath $depPkgFile -Raw -Encoding utf8 | ConvertFrom-Json).version) } catch { $depVer = $null }
    }
    $hasNewVersion = $false
    if ((Test-Path -LiteralPath $arch) -and $archVer -and $depVer) {
      $hasNewVersion = ($archVer -ne $depVer)
    } elseif (Test-Path -LiteralPath $arch) {
      # 读不到版本（老归档、结构异常）时退回 mtime，但要求比已部署目录新 10 秒以上，避免每轮误判
      $archTime = (Get-Item -LiteralPath $arch).LastWriteTime
      $depTime = (Get-ChildItem -LiteralPath $target -Recurse -File -Force | Sort-Object LastWriteTime -Descending | Select-Object -First 1).LastWriteTime
      $hasNewVersion = $archTime -gt $depTime.AddSeconds(10)
    }
    if ($hasNewVersion) {
      Warn "本地插件有新版本，将重新部署：$target（$depVer → $archVer，旧目录先改名备份）"
      $bak = "$target.bak-" + (Get-Date -Format 'yyyyMMddHHmmss')
      Move-Item -LiteralPath $target -Destination $bak
      Ok "旧版本已备份为：$bak"
      # 同一插件只留刚生成的这一份备份：这些目录动辄几十兆，攒几次会把小盘塞满
      Get-ChildItem -LiteralPath $AppRoot -Directory -Force -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -like "$dirName.bak-*" -and $_.FullName -ne $bak } |
        ForEach-Object {
          Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction SilentlyContinue
          Warn ("已清理更旧的插件备份：" + $_.Name)
        }
      $needExtract += $dirName
    } else {
      Ok "本地插件已存在：$target"
    }
  } else {
    $needExtract += $dirName
  }
}
if ($needExtract.Count -gt 0) {
  # tar 在部分机器（精简 PATH、服务账户、非交互进程）里不在 PATH，必须用绝对路径
  $tarExe = Join-Path $env:SystemRoot 'System32\tar.exe'
  if (-not (Test-Path -LiteralPath $tarExe)) {
    $alt = Join-Path $env:SystemRoot 'System32\bsdtar.exe'
    if (Test-Path -LiteralPath $alt) { $tarExe = $alt } else { $tarExe = '' }
  }
  $staging = Join-Path $env:TEMP ("dshcfg-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
  New-Item -ItemType Directory -Path $staging -Force | Out-Null
  foreach ($dirName in $needExtract) {
    $tgz = Join-Path $RepoRoot "local-plugins\$dirName.tgz"
    $zip = Join-Path $RepoRoot "local-plugins\$dirName.zip"
    $out = Join-Path $staging $dirName
    if (Test-Path -LiteralPath $tgz) {
      if ([string]::IsNullOrEmpty($tarExe)) { Die "找不到 tar.exe（$env:SystemRoot\System32\tar.exe），无法解压 $tgz" }
      New-Item -ItemType Directory -Path $out -Force | Out-Null
      & $tarExe -xzf $tgz -C $out
      if ($LASTEXITCODE -ne 0) { Die "解压失败：$tgz（tar 退出码 $LASTEXITCODE）" }
      # npm tgz 的根目录是 package/，需要摊平
      $pkgDir = Join-Path $out 'package'
      if (Test-Path -LiteralPath $pkgDir) {
        $final = Join-Path $AppRoot $dirName
        if (Test-Path -LiteralPath $final) { Remove-Item -LiteralPath $final -Recurse -Force }
        Move-Item -LiteralPath $pkgDir -Destination $final
      }
      Ok "已解压并部署：$final"
    } elseif (Test-Path -LiteralPath $zip) {
      Expand-Archive -LiteralPath $zip -DestinationPath $out -Force
      $inner = Join-Path $out $dirName
      if (-not (Test-Path -LiteralPath $inner)) { $inner = $out }
      $final = Join-Path $AppRoot $dirName
      if (Test-Path -LiteralPath $final) { Remove-Item -LiteralPath $final -Recurse -Force }
      Move-Item -LiteralPath $inner -Destination $final
      Ok "已解压并部署：$final"
    } else {
      Warn "仓库里没有 $dirName 的归档，跳过（该插件会装不上）"
    }
  }
  Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue
}
} else { Warn '跳过（未勾选同步）：本地源码插件包（local-plugins）' }

# ---------- 9. pnpm install ----------
if ($SkipInstall) {
  Warn "已指定 -SkipInstall，跳过依赖安装。插件需要手动处理后再启动。"
} else {
  $nodeExe = Join-Path $AppRoot 'resources\runtime\primary-runtime\dependencies\node\bin\node.exe'
  $pnpmCjs = Join-Path $AppRoot 'resources\runtime\primary-runtime\dependencies\pnpm\bin\pnpm.cjs'
  Push-Location $ProfileDir
  try {
    $installed = $false
    $skipBecauseReady = $false
    if ((Test-Path -LiteralPath $nodeExe) -and (Test-Path -LiteralPath $pnpmCjs)) {
      Say "  使用客户端内置 pnpm 安装依赖（严格按 lockfile）..."
      & $nodeExe $pnpmCjs install --frozen-lockfile
      $code = $LASTEXITCODE
      if ($code -ne 0) {
        # 严格模式失败最常见的原因是 lockfile 与 package.json 的 specifier 对不上（老仓库的盘符残留、
        # 或捕获机和本机的依赖清单本来就有差异）。这时按 package.json 重新解析一次并重写 lockfile。
        Warn "pnpm install --frozen-lockfile 返回 $code，改为 --no-frozen-lockfile 重试（会就地重写 pnpm-lock.yaml）..."
        & $nodeExe $pnpmCjs install --no-frozen-lockfile
        $code = $LASTEXITCODE
        if ($code -eq 0) { Warn "已用 --no-frozen-lockfile 装好；记得回主力机跑 capture，把新 lockfile 提交回仓库" }
      }
      $installed = ($code -eq 0)
    } elseif (Get-Command pnpm -ErrorAction SilentlyContinue) {
      Say "  使用系统 pnpm 安装依赖..."
      & pnpm install --frozen-lockfile
      if ($LASTEXITCODE -ne 0) { & pnpm install --no-frozen-lockfile }
      $installed = ($LASTEXITCODE -eq 0)
    } else {
      # 找不到 pnpm（客户端内置路径随版本变、系统也可能没装）时不能一律 exit 1：
      # post-exit 会把 apply 的非零退出码当成「拉取失败」，接着自动回滚仓库和配置，
      # 于是拉取明明成功了却被打回原状（真实故障：18 项全选云端、快进完成后又被回滚）。
      # 只要 profile 里 node_modules 已经存在，依赖就是可用的，按成功处理。
      $nodeModules = Join-Path $ProfileDir 'node_modules'
      if (Test-Path -LiteralPath $nodeModules) {
        $installed = $true
        $skipBecauseReady = $true
      } else {
        Warn "找不到 pnpm，且 $nodeModules 不存在，跳过安装。请手动在 $ProfileDir 执行 pnpm install --frozen-lockfile"
        Pop-Location
        exit 1
      }
    }
    if ($installed) {
      if ($skipBecauseReady) { Ok '依赖已就绪（profile 里已有 node_modules），无需 pnpm 安装' }
      else { Ok '依赖安装完成' }
    }
    else { Warn "pnpm install 仍未成功，依赖没装上（下面的自检会把缺的插件列出来）" }
  } finally {
    Pop-Location
  }
}

# ---------- 9.5 内置运行时链接修复 ----------
# 客户端升级会清空 resources\runtime，装卸插件所依赖的 pnpm 路径随之失效
# （报错形如 Cannot find module ...\dependencies\pnpm\bin\pnpm.mjs）。
# 每次落地都幂等补回一次链接；已在就别动，是真实目录也别动。
Repair-PrimaryRuntimeLink $AppRoot $DshHome

# ---------- 9.6 清理卸载残留：孤儿链接 + 冗余插件备份 ----------
# 插件卸载会删安装目录、package.json 依赖、cordis 段，却常常漏掉 profile\node_modules 里那条
# junction（实测 dsh-image-search：目标目录删了、链接还指着它）。这类断链 pnpm 管不着——平铺布局下
# 它只按 lockfile 重装，而链接不是它建的；同步过去也从来不清理，于是一直挂到下次重装。
# 判据只认同时成立的三种情况，宁可漏删也不误删正常依赖：
#   ① 是链接（Junction / SymbolicLink）
#   ② 所有 Target 都不存在
#   ③ 不在 package.json 的 dependencies 里
if (Test-SyncGroupEnabled $Scope 'profile') {
  $nmDir = Join-Path $ProfileDir 'node_modules'
  if (Test-Path -LiteralPath $nmDir) {
    $depNames = @()
    try { $depNames = @((Get-Content -LiteralPath (Join-Path $ProfileDir 'package.json') -Raw -Encoding utf8 | ConvertFrom-Json).dependencies.PSObject.Properties.Name) } catch { $depNames = @() }

    $candidates = New-Object System.Collections.ArrayList
    Get-ChildItem -LiteralPath $nmDir -Force -ErrorAction SilentlyContinue | ForEach-Object {
      [void]$candidates.Add([pscustomobject]@{ Rel = $_.Name; Item = $_ })
    }
    foreach ($sc in (Get-ChildItem -LiteralPath $nmDir -Force -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -like '@*' -and -not $_.LinkType })) {
      Get-ChildItem -LiteralPath $sc.FullName -Force -ErrorAction SilentlyContinue | ForEach-Object {
        [void]$candidates.Add([pscustomobject]@{ Rel = ($sc.Name + '/' + $_.Name); Item = $_ })
      }
    }

    $pruned = 0
    foreach ($c in $candidates) {
      $it = $c.Item
      if (-not $it.LinkType) { continue }
      if ($depNames -contains $c.Rel) { continue }
      $alive = $false
      foreach ($tg in @($it.Target)) { if ($tg -and (Test-Path -LiteralPath $tg)) { $alive = $true; break } }
      if ($alive) { continue }
      try {
        # junction 必须用 Directory.Delete 删链接本身；Remove-Item -Recurse 在旧实现里可能顺着链接删到目标
        if ($it.PSIsContainer) { [IO.Directory]::Delete($it.FullName, $false) }
        else { [IO.File]::Delete($it.FullName) }
        $pruned++
        Warn ("已清理孤儿链接（卸载残留）：{0} → 目标不存在 {1}" -f $c.Rel, ($it.Target -join ','))
      } catch {
        Warn ("孤儿链接删不掉（可能被占用）：{0} → {1}" -f $c.Rel, $_.Exception.Message)
      }
    }
    if ($pruned -gt 0) { Ok "已清理 $pruned 个孤儿链接" } else { Ok '没有孤儿链接' }
  }

  # 插件备份：<目录>.bak-<时间戳> 是「旧目录先改名备份」留下的。同版本备份毫无价值（内容就是刚
  # 铺上去的那一份），直接清掉；版本不同的只留最新一份。主目录已不存在的备份保留（可能是唯一回滚点）。
  $bakDirs = @(Get-ChildItem -LiteralPath $AppRoot -Directory -Force -ErrorAction SilentlyContinue | Where-Object { $_.Name -match '^(.+)\.bak-\d{14}$' })
  if ($bakDirs.Count -gt 0) {
    $bm = 0
    foreach ($g in ($bakDirs | Group-Object { [regex]::Match($_.Name, '^(.+)\.bak-\d{14}$').Groups[1].Value })) {
      $livePkg = Join-Path (Join-Path $AppRoot $g.Name) 'package.json'
      $liveVer = $null
      if (Test-Path -LiteralPath $livePkg) { try { $liveVer = [string]((Get-Content -LiteralPath $livePkg -Raw -Encoding utf8 | ConvertFrom-Json).version) } catch { } }
      if (-not $liveVer) { continue }
      $keep = ($g.Group | Sort-Object Name -Descending | Select-Object -First 1)
      foreach ($b in $g.Group) {
        $bPkg = Join-Path $b.FullName 'package.json'
        $bVer = $null
        if (Test-Path -LiteralPath $bPkg) { try { $bVer = [string]((Get-Content -LiteralPath $bPkg -Raw -Encoding utf8 | ConvertFrom-Json).version) } catch { } }
        $same = ($bVer -and ($bVer -eq $liveVer))
        $latest = ($b.FullName -eq $keep.FullName)
        if ($same -or (-not $latest)) {
          Remove-Item -LiteralPath $b.FullName -Recurse -Force -ErrorAction SilentlyContinue
          $bm++
          Warn ("已清理插件备份：{0}（{1}）" -f $b.Name, $(if ($same) { '与在用版本相同，冗余' } else { '只保留最新一份' }))
        }
      }
    }
    if ($bm -eq 0) { Ok '插件备份无需清理' }
  }
}
# ---------- 10. 自检 ----------
Say ""
Say "== 自检 =="
$deps = (Get-Content -LiteralPath (Join-Path $ProfileDir 'package.json') -Raw -Encoding utf8 | ConvertFrom-Json).dependencies
$missing = @()
foreach ($name in $deps.PSObject.Properties.Name) {
  # 包名里的 / 要换成 \ 才是真实的 node_modules 路径（@scope/name → @scope\name）
  $probe = Join-Path $ProfileDir ("node_modules\" + ($name -replace '/', '\'))
  if (-not (Test-Path -LiteralPath $probe)) { $missing += $name }
}
if ($missing.Count -eq 0) { Ok "全部 $(@($deps.PSObject.Properties).Count) 个插件依赖已就位" }
else { Warn ("缺少 $($missing.Count) 个插件：" + ($missing -join ', ')) }

# bundle 可解析性检查：清单里写了、本机却没有 → 启动期 entry loading 必挂（整个应用起不来，不是功能不可用）
# 解析顺序与 DSH 一致：先 profile\node_modules（pnpm 装的），再 <AppRoot>\resources\app\dsh\node_modules（宿主自带）
$bundles = @((Get-Content -LiteralPath (Join-Path $ProfileDir 'package.json') -Raw -Encoding utf8 | ConvertFrom-Json).dsh.profile.bundles)
$unresolved = @()
foreach ($b in $bundles) {
  $rel = ($b -replace '/', '\')
  if (Test-Path -LiteralPath (Join-Path (Join-Path $ProfileDir 'node_modules') ($rel + '\package.json'))) { continue }
  if (Test-HostBundle $AppRoot $b) { continue }
  $unresolved += $b
}
if ($unresolved.Count -eq 0) {
  Ok "bundle 清单 $($bundles.Count) 项，全部可解析"
} else {
  Warn "以下 $($unresolved.Count) 个 bundle 在本机找不到，启动会在 entry loading 阶段失败："
  $unresolved | ForEach-Object { Warn "  - $_" }
  if (-not $ForceBundles) {
    Die ("已停止，先别启动。处理：①若上面「缺少插件」不为空，说明 pnpm install 没成功；" +
         "②若是宿主绑定的实验性 bundle，直接删掉本机 profile\package.json 里那一行；" +
         "③确认无误后可加 -ForceBundles 跳过本检查（启动仍有崩溃风险）。")
  }
  Warn "已加 -ForceBundles，跳过该检查（启动仍可能崩溃）"
}
Ok "Skill 目录：$((Get-ChildItem -LiteralPath $skillsDst -Directory -Force -ErrorAction SilentlyContinue | Measure-Object).Count) 个"
Say ""
Say "下一步：完全启动 DSH（不是重启窗口，要确认进程全部退出后再开）。"
if ($hostAppVersion) { Say "版本：本机 app = $hostAppVersion（仓库契约 $contractVersion）" }
Say "验证：插件页看 20 项是否齐全、按要求检查 cordis.patch.yml 里的开关是否生效、Skill 列表能列出。"
Say "如需回滚：把 $BackupDir 里的文件拷回原位置（工作区资料在 workspace\ 子目录、登记表备份为 workspace-registry-before.json）。"

exit 0