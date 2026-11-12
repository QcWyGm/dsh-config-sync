<#
DSH 配置同步 —— 快速还原（把本机 profile 退回到某个备份快照，或直接取 git 某个提交里的配置）

为什么需要它：
  apply.ps1 每次跑之前都会在 ~\.dsh\backups\config-<时间戳>\ 打一份快照，但没有回退入口；
  真出问题（起不来、插件全挂、依赖半装）时只能手工拷文件，容易漏、且容易把当前状态也弄丢。
  本脚本把「先自保、再回退、再重装、再核对」收成一步。

用法
  powershell -File restore.ps1                        # 取 ~\.dsh\backups 下最新一份快照回退
  powershell -File restore.ps1 -BackupDir "$env:USERPROFILE\.dsh\backups\config-20261109-191310"
  powershell -File restore.ps1 -FromCommit 9acc303    # 没有快照（新机器第一次就崩）时，从仓库某个提交取配置
  powershell -File restore.ps1 -DryRun                # 只打印将要做什么，不写任何文件
  powershell -File restore.ps1 -SkipInstall           # 只还原文件，不跑 pnpm install
  powershell -File restore.ps1 -WithMnemon            # 连 <AppRoot>\mnemon 一起回（快照里有 mnemon-old 才有效）

要点
  - 回退前先把当前状态另存一份 manual-<时间戳>，回退错了还能再回退回来。
  - 只覆盖、不删除：本机多出来的文件不会被清掉（避免误删你后来新增的插件配置）。
  - 还原完按 profile\package.json 的 bundles 逐项检查能否在本机解析，缺就提示/重装依赖。
#>
param(
  [string]$RepoRoot = (Split-Path -Parent $PSCommandPath),
  [string]$DshHome = $(Join-Path $env:USERPROFILE '.dsh'),
  [string]$ProfileName = 'desktop',
  [string]$AppRoot = '',
  [string]$BackupDir = '',
  [string]$FromCommit = '',
  [switch]$SkipInstall,
  [switch]$WithMnemon,
  [switch]$DryRun,
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'dsh-sync-common.ps1')

