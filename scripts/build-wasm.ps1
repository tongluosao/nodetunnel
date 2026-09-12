<#
.SYNOPSIS
    编译 EasyTier WASM 核心。

.DESCRIPTION
    从只读参考目录「其他项目代码/EasyTier」编译 easytier-core 的 WASM 产物。

    重要：参考目录是只读的。Cargo 默认会在工作区下创建 target/ 目录，
    因此本脚本通过 CARGO_TARGET_DIR 把全部中间产物重定向到
    <本仓库>/.wasm-build/target，参考目录不会产生任何新文件。

.PARAMETER Profile
    browser 或 cloudflare。

.PARAMETER Output
    输出 wasm 的路径（相对于本仓库根）。

.EXAMPLE
    pwsh -File scripts/build-wasm.ps1 -Profile cloudflare -Output apps/worker/wasm/easytier_core.wasm
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('browser', 'cloudflare')]
    [string]$Profile,

    [Parameter(Mandatory = $true)]
    [string]$Output
)

$ErrorActionPreference = 'Stop'

<#
.SYNOPSIS
    查找 clang 所在目录。

.DESCRIPTION
    部分依赖（如 ring）在 wasm32-wasip1 目标下需要用 clang 编译 C/汇编代码。
    cc-rs 只从 PATH 查找 clang，因此这里返回其目录供调用方注入 PATH。

    查找顺序：PATH 中已有 -> Visual Studio 自带 LLVM -> 官方 LLVM 安装目录。
#>
function find-clang {
    $existing = Get-Command clang -ErrorAction SilentlyContinue
    if ($existing) {
        return Split-Path -Parent $existing.Source
    }

    $candidates = @(
        'G:\visual studio\VC\Tools\Llvm\x64\bin',
        'C:\Program Files\LLVM\bin',
        'C:\Program Files (x86)\LLVM\bin'
    )
    foreach ($candidate in $candidates) {
        if (Test-Path (Join-Path $candidate 'clang.exe')) {
            return $candidate
        }
    }

    return $null
}

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$upstreamRoot = Join-Path $repositoryRoot '其他项目代码/EasyTier'
$buildTarget = Join-Path $repositoryRoot '.wasm-build/target'

if (-not (Test-Path $upstreamRoot)) {
    throw "未找到只读参考目录: $upstreamRoot"
}

# 确保 Rust 工具链在 PATH 中（rustup 默认安装位置）。
$cargoBin = Join-Path $env:USERPROFILE '.cargo/bin'
if (Test-Path $cargoBin) {
    $env:Path = "$cargoBin;$env:Path"
}

if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) {
    throw '未找到 cargo。请先安装 Rust 工具链：https://rustup.rs'
}

# 校验 wasm32-wasip1 目标已安装。
$targets = & rustup target list --installed 2>&1
if ($targets -notcontains 'wasm32-wasip1') {
    throw '缺少 wasm32-wasip1 目标，请运行: rustup target add wasm32-wasip1'
}

if ($Profile -eq 'browser') {
    $features = 'wasm-host-tunnel-outbound,aes-gcm,proxy-smoltcp-stack'
} else {
    $features = 'wasm-host-tunnel,aes-gcm'
}

# ---------------------------------------------------------------------------
# Windows 上的关键前置：MSVC 环境。
#
# 即使目标是 wasm32-wasip1，构建过程仍需先为「宿主」编译过程宏（proc-macro）
# 与 build script，这要求链接器能找到 kernel32.lib 等系统库。
# 若未加载 Visual Studio 环境，会出现：
#   LINK : fatal error LNK1181: 无法打开输入文件“kernel32.lib”
# 因此这里通过 vcvars64.bat 初始化环境后再调用 cargo。
# ---------------------------------------------------------------------------
$vcvars = $null
if ($IsWindows -or $env:OS -eq 'Windows_NT') {
    $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
    $vsRoot = $null
    if (Test-Path $vswhere) {
        $vsRoot = (& $vswhere -latest -products * `
            -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 `
            -property installationPath 2>$null | Select-Object -First 1)
    }
    $candidates = @()
    if ($vsRoot) { $candidates += (Join-Path $vsRoot 'VC/Auxiliary/Build/vcvars64.bat') }
    $candidates += 'G:\visual studio\VC\Auxiliary\Build\vcvars64.bat'
    $candidates += 'C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvars64.bat'
    $candidates += 'C:\Program Files\Microsoft Visual Studio\2022\Professional\VC\Auxiliary\Build\vcvars64.bat'
    $candidates += 'C:\Program Files\Microsoft Visual Studio\2022\Enterprise\VC\Auxiliary\Build\vcvars64.bat'
    $vcvars = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1

    if (-not $vcvars) {
        Write-Warning '未找到 vcvars64.bat，若链接失败请安装 Visual Studio C++ 生成工具。'
    }
}

