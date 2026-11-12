<#
  运行中把插件新版本装进插件目录（**不退出** DSH）。

  由宿主的 install-live 动作调用：
    powershell -NoProfile -ExecutionPolicy Bypass -File install-plugin.ps1 `
        -PluginDir <AppRoot>\dsh-config-sync-<ver> -Version 0.3.4 -Sha256 <hex> `
        -TgzUrls "https://cdn.jsdelivr.net/.../0.3.4.tgz|https://raw.githubusercontent.com/.../0.3.4.tgz" `
        -DshHome C:\Users\xx\.dsh

  要点
    - 下载地址是**候选列表**（| 分隔），按顺序试，哪个先成功就用哪个：国内直连 raw.githubusercontent.com
      经常不通，CDN 兜在前面才不至于"检查能过、下载过不去"。
    - 校验 sha256 → 解包 → 比对包里的 version 与清单一致，三步都过才动插件目录。
    - 动手前整目录备份到 <DshHome>\backups\plugin-<旧版本>-<时间戳>；覆盖失败就把它拷回去。
    - 不重启、不关 DSH：覆盖的是磁盘文件，进程里跑的还是旧代码，所以要提示"重启生效"。
    - 结果固定打一行 RESULT:{json} 给宿主解析（ok / version / backup / log / error）。
#>
param(
  [Parameter(Mandatory = $true)][string]$PluginDir,
  [string]$Version = '',
  [string]$Sha256 = '',
  # 候选下载地址，用 | 分隔
  [string]$TgzUrls = '',
  # 已经下好的本地包（有就不用下载）
  [string]$TgzFile = '',
  [string]$DshHome = $(Join-Path $env:USERPROFILE '.dsh'),
  [string]$LogFile = ''
)

$ErrorActionPreference = 'Continue'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'

if (-not $LogFile) {
  $logDir = Join-Path $DshHome 'logs'
  if (-not (Test-Path -LiteralPath $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
  $LogFile = Join-Path $logDir ("plugin-install-{0}.log" -f $stamp)
}
function Log([string]$text) {
  $line = "[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss'), $text
  try { Add-Content -LiteralPath $LogFile -Value $line -Encoding utf8 } catch { }
}

function EmitResult([bool]$ok, [string]$errorText, [string]$backupPath) {
  $obj = [ordered]@{
    ok      = $ok
    version = $Version
    backup  = $backupPath
    log     = $LogFile
    error   = $errorText
  }
  # 宿主只认这一行，别把它混进进度输出里
  Write-Output ("RESULT:" + ($obj | ConvertTo-Json -Compress -Depth 3))
  exit 0
}

# 失败时用备份把插件目录恢复成动手前的样子
function Restore-Backup([string]$backup, [string]$target) {
  if (-not $backup -or -not (Test-Path -LiteralPath $backup)) { return $false }
  try {
    foreach ($it in @(Get-ChildItem -LiteralPath $target -Force)) {
      Remove-Item -LiteralPath $it.FullName -Recurse -Force -ErrorAction SilentlyContinue
    }
    foreach ($it in @(Get-ChildItem -LiteralPath $backup -Force)) {
      Copy-Item -LiteralPath $it.FullName -Destination $target -Recurse -Force
    }
    return $true
  } catch {
    Log ("回滚失败：{0}" -f $_.Exception.Message)
    return $false
  }
}

Log ("==== 安装插件 {0} 到 {1} ====" -f $Version, $PluginDir)

if (-not (Test-Path -LiteralPath $PluginDir)) { EmitResult $false ("找不到插件目录：" + $PluginDir) '' }

$currentVersion = ''
try { $currentVersion = (Get-Content -LiteralPath (Join-Path $PluginDir 'package.json') -Raw -Encoding utf8 | ConvertFrom-Json).version } catch { }
Log ("当前版本：{0}" -f $currentVersion)

$tmp = Join-Path $env:TEMP ("dsh-plugin-live-{0}-{1}.tgz" -f $Version, $stamp)
$pkgPath = ''
if ($TgzFile -and (Test-Path -LiteralPath $TgzFile)) {
  $pkgPath = $TgzFile
  Log ("使用本地包：{0}" -f $pkgPath)
} else {
  $urls = @($TgzUrls -split '\|' | Where-Object { $_ -and $_.Trim() })
  if ($urls.Count -eq 0) { EmitResult $false '没有给下载地址，也没有本地包' '' }
  $errors = @()
  foreach ($u in $urls) {
    Log ("尝试下载：{0}" -f $u)
    try {
      Invoke-WebRequest -Uri $u.Trim() -OutFile $tmp -UseBasicParsing -TimeoutSec 90
      if ((Test-Path -LiteralPath $tmp) -and ((Get-Item -LiteralPath $tmp).Length -gt 0)) {
        $pkgPath = $tmp
        Log ("下载成功：{0:N0} 字节" -f (Get-Item -LiteralPath $tmp).Length)
        break
      }
      $errors += ("{0}：文件没有落盘" -f $u)
    } catch {
      $errors += ("{0}：{1}" -f $u, $_.Exception.Message)
      Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
    }
  }
  if (-not $pkgPath) {
    $msg = '下载安装包失败（每个地址都试过了）：' + ($errors -join '；')
    Log $msg
    EmitResult $false $msg ''
  }
}

if ($Sha256) {
  $hash = (Get-FileHash -LiteralPath $pkgPath -Algorithm SHA256).Hash.ToLower()
  Log ("sha256：{0}" -f $hash)
  if ($hash -ne $Sha256.ToLower()) {
    Log 'sha256 与清单不一致，放弃安装'
    Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
    EmitResult $false '安装包 sha256 校验不通过（没下载全或被改动）' ''
  }
  Log 'sha256 校验通过'
}

$tar = Join-Path $env:SystemRoot 'System32\tar.exe'
if (-not (Test-Path -LiteralPath $tar)) { $tar = 'tar.exe' }
$stage = Join-Path $env:TEMP ("dsh-plugin-live-stage-" + $stamp)
$payload = ''
try {
  if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
  New-Item -ItemType Directory -Path $stage -Force | Out-Null
  & $tar -xzf $pkgPath -C $stage *> $null
  if ($LASTEXITCODE -ne 0) { throw ("解包失败，退出码 {0}" -f $LASTEXITCODE) }
  $payload = Join-Path $stage 'package'
  if (-not (Test-Path -LiteralPath $payload)) { throw '安装包结构不对（里面没有 package 目录）' }
  $newVersion = (Get-Content -LiteralPath (Join-Path $payload 'package.json') -Raw -Encoding utf8 | ConvertFrom-Json).version
  Log ("包内版本：{0}" -f $newVersion)
  if ($Version -and $newVersion -ne $Version) { throw ("安装包里的版本是 {0}，与清单 {1} 不一致" -f $newVersion, $Version) }
} catch {
  Log ("解包/校验失败：{0}" -f $_.Exception.Message)
  if ($stage -and (Test-Path -LiteralPath $stage)) { Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue }
  Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
  EmitResult $false ('安装包有问题：' + $_.Exception.Message) ''
}

# 整目录备份：写坏了能手动拷回去，也能自动回滚
$backup = Join-Path (Join-Path $DshHome 'backups') ("plugin-{0}-{1}" -f $(if ($currentVersion) { $currentVersion } else { 'unknown' }), $stamp)
$backupOk = $false
try {
  New-Item -ItemType Directory -Path (Split-Path -Parent $backup) -Force | Out-Null
  Copy-Item -LiteralPath $PluginDir -Destination $backup -Recurse -Force
  $backupOk = $true
  Log ("旧版已备份：{0}" -f $backup)
} catch {
  Log ("备份失败（继续安装，出问题就没有自动回滚了）：{0}" -f $_.Exception.Message)
}

Log '覆盖安装…'
$installError = ''
try {
  foreach ($it in @(Get-ChildItem -LiteralPath $payload -Force)) {
    Copy-Item -LiteralPath $it.FullName -Destination $PluginDir -Recurse -Force
  }
  $installed = (Get-Content -LiteralPath (Join-Path $PluginDir 'package.json') -Raw -Encoding utf8 | ConvertFrom-Json).version
  Log ("安装完成，插件目录现在指向版本 {0}" -f $installed)
} catch {
  $installError = $_.Exception.Message
}

if ($installError) {
  $restored = Restore-Backup $(if ($backupOk) { $backup } else { '' }) $PluginDir
  $note = if ($restored) { '已用备份回滚到安装前的状态' } else { '没能自动回滚，手动把 ' + $backup + ' 拷回去' }
  Log ("写入失败：{0}（{1}）" -f $installError, $note)
  if ($stage -and (Test-Path -LiteralPath $stage)) { Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue }
  Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
  EmitResult $false ("写入失败：" + $installError + '（' + $note + '）') $(if ($backupOk) { $backup } else { '' })
}

if ($stage -and (Test-Path -LiteralPath $stage)) { Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue }
Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
EmitResult $true '' $(if ($backupOk) { $backup } else { '' })