$ProfileDir = Join-Path $DshHome ('profiles\' + $ProfileName)
$ProfileFiles = @('package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'cordis.yml', 'cordis.patch.yml')
$HomeFiles = @('AGENTS.md', 'prompt-inject.md')

# 客户端根：没传就按常见安装位置探测，判据是存在 resources\app\package.json
function Resolve-AppRoot([string]$explicit) {
  $cands = @()
  if ($explicit) { $cands += $explicit }
  $cands += @('D:\DeepSeekHarness', 'D:\DSH', 'G:\DSH', 'G:\DeepSeekHarness', 'C:\DeepSeekHarness')
  foreach ($c in $cands) {
    if (Test-Path -LiteralPath (Join-Path $c 'resources\app\package.json')) { return $c }
  }
  if ($explicit) { return $explicit }
  return 'D:\DeepSeekHarness'
}

# git 位置探测统一在 dsh-sync-common.ps1 里（Get-GitExe），restore 允许找不到（只影响 pnpm 安装步骤）

# 按 profile\package.json 的 bundles 逐项查能否解析（profile\node_modules 优先，再宿主自带 node_modules）
function Get-UnresolvedBundles {
  $missing = New-Object System.Collections.ArrayList
  $pkgPath = Join-Path $ProfileDir 'package.json'
  if (-not (Test-Path -LiteralPath $pkgPath)) { return $missing }
  try { $pkg = Get-Content -LiteralPath $pkgPath -Raw -Encoding utf8 | ConvertFrom-Json } catch { return $missing }
  $bundles = @($pkg.dsh.profile.bundles)
  $roots = @((Join-Path $ProfileDir 'node_modules'), (Join-Path $AppRoot 'resources\app\dsh\node_modules'))
  foreach ($b in $bundles) {
    if ([string]::IsNullOrWhiteSpace($b)) { continue }
    $rel = [string]($b -replace '/', '\')
    $found = $false
    foreach ($r in $roots) {
      if (Test-Path -LiteralPath (Join-Path $r (Join-Path $rel 'package.json'))) { $found = $true; break }
    }
    if (-not $found) { [void]$missing.Add($b) }
  }
  return $missing
}

$AppRoot = Resolve-AppRoot $AppRoot

Say "== DSH 配置同步 / restore =="
Say "仓库：$RepoRoot"
Say "DSH home：$DshHome"
Say "客户端：$AppRoot"
Say "profile：$ProfileDir"
if ($DryRun) { Say "模式：DryRun（只看不动）" }
Say ""

# ---------- 0. 前置检查 ----------
$proc = Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue
if ($proc -and -not $Force) {
  Die "DeepSeek Harness 仍在运行（PID: $(($proc.Id) -join ',')）。请完全退出（含托盘）后重试，或加 -Force 强制继续。"
}
if (-not (Test-Path -LiteralPath $RepoRoot)) { Warn "仓库目录不存在：$RepoRoot（仅 -FromCommit 需要它）" }
if (-not (Test-Path -LiteralPath $ProfileDir)) {
  if ($DryRun) { Say "  profile 目录不存在（还原时会新建）：$ProfileDir" }
  else {
    New-Item -ItemType Directory -Path $ProfileDir -Force | Out-Null
    Warn "profile 目录原本不存在，已新建：$ProfileDir"
  }
}

# ---------- 1. 确定还原来源 ----------
$mode = ''
if ($FromCommit) {
  $gitExe = Get-GitExe
  if (-not $gitExe) { Die "找不到 git，无法按提交还原。请安装 Git 或改用 -BackupDir。" }
  # 注意：不能用 "{0}^{commit}" -f ，`{commit}` 会被当成格式占位符 → "Error formatting a string"
  & $gitExe -C $RepoRoot rev-parse --verify ($FromCommit + '^{commit}') 2>&1 | Out-Null
  if ($LASTEXITCODE -ne 0) { Die "git 里找不到提交：$FromCommit" }
  $mode = 'git'
  Say "来源：git 提交 $FromCommit 的 profile\"
} else {
  if (-not $BackupDir) {
    $bkRoot = Join-Path $DshHome 'backups'
    if (-not (Test-Path -LiteralPath $bkRoot)) {
      Die "没有备份目录 $bkRoot，也没有指定 -FromCommit。若这是全新机器，本来就没有旧配置可还原：请跑 sync.ps1 pull，或 apply.ps1 -WorkspaceOnly 先落地资料。"
    }
    $cands = @(Get-ChildItem -LiteralPath $bkRoot -Directory -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending)
    if ($cands.Count -eq 0) {
      Die "$bkRoot 下没有任何快照。若这是全新机器，请跑 sync.ps1 pull，或用 -FromCommit 取仓库历史配置。"
    }
    # 新机器首次拉取时本机还没有 profile 文件，apply 会留下一个空快照；这类快照不能用来还原
    # （否则还原会"一个 profile 文件都没有"直接失败），所以按时间倒序找第一份带 profile 的快照。
    $usable = @($cands | Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'package.json') })
    if ($usable.Count -eq 0) {
      Die ("$bkRoot 下 {0} 份快照里都没有 profile 文件（package.json），无法还原配置。全新机器本来就没有旧配置可退：如需回到某个提交的配置，用 -FromCommit。" -f $cands.Count)
    }
    $BackupDir = $usable[0].FullName
    if ($usable[0].Name -ne $cands[0].Name) {
      Warn ("最新一份 {0} 里没有 profile 文件（新机器首次拉取时本机无配置可备份），已改用 {1}" -f $cands[0].Name, $usable[0].Name)
    } else {
      Warn "未指定备份点，取最新一份：$BackupDir"
    }
  }
  if (-not (Test-Path -LiteralPath $BackupDir)) { Die "备份目录不存在：$BackupDir" }
  $mode = 'backup'
  Say "来源：备份快照 $BackupDir"
}
Say ""

# ---------- 2. 自保：先把当前状态另存一份 ----------
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$safety = Join-Path $DshHome ('backups\manual-' + $stamp)
if (-not $DryRun) {
  New-Item -ItemType Directory -Path $safety -Force | Out-Null
  $n = 0
  foreach ($f in $ProfileFiles) {
    $src = Join-Path $ProfileDir $f
    if (Test-Path -LiteralPath $src) { Copy-Item -LiteralPath $src -Destination (Join-Path $safety $f) -Force; $n++ }
  }
  foreach ($f in $HomeFiles) {
    $src = Join-Path $DshHome $f
    if (Test-Path -LiteralPath $src) { Copy-Item -LiteralPath $src -Destination (Join-Path $safety $f) -Force; $n++ }
  }
  if ($n -gt 0) { Ok "已把当前状态另存到 $safety（$n 个文件），回退错了还能再回退" }
  else { Warn "当前没有可备份的配置（全新机器？），继续" }
}

# ---------- 3. 还原 profile 配置 ----------
if ($mode -eq 'git') {
  foreach ($f in $ProfileFiles) {
    if ($DryRun) { Say "  将写入 profile\$f（取自 $FromCommit）"; continue }
    $raw = (& $gitExe -C $RepoRoot show ($FromCommit + ':profile/' + $f)) -join "`n"
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($raw)) { Warn "提交 $FromCommit 里没有 profile\$f，跳过"; continue }
    Write-TextPreserveBom (Join-Path $ProfileDir $f) ($raw + "`n")
    Ok "已写回 profile\$f"
  }
} else {
  $restored = 0
  foreach ($f in $ProfileFiles) {
    $src = Join-Path $BackupDir $f
    if (-not (Test-Path -LiteralPath $src)) { Warn "快照里没有 $f，跳过（该文件保持现状）"; continue }
    if ($DryRun) { Say "  将写回 profile\$f"; continue }
    Copy-Item -LiteralPath $src -Destination (Join-Path $ProfileDir $f) -Force
    $restored++
  }
  if (-not $DryRun -and $restored -eq 0) { Die "快照里一个 profile 文件都没有，$BackupDir 可能不是 apply 生成的备份点。" }
  if (-not $DryRun) { Ok "已写回 profile 配置 $restored 个文件" }

  foreach ($f in $HomeFiles) {
    $src = Join-Path $BackupDir $f
    if (-not (Test-Path -LiteralPath $src)) { continue }
    if ($DryRun) { Say "  将写回 $f"; continue }
    Copy-Item -LiteralPath $src -Destination (Join-Path $DshHome $f) -Force
    Ok "已写回 $f"
  }

  $bkSettings = Join-Path $BackupDir 'settings'
  if (Test-Path -LiteralPath $bkSettings) {
    if ($DryRun) { Say "  将写回 settings\ 下的插件设置文件" }
    else {
      $cnt = 0
      Get-ChildItem -LiteralPath $bkSettings -File -Force | ForEach-Object {
        Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $DshHome $_.Name) -Force
        $cnt++
      }
      Ok "已写回 settings 下 $cnt 个插件设置文件"
    }
  }
}
Say ""

