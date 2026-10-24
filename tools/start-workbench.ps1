param([switch]$NoBrowser)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$url = 'http://127.0.0.1:5173'
$started = $null
$logDirectory = Join-Path $projectRoot 'server/data/launcher'

function Test-Health([int]$Port) {
    try {
        $response = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/health" -TimeoutSec 2
        return $response.ok -eq $true
    } catch { return $false }
}

function Test-Listening([int]$Port) {
    $socket = [System.Net.Sockets.TcpClient]::new()
    try {
        return $socket.ConnectAsync('127.0.0.1', $Port).Wait(400) -and $socket.Connected
    } catch { return $false }
    finally { $socket.Dispose() }
}

# 失败时先把日志尾部打出来再清理进程：直接 taskkill 会让重定向缓冲来不及刷盘，
# 日志只剩启动头几行，真正的错误（2026-10-24 的桌宠挂载卡死、better-sqlite3 ABI 崩溃）
# 全被吞掉，用户只能看到一句“等待前后端就绪超时”。
function Show-LogTail([string]$Path, [string]$Title, [int]$Lines = 25) {
    if (-not $Path -or -not (Test-Path -LiteralPath $Path)) { return }
    Write-Host "----- $Title（末 $Lines 行）-----"
    try {
        Get-Content -LiteralPath $Path -Tail $Lines -Encoding utf8 -ErrorAction Stop | ForEach-Object { Write-Host $_ }
    } catch {
        Write-Host "（日志读取失败：$($_.Exception.Message)）"
    }
    Write-Host '----- 日志结束 -----'
}

