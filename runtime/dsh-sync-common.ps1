# DSH 配置同步 —— apply.ps1 / capture.ps1 共用的常量与函数
#
# 为什么单独抽一个文件：
#   两个脚本原来各自复制了一份 Say/Ok/Warn/Die、路径段计算、工作区忽略规则、安装目录正则。
#   改一端忘另一端就会出现「capture 归一了、apply 没展开」这类只有跨机才暴露的错，
#   所以统一收在这里，两个脚本用 dot-source 引入（. "$PSScriptRoot\dsh-sync-common.ps1"）。
#
# 纪律：本文件被两个脚本共用，改完必须两端都跑一遍回归（capture → git status 应干净）。

$BS = [string][char]92
# git 的输出是 UTF-8，Windows PowerShell 5.1 默认按当前代码页（936）读管道，
# 中文 commit message 到日志里就成了「鎺掗槦」这种乱码。统一按 UTF-8 解。
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }
try { $OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }
$AppRootToken       = '{{APP_ROOT}}'
$WorkspaceHomeToken = '{{WORKSPACE_HOME}}'
# 只出现在会话头 cwd 归一里（<home>\im 这类不属于前两个 token 的路径），apply 端不需要展开
$DshHomeToken       = '{{DSH_HOME}}'

function Say($m)  { Write-Host $m }
function Ok($m)   { Write-Host "  [OK] $m" -ForegroundColor Green }
function Warn($m) { Write-Host "  [!]  $m"  -ForegroundColor Yellow }
function Die($m)  { Write-Host "  [X]  $m"  -ForegroundColor Red; exit 1 }

# ---------- 未同步文件清单（notices） ----------
# 为什么单独攒一份文件：capture / sync / apply 是不同进程，各自只能写日志，用户看不到
# 「哪些文件这次没同步」；post-exit 在进度窗口末尾要汇总它，面板（index.js / client.js）
# 要常驻显示它。所以统一落到 ~\.dsh\sync-notices.json，谁跑谁追加，收尾谁读谁用。
# kind：
#   too-large  超过单文件上限（capture 跳过 / push 前从索引剔除 / 历史里已存在）
#   skipped    被规则或占用跳过（不是失败，但用户该知道）
#   failed     写入失败、被远端拒绝等真失败
#   history    历史提交里已存在的超限文件（远端必然拒收，必须改写历史或换仓库）
$script:SyncNoticeItems = New-Object 'System.Collections.ArrayList'
$script:SyncNoticeHome = $null
$script:SyncNoticeMode = ''
$script:SyncNoticeLoaded = $false

function Get-SyncNoticesPath([string]$dshHome) {
  $h = if ($dshHome) { $dshHome } else { Join-Path $env:USERPROFILE '.dsh' }
  return (Join-Path $h 'sync-notices.json')
}

function Read-SyncNotices([string]$dshHome) {
  try {
    $p = Get-SyncNoticesPath $dshHome
    if (-not (Test-Path -LiteralPath $p)) { return $null }
    return (Get-Content -LiteralPath $p -Raw -Encoding utf8 | ConvertFrom-Json)
  } catch { return $null }
}