# ---------- 4. 可选：记忆数据 mnemon ----------
if ($WithMnemon) {
  $mnSrc = Join-Path $BackupDir 'mnemon-old'
  $mnDst = Join-Path $AppRoot 'mnemon'
  if (-not (Test-Path -LiteralPath $mnSrc)) {
    Warn "快照里没有 mnemon-old，跳过记忆数据（-FromCommit 模式下也不支持）"
  } elseif ($DryRun) {
    Say "  将用 $mnSrc 覆盖 $mnDst"
  } else {
    if (Test-Path -LiteralPath $mnDst) {
      $mnBk = Join-Path $safety 'mnemon-old'
      Copy-Item -LiteralPath $mnDst -Destination $mnBk -Recurse -Force
      Warn "现有 mnemon 已另存到 $mnBk"
    }
    CopyMerge $mnSrc $mnDst
    Ok "已还原记忆数据到 $mnDst"
  }
  Say ""
}

if ($DryRun) {
  Say "== DryRun 结束（没有写任何文件）=="
  exit 0
}

# ---------- 5. 核对：版本契约 + bundle 可解析性 ----------
$localVer = Get-HostAppVersion $AppRoot
$contractPath = Join-Path $RepoRoot 'profile\host-contract.json'
$contractVer = $null
if (Test-Path -LiteralPath $contractPath) {
  try { $contractVer = [string](Get-Content -LiteralPath $contractPath -Raw -Encoding utf8 | ConvertFrom-Json).appVersion } catch { }
}
Say "  本机 app 版本：$localVer；仓库契约：$contractVer"
if ($localVer -and $contractVer -and $localVer -ne $contractVer) {
  Warn "两端版本不一致：本机 $localVer，仓库契约 $contractVer。还原只修本机文件，拉起后仍可能在 pull 时被版本契约拦下（需升级本机，或 pull 加 -AllowVersionDrift）。"
}

