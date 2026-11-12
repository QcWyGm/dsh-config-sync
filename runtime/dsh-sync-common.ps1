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
$SyncScopeGroups = @('profile', 'prompt', 'skills', 'presets', 'storages-record', 'settings', 'mnemon', 'local-plugins', 'workspace', 'conversations')

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

