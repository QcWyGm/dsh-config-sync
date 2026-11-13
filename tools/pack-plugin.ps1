<#
打包 dsh-config-sync 插件 tgz（发布用，自包含：只读本仓库）

用法
  pwsh -File tools\pack-plugin.ps1                  # 打 releases\dsh-config-sync-<version>.tgz，并把 sha256 回填 version.json
  pwsh -File tools\pack-plugin.ps1 -NoManifest      # 只打包，不动 version.json
  pwsh -File tools\pack-plugin.ps1 -Output x.tgz    # 打到别处（不回填清单）

要点
  - 包内布局与 npm pack 一致：`package/` 前缀，内容按 package.json 的 files 字段收集，
    所以两种打包方式产出的条目相同（字节不同，谁打的就以谁的 sha256 为准）。
  - 用 %SystemRoot%\System32\tar.exe（Windows 自带），不依赖 npm / 7z / pnpm。
  - sha256 只在「输出落在 releases\、文件名与 version.json 里的 tgz 对得上」时才回填，
    避免把临时包的 hash 写进发布清单。
  - 发布顺序：改代码 → 本脚本打包 → 更新 market-index.json 的 version 与 commit → 推送。
#>
param(
  [string]$RepoRoot = (Split-Path -Parent $PSScriptRoot),
  [string]$Output,
  [switch]$NoManifest
)
$ErrorActionPreference = 'Stop'

$pkgFile = Join-Path $RepoRoot 'package.json'
if (-not (Test-Path -LiteralPath $pkgFile)) { throw "不是插件仓库根（缺 package.json）：$RepoRoot" }
$pkg = Get-Content -LiteralPath $pkgFile -Raw -Encoding utf8 | ConvertFrom-Json
$version = [string]$pkg.version
if (-not $Output) { $Output = Join-Path $RepoRoot ("releases\dsh-config-sync-{0}.tgz" -f $version) }
$outFull = [IO.Path]::GetFullPath($Output)
$outName = Split-Path -Leaf $outFull

$stage = Join-Path ([IO.Path]::GetTempPath()) ("pack-dsh-config-sync-" + [Guid]::NewGuid().ToString('N').Substring(0, 8))
$pkgDir = Join-Path $stage 'package'
New-Item -ItemType Directory -Path $pkgDir -Force | Out-Null
try {
  # files 字段是唯一口径：漏了 runtime\ 会静默打出体积偏小、装上也跑不起来的坏包
  $files = @($pkg.files)
  if ($files.Count -eq 0) { $files = @('index.js', 'client.js', 'package.json', 'cordis.patch.yml', 'README.md', 'README.en.md', 'LICENSE', 'runtime', 'tools') }
  foreach ($item in $files) {
    $from = Join-Path $RepoRoot $item
    if (Test-Path -LiteralPath $from) { Copy-Item -LiteralPath $from -Destination (Join-Path $pkgDir $item) -Recurse }
  }
  # package.json 必须带进包（npm 装包靠它认入口）
  Copy-Item -LiteralPath $pkgFile -Destination (Join-Path $pkgDir 'package.json') -Force

  $parent = Split-Path -Parent $outFull
  if (-not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
  if (Test-Path -LiteralPath $outFull) { Remove-Item -LiteralPath $outFull -Force }
  $tar = Join-Path $env:SystemRoot 'System32\tar.exe'
  & $tar -czf $outFull -C $stage package
  if ($LASTEXITCODE -ne 0) { throw "tar 打包失败，退出码 $LASTEXITCODE" }

  $size = (Get-Item -LiteralPath $outFull).Length
  $sha = (Get-FileHash -LiteralPath $outFull -Algorithm SHA256).Hash.ToLower()
  $count = (& $tar -tzf $outFull | Measure-Object).Count
  "已打包：$outFull（$size 字节，$count 个条目，版本 $version）"
  "sha256：$sha"

  if (-not $NoManifest) {
    $manFile = Join-Path $RepoRoot 'version.json'
    if (Test-Path -LiteralPath $manFile) {
      $man = Get-Content -LiteralPath $manFile -Raw -Encoding utf8 | ConvertFrom-Json
      $wantTgz = [string]$man.tgz
      $wantName = Split-Path -Leaf ($wantTgz -replace '/', '\')
      if ($wantName -and $wantName -eq $outName) {
        $raw = Get-Content -LiteralPath $manFile -Raw -Encoding utf8
        if ($raw -match '"sha256"\s*:\s*"[^"]*"') {
          $new = [regex]::Replace($raw, '"sha256"\s*:\s*"[^"]*"', ('"sha256":"' + $sha + '"'), 1)
          [IO.File]::WriteAllText($manFile, $new, (New-Object Text.UTF8Encoding($false)))
          "已回填 version.json 的 sha256（$outName）"
        } else { "version.json 里没有 sha256 字段，未回填" }
      } else {
        "version.json 里的 tgz 是「$wantTgz」，与本次输出「$outName」不一致，未回填"
      }
    }
  }
} finally {
  Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
}