$missing = @(Get-UnresolvedBundles)
if ($missing.Count -gt 0) {
  Warn "有 $($missing.Count) 个 bundle 在本机解析不到：$($missing -join ', ')"
} else {
  Ok "所有 bundle 都能在本机解析"
}

# ---------- 6. 重装依赖 ----------
if ($SkipInstall) {
  Warn "已指定 -SkipInstall，跳过依赖安装（缺的 bundle 若在 profile\node_modules 里，仍需手动 pnpm install）"
} elseif ($missing.Count -eq 0) {
  Ok "依赖已经齐全，跳过 pnpm install"
} else {
  $nodeExe = Join-Path $AppRoot 'resources\runtime\primary-runtime\dependencies\node\bin\node.exe'
  $pnpmCjs = Join-Path $AppRoot 'resources\runtime\primary-runtime\dependencies\pnpm\bin\pnpm.cjs'
  Push-Location $ProfileDir
  try {
    if ((Test-Path -LiteralPath $nodeExe) -and (Test-Path -LiteralPath $pnpmCjs)) {
      Say "  使用客户端内置 pnpm 按 lockfile 安装（可能需要几分钟）..."
      & $nodeExe $pnpmCjs install --frozen-lockfile
      if ($LASTEXITCODE -ne 0) {
        Warn "严格模式失败（lockfile 与 package.json 对不上），改为 --no-frozen-lockfile 重试..."
        & $nodeExe $pnpmCjs install --no-frozen-lockfile
      }
    } elseif (Get-Command pnpm -ErrorAction SilentlyContinue) {
      Say "  使用系统 pnpm 安装..."
      & pnpm install --frozen-lockfile
      if ($LASTEXITCODE -ne 0) { & pnpm install --no-frozen-lockfile }
    } else {
      Warn "找不到 pnpm。请手动在 $ProfileDir 执行：pnpm install --frozen-lockfile"
    }
  } finally {
    Pop-Location
  }

  $missing2 = @(Get-UnresolvedBundles)
  if ($missing2.Count -eq 0) { Ok "重装后所有 bundle 均可解析" }
  else { Warn "重装后仍有 $($missing2.Count) 个解析不到：$($missing2 -join ', ')。检查磁盘空间（scripts 面板会报），或回退到更早的快照。" }
}

Say ""
Say "== 还原完成 =="
Say "  profile：$ProfileDir"
Say "  当前状态另存在：$safety"
Say "  下一步：启动 DSH，确认能进到主界面；如果不正常，用 sync.ps1 status 看版本契约与 bundle 计数。"
exit 0