function Save-SyncNotices {
  try {
    $p = Get-SyncNoticesPath $script:SyncNoticeHome
    $dir = Split-Path -Parent $p
    if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    $byKind = [ordered]@{}
    foreach ($k in @('too-large', 'history', 'skipped', 'failed')) {
      $byKind[$k] = @($script:SyncNoticeItems | Where-Object { $_.kind -eq $k }).Count
    }
    $obj = [ordered]@{
      at     = [long]([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())
      mode   = $script:SyncNoticeMode
      total  = $script:SyncNoticeItems.Count
      byKind = $byKind
      items  = @($script:SyncNoticeItems)
    }
    [IO.File]::WriteAllText($p, ($obj | ConvertTo-Json -Depth 4), (New-Object Text.UTF8Encoding $false))
  } catch { }
}

# 每个动作开始时清空。被 sync 调起的子脚本（capture）要传 -NoResetNotices，
# 否则它一 Reset 就把父进程已经攒下的条目抹掉。
function Reset-SyncNotices([string]$dshHome, [string]$mode) {
  $script:SyncNoticeHome = $dshHome
  $script:SyncNoticeMode = $mode
  $script:SyncNoticeItems.Clear()
  $script:SyncNoticeLoaded = $true
  Save-SyncNotices
}

function Add-SyncNotice {
  param([string]$Kind = 'skipped', [string]$Path = '', [string]$Reason = '', [long]$Bytes = 0)
  if (-not $Path) { return }
  # 先吃进磁盘上别的进程已经写好的条目（capture 与 sync 是两个进程）
  if (-not $script:SyncNoticeLoaded) {
    $existing = Read-SyncNotices $script:SyncNoticeHome
    if ($existing -and $existing.items) {
      foreach ($it in @($existing.items)) {
        [void]$script:SyncNoticeItems.Add([ordered]@{ kind = [string]$it.kind; path = [string]$it.path; bytes = [long]$it.bytes; reason = [string]$it.reason })
      }
    }
    $script:SyncNoticeLoaded = $true
  }
  foreach ($it in $script:SyncNoticeItems) {
    if ($it.kind -eq $Kind -and $it.path -eq $Path) { return }
  }
  [void]$script:SyncNoticeItems.Add([ordered]@{ kind = $Kind; path = $Path; bytes = $Bytes; reason = $Reason })
  Save-SyncNotices
}

# 给窗口/面板用的一行摘要：「2 个超过单文件上限、1 个被远端拒绝」
function Get-SyncNoticesSummary($notices) {
  if (-not $notices -or -not $notices.items -or @($notices.items).Count -eq 0) { return '' }
  $bk = $notices.byKind
  $parts = @()
  if ($bk.'too-large' -gt 0) { $parts += ("{0} 个超过单文件上限" -f $bk.'too-large') }
  if ($bk.history -gt 0) { $parts += ("{0} 个历史提交里的超限文件" -f $bk.history) }
  if ($bk.skipped -gt 0) { $parts += ("{0} 个被规则跳过" -f $bk.skipped) }
  if ($bk.failed -gt 0) { $parts += ("{0} 个写入/推送失败" -f $bk.failed) }
  return ($parts -join '、')
}

# Windows PowerShell 5.1 的模块自动加载偶尔拿不到 Get-FileHash（PSModulePath 被别的版本目录污染时，
# 会先撞上一个装不进 5.1 的同名模块，之后这个 cmdlet 就"不存在"了，脚本直接 CommandNotFound 崩掉）。
# 同步链路全靠它判断"文件要不要覆盖"，所以缺了就补一个等价实现，不让一个 cmdlet 决定整条链路生死。
if (-not (Get-Command Get-FileHash -ErrorAction SilentlyContinue)) {
  function Get-FileHash {
    param(
      [Parameter(Mandatory = $true)][string]$LiteralPath,
      [ValidateSet('SHA256', 'SHA1', 'MD5')][string]$Algorithm = 'SHA256'
    )
    $algo = [System.Security.Cryptography.HashAlgorithm]::Create($Algorithm)
    $fs = [System.IO.File]::Open($LiteralPath, 'Open', 'Read', 'ReadWrite')
    try { $bytes = $algo.ComputeHash($fs) } finally { $fs.Dispose(); $algo.Dispose() }
    [pscustomobject]@{
      Algorithm = $Algorithm
      Hash      = (($bytes | ForEach-Object { $_.ToString('X2') }) -join '')
      Path      = $LiteralPath
    }
  }
}

# 默认工作区（<WorkspaceHome>\default-workspace）不参与同步。
# 原因：它的目录名由「本机 WorkspaceHome 绝对路径」编码而来，两台机器的 WorkspaceHome 天然不同，
# 同步过去只会在目标机器上留下一个"文件在、但 DSH 按自己的编码找不到"的目录（表现为该工作区历史为空）。
# 判据只看尾段：编码名一律以 "-default-workspace--" 收尾（含 CJK 转义段也不影响）。
function Test-DefaultWorkspaceDir([string]$dirName) {
  if (-not $dirName) { return $false }
  return ($dirName -like '*-default-workspace--')
}

# git 常常不在当前进程的 PATH 里（尤其是从客户端里起的命令行），按常见安装位置兜底。
# 以前 sync.ps1 / restore.ps1 / post-exit.ps1 各写一份，位置表还不一致（restore 那份写死 C:\Program Files
# 且不认 LOCALAPPDATA），合并到这里。返回 $null 表示没找到，由调用方决定报错还是降级。
# post-exit.ps1 例外：它要在仓库目录缺失时也能跑，所以自带一份最小实现（见该文件注释）。
function Get-GitExe {
  foreach ($p in @(
      (Join-Path $env:ProgramFiles 'Git\cmd\git.exe'),
      (Join-Path $env:LOCALAPPDATA 'Programs\Git\cmd\git.exe'),
      (Join-Path ${env:ProgramFiles(x86)} 'Git\cmd\git.exe')
    )) {
    if ($p -and (Test-Path -LiteralPath $p)) { return $p }
  }
  $c = Get-Command git.exe -ErrorAction SilentlyContinue
  if ($c) { return $c.Source }
  return $null
}

# 求 $full 相对 $base 的路径：按路径段数取尾巴，避免 8.3 短路径（ADMINI~1）或大小写差异导致 Substring 算错
function Get-RelPath([string]$base, [string]$full) {  $b = @($base -split '\\' | Where-Object { $_ -ne '' })
  $f = @($full -split '\\' | Where-Object { $_ -ne '' })
  if ($f.Count -le $b.Count) { return $null }
  return ($f[$b.Count..($f.Count - 1)] -join '\')
}

# 把 $srcDir 的内容合并进 $dstDir：目标已存在同名子目录时不能再用 Copy-Item -Recurse（会套娃成 x\x）
function CopyMerge($srcDir, $dstDir) {
  if (-not (Test-Path -LiteralPath $dstDir)) { New-Item -ItemType Directory -Path $dstDir -Force | Out-Null }
  Get-ChildItem -LiteralPath $srcDir -Force | ForEach-Object {
    $d = Join-Path $dstDir $_.Name
    if ($_.PSIsContainer) { CopyMerge $_.FullName $d }
    else { Copy-Item -LiteralPath $_.FullName -Destination $d -Force }
  }
}

# ---------- 工作区资料：忽略清单 ----------
$wsSkipDirs  = @('.git','node_modules','sessions','attachments','logs','_tmp','staging','.dsh','.agent-teams','models')
$wsSkipFiles = @('Thumbs.db','desktop.ini','.DS_Store')
$wsSkipExt   = @('.bak','.tmp','.log','.whl','.safetensors','.ckpt')
# 单文件上限：Gitee 免费版单文件 100MB、仓库总量 1GB。超过一律不进仓库——
# 真实事故：默认工作区的 img-gen\models 里 sd_xl_base_1.0.safetensors(6.6GB) + 三个 torch*.whl(各 2.3GB)
# 共 13.8GB 被同步进仓库，既拖垮每次同步、又把云端配额顶爆（push 被 pre-receive 拒绝）。
# 这类大文件本来就该留在本机（原件在工作区目录里不动），同步只搬配置/资料。
$wsMaxFileBytes = 100MB

function Test-WorkspaceIgnored([string]$rel) {
  # 只按「目录段」判忽略，最后一段是文件名不算目录（否则一个恰好叫 logs 的文件会被误跳过）
  $parts = @($rel.Replace($BS,'/') -split '/' | Where-Object { $_ -ne '' })
  $dirParts = if ($parts.Count -gt 1) { @($parts[0..($parts.Count-2)]) } else { @() }
  foreach ($seg in $dirParts) { if ($wsSkipDirs -contains $seg) { return $true } }
  $leaf = if ($parts.Count -gt 0) { $parts[$parts.Count-1] } else { '' }
  if ($wsSkipFiles -contains $leaf) { return $true }
  if ($wsSkipExt -contains ([IO.Path]::GetExtension($leaf).ToLower())) { return $true }
  if ($leaf -like '*.bak-*') { return $true }
  return $false
}

# ---------- 客户端安装目录 ----------
# 仓库里凡是「客户端安装目录」的绝对路径，一律存成 {{APP_ROOT}}/ 前缀；
# apply 时展开成本机路径，capture 时归一成占位符。
#
# 关键修复（2026-11-10）：旧版正则把目录名写死成 DeepSeekHarness，
# 客户端装在 D:\DSH 时占位符机制整体失效（本机路径原样入库 → 另一台 lock 与 package.json 对不上 → install 半装 → 启动崩）。
# 现在按「本机 -AppRoot 的实际末级目录名」生成正则：DSH、DeepSeekHarness、任意目录名都能命中。
function Get-AppRootLeaf([string]$appRoot) {
  $leaf = Split-Path -Leaf ($appRoot.TrimEnd('\', '/'))
  if ([string]::IsNullOrWhiteSpace($leaf)) { $leaf = 'DeepSeekHarness' }
  return $leaf
}

function Get-AppRootPattern([string]$appRoot) {
  $leaf = Get-AppRootLeaf $appRoot
  # 匹配 [盘符]:[\...\]<末级目录名>，含 JSON 双反斜杠写法；不匹配 <名字>-xxx 这类更长的目录
  return ('(?i)(?<![A-Za-z0-9_])[A-Z]:[\\/]+(?:[^\s"''`,;()\[\]]*[\\/]+)?' + [regex]::Escape($leaf) + '(?![\w-])(?:[\\/]+)?')
}

function Get-AppRootFwd([string]$appRoot) {
  return ($appRoot -replace '\\', '/').TrimEnd('/')
}

# 把文本里「本机安装目录」的各种写法整体替换成 $replacement。
# 先做字面替换（覆盖任意目录名、任意盘符，这是主路径），再用正则兜底别的机器残留的同名目录。
function Convert-AppRootText([string]$text, [string]$appRoot, [string]$replacement) {
  $fwd   = Get-AppRootFwd $appRoot
  $plain = $appRoot.TrimEnd('\', '/')
  $text = $text.Replace($plain, $replacement)
  $text = $text.Replace($fwd,   $replacement)
  # JSON 里的双反斜杠写法：D:\\DeepSeekHarness
  $text = $text.Replace(($plain -replace '\\', '\\\\'), ($replacement -replace '/', '\\\\'))
  # 兜底：别的机器残留的同名目录（任意盘符）
  $pattern = Get-AppRootPattern $appRoot
  return [regex]::Replace($text, $pattern, ($replacement + '/'))
}

# ---------- 文本读写（保 BOM） ----------
function Read-TextPreserveBom([string]$path) {
  $bytes = [IO.File]::ReadAllBytes($path)
  $text = [Text.Encoding]::UTF8.GetString($bytes)
  if ($text.Length -gt 0 -and $text[0] -eq [char]0xFEFF) { $text = $text.Substring(1) }
  return $text
}

function Write-TextPreserveBom([string]$path, [string]$text) {
  $hasBom = $false
  if (Test-Path -LiteralPath $path) {
    $b = [IO.File]::ReadAllBytes($path)
    $hasBom = ($b.Length -ge 3 -and $b[0] -eq 0xEF -and $b[1] -eq 0xBB -and $b[2] -eq 0xBF)
  }
  [IO.File]::WriteAllText($path, $text, (New-Object Text.UTF8Encoding($hasBom, $false)))
}

# ---------- 宿主版本 ----------
# 真正的 app 版本在 <AppRoot>\resources\app\package.json 的 version；
# <AppRoot>\version 里是 Electron 版本（44.7.0 这种），拿它当版本依据会误判「两端已对齐」。
#
# 两种客户端构建都要认：
#   解包版 → <AppRoot>\resources\app\package.json
#   打包版 → <AppRoot>\resources\app.asar（里面仍有 dsh\package.json，版本与本机 app 版一致）
# 只认前者时，打包版机器会「读不到版本」→ 跳过校验，bundle 探路也全落空。
function Get-AsarEntryText([string]$asar, [string]$entryPath) {
  # entryPath 用 '/' 分段，例如 'dsh/package.json'；读不到返回 $null。
  # asar 结构：16 字节头（偏移 4 = header 长度，偏移 12 = JSON 长度，数据从 8+headerSize 起算）。
  #
  # 这里**不整体 JSON.parse**：asar 头部有 5.7MB，而 PowerShell 5.1 的 ConvertFrom-Json
  # （JavaScriptSerializer）默认上限 2MB，直接解析必然抛 "length of the string exceeds"。
  # 改为在头部文本里定位锚点 '"dsh":{"files":{' 后的第一个 '"package.json":{'，
  # 从它紧邻的 "size"/"offset" 取值，再把那一段小文件读出来（小文件解析没有上限问题）。
  if (-not (Test-Path -LiteralPath $asar)) { return $null }
  if ($entryPath -notmatch '^(.+)/([^/]+)$') { return $null }
  $parent = $Matches[1]
  $leaf = $Matches[2]
  $fs = $null
  try {
    $fs = [IO.File]::Open($asar, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
    $head = New-Object byte[] 16
    if ($fs.Read($head, 0, 16) -ne 16) { return $null }
    $headerSize = [int64][BitConverter]::ToUInt32($head, 4)
    $jsonLen = [int][BitConverter]::ToUInt32($head, 12)
    if ($jsonLen -lt 2 -or $jsonLen -gt 200MB) { return $null }
    $jsonBytes = New-Object byte[] $jsonLen
    $read = 0
    while ($read -lt $jsonLen) {
      $n = $fs.Read($jsonBytes, $read, $jsonLen - $read)
      if ($n -le 0) { return $null }
      $read += $n
    }
    $text = [Text.Encoding]::UTF8.GetString($jsonBytes)
    $anchor = '"' + $parent + '":{"files":{'
    $ai = $text.IndexOf($anchor)
    if ($ai -lt 0) { return $null }
    $ei = $text.IndexOf('"' + $leaf + '":{', $ai)
    if ($ei -lt 0) { return $null }
    $chunk = $text.Substring($ei, [Math]::Min(400, $text.Length - $ei))
    $m = [regex]::Match($chunk, '"size":(\d+),"offset":"?(\d+)"?')
    if (-not $m.Success) { return $null }
    $size = [int64]$m.Groups[1].Value
    $off = [int64]$m.Groups[2].Value
    if ($size -le 0 -or $size -gt 8MB) { return $null }
    $fs.Position = [int64](8 + $headerSize) + $off
    $bytes = New-Object byte[] $size
    $read = 0
    while ($read -lt $size) {
      $n = $fs.Read($bytes, $read, $size - $read)
      if ($n -le 0) { return $null }
      $read += $n
    }
    return [Text.Encoding]::UTF8.GetString($bytes)
  } catch { return $null } finally { if ($fs) { $fs.Dispose() } }
}

function Get-HostAppVersion([string]$appRoot) {
  $p = Join-Path $appRoot 'resources\app\package.json'
  if (Test-Path -LiteralPath $p) {
    try { return [string](Get-Content -LiteralPath $p -Raw -Encoding utf8 | ConvertFrom-Json).version } catch { }
  }
  $asar = Join-Path $appRoot 'resources\app.asar'
  if (Test-Path -LiteralPath $asar) {
    $text = Get-AsarEntryText $asar 'dsh/package.json'
    if ($text) {
      try { return [string]($text | ConvertFrom-Json).version } catch { }
    }
  }
  return $null
}

# 宿主自带 bundle 的落点：解包版在 resources\app\dsh\node_modules，打包版在 app.asar.unpacked\dsh\node_modules。
function Get-HostDshNodeModules([string]$appRoot) {
  return @(
    (Join-Path $appRoot 'resources\app\dsh\node_modules'),
    (Join-Path $appRoot 'resources\app.asar.unpacked\dsh\node_modules')
  )
}

function Get-HostNodeExe([string]$appRoot) {
  $p = Join-Path $appRoot 'resources\runtime\primary-runtime\dependencies\node\bin\node.exe'
  if (Test-Path -LiteralPath $p) { return $p }
  # 后台自动同步是从客户端进程拉起来的，PATH 里往往**没有** node（用户交互终端里才有）。
  # 只认 PATH 会让「会话头部 cwd 修正」在无人值守时静默跳过，拉取后会话全部变成
  # 带 {{APP_ROOT}} 占位符的文件，DSH 一个都不登记 —— 用户看到的就是「工作区还在、会话没了」。
  # 所以这里把常见安装位置也探一遍。
  $guesses = @()
  foreach ($base in @($env:ProgramFiles, ${env:ProgramFiles(x86)}, $env:LOCALAPPDATA)) {
    if (-not $base) { continue }
    $guesses += (Join-Path $base 'nodejs\node.exe')
    $guesses += (Join-Path $base 'Programs\nodejs\node.exe')
    $guesses += (Join-Path $base 'Volta\bin\node.exe')
    $guesses += (Join-Path $base 'fnm\node.exe')
  }
  foreach ($g in $guesses) {
    if (Test-Path -LiteralPath $g) { return $g }
  }
  try {
    $c = Get-Command node -ErrorAction Stop
    if ($c -and $c.Source) { return $c.Source }
  } catch { }
  return $null
}

# 能跑 Node 脚本的「执行器」：优先真 Node；没有的话用客户端自带的 Electron
# （ELECTRON_RUN_AS_NODE=1 时它就是 node，自带 zstd，版本通常比用户装的还新）。
# 用户机器上经常根本没装独立 Node —— 只认 node.exe 会让会话头部永远修不了。
function Get-HostNodeRunner([string]$appRoot) {
  $node = Get-HostNodeExe $appRoot
  if ($node) { return @{ Exe = $node; Electron = $false } }
  if (-not (Test-Path -LiteralPath $appRoot)) { return $null }
  $exes = @(Get-ChildItem -LiteralPath $appRoot -Filter '*.exe' -File -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -notmatch 'Uninstall' })
  $hostExe = $exes | Where-Object { $_.Name -match 'DeepSeek Harness' } | Select-Object -First 1
  if (-not $hostExe) { $hostExe = $exes | Select-Object -First 1 }
  if ($hostExe) { return @{ Exe = $hostExe.FullName; Electron = $true } }
  return $null
}

$script:AsarBundleNameCache = @{}
# 打包版客户端把宿主 bundle 整个塞在 app.asar 里（dsh/node_modules/<pkg>），磁盘上**没有**对应目录。
# 只按路径判断会让 asar 版机器把 20 多个自带 bundle 全误报成「找不到」，进而误删实验性 bundle。
# 这里交给客户端自带 node 读 asar 头，列出包内 node_modules 下的包名（两级，够 @scope/name）。
function Get-AsarBundleNames([string]$appRoot) {
  $asar = Join-Path $appRoot 'resources\app.asar'
  if (-not (Test-Path -LiteralPath $asar)) { return $null }
  $node = Get-HostNodeExe $appRoot
  if (-not $node) { return $null }
  if ($script:AsarBundleNameCache.ContainsKey($asar)) { return $script:AsarBundleNameCache[$asar] }
  $js = @'
const fs=require('fs');
const a=process.argv[2];
const fd=fs.openSync(a,'r');const h=Buffer.alloc(16);fs.readSync(fd,h,0,16,0);
const jl=h.readUInt32LE(12);const b=Buffer.alloc(jl);fs.readSync(fd,b,0,jl,16);fs.closeSync(fd);
const t=JSON.parse(b.toString('utf8'));
const nm=(t.files&&t.files.dsh&&t.files.dsh.files&&t.files.dsh.files.node_modules)||(t.files&&t.files.node_modules);
const out=[];
(function walk(node,prefix,depth){
  if(!node||!node.files||depth>2) return;
  for(const [k,v] of Object.entries(node.files)){
    const name=prefix?prefix+'/'+k:k;
    if(v&&v.files){ out.push(name); walk(v,name,depth+1); }
  }
})(nm,'',1);
process.stdout.write(JSON.stringify(out));
'@
  $tmp = Join-Path $env:TEMP ('asar-names-' + [Guid]::NewGuid().ToString('N') + '.cjs')
  try {
    [IO.File]::WriteAllText($tmp, $js, (New-Object Text.UTF8Encoding($false)))
    $raw = (& $node $tmp $asar 2>$null | Out-String)
    $names = @($raw.Trim() | ConvertFrom-Json)
    $script:AsarBundleNameCache[$asar] = $names
    return $names
  } catch {
    $script:AsarBundleNameCache[$asar] = $null
    return $null
  } finally {
    if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue }
  }
}

# 判断 bundle 是否存在于宿主（路径 or asar 包内）。判不了返回 $true（宁可放过，也别误删）。
function Test-HostBundle([string]$appRoot, [string]$bundle) {
  $rel = ($bundle -replace '/', '\')
  foreach ($m in (Get-HostDshNodeModules $appRoot)) {
    if (Test-Path -LiteralPath (Join-Path $m ($rel + '\package.json'))) { return $true }
  }
  $names = Get-AsarBundleNames $appRoot
  if ($null -eq $names) { return $true }
  return ($names -contains $bundle)
}

function Get-HostElectronVersion([string]$appRoot) {
  $p = Join-Path $appRoot 'version'
  if (-not (Test-Path -LiteralPath $p)) { return $null }
  return (Read-TextPreserveBom $p).Trim()
}

# ---------- 客户端根（AppRoot）自动定位 ----------
# 客户端可能装在任意盘/任意目录，也会被卸载重装到别处；脚本里写死一个盘符换机或换盘就废。
# 定位顺序：显式参数（且要对得上）→ 环境变量 → 注册表卸载项的 InstallLocation（最权威）→ 常见位置。
function Test-AppRootDir([string]$path) {
  if ([string]::IsNullOrWhiteSpace($path)) { return $false }
  $p = $path.TrimEnd('\', '/')
  return (Test-Path -LiteralPath (Join-Path $p 'resources\app.asar')) -or (Test-Path -LiteralPath (Join-Path $p 'resources\app\package.json'))
}

function Get-InstalledAppLocation([string]$namePattern) {
  $roots = @(
    'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*'
  )
  foreach ($r in $roots) {
    try {
      $items = Get-ItemProperty -Path $r -ErrorAction Stop
    } catch { continue }
    foreach ($it in $items) {
      if (-not $it) { continue }
      if ($it.DisplayName -and ($it.DisplayName -like $namePattern) -and $it.InstallLocation) {
        if (Test-AppRootDir $it.InstallLocation) { return $it.InstallLocation.TrimEnd('\', '/') }
      }
    }
  }
  return $null
}

function Resolve-DshAppRoot([string]$explicit) {
  $tried = @()
  if ($explicit) {
    if (Test-AppRootDir $explicit) { return $explicit.TrimEnd('\', '/') }
    $tried += $explicit
  }
  if ($env:DSH_APP_ROOT) {
    if (Test-AppRootDir $env:DSH_APP_ROOT) { return $env:DSH_APP_ROOT.TrimEnd('\', '/') }
    $tried += $env:DSH_APP_ROOT
  }
  $reg = Get-InstalledAppLocation '*DeepSeek Harness*'
  if ($reg) { return $reg }
  $candidates = @()
  foreach ($r in @($env:LOCALAPPDATA, $env:ProgramFiles, ${env:ProgramFiles(x86)})) {
    if ($r) { $candidates += (Join-Path $r 'Programs\DeepSeekHarness'); $candidates += (Join-Path $r 'DeepSeekHarness') }
  }
  $candidates += 'D:\DeepSeekHarness', 'D:\DSH', 'G:\DeepSeekHarness', 'G:\DSH', 'E:\DeepSeekHarness'
  if ($env:DSH_HOME) {
    # .dsh 与客户端常在同一层盘位的不同目录，这里只做兜底试探
    $candidates += (Join-Path (Split-Path -Parent $env:DSH_HOME) 'DeepSeekHarness')
  }
  foreach ($c in $candidates) {
    if ($c -and (Test-AppRootDir $c)) { return $c.TrimEnd('\', '/') }
  }
  return $null
}

# ---------- 同步内容勾选（config-sync-scope.json）----------
# 面板「同步内容」卡片的落点：每组一行、组内还能排除单项。文件不存在 = 全勾（老行为不变）。
# 纪律：勾选只决定「要不要处理」——跳过就是既不抓也不还原；
#       只有 deleteCloud 打开时才顺手删掉仓库里那份副本（默认关闭，删了就不可逆）。
$SyncScopeGroups = @('profile', 'prompt', 'skills', 'presets', 'storages-record', 'settings', 'mnemon', 'local-plugins', 'plugin-data', 'extra', 'workspace', 'conversations')

# ---------- 插件数据 / 额外路径（0.3.51 起）----------
# 背景：以前的同步范围是白名单（十组固定清单），新装的插件如果自己往 <DshHome>\<插件名>\ 或
# 自定义目录里写配置/数据，默认一个都带不走。这里补两组：
#   plugin-data —— 自动枚举 <DshHome> 的一级子目录（排除已被其他组覆盖的系统目录），每个插件一项，
#                  递归收符合规则的小文件；
#   extra       —— 用户在面板上自己填的额外路径（文件或目录），一项一条。
# 两组的规则都写在配置文件 <DshHome>\config-sync-extra.json（本机，不进仓库）：
# 排除名单可改、单文件上限可改（硬顶 100MB —— GitHub 单文件超过 100MB 会被拒收，调大也没用）。
$SyncExtraHardMaxBytes = 104857600

$SyncExtraDefaultSkipDirs = @(
  'profiles', 'skills', '.agent-presets', 'storages', 'sessions', 'attachments', 'logs', 'backups',
  'update-staging', 'electron', 'dsh-runtimes', 'dsh-market', '.dsh-plugin-market', 'dsh-session-manager',
  'im', 'node_modules'
)

$SyncExtraDefaultExclude = @(
  '*.db', '*.db-*', '*.db3', '*.sqlite', '*.sqlite3', '*.sqlite-*', '*.db-shm', '*.db-wal',
  '*.node', '*.exe', '*.dll', '*.asar', '*.pak', '*.bin', '*.iso', '*.img',
  '*.zip', '*.7z', '*.rar', '*.tar', '*.gz', '*.tgz', '*.mp4', '*.mkv', '*.avi',
  '*.log', '*.log.*', '*.tmp', '*.bak', '*.bak-*', '*.old', '*.orig', '*.swp',
  'api-key', '*.pem', '*.key', '*.p12', '*.pfx', '*.crt',
  '*cache*', '*token*', '*secret*', '*credential*', '*password*', '*vault*',
  'node_modules', '.git', '.cache', '__pycache__', '.venv'
)

# 凭据内容嗅探：名字看不出、内容里却带登录态的文件（workbuddy-vault\cn\<hash>.json 就是这种，
# 里面是 accessToken）不能进仓库。抓取时读前 8KB 判一次，命中就跳过并 Warn。
$SyncExtraSecretMarkers = @(
  '"accesstoken"', '"refreshtoken"', '"idtoken"', '"apikey"', '"api_key"',
  '"clientsecret"', '"privatekey"', '"password"', 'authorization: bearer'
)

function Test-SyncExtraSecret([string]$file) {
  try {
    if ((Get-Item -LiteralPath $file -Force).Length -gt 8MB) { return $false }
    $bytes = [IO.File]::ReadAllBytes($file)
    if ($bytes.Length -gt 8192) { $bytes = $bytes[0..8191] }
    # 二进制里到处是 NUL，别拿它当文本嗅探（真正的二进制文件另有扩展名清单挡着）
    if ($bytes -contains 0) { return $false }
    $text = ([Text.Encoding]::UTF8.GetString($bytes)).ToLowerInvariant()
    foreach ($m in $SyncExtraSecretMarkers) { if ($text.Contains($m)) { return $true } }
    return $false
  } catch { return $false }
}

# 自动枚举时被凭据嗅探挡下的文件：抓完集中 Warn 一次，用户知道"这些没进来、为什么"
$script:SyncExtraSecretSkips = New-Object System.Collections.ArrayList
function Reset-SyncExtraSecretSkips { $script:SyncExtraSecretSkips.Clear() }
function Get-SyncExtraSecretSkips { return @($script:SyncExtraSecretSkips) }

function Get-SyncExtraPath([string]$DshHome) { return (Join-Path $DshHome 'config-sync-extra.json') }

function Get-SyncExtraConfig([string]$DshHome) {
  $pd = [pscustomobject]@{
    enabled     = $true
    maxFileBytes = $SyncExtraHardMaxBytes
    exclude     = @($SyncExtraDefaultExclude)
    skipDirs    = @($SyncExtraDefaultSkipDirs)
  }
  $ex = [pscustomobject]@{ enabled = $true; paths = @() }
  $f = $null
  if ($DshHome) { $f = Get-SyncExtraPath $DshHome }
  if ($f -and (Test-Path -LiteralPath $f)) {
    try {
      $j = Get-Content -LiteralPath $f -Raw -Encoding utf8 | ConvertFrom-Json
      if ($j.pluginData) {
        if ($null -ne $j.pluginData.PSObject.Properties['enabled']) { $pd.enabled = ($j.pluginData.enabled -ne $false) }
        if ($null -ne $j.pluginData.PSObject.Properties['maxFileBytes']) {
          $v = 0
          if ([int64]::TryParse([string]$j.pluginData.maxFileBytes, [ref]$v) -and $v -gt 0) { $pd.maxFileBytes = [Math]::Min([int64]$v, [int64]$SyncExtraHardMaxBytes) }
        }
        # 排除名单是"整份替换"，不是追加：用户在面板里删掉一条就真的不再排除。
        # 注意空数组也要能生效（@() 在 PowerShell 里转布尔是 $false，所以按"属性存在"判断）
        if ($j.pluginData.PSObject.Properties['exclude']) { $pd.exclude = @($j.pluginData.exclude | Where-Object { $_ }) }
        if ($j.pluginData.PSObject.Properties['skipDirs']) { $pd.skipDirs = @($j.pluginData.skipDirs | Where-Object { $_ }) }
      }
      if ($j.extra) {
        if ($null -ne $j.extra.PSObject.Properties['enabled']) { $ex.enabled = ($j.extra.enabled -ne $false) }
        if ($j.extra.PSObject.Properties['paths'] -and $j.extra.paths) {
          $ex.paths = @($j.extra.paths | Where-Object { $_ -and $_.id -and $_.src } | ForEach-Object {
              [pscustomobject]@{ id = [string]$_.id; src = [string]$_.src; label = [string]$(if ($_.label) { $_.label } else { $_.id }) }
            })
        }
      }
    } catch {
      Warn ("config-sync-extra.json 解析失败，按默认规则处理：" + $_.Exception.Message)
    }
  }
  return [pscustomobject]@{ version = 1; pluginData = $pd; extra = $ex }
}

function Save-SyncExtraConfig([string]$DshHome, $cfg) {
  $j = [ordered]@{
    version  = 1
    pluginData = [ordered]@{
      enabled      = ($cfg.pluginData.enabled -ne $false)
      maxFileBytes = [int64]$cfg.pluginData.maxFileBytes
      exclude      = @($cfg.pluginData.exclude | Where-Object { $_ })
      skipDirs     = @($cfg.pluginData.skipDirs | Where-Object { $_ })
    }
    extra    = [ordered]@{
      enabled = ($cfg.extra.enabled -ne $false)
      paths   = @($cfg.extra.paths | Where-Object { $_ } | ForEach-Object { [ordered]@{ id = [string]$_.id; src = [string]$_.src; label = [string]$_.label } })
    }
  }
  $f = Get-SyncExtraPath $DshHome
  [IO.File]::WriteAllText($f, ($j | ConvertTo-Json -Depth 6), (New-Object Text.UTF8Encoding($false)))
  return $f
}

# 排除判定：文件名或任一路径段命中通配就排除；超过单文件上限也排除（返回原因，空串表示通过）
function Test-SyncExtraSkip([string]$relName, [long]$size, $cfg) {
  $max = [Math]::Min([int64]$cfg.pluginData.maxFileBytes, [int64]$SyncExtraHardMaxBytes)
  if ($size -gt $max) { return 'too-big' }
  if (-not $relName) { return '' }
  $parts = @($relName -split '[\\/]' | Where-Object { $_ })
  $name = if ($parts.Count -gt 0) { $parts[$parts.Count - 1] } else { $relName }
  $pats = @($cfg.pluginData.exclude)
  foreach ($p in $pats) {
    $wp = New-Object System.Management.Automation.WildcardPattern($p, [System.Management.Automation.WildcardOptions]::IgnoreCase)
    if ($wp.IsMatch($name)) { return 'excluded' }
    foreach ($seg in $parts) { if ($wp.IsMatch($seg)) { return 'excluded' } }
  }
  return ''
}

# 插件数据槽：<DshHome> 一级目录（跳过系统/已覆盖目录与隐藏目录）
function Get-PluginDataSlots([string]$DshHome, $cfg) {
  $out = New-Object System.Collections.ArrayList
  if (-not $DshHome -or -not (Test-Path -LiteralPath $DshHome)) { return @() }
  $skip = @($cfg.pluginData.skipDirs)
  foreach ($d in (Get-ChildItem -LiteralPath $DshHome -Directory -Force -ErrorAction SilentlyContinue)) {
    $name = $d.Name
    if (-not $name) { continue }
    if ($skip -contains $name) { continue }
    if ($name.StartsWith('.')) { continue }
    [void]$out.Add([pscustomobject]@{ id = $name; label = $name; src = $d.FullName })
  }
  return @($out)
}

# 递归枚举一个槽里「规则允许」的文件（depth 上限 8、条数上限 4000，避免面板读一次就卡住）
function Get-PluginDataFiles([string]$slotDir, $cfg, [string]$baseDir = '') {
  $files = New-Object System.Collections.ArrayList
  $limit = 4000
  if (-not $baseDir) { $baseDir = $slotDir }
  function Get-FilesInner([string]$dir, [int]$depth) {
    if ($depth -gt 8 -or $files.Count -ge $limit) { return }
    foreach ($f in (Get-ChildItem -LiteralPath $dir -File -Force -ErrorAction SilentlyContinue)) {
      if ($files.Count -ge $limit) { return }
      $rel = Get-RelPath $baseDir $f.FullName
      if (Test-SyncExtraSkip $rel ([long]$f.Length) $cfg) { continue }
      if (Test-SyncExtraSecret $f.FullName) { [void]$script:SyncExtraSecretSkips.Add($rel); continue }
      [void]$files.Add([pscustomobject]@{ rel = $rel; full = $f.FullName; size = [long]$f.Length })
    }
    foreach ($sub in (Get-ChildItem -LiteralPath $dir -Directory -Force -ErrorAction SilentlyContinue)) {
      if ($files.Count -ge $limit) { return }
      # junction / 符号链接一律不跟：pocs、imports 这类目录常是指到别处（甚至别的盘）的链接，
      # 跟进会把几千个外部文件当成"插件数据"抓走，还会一路撞到 4000 上限被截断
      if ($sub.Attributes -band [IO.FileAttributes]::ReparsePoint) { continue }
      if (Test-SyncExtraSkip $sub.Name 0 $cfg) {
        # 目录段命中排除名单时不再下去（node_modules / .git / *cache* 这类）
        $pats = @($cfg.pluginData.exclude)
        $hit = $false
        foreach ($p in $pats) {
          $wp = New-Object System.Management.Automation.WildcardPattern($p, [System.Management.Automation.WildcardOptions]::IgnoreCase)
          if ($wp.IsMatch($sub.Name)) { $hit = $true; break }
        }
        if ($hit) { continue }
      }
      Get-FilesInner $sub.FullName ($depth + 1)
    }
  }
  Get-FilesInner $slotDir 0
  return @($files)
}

# 必需组：不许取消勾选。理由都是"不勾就报错"这一个事实：
#   profile 里的 package.json / cordis.patch.yml 是 apply 的前置条件 —— 仓库缺它们，apply.ps1 直接 Die；
#   同一组的 host-contract.json 是两端版本一致性校验，丢了它版本不一致也照铺，客户端可能起不来。
# 所以这里（以及面板）都把 profile 钉死为开启，手改 JSON 关掉也按开启处理。
$SyncRequiredGroups = @('profile')

function Test-SyncRequiredGroup([string]$Group) { return ($SyncRequiredGroups -contains $Group) }

function Get-SyncScopePath([string]$DshHome) { return (Join-Path $DshHome 'config-sync-scope.json') }

function Get-SyncScope([string]$DshHome) {
  $path = Get-SyncScopePath $DshHome
  $fallback = [pscustomobject]@{ version = 1; deleteCloud = $false; groups = [pscustomobject]@{} }
  if (-not $path -or -not (Test-Path -LiteralPath $path)) { return $fallback }
  try {
    $raw = Get-Content -LiteralPath $path -Raw -Encoding utf8
    if (-not $raw -or -not $raw.Trim()) { return $fallback }
    $obj = $raw | ConvertFrom-Json
    if ($null -eq $obj) { return $fallback }
    if ($null -eq $obj.PSObject.Properties['deleteCloud']) {
      $obj | Add-Member -NotePropertyName deleteCloud -NotePropertyValue $false -Force
    }
    if ($null -eq $obj.PSObject.Properties['groups']) {
      $obj | Add-Member -NotePropertyName groups -NotePropertyValue ([pscustomobject]@{}) -Force
    }
    return $obj
  } catch {
    Warn ("config-sync-scope.json 解析失败，按「全勾」处理：" + $_.Exception.Message)
    return $fallback
  }
}

function Get-SyncScopeGroup($Scope, [string]$Group) {
  if (-not $Scope -or -not $Scope.groups) { return $null }
  $p = $Scope.groups.PSObject.Properties[$Group]
  if ($null -eq $p) { return $null }
  return $p.Value
}

function Test-SyncGroupEnabled($Scope, [string]$Group) {
  # 必需组永远为真：否则取消勾选 → 仓库缺 profile → 另一台 apply 直接 Die
  if (Test-SyncRequiredGroup $Group) { return $true }
  $g = Get-SyncScopeGroup $Scope $Group
  if ($null -eq $g) { return $true }
  $p = $g.PSObject.Properties['enabled']
  if ($null -ne $p -and $p.Value -eq $false) { return $false }
  return $true
}

function Test-SyncItemEnabled($Scope, [string]$Group, [string]$Item) {
  if (Test-SyncRequiredGroup $Group) { return $true }
  if (-not (Test-SyncGroupEnabled $Scope $Group)) { return $false }
  $g = Get-SyncScopeGroup $Scope $Group
  if ($null -eq $g) { return $true }
  $p = $g.PSObject.Properties['excluded']
  if ($null -eq $p) { return $true }
  return (-not (@($p.Value) -contains $Item))
}

function Test-SyncDeleteCloud($Scope) {
  if (-not $Scope) { return $false }
  return ($Scope.deleteCloud -eq $true)
}

# 整组被跳过时调用：deleteCloud 打开就把仓库里那份删掉；默认什么都不做（留着，以后勾回来接着用）
function Skip-SyncGroup($Scope, [string]$RepoRoot, [string]$Group) {
  Warn ("跳过（未勾选同步）：" + $Group)
  if (-not (Test-SyncDeleteCloud $Scope)) { return }
  $target = Join-Path $RepoRoot $Group
  if (Test-Path -LiteralPath $target) {
    Remove-Item -LiteralPath $target -Recurse -Force
    Warn ("已按「删除云端副本」移除仓库里的 " + $Group)
  }
}

# 组内单项被跳过时调用（item 是仓库里的相对路径，如 skills\foo、settings\x.json）
function Skip-SyncItem($Scope, [string]$RepoRoot, [string]$Group, [string]$Item, [string]$RepoRel) {
  if (-not (Test-SyncDeleteCloud $Scope) -or -not $RepoRel) { return }
  $target = Join-Path $RepoRoot $RepoRel
  if (Test-Path -LiteralPath $target) {
    Remove-Item -LiteralPath $target -Recurse -Force
    Warn ("已按「删除云端副本」移除仓库里的 " + $RepoRel)
  }
}

# ============================================================
# 内置运行时链接修复
# -----------------------------------------------------------
# 现象：插件页点「卸载」或装新插件时报
#   Cannot find module '<AppRoot>\resources\runtime\primary-runtime\dependencies\pnpm\bin\pnpm.mjs'
# 原因：客户端把内置运行时实际放在 <DshHome>\dsh-runtimes\dsh-primary-runtime，
#       而装卸插件时的 pnpm 调用拼的却是安装目录下的 resources\runtime\primary-runtime。
#       客户端升级会重建 resources\runtime（清空它），链接就此消失，之后所有
#       link: 型插件的装卸都会失败（插件本体没坏，是 pnpm 找不到）。
# 做法：每次 apply 幂等补回一次 junction。只建、不删、不覆盖已有真实目录。
# ============================================================
function Repair-PrimaryRuntimeLink([string]$appRoot, [string]$dshHome) {
  if (-not $appRoot -or -not $dshHome) { return }
  $target     = Join-Path $dshHome 'dsh-runtimes\dsh-primary-runtime'
  $targetProbe = Join-Path $target 'dependencies\pnpm\bin\pnpm.mjs'
  $link       = Join-Path $appRoot 'resources\runtime\primary-runtime'
  $linkProbe  = Join-Path $link 'dependencies\pnpm\bin\pnpm.mjs'

  # 判据只认「能不能解析出 pnpm.mjs」，不比路径字符串：
  # $dshHome 可能传成 8.3 短名（如 ADMINI~1），而 junction 的 Target 是长名，
  # 字符串一比就误判成「指向别处」，白报一次告警。
  if (Test-Path -LiteralPath $link) {
    if (Test-Path -LiteralPath $linkProbe) { Ok '内置运行时链接已就绪'; return }
    $item = Get-Item -LiteralPath $link -Force
    if ($item.LinkType -and $item.Target) {
      Warn ("内置运行时链接在，但取不到 pnpm.mjs（指向 " + [string](@($item.Target)[0]) + "）；本次不动，需人工确认")
    } else {
      Warn ("客户端自带运行时目录存在，但里面没有 pnpm.mjs（" + $link + "）；本次不动，若装卸插件失败请检查客户端安装是否完整")
    }
    return
  }

  # 探针必须落到 pnpm.mjs 本身：只看目录存在会误判「运行时齐了」，而客户端真正 require 的是这个文件
  if (-not (Test-Path -LiteralPath $targetProbe)) {
    Warn ("本机没有可用的内置运行时（" + $target + "），跳过链接修复；插件装卸仍会失败，先让客户端把运行时装好")
    return
  }

  $parent = Split-Path -Parent $link
  if (-not (Test-Path -LiteralPath $parent)) {
    Warn ("缺少 " + $parent + "（客户端目录结构有变？），跳过运行时链接修复")
    return
  }

  try {
    New-Item -ItemType Junction -Path $link -Target $target -ErrorAction Stop | Out-Null
    Ok ("已补回内置运行时链接：" + $link + " -> " + $target)
  } catch {
    Warn ("补内置运行时链接失败：" + $_.Exception.Message + "；可手动执行：cmd /c mklink /J `"" + $link + "`" `"" + $target + "`"")
  }
}

# ---------- 远端地址 → 主机名 / 认证自检提示（0.3.27）----------
<#
  插件不挑平台：远端地址只校验「写法」（git@host:path / ssh:// / https://），
  Gitee、GitHub、GitLab、自建 Gitea 走的是同一套 fetch/push/pull。
  这两个函数只解决「报错文案」：以前自检提示写死 ssh -T git@gitee.com，
  用 GitHub/GitLab 的人照着敲会连到错的主机；现在按 origin 的真实主机名现算。
#>
function Get-RemoteHost([string]$Url) {
  if ([string]::IsNullOrWhiteSpace($Url)) { return '' }
  $u = $Url.Trim()
  if ($u -match '^ssh://(?:[^@/]+@)?([^/:]+)') { return $Matches[1] }   # ssh://git@host:22/owner/repo.git
  if ($u -match '^[^@/\s]+@([^:/\s]+):')        { return $Matches[1] }   # git@host:owner/repo.git
  if ($u -match '^https?://([^/]+)')            { return $Matches[1] }   # https://host/owner/repo.git
  return ''
}

<#
  HTTPS 地址没有 SSH 自检这一说：凭据走 Git 凭据管理器（GCM）或 URL 里的 token；
  只有 SSH 地址才给 ssh -T git@<host>。
#>
function Get-RemoteAuthHint([string]$Url) {
  $hostName = Get-RemoteHost $Url
  if ($Url -match '^https?://') {
    if ($hostName) { return ("先确认 " + $hostName + " 的 HTTPS 凭据（Git 凭据管理器里的账号/私人令牌）：git ls-remote --heads origin") }
    return '先确认 HTTPS 凭据（Git 凭据管理器里的账号/私人令牌）：git ls-remote --heads origin'
  }
  if ($hostName) { return ("先自检 SSH：ssh -T git@" + $hostName) }
  return '先自检 SSH：用 origin 里的真实主机名（ssh -T git@<host>）'
}

# ---------- 跨机路径根（0.3.30 起） ----------
# 两台机器的客户端装在哪、.dsh 在哪、工作区根在哪，通常都不一样。仓库里凡是这些根下面的
# 绝对路径一律存成占位符，落地时再展开成本机值：
#   {{APP_ROOT}}       客户端安装目录
#   {{DSH_HOME}}       ~\.dsh
#   {{WORKSPACE_HOME}} 工作区根
#   {{ROOT:<key>}}     用户自选目录（ComfyUI 模型目录、mihomo 之类），键值由用户在面板里确认一次
# 仓库里一律用正斜杠（{{APP_ROOT}}/xxx），JSON 里不会出现 \ 转义问题，PowerShell / Node 也都认。
function Get-SyncRootsPath([string]$DshHome) { return (Join-Path $DshHome 'config-sync-roots.json') }
function Get-PendingPathsPath([string]$DshHome) { return (Join-Path $DshHome 'config-sync-pending-paths.json') }

function ConvertTo-FwdPath([string]$p) {
  if (-not $p) { return '' }
  return $p.Replace('\', '/')
}

# 同一个路径在文本里可能出现成 4 种写法（原样 / JSON 双反斜杠 / 正斜杠 / JSON 转义斜杠）
function Get-PathVariants([string]$p) {
  if (-not $p) { return @() }
  $bs = [string][char]92
  $out = New-Object System.Collections.ArrayList
  [void]$out.Add($p)
  [void]$out.Add($p.Replace($bs, $bs + $bs))
  [void]$out.Add($p.Replace($bs, '/'))
  [void]$out.Add($p.Replace($bs, $bs + '/'))
  return @($out | Where-Object { $_ })
}

function Get-SyncRoots([string]$DshHome, [string]$AppRoot = '', [string]$WorkspaceHome = '') {
  $o = [ordered]@{
    version       = 1
    appRoot       = ''
    dshHome       = $DshHome
    workspaceHome = ''
    custom        = [ordered]@{}
    confirmed     = @()
    updatedAt     = ''
  }
  $f = Get-SyncRootsPath $DshHome
  if (Test-Path -LiteralPath $f) {
    try {
      $j = Get-Content -LiteralPath $f -Raw -Encoding utf8 | ConvertFrom-Json
      if ($j.appRoot) { $o.appRoot = [string]$j.appRoot }
      if ($j.dshHome) { $o.dshHome = [string]$j.dshHome }
      if ($j.workspaceHome) { $o.workspaceHome = [string]$j.workspaceHome }
      if ($j.custom) { foreach ($k in @($j.custom.PSObject.Properties.Name | Where-Object { $_ })) { $o.custom[$k] = [string]$j.custom.$k } }
      if ($j.confirmed) { $o.confirmed = @($j.confirmed) }
      $o.updatedAt = [string]$j.updatedAt
    } catch { }
  }
  # roots.json 是用户确认过的值，优先；没有才用本次探测/传参
  if (-not $o.appRoot -and $AppRoot) { $o.appRoot = $AppRoot }
  if (-not $o.workspaceHome -and $WorkspaceHome) { $o.workspaceHome = $WorkspaceHome }
  # 用户主目录也能自动探测，不用问人：有些配置把工作区建在 Documents\deepseek-harness 下，
  # 那个路径既不在安装目录也不在 .dsh / 工作区根里，不归一就会把老机器的用户名带过去。
  if (-not $o.custom.Contains('userHome')) { $o.custom['userHome'] = [string]$env:USERPROFILE }
  return [pscustomobject]$o
}

function Save-SyncRoots([string]$DshHome, $roots) {
  $roots.updatedAt = (Get-Date).ToString('s')
  $f = Get-SyncRootsPath $DshHome
  $j = [ordered]@{
    version       = 1
    appRoot       = [string]$roots.appRoot
    dshHome       = [string]$roots.dshHome
    workspaceHome = [string]$roots.workspaceHome
    custom        = $(if ($roots.custom) { $roots.custom } else { [ordered]@{} })
    confirmed     = @($roots.confirmed)
    updatedAt     = $roots.updatedAt
  }
  [IO.File]::WriteAllText($f, ($j | ConvertTo-Json -Depth 6), (New-Object Text.UTF8Encoding($false)))
  return $f
}

# 本机路径 → 占位符（capture 用）。长根先替换，避免根互相包含时替换错位。
function ConvertTo-TokenText([string]$text, $roots) {
  if (-not $text) { return $text }
  $items = New-Object System.Collections.ArrayList
  if ($roots.appRoot -and $roots.appRoot.Length -ge 3) { [void]$items.Add(@{ Token = '{{APP_ROOT}}'; Value = [string]$roots.appRoot }) }
  if ($roots.workspaceHome -and $roots.workspaceHome.Length -ge 5) { [void]$items.Add(@{ Token = '{{WORKSPACE_HOME}}'; Value = [string]$roots.workspaceHome }) }
  if ($roots.dshHome -and $roots.dshHome.Length -ge 5) { [void]$items.Add(@{ Token = '{{DSH_HOME}}'; Value = [string]$roots.dshHome }) }
  if ($roots.custom) {
    if ($roots.custom -is [System.Collections.IDictionary]) {
      # capture 传进来的 custom 是有序字典（键就是真实的 userHome 之类），不能走 PSObject.Properties
      foreach ($k in @($roots.custom.Keys)) {
        $v = [string]($roots.custom[$k])
        if ($k -and $v -and $v.Length -ge 3) { [void]$items.Add(@{ Token = ('{{ROOT:' + $k + '}}'); Value = $v }) }
      }
    } else {
      foreach ($k in @($roots.custom.PSObject.Properties.Name | Where-Object { $_ })) {
        $v = [string]($roots.custom.PSObject.Properties[$k].Value)
        if ($v -and $v.Length -ge 3) { [void]$items.Add(@{ Token = ('{{ROOT:' + $k + '}}'); Value = $v }) }
      }
    }
  }
  $sorted = @($items | Sort-Object { $_.Value.Length } -Descending)
  foreach ($r in $sorted) {
    foreach ($v in (Get-PathVariants $r.Value)) { $text = $text.Replace($v, $r.Token) }
  }
  # 占位符后面那一段路径的分隔符统一成正斜杠：{{APP_ROOT}}\x、{{APP_ROOT}}\\x\\y 都变成 {{APP_ROOT}}/x、/y。
  # 只动紧跟在占位符后面的那一段（到引号/逗号/空白为止），不碰 JSON 里别的字符串。
  $text = [regex]::Replace($text, '(\{\{(?:APP_ROOT|DSH_HOME|WORKSPACE_HOME|ROOT:[A-Za-z0-9_.\-]+)\}\})((?:\\\\|\\|/)[^"\s,;:}{\[\]]*)', { param($m) $m.Groups[1].Value + ($m.Groups[2].Value.Replace('\\', '/').Replace('\', '/')) })
  # 自选目录的占位符没配值时会原样留着，交给 apply 报 pending
  return $text
}

# 占位符 → 本机路径（apply 用）。值统一用正斜杠展开。
function Expand-TokenText([string]$text, $roots) {
  if (-not $text) { return $text }
  $text = $text.Replace('{{APP_ROOT}}', (ConvertTo-FwdPath ([string]$roots.appRoot)))
  $text = $text.Replace('{{WORKSPACE_HOME}}', (ConvertTo-FwdPath ([string]$roots.workspaceHome)))
  $text = $text.Replace('{{DSH_HOME}}', (ConvertTo-FwdPath ([string]$roots.dshHome)))
  if ($roots.custom) {
    if ($roots.custom -is [System.Collections.IDictionary]) {
      foreach ($k in @($roots.custom.Keys)) {
        $v = [string]($roots.custom[$k])
        if ($k -and $v) { $text = $text.Replace(('{{ROOT:' + $k + '}}'), (ConvertTo-FwdPath $v)) }
      }
    } else {
      foreach ($k in @($roots.custom.PSObject.Properties.Name | Where-Object { $_ })) {
        $v = [string]($roots.custom.PSObject.Properties[$k].Value)
        if ($v) { $text = $text.Replace(('{{ROOT:' + $k + '}}'), (ConvertTo-FwdPath $v)) }
      }
    }
  }
  return $text
}
# 文本里还剩哪些没展开的占位符（apply 用；返回去重后的 token 列表）
function Get-MissingTokens([string]$text) {
  if (-not $text) { return @() }
  $m = [regex]::Matches($text, '\{\{(APP_ROOT|DSH_HOME|WORKSPACE_HOME|ROOT:[A-Za-z0-9_.\-]+)\}\}')
  $set = @{}
  foreach ($x in $m) { $set[$x.Value] = $true }
  return @($set.Keys)
}

function Write-PendingPaths([string]$DshHome, $items) {
  $f = Get-PendingPathsPath $DshHome
  $j = [ordered]@{ generatedAt = (Get-Date).ToString('s'); missing = @($items) }
  [IO.File]::WriteAllText($f, ($j | ConvertTo-Json -Depth 6), (New-Object Text.UTF8Encoding($false)))
  return $f
}

function Clear-PendingPaths([string]$DshHome) {
  $f = Get-PendingPathsPath $DshHome
  if (Test-Path -LiteralPath $f) { Remove-Item -LiteralPath $f -Force -ErrorAction SilentlyContinue }
}

# 占位符给人看的中文说明（面板「路径确认」用，apply 记 pending 时也带上）
function Get-TokenHint([string]$token) {
  switch ($token) {
    '{{APP_ROOT}}' { return '客户端安装目录（DeepSeekHarness 所在的目录）' }
    '{{DSH_HOME}}' { return '.dsh 配置目录（一般是 %USERPROFILE%\.dsh）' }
    '{{WORKSPACE_HOME}}' { return '工作区根目录（工作区都建在这下面）' }
    default {
      $key = $token -replace '^\{\{ROOT:', ''
      $key = $key -replace '\}\}$', ''
      return ('自选目录：' + $key + ' —— 这台机器上对应的路径由你来定')
    }
  }
}