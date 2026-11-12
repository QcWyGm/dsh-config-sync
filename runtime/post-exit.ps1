<#
退出后执行同步：等 DSH 完全退出，再跑 pull 或 push（插件在 DSH 进程里，自己等不了自己退出）

由插件在 DSH 运行期用 detached 方式拉起：
  powershell -NoProfile -ExecutionPolicy Bypass -File post-exit.ps1 -Mode pull|push -WatchPid <dsh pid> `
      -RepoRoot G:\dsh-config -DshHome C:\Users\xx\.dsh -AppRoot G:\DeepSeekHarness [-Restart]

要点
  - 只认 WatchPid：那个进程消失（DSH 真退出，含托盘）后才动手，避免在运行中的客户端上 apply。
  - pull 用 apply 落地配置，必须 DSH 不在；push 要抓配置同样必须退出。
  - pull 失败要**自动回滚**：仓库 reset 回拉取前的 HEAD，配置用这次 apply 之前刚建的快照
    （backups\config-<时间戳>）还原，然后照常重启，让客户端回到动手前的样子。
  - -Restart：pull / push 都支持 —— 动作做完（无论成败）把客户端重新拉起来。
    pull：成功=用新配置，失败=用回滚后的原配置；push：成功=回到刚推完的状态，失败=回到原状。
  - 不论成败都写 <DshHome>\auto-sync-result.json，客户端下次启动读它弹 5 秒提示。
  - 本脚本由插件以**可见窗口**启动：进度用 Write-Host 实时打到窗口，同时照旧写日志文件
    <DshHome>\logs\auto-sync-<时间戳>.log（窗口被关/没显示时也能查）。
#>
param(
  [Parameter(Mandatory = $true)][ValidateSet('pull', 'push', 'update')][string]$Mode,
  [int]$WatchPid = 0,
  # wait：隐藏进程，只等 DSH 退出，退出后换一个**可见窗口**跑 run
  # run ：真正执行同步（默认，直接调用时不用传）
  [ValidateSet('wait', 'run')][string]$Phase = 'run',
  [string]$RepoRoot,
  [string]$DshHome = $(Join-Path $env:USERPROFILE '.dsh'),
  [string]$AppRoot = '',
  [switch]$Restart,
  [int]$MaxWaitMinutes = 30,
  [string]$LogFile,
  # ---- 仅 -Mode update 用：插件自身更新 ----
  [string]$PluginDir = '',
  [string]$UpdateVersion = '',
  [string]$UpdateTgz = '',
  [string]$UpdateSha256 = '',
  # 仓库是私有库时必须带的只读令牌（Gitee 私人令牌）；留空就按匿名方式下载
  [string]$UpdateToken = ''
)

# ---------- Phase=wait：只等退出，然后换成可见窗口执行 ----------
# 为什么要分两段：窗口必须**在 DSH 退出之后**才出现。排队阶段就弹窗的话，
# 用户从开机到关窗口这段时间会一直挂着一个"等 DSH 退出"的黑窗，什么也干不了还挡着视线。
if ($Phase -eq 'wait') {
  $deadline = (Get-Date).AddMinutes($MaxWaitMinutes)
  $noWindowTicks = 0
  $waitLog = Join-Path $DshHome 'logs\auto-sync-wait.log'
  function WaitLog([string]$text) {
    try {
      $dir = Split-Path -Parent $waitLog
      if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
      Add-Content -LiteralPath $waitLog -Value ("[{0}] [{1}] {2}" -f (Get-Date -Format 'HH:mm:ss'), $Mode, $text) -Encoding utf8
    } catch { }
  }
  WaitLog ("等待开始（pid {0}）" -f $WatchPid)
  while ($true) {
    # 按**进程名**判断，而不是只看传进来的 pid：插件传的 pid 未必是「那个活着的客户端」——
    # 实测出现过 watchPid 对应的进程早就不在了、而客户端明明还在跑，等待态于是当场开工，
    # 在 DSH 运行期间拉取/推送（正是绝对不能发生的事）。
    $byName = @(Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue)
    $byPid = if ($WatchPid -gt 0) { Get-Process -Id $WatchPid -ErrorAction SilentlyContinue } else { $null }
    if ($byName.Count -eq 0 -and -not $byPid) { WaitLog 'DSH 已完全退出'; break }

    # 用户点了窗口右上角的关闭、前台窗口全没了，但进程赖着不走（实测 7 个进程全部 hwnd=0 还活着）。
    # 不能只看「曾经出现过窗口」——等待进程可能是在窗口关掉之后才起来的（实测就这么漏判了），
    # 改用批次年龄：这批客户端进程已经活了 60 秒以上、却一个可见窗口都没有 → 认定用户已关闭。
    $visible = @($byName | Where-Object { $_.MainWindowHandle -ne 0 })
    $newest = $byName | Sort-Object StartTime -Descending | Select-Object -First 1
    $ageSec = if ($newest -and $newest.StartTime) { ((Get-Date) - $newest.StartTime).TotalSeconds } else { 0 }
    if ($visible.Count -eq 0 -and $ageSec -gt 60) { $noWindowTicks++ } else { $noWindowTicks = 0 }
    if ($noWindowTicks -ge 8) {
      WaitLog '前台窗口已关闭且进程不退，强制结束残留进程'
      try { Stop-Process -Name 'DeepSeek Harness' -Force -ErrorAction SilentlyContinue } catch { }
      Start-Sleep -Seconds 3
      if (@(Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue).Count -eq 0) { WaitLog '已全部结束'; break }
      $noWindowTicks = 0
    }
    if ((Get-Date) -gt $deadline) { WaitLog '等待超时，放弃本次同步'; exit 2 }
    Start-Sleep -Seconds 2
  }
  # 进程刚退时文件句柄还没释放，留一点余量再交给可见实例
  Start-Sleep -Seconds 2
  $pwshExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  if (-not (Test-Path -LiteralPath $pwshExe)) { $pwshExe = 'powershell.exe' }
  $relay = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $PSCommandPath,
    '-Mode', $Mode, '-WatchPid', '0', '-Phase', 'run', '-DshHome', $DshHome)
  if ($RepoRoot) { $relay += @('-RepoRoot', $RepoRoot) }
  if ($AppRoot) { $relay += @('-AppRoot', $AppRoot) }
  if ($Restart) { $relay += '-Restart' }
  if ($PluginDir) { $relay += @('-PluginDir', $PluginDir) }
  if ($UpdateVersion) { $relay += @('-UpdateVersion', $UpdateVersion) }
  if ($UpdateTgz) { $relay += @('-UpdateTgz', $UpdateTgz) }
  if ($UpdateSha256) { $relay += @('-UpdateSha256', $UpdateSha256) }
  if ($UpdateToken) { $relay += @('-UpdateToken', $UpdateToken) }
  try { Start-Process -FilePath $pwshExe -ArgumentList $relay -WindowStyle Normal | Out-Null } catch { }
  exit 0
}

$ErrorActionPreference = 'Continue'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'

# 窗口是可见的：给它一个能看懂的标题，并把控制台编码设成 UTF-8（否则中文进度全是乱码）
try { $Host.UI.RawUI.WindowTitle = ('DSH 配置同步 · ' + $(if ($Mode -eq 'update') { '插件更新' } elseif ($Mode -eq 'pull') { '拉取' } else { '推送' })) } catch { }
try { [Console]::OutputEncoding = New-Object Text.UTF8Encoding $false; $OutputEncoding = [Console]::OutputEncoding } catch { }

if (-not $LogFile) {
  $logDir = Join-Path $DshHome 'logs'
  if (-not (Test-Path -LiteralPath $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
  $LogFile = Join-Path $logDir ("auto-sync-{0}-{1}.log" -f $Mode, $stamp)
}
function Log([string]$text) {
  $line = "[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss'), $text
  Add-Content -LiteralPath $LogFile -Value $line -Encoding utf8
  # 同步打到可见窗口；窗口不显示或已被关掉就静默跳过，绝不因为写屏失败中断同步
  try { Write-Host $line } catch { }
}

$ResultFile = Join-Path $DshHome 'auto-sync-result.json'
# 接管互斥锁：等待阶段记的是那个等候进程的 pid，这里换成真正干活的进程；
# 别的同步动作看到这把锁（且 pid 活着）就会排队等待/放弃，不会两个一起改配置。
try {
  [IO.File]::WriteAllText((Join-Path $DshHome 'auto-sync.lock'),
    ([ordered]@{ pid = $PID; mode = $Mode; at = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() } | ConvertTo-Json),
    (New-Object Text.UTF8Encoding $false))
} catch { }
# 结果文件给客户端下次启动读：ok/mode/at/code/message/restored/log
function Write-Result([bool]$ok, [int]$code, [string]$message, [bool]$restored) {
  $obj = [ordered]@{
    mode      = $Mode
    ok        = $ok
    at        = [long]([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())
    code      = $code
    message   = $message
    restored  = $restored
    log       = $LogFile
    appRoot   = $AppRoot
    restart   = [bool]$Restart
  }
  try {
    $dir = Split-Path -Parent $ResultFile
    if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    $json = $obj | ConvertTo-Json -Depth 4
    [IO.File]::WriteAllText($ResultFile, $json, (New-Object Text.UTF8Encoding $false))
    Log ("结果已写入：{0}" -f $ResultFile)
  } catch { Log ("写结果文件失败：{0}" -f $_.Exception.Message) }
}

function Finish([int]$code, [string]$note) {
  Log ("结束：{0}（退出码 {1}）" -f $note, $code)
  Log ("日志：{0}" -f $LogFile)
  # 放开互斥锁：只删自己写的那把（锁里 pid 不是本进程就别动，可能是后来者）
  try {
    $lockPath = Join-Path $DshHome 'auto-sync.lock'
    if (Test-Path -LiteralPath $lockPath) {
      $lock = Get-Content -LiteralPath $lockPath -Raw | ConvertFrom-Json
      if ([int]$lock.pid -eq $PID) { Remove-Item -LiteralPath $lockPath -Force }
    }
  } catch { }
  # 窗口跟着进程一起关，停 3 秒让用户看清成功/失败与日志路径
  try { Start-Sleep -Seconds 3 } catch { }
  exit $code
}

# git 位置探测的正主在 dsh-sync-common.ps1（Get-GitExe）。本脚本故意保留一份最小实现：
# 它的职责是「仓库/插件目录残了也要能等退出并重启」，不能反过来依赖仓库里的公共文件。
# 改位置表时两边一起改（这里只有兜底逻辑，不参与路径归一）。
if (-not (Get-Command Get-GitExe -ErrorAction SilentlyContinue)) {
  function Get-GitExe {
    foreach ($p in @("$env:ProgramFiles\Git\cmd\git.exe", "$env:LOCALAPPDATA\Programs\Git\cmd\git.exe", "${env:ProgramFiles(x86)}\Git\cmd\git.exe")) {
      if ($p -and (Test-Path -LiteralPath $p)) { return $p }
    }
    $c = Get-Command git.exe -ErrorAction SilentlyContinue
    if ($c) { return $c.Source }
    return $null
  }
}

Log ("开始：mode={0} watchPid={1}" -f $Mode, $WatchPid)
Log ("仓库：{0}" -f $RepoRoot)

# ---------- 等 DSH 退出（只在被直接调用、还带着 pid 时；正常链路由 Phase=wait 干这件事） ----------
if ($WatchPid -gt 0) {
  Log ("等 DSH 完全退出（pid {0}，最多 {1} 分钟）…关掉客户端窗口就行，同步会自动开始" -f $WatchPid, $MaxWaitMinutes)
  $deadline = (Get-Date).AddMinutes($MaxWaitMinutes)
  while ($true) {
    $p = Get-Process -Id $WatchPid -ErrorAction SilentlyContinue
    if (-not $p) { break }
    if ((Get-Date) -gt $deadline) {
      Log ("等待超时（{0} 分钟），DSH 仍在运行，放弃本次同步" -f $MaxWaitMinutes)
      Finish 2 '等待超时'
    }
    Start-Sleep -Seconds 2
  }
  Log 'DSH 已退出'
  # 进程刚退时文件句柄可能还没释放，留一点余量
  Start-Sleep -Seconds 3
}


# ---------- 自动重启：动作做完就把客户端拉起来（pull / push / update 共用） ----------

# 为什么不能直接用 Start-Process 拉客户端：
#   进度窗口是个控制台程序，从它里面 Start-Process 出来的客户端会跟着进那个控制台的作业；
#   用户点窗口的 × 关掉进度显示时，conhost 清理作业会把刚重启的客户端一起结束（实测复现：
#   结束探测窗口进程后，它用 Start-Process 起的子进程同时消失）。
#   而窗口自己跑完、进程正常退出时不做这次清理，所以"等它自己关"看起来是好的。
# 实测三种启动方式（visible 控制台 + notepad 做探针）：
#   Start-Process  → 关窗口后子进程被连坐
#   explorer 代启  → 子进程存活（Explorer 长期驻留，不在本窗口的作业里）
#   自建 DETACHED/BREAKAWAY 进程 → 进程起不活，不可用（所以没保留这条分支）
function Start-Detached([string]$exe) {
  $workDir = Split-Path -Parent $exe
  $explorer = Join-Path $env:SystemRoot 'explorer.exe'
  if (Test-Path -LiteralPath $explorer) {
    try {
      Start-Process -FilePath $explorer -ArgumentList ('"' + $exe + '"') | Out-Null
      return 'explorer'
    } catch { Log ("explorer 代启失败：{0}" -f $_.Exception.Message) }
  }
  # 兜底：原方式。会把客户端挂进本窗口的作业，手动关进度窗口时仍有被连坐的风险。
  try {
    Start-Process -FilePath $exe -WorkingDirectory $workDir | Out-Null
    return 'plain'
  } catch {
    Log ("启动命令失败：{0}" -f $_.Exception.Message)
    return $null
  }
}

function RestartClient {
  $exe = $null
  if ($AppRoot) { $candidate = Join-Path $AppRoot 'DeepSeek Harness.exe'; if (Test-Path -LiteralPath $candidate) { $exe = $candidate } }
  if (-not $exe) {
    try {
      $reg = Get-ItemProperty -LiteralPath 'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*' -ErrorAction SilentlyContinue |
        Where-Object { $_.DisplayName -match 'DeepSeek Harness' } | Select-Object -First 1
      if ($reg -and $reg.InstallLocation) {
        $candidate = Join-Path $reg.InstallLocation 'DeepSeek Harness.exe'
        if (Test-Path -LiteralPath $candidate) { $exe = $candidate }
      }
    } catch { }
  }
  if ($exe) {
    # 继承来的环境变量会让客户端「启动了但立刻退出、没有窗口」：
    #   ELECTRON_RUN_AS_NODE=1  → exe 以纯 node 模式跑，不建窗口，几秒后退出
    #   NODE_OPTIONS / NODE_PATH → 预加载或解析路径错乱
    # 这些变量是宿主主进程给「自己派生的子进程」用的，客户端本身不需要，启动前清干净。
    foreach ($name in @('ELECTRON_RUN_AS_NODE', 'ELECTRON_NO_ATTACH_CONSOLE', 'NODE_OPTIONS', 'NODE_PATH')) {
      $value = [Environment]::GetEnvironmentVariable($name)
      if ($value) {
        Log ("清掉继承的环境变量 {0}={1}" -f $name, $value)
        [Environment]::SetEnvironmentVariable($name, $null)
      }
    }
    Log ("启动环境：RUN_AS_NODE={0} NODE_OPTIONS={1} DSH_HOME={2}" -f $env:ELECTRON_RUN_AS_NODE, $env:NODE_OPTIONS, $env:DSH_HOME)

    # 为什么重试：Electron 刚退出时用户数据目录的锁还没释放干净，此时拉起的实例
    # 会启动后立刻静默退出（实测：push 完 19:24:29「已启动」，19:24:57 一查 0 进程；
    # 手动隔 11 秒再启就正常 6 进程）。所以启动后数一下进程，没活就等一会儿重试。
    $ok = $false
    for ($attempt = 1; $attempt -le 3; $attempt++) {
      Log ("重启客户端（第 {0} 次）：{1}" -f $attempt, $exe)
      $how = Start-Detached $exe
      if (-not $how) { continue }
      Log ("启动方式：{0}（不继承进度窗口的控制台与作业）" -f $how)
      Start-Sleep -Seconds 5
      $alive = @(Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue).Count
      if ($alive -gt 0) { Log ("已启动（当前 {0} 个进程）" -f $alive); $ok = $true; break }
      Log '启动后进程又退了（旧实例的锁可能还没释放），等 8 秒重试'
      Start-Sleep -Seconds 8
    }
    if (-not $ok) { Finish 4 '重启失败（试了 3 次都没起来）' }

    # 重启成功后再刷一次"上次同步时间"。apply/capture 刚写过的文件 mtime 落在这之前，
    # 客户端起来 8 秒的首检会把它们当成"本机有未推送的新内容"，立刻排一个空推送
    #（实测：拉取重启后 19:46:04 又排了一次 push）。把分水岭推到重启之后，首检就安静了。
    try {
      $stateFile = Join-Path $DshHome 'config-sync-state.json'
      $state = @{ lastSyncAt = (Get-Date).ToString('o'); mode = $Mode; repo = $RepoRoot }
      if (Test-Path -LiteralPath $stateFile) {
        $old = Get-Content -LiteralPath $stateFile -Raw | ConvertFrom-Json
        $state = [ordered]@{
          lastSyncAt = (Get-Date).ToString('o')
          mode       = $Mode
          repo       = $(if ($old.repo) { $old.repo } else { $RepoRoot })
          head       = $old.head
        }
      }
      [IO.File]::WriteAllText($stateFile, ($state | ConvertTo-Json -Depth 4), (New-Object Text.UTF8Encoding $false))
      Log '已刷新同步分水岭（重启后的首检不会误报待推送）'
    } catch { Log ("刷新同步分水岭失败：{0}" -f $_.Exception.Message) }
  } else {
    Log '找不到 DeepSeek Harness.exe，跳过自动重启'
  }
}

# ---------- 仅更新模式：下载插件包 → 校验 sha256 → 备份旧版 → 覆盖安装 → 重启 ----------
# 更新的是**插件自己**（<AppRoot>\dsh-config-sync-<ver>\），不是配置仓库：
# 所以不能走 sync.ps1，也不能先 apply（那会把旧插件部署回去）。
if ($Mode -eq 'update') {
  if (-not $PluginDir -or -not (Test-Path -LiteralPath $PluginDir)) { Finish 6 ('找不到插件目录：' + $PluginDir) }
  if (-not $UpdateTgz) { Finish 6 '更新清单里没有 tgz 下载地址' }

  $currentVersion = ''
  try { $currentVersion = (Get-Content -LiteralPath (Join-Path $PluginDir 'package.json') -Raw -Encoding utf8 | ConvertFrom-Json).version } catch { }
  Log ("插件目录：{0}（当前版本 {1}）" -f $PluginDir, $currentVersion)
  Log ("目标版本：{0}" -f $UpdateVersion)

  $tar = Join-Path $env:SystemRoot 'System32\tar.exe'
  if (-not (Test-Path -LiteralPath $tar)) { $tar = 'tar.exe' }

  $tmp = Join-Path $env:TEMP ("dsh-plugin-{0}-{1}.tgz" -f $UpdateVersion, $stamp)
  # 私有仓库：把 raw 链接换成 Gitee API 的 raw 端点并带 access_token（匿名 raw 会 403）
  $fetchUrl = $UpdateTgz
  if ($UpdateToken) {
    # raw 链接 → API raw 端点；分支不能留在路径里，要改成 ref 参数
    $m = [regex]::Match($UpdateTgz, '^https://gitee\.com/([^/]+)/([^/]+)/raw/([^/]+)/(.+)$')
    if ($m.Success) {
      $fetchUrl = ("https://gitee.com/api/v5/repos/{0}/{1}/raw/{2}?ref={3}" -f $m.Groups[1].Value, $m.Groups[2].Value, $m.Groups[4].Value, $m.Groups[3].Value)
    }
    $sep = if ($fetchUrl.Contains('?')) { '&' } else { '?' }
    $fetchUrl = "$fetchUrl${sep}access_token=$([uri]::EscapeDataString($UpdateToken))"
  }
  Log ("下载安装包：{0}{1}" -f $UpdateTgz, $(if ($UpdateToken) { '（私有仓库，带令牌）' } else { '' }))
  $downloadError = $null
  try {
    Invoke-WebRequest -Uri $fetchUrl -OutFile $tmp -UseBasicParsing -TimeoutSec 180
  } catch {
    $downloadError = $_.Exception.Message
  }
  if ($downloadError -or -not (Test-Path -LiteralPath $tmp)) {
    $msg = "插件更新失败：下载安装包失败（{0}）" -f $(if ($downloadError) { $downloadError } else { '文件没有落盘' })
    Log $msg
    Write-Result $false 7 $msg $false
    Finish 7 '更新失败：下载失败'
  }
  Log ("已下载 {0:N0} 字节：{1}" -f (Get-Item -LiteralPath $tmp).Length, $tmp)

  if ($UpdateSha256) {
    $hash = (Get-FileHash -LiteralPath $tmp -Algorithm SHA256).Hash.ToLower()
    Log ("sha256：{0}" -f $hash)
    if ($hash -ne $UpdateSha256.ToLower()) {
      Write-Result $false 7 '插件更新失败：安装包 sha256 校验不通过（可能没下载全或被改动）' $false
      Finish 7 '更新失败：sha256 不符'
    }
    Log 'sha256 校验通过'
  }

  $stage = Join-Path $env:TEMP ("dsh-plugin-stage-" + $stamp)
  $stageError = $null
  try {
    if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
    New-Item -ItemType Directory -Path $stage -Force | Out-Null
    & $tar -xzf $tmp -C $stage *>&1 | ForEach-Object { Log ([string]$_) }
    if ($LASTEXITCODE -ne 0) { throw ("解包失败，退出码 {0}" -f $LASTEXITCODE) }
    $payload = Join-Path $stage 'package'
    if (-not (Test-Path -LiteralPath $payload)) { throw '安装包结构不对（里面没有 package 目录）' }
    $newVersion = (Get-Content -LiteralPath (Join-Path $payload 'package.json') -Raw -Encoding utf8 | ConvertFrom-Json).version
    if ($UpdateVersion -and $newVersion -ne $UpdateVersion) { throw ("安装包里的版本是 {0}，与清单 {1} 不一致" -f $newVersion, $UpdateVersion) }
  } catch { $stageError = $_.Exception.Message }
  if ($stageError) {
    Log ("解包/校验失败：{0}" -f $stageError)
    Write-Result $false 7 ("插件更新失败：" + $stageError) $false
    Finish 7 '更新失败：安装包有问题'
  }

  # 装之前先整目录备份：写坏了能手动拷回去（不给自动回滚，是因为回滚本身也要覆盖安装）
  $backup = Join-Path (Join-Path $DshHome 'backups') ("plugin-{0}-{1}" -f $currentVersion, $stamp)
  try {
    New-Item -ItemType Directory -Path (Split-Path -Parent $backup) -Force | Out-Null
    Copy-Item -LiteralPath $PluginDir -Destination $backup -Recurse -Force
    Log ("旧版已备份：{0}" -f $backup)
  } catch { Log ("备份旧版失败（继续安装）：{0}" -f $_.Exception.Message) }

  Log '覆盖安装…'
  $installError = $null
  try {
    foreach ($it in @(Get-ChildItem -LiteralPath $payload -Force)) {
      Copy-Item -LiteralPath $it.FullName -Destination $PluginDir -Recurse -Force
    }
    $installed = (Get-Content -LiteralPath (Join-Path $PluginDir 'package.json') -Raw -Encoding utf8 | ConvertFrom-Json).version
    Log ("安装完成，插件目录现在指向版本 {0}" -f $installed)
  } catch { $installError = $_.Exception.Message }
  if ($installError) {
    Write-Result $false 7 ("插件更新失败：写入失败（" + $installError + "），旧版备份在 " + $backup) $false
    Finish 7 '更新失败：写入失败'
  }

  Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
  Write-Result $true 0 ("插件已更新到 " + $UpdateVersion + "（重启后生效）") $false
  if ($Restart) { RestartClient }
  Finish 0 ('完成（插件已更新到 ' + $UpdateVersion + '）')
}

# ---------- 找 sync.ps1（仓库优先，退回插件自带 runtime） ----------
$sync = $null
if ($RepoRoot) { $candidate = Join-Path $RepoRoot 'sync.ps1'; if (Test-Path -LiteralPath $candidate) { $sync = $candidate } }
if (-not $sync) {
  $candidate = Join-Path $PSScriptRoot 'sync.ps1'
  if (Test-Path -LiteralPath $candidate) { $sync = $candidate }
}
if (-not $sync) { Log '找不到 sync.ps1（仓库和插件 runtime 都没有），放弃'; Finish 3 '缺 sync.ps1' }
if (-not $RepoRoot) { $RepoRoot = Split-Path -Parent $sync }
Log ("执行体：{0}" -f $sync)

$syncArgs = @{
  Action = $Mode
  RepoRoot = $RepoRoot
  DshHome = $DshHome
  Force = $true
}
if ($AppRoot) { $syncArgs['AppRoot'] = $AppRoot }

# ---------- pull 前留一张底：HEAD + 备份快照清单 ----------
$git = Get-GitExe
$headBefore = ''
$backupRoot = Join-Path $DshHome 'backups'
$backupsBefore = @()
if ($Mode -eq 'pull') {
  if ($git) {
    $headBefore = (& $git -C $RepoRoot rev-parse HEAD 2>$null | Out-String).Trim()
    Log ("拉取前 HEAD：{0}" -f $headBefore)
  } else {
    Log '找不到 git.exe，失败时将无法回滚仓库（只能回滚配置）'
  }
  if (Test-Path -LiteralPath $backupRoot) {
    $backupsBefore = @(Get-ChildItem -LiteralPath $backupRoot -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -like 'config-*' } | Select-Object -ExpandProperty FullName)
  }
}

# ---------- 执行 ----------
& $sync @syncArgs *>&1 | ForEach-Object { Log ([string]$_) }
$code = $LASTEXITCODE
if ($null -eq $code) { $code = 0 }
Log ("sync.ps1 {0} 退出码：{1}" -f $Mode, $code)

$failed = ($code -ne 0)

# ---------- 失败自动回滚（仅 pull） ----------
$restored = $false
if ($failed -and $Mode -eq 'pull') {
  Log '拉取失败：开始自动回滚'
  # 1) 仓库回到拉取前的提交（pull 可能已经把仓库更新了，失败的是后面的 apply）
  if ($git -and $headBefore) {
    & $git -C $RepoRoot reset --hard $headBefore *>&1 | ForEach-Object { Log ([string]$_) }
    if ($LASTEXITCODE -eq 0) { Log ("仓库已回滚到 {0}" -f $headBefore) } else { Log ("仓库回滚失败（退出码 {0}），继续回滚配置" -f $LASTEXITCODE) }
  }
  # 2) 配置用「这次动作中新出现的快照」还原（apply 在写盘前必先建一份）
  $snapshot = $null
  if (Test-Path -LiteralPath $backupRoot) {
    $all = @(Get-ChildItem -LiteralPath $backupRoot -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -like 'config-*' } | Sort-Object Name -Descending)
    if ($all.Count -gt 0) {
      $newest = $all[0].FullName
      # 优先用「这次动作中新出现的」快照；没有新的（说明 apply 没走到建快照）就用最新那份，
      # 反正都是本次动作内唯一的候选，多一层数组长度判断是死代码，已删。
      $snapshot = $newest
      if ($backupsBefore -contains $newest) { Log '这次动作没新建快照，退回用最新一份已有快照' }
    }
  }
  if ($snapshot) {
    Log ("用快照还原配置：{0}" -f $snapshot)
    $restore = Join-Path $RepoRoot 'restore.ps1'
    if (-not (Test-Path -LiteralPath $restore)) { $restore = Join-Path $PSScriptRoot 'restore.ps1' }
    if (Test-Path -LiteralPath $restore) {
      $rargs = @{ RepoRoot = $RepoRoot; DshHome = $DshHome; BackupDir = $snapshot; Force = $true }
      if ($AppRoot) { $rargs['AppRoot'] = $AppRoot }
      & $restore @rargs *>&1 | ForEach-Object { Log ([string]$_) }
      if ($LASTEXITCODE -eq 0) { $restored = $true } else { Log ("还原失败（退出码 {0}），请手动处理" -f $LASTEXITCODE) }
      Log ("配置还原退出码：{0}" -f $LASTEXITCODE)
    } else {
      Log '找不到 restore.ps1，无法自动还原配置'
    }
  } else {
    Log '没有可用快照（apply 可能还没开始写盘），跳过配置还原'
  }
  if ($restored) { Log '已回滚到拉取前的状态' } else { Log '回滚不完整，请打开日志核对' }
}

# ---------- 写结果文件（客户端下次启动弹提示用） ----------
if ($Mode -eq 'pull') {
  if ($failed) {
    Write-Result $false $code ("拉取失败" + $(if ($restored) { '，已自动还原上一次的配置' } else { '，且未能完整还原' }) + '；详见日志') $restored
  } else {
    Write-Result $true 0 '云端配置已拉取到本机' $false
  }
} else {
  if ($failed) { Write-Result $false $code '推送失败（改动还在本地，下次再推）' $false }
  else { Write-Result $true 0 '本机改动已推送到云端' $false }
}

# 动作做完、结果已落盘，再把客户端拉起来（更新模式在上面自己调过 RestartClient 了）
if ($Restart) { RestartClient }

if ($failed) {
  # 文案按动作分开写（旧版一律写「pull 已尝试回滚」，push 失败时也这么报，误导排查）
  if ($Mode -eq 'pull') {
    if ($restored) { Finish 5 '同步失败：拉取失败，已回滚到同步前的配置' }
    else { Finish 5 '同步失败：拉取失败，回滚不完整，请打开日志核对' }
  } else {
    Finish 5 '同步失败：推送失败，改动仍在本地，下次启动可再推'
  }
}
Finish 0 ('完成' + $(if ($Mode -eq 'pull') { '（已拉取）' } else { '（已推送）' }))