Write-Host "[1/3] 编译 easytier-core ($Profile) ..."
Write-Host "     参考目录: $upstreamRoot"
Write-Host "     构建缓存: $buildTarget"
if ($vcvars) {
    Write-Host "     MSVC 环境: $vcvars"
}

$env:CARGO_TARGET_DIR = $buildTarget
$env:CARGO_PROFILE_RELEASE_OPT_LEVEL = 'z'

$cargoArgs = @(
    'build',
    '--manifest-path', (Join-Path $upstreamRoot 'Cargo.toml'),
    '-p', 'easytier-core',
    '--release',
    '--target', 'wasm32-wasip1',
    '--no-default-features',
    '--features', $features
)

if ($vcvars) {
    # 在 cmd 中先调用 vcvars64.bat 再执行 cargo，使子进程继承完整的环境变量。
    $quotedArgs = ($cargoArgs | ForEach-Object { '"' + $_ + '"' }) -join ' '
    #
    # 注意：部分 Visual Studio 安装的 vcvars64.bat 生成的 LIB 只包含 ucrt，
    # 缺少 Windows SDK 的 um 目录（kernel32.lib 等系统导入库所在处），
    # 会导致 LNK1181。这里显式补齐 SDK 的 um 与 ucrt 路径。
    $sdkRoot = 'C:\Program Files (x86)\Windows Kits\10'
    $sdkLibRoot = Join-Path $sdkRoot 'Lib'
    $sdkVersion = Get-ChildItem $sdkLibRoot -Directory -ErrorAction SilentlyContinue |
        Sort-Object Name -Descending |
        Select-Object -First 1 -ExpandProperty Name

    $extraLib = ''
    $extraInclude = ''
    if ($sdkVersion) {
        foreach ($candidate in @(
                (Join-Path $sdkLibRoot "$sdkVersion/um/x64"),
                (Join-Path $sdkLibRoot "$sdkVersion/ucrt/x64")
            )) {
            if (Test-Path $candidate) { $extraLib += $candidate + ';' }
        }

        $sdkIncludeRoot = Join-Path $sdkRoot 'Include'
        foreach ($candidate in @(
                (Join-Path $sdkIncludeRoot "$sdkVersion/ucrt"),
                (Join-Path $sdkIncludeRoot "$sdkVersion/shared"),
                (Join-Path $sdkIncludeRoot "$sdkVersion/um")
            )) {
            if (Test-Path $candidate) { $extraInclude += $candidate + ';' }
        }
    }

    $msvcLib = 'G:\visual studio\VC\Tools\MSVC\14.51.36231\lib\x64'
    if (Test-Path $msvcLib) {
        $extraLib += $msvcLib + ';'
    }

    # 通过一个临时的包装批处理文件调用，而不是拼 `cmd /c "a && b && c"`。
    #
    # 原因：在 `cmd /c "call vcvars.bat && set X=%X%;..."` 这种一行命令中，
    # %X% 会在 vcvars.bat 执行「之前」就被展开，导致 vcvars 设置的值被覆盖
    # （表现为 INCLUDE 被清空、找不到 vcruntime.h）。
    # 写进 .bat 文件后由 cmd 逐行解析，并开启延迟展开，即可正确追加。
    $wrapperPath = Join-Path $repositoryRoot '.wasm-build/build-cargo.cmd'
    $wrapperDirectory = Split-Path -Parent $wrapperPath
    if (-not (Test-Path $wrapperDirectory)) {
        New-Item -ItemType Directory -Path $wrapperDirectory -Force | Out-Null
    }

    $wrapperLines = @(
        '@echo off',
        'setlocal enabledelayedexpansion',
        "call `"$vcvars`" >nul 2>&1",
        'if errorlevel 1 (echo [错误] 无法初始化 Visual Studio 环境 & exit /b 1)'
    )

    # ring 等 crate 会用 cc-rs 把 C/汇编交叉编译到 wasm32-wasip1，这要求 clang。
    $clangDirectory = find-clang
    if ($clangDirectory) {
        $wrapperLines += "set `"PATH=$clangDirectory;!PATH!`""
        Write-Host "     clang: $clangDirectory"
    } else {
        Write-Warning '未找到 clang。ring 在 wasm32-wasip1 目标下需要它，构建可能失败。'
    }

    if ($extraLib -ne '') {
        $wrapperLines += "set `"LIB=$extraLib!LIB!`""
    }
    # INCLUDE 追加在后面：SDK 的 corecrt.h 需要 MSVC include 目录中的
    # vcruntime.h，MSVC 路径必须保持优先。
    if ($extraInclude -ne '') {
        $wrapperLines += "set `"INCLUDE=!INCLUDE!$extraInclude`""
    }

    # 注意：批处理文件必须以 UTF-8（含 BOM 或配合 chcp 65001）写出，
    # 否则中文路径「其他项目代码」会被按当前代码页错误解码成问号。
    # 这里同时改用仓库根目录下的相对路径，进一步规避编码风险。
    $relativeManifest = '其他项目代码\EasyTier\Cargo.toml'
    $cargoArgsRelative = @(
        'build',
        '--manifest-path', $relativeManifest,
        '-p', 'easytier-core',
        '--release',
        '--target', 'wasm32-wasip1',
        '--no-default-features',
        '--features', $features
    )
    $quotedArgs = ($cargoArgsRelative | ForEach-Object { '"' + $_ + '"' }) -join ' '

    $wrapperLines += "cd /d `"$repositoryRoot`""
    $wrapperLines += "cargo $quotedArgs"
    $wrapperLines += 'exit /b %ERRORLEVEL%'

    # 使用 UTF-8 编码 + chcp 65001，保证中文路径正确传递。
    $wrapperLines = @('@echo off', 'chcp 65001 >nul') + $wrapperLines[1..($wrapperLines.Length - 1)]
    Set-Content -Path $wrapperPath -Value $wrapperLines -Encoding utf8

    if ($extraLib -ne '') { Write-Host "     补充 LIB: $extraLib" }
    if ($extraInclude -ne '') { Write-Host "     追加 INCLUDE: $extraInclude" }

    & cmd.exe /c $wrapperPath
} else {
    & cargo @cargoArgs
}

if ($LASTEXITCODE -ne 0) {
    throw "cargo build 失败，退出码 $LASTEXITCODE"
}

$artifact = Join-Path $buildTarget 'wasm32-wasip1/release/easytier_core.wasm'
if (-not (Test-Path $artifact)) {
    throw "未找到编译产物: $artifact"
}

# wasm-opt 由 runtime 包的 devDependency `binaryen` 提供。
$wasmOpt = Join-Path $repositoryRoot 'packages/easytier-js/runtime/node_modules/.bin/wasm-opt.cmd'
if (-not (Test-Path $wasmOpt)) {
    $wasmOpt = Join-Path $repositoryRoot 'node_modules/.bin/wasm-opt.cmd'
}

$outputPath = Join-Path $repositoryRoot $Output
$outputDirectory = Split-Path -Parent $outputPath
if (-not (Test-Path $outputDirectory)) {
    New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
}

if (Test-Path $wasmOpt) {
    Write-Host '[2/3] 使用 wasm-opt 优化 ...'
    & $wasmOpt $artifact -Oz `
        --enable-bulk-memory `
        --enable-nontrapping-float-to-int `
        --strip-debug `
        --strip-producers `
        -o $outputPath
    if ($LASTEXITCODE -ne 0) {
        throw "wasm-opt 失败，退出码 $LASTEXITCODE"
    }
} else {
    Write-Host '[2/3] 未找到 wasm-opt，直接复制未优化产物 ...'
    Copy-Item $artifact $outputPath -Force
}

$size = (Get-Item $outputPath).Length
Write-Host "[3/3] 完成: $Output ($([Math]::Round($size / 1MB, 2)) MB)"
Write-Host "     参考目录未被写入（构建缓存位于 .wasm-build/）"
