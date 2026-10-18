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

    $devScript = if ($clientListening) { 'dev:server' } elseif ($serverReady) { 'dev:client' } else { 'dev' }
    Write-Host "正在启动缺失的服务：pnpm $devScript"
    New-Item $logDirectory -ItemType Directory -Force | Out-Null
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
    $stdoutLog = Join-Path $logDirectory "$stamp.out.log"
    $stderrLog = Join-Path $logDirectory "$stamp.err.log"
    Write-Host "启动日志：$stdoutLog"
    # 批处理由 cmd 执行；路径来自本机命令发现，单独加引号以兼容空格。
    $commandLine = '/d /s /c ""{0}" {1}"' -f $pnpm.Source, $devScript
    $started = Start-Process -FilePath $env:ComSpec -ArgumentList $commandLine -WorkingDirectory $projectRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog
    $deadline = [DateTime]::UtcNow.AddSeconds(120)
    do {
        if ($started.HasExited) { throw "启动进程已退出，退出码：$($started.ExitCode)。" }
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
    while (-not $started.HasExited) {
        Start-Sleep -Seconds 5
        if ((Test-Health 5175) -and (Test-Health 5173)) {
            $failedChecks = 0
        } else {
            $failedChecks++
            if ($failedChecks -ge 6) { throw '服务健康检查持续失败，请查看启动日志；重新运行 BAT 可重试。' }
        }
    }
    throw "服务进程已退出，退出码：$($started.ExitCode)。请查看启动日志。"
} catch {
    Write-Host "启动失败：$($_.Exception.Message)" -ForegroundColor Red
    if ($stderrLog) { Write-Host "错误日志：$stderrLog" }
    if ($stdoutLog) { Write-Host "输出日志：$stdoutLog" }
    exit 1
} finally {
    if ($started -and -not $started.HasExited) {
        # 只清理本次创建的进程树，保留启动前已经运行的服务。
        & taskkill.exe /PID $started.Id /T /F 2>$null | Out-Null
    }
}
