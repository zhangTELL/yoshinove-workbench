param([switch]$Quiet)

# 停止由 `启动Yoshinove工作台.bat` 拉起的开发服务（前端 vite、后端 tsx watch 及其应用子进程、
# 以及桌宠 electron helper）。识别方式是进程命令行里含本仓库路径，因此只会动属于本项目的进程，
# 不会误杀机器上其他 node。
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$ports = 5173, 5175

function Get-WorkbenchProcess {
    Get-CimInstance Win32_Process | Where-Object {
        $commandLine = $_.CommandLine
        $_.ProcessId -ne $PID -and $commandLine -and (
            ($_.Name -in @('node.exe', 'electron.exe') -and $commandLine.IndexOf($projectRoot, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) -or
            ($_.Name -in @('pwsh.exe', 'powershell.exe', 'cmd.exe') -and $commandLine -like '*start-workbench.ps1*')
        )
    }
}

function Get-BusyPort {
    Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
        Where-Object { $_.LocalPort -in $ports } |
        ForEach-Object {
            $owner = Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue
            [pscustomobject]@{
                Port = $_.LocalPort
                ProcessId = $_.OwningProcess
                Name = if ($owner) { $owner.ProcessName } else { '已退出' }
            }
        }
}

function Stop-ProcessTree([int]$ProcessId) {
    & taskkill.exe /PID $ProcessId /T /F 2>$null | Out-Null
}

$killed = 0
foreach ($pass in 1..2) {
    $targets = @(Get-WorkbenchProcess)
    if (-not $targets.Count) { break }
    # 先结束启动器窗口（它自己也会清理子进程），再结束剩余的 node。
    $ordered = @($targets | Where-Object { $_.Name -in @('pwsh.exe', 'powershell.exe', 'cmd.exe') }) +
               @($targets | Where-Object { $_.Name -in @('node.exe', 'electron.exe') })
    foreach ($item in $ordered) {
        if ($item.ProcessId -eq $PID) { continue }
        if (-not $Quiet) { Write-Host ("结束 {0}（PID {1}）" -f $item.Name, $item.ProcessId) }
        Stop-ProcessTree $item.ProcessId
        $killed++
    }
    Start-Sleep -Milliseconds 600
}

$deadline = (Get-Date).AddSeconds(10)
do {
    $busy = @(Get-BusyPort)
    if (-not $busy.Count) { break }
    Start-Sleep -Milliseconds 300
} while ((Get-Date) -lt $deadline)

if (-not $killed) {
    Write-Host '没有发现本启动器拉起的进程。' -ForegroundColor Yellow
}

$busy = @(Get-BusyPort)
if (-not $busy.Count) {
    Write-Host "服务已停止，端口 $($ports -join ' / ') 均已释放。" -ForegroundColor Green
    exit 0
}

Write-Host '以下端口仍被占用，且占用者不是本次识别的进程，未强行结束：' -ForegroundColor Yellow
$busy | ForEach-Object { Write-Host ("  {0} -> PID {1}（{2}）" -f $_.Port, $_.ProcessId, $_.Name) }
Write-Host '如需强制结束，请先确认该进程用途再手动处理。'
exit 2