try {
    Set-Location -LiteralPath $projectRoot
    $serverReady = Test-Health 5175
    $clientReady = $serverReady -and (Test-Health 5173)
    if ($clientReady) {
        Write-Host '前后端均已就绪。'
        if (-not $NoBrowser) { Start-Process $url }
        exit 0
    }

    $clientListening = Test-Listening 5173
    if (-not $serverReady -and (Test-Listening 5175)) {
        throw '5175 端口已占用，但后端健康检查失败。请检查已有服务，启动器不会关闭未知进程。'
    }
    if ($serverReady -and $clientListening) {
        throw '5173 端口已占用，但前端代理健康检查失败。请检查原前端窗口。'
    }

    $node = Get-Command node -CommandType Application -ErrorAction Stop | Select-Object -First 1
    $nodeVersion = & $node.Source --version
    if ($LASTEXITCODE -ne 0 -or $nodeVersion -notmatch '^v26\.') {
        throw "需要 Node.js 26，当前为 $nodeVersion，路径：$($node.Source)"
    }
    $pnpm = Get-Command pnpm.cmd -CommandType Application -ErrorAction Stop | Select-Object -First 1
    $pnpmVersion = & $pnpm.Source --version
    if ($LASTEXITCODE -ne 0 -or $pnpmVersion -notmatch '^11\.') {
        throw "需要 pnpm 11，当前为 $pnpmVersion。"
    }
    # 把校验过的这个 Node 26 目录前置到子进程 PATH：pnpm 拉起 .bin shim 时按 PATH 找 node，
    # 若机器上还有别的 Node（如 22）排在前面，better-sqlite3 会因 ABI 不匹配当场崩溃。
    $nodeDir = Split-Path -Path $node.Source -Parent
    if ($nodeDir) { $env:PATH = "$nodeDir;$env:PATH" }
    if (-not (Test-Path 'node_modules/concurrently')) {
        & $pnpm.Source install --frozen-lockfile
        if ($LASTEXITCODE -ne 0) { throw '依赖安装失败，请检查上方输出。' }
    }
    if (-not (Test-Path 'client/public/vditor/dist')) {
        if (-not (Test-Path 'client/node_modules/vditor/dist')) {
            throw '缺少 Vditor 资源，请先运行 pnpm install。'
        }
        New-Item 'client/public/vditor' -ItemType Directory -Force | Out-Null
        Copy-Item 'client/node_modules/vditor/dist' 'client/public/vditor/dist' -Recurse
    }

    # 2026-10-24：不再用 `pnpm dev`（concurrently），也不再经由 pnpm/.bin shim 间接启动。
    # 1) concurrently 会让后端进程在动态 import 桌宠运行时（vendor/dsh-pet/lib/workbench-host.mjs）
    #    时同步死锁：CPU 不涨、定时器不跑、日志停在 import 前一行，5175 永不监听。
    # 2) .bin shim 靠 PATH 找 node，机器上若有别的 Node（如 22）排在前面，better-sqlite3 会因
    #    ABI 不匹配（147 vs 127）当场崩溃。
    # 因此这里用**校验过的 node.exe 绝对路径**直接跑 tsx / vite，前后端各自一份日志，
    # 清理时也只清理本次创建的进程。
    $tsxCli = Join-Path $projectRoot 'server/node_modules/tsx/dist/cli.mjs'
    $viteBin = Join-Path $projectRoot 'client/node_modules/vite/bin/vite.js'
    if (-not (Test-Path -LiteralPath $tsxCli)) { throw '缺少 tsx，请先运行 pnpm install。' }
    if (-not (Test-Path -LiteralPath $viteBin)) { throw '缺少 vite，请先运行 pnpm install。' }

    Write-Host '正在准备桌宠运行时…'
    & $node.Source 'tools/setup-pet.mjs'
    if ($LASTEXITCODE -ne 0) { throw '桌宠运行时准备失败，请检查上方输出。' }

    New-Item $logDirectory -ItemType Directory -Force | Out-Null
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
    $logFiles = @()
    $processes = @()
    $launch = {
        param([string]$Name, [string]$WorkDir, $Arguments)
        $stdoutLog = Join-Path $logDirectory "$stamp-$Name.out.log"
        $stderrLog = Join-Path $logDirectory "$stamp-$Name.err.log"
        $quoted = @($Arguments | ForEach-Object { '"{0}"' -f $_ })
        $proc = Start-Process -FilePath $node.Source -ArgumentList $quoted -WorkingDirectory $WorkDir -WindowStyle Hidden -PassThru -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog
        [pscustomobject]@{ Name = $Name; Process = $proc; Stdout = $stdoutLog; Stderr = $stderrLog }
    }
    if (-not $serverReady) {
        $processes += & $launch -Name 'server' -WorkDir (Join-Path $projectRoot 'server') -Arguments @($tsxCli, 'watch', 'src/index.ts')
    }
    if (-not $clientReady) {
        $processes += & $launch -Name 'client' -WorkDir (Join-Path $projectRoot 'client') -Arguments @($viteBin)
    }
    foreach ($item in $processes) {
        $logFiles += $item.Stdout
        $logFiles += $item.Stderr
        Write-Host "已启动 $($item.Name)：$($item.Stdout)"
    }

    $deadline = [DateTime]::UtcNow.AddSeconds(120)
    do {
        foreach ($item in $processes) {
            if ($item.Process.HasExited) { throw "$($item.Name) 进程已退出，退出码：$($item.Process.ExitCode)。" }
        }
        $serverReady = Test-Health 5175
        $clientReady = $serverReady -and (Test-Health 5173)
        if ($clientReady) { break }
        if ([DateTime]::UtcNow -gt $deadline) { throw '等待前后端就绪超时，请查看启动日志。' }
        Start-Sleep -Milliseconds 500
    } while ($true)

    Write-Host "前后端均已就绪：$url"
    if (-not $NoBrowser) { Start-Process $url }
    Write-Host '请保留此窗口；按 Ctrl+C 停止本次启动的服务。'
    $failedChecks = 0
    while ($true) {
        Start-Sleep -Seconds 5
        foreach ($item in $processes) {
            if ($item.Process.HasExited) { throw "$($item.Name) 进程已退出，退出码：$($item.Process.ExitCode)。请查看启动日志。" }
        }
        if ((Test-Health 5175) -and (Test-Health 5173)) {
            $failedChecks = 0
        } else {
            $failedChecks++
            if ($failedChecks -ge 6) { throw '服务健康检查持续失败，请查看启动日志；重新运行 BAT 可重试。' }
        }
    }
} catch {
    Write-Host "启动失败：$($_.Exception.Message)" -ForegroundColor Red
    foreach ($path in $logFiles) {
        if ($path) { Show-LogTail $path (Split-Path -Path $path -Leaf) }
    }
    exit 1
} finally {
    foreach ($item in $processes) {
        if ($item.Process -and -not $item.Process.HasExited) {
            # 只清理本次创建的进程树，保留启动前已经运行的服务。
            & taskkill.exe /PID $item.Process.Id /T /F 2>$null | Out-Null
        }
    }
}
