function Get-WorkbenchPorts {
    $webValue = if ($env:WORKBENCH_WEB_PORT) { $env:WORKBENCH_WEB_PORT } elseif ($env:WORKBENCH_HTTP_PORT) { $env:WORKBENCH_HTTP_PORT } else { '5173' }
    $apiValue = if ($env:PORT) { $env:PORT } else { '5175' }
    $webPort = 0
    $apiPort = 0
    if (-not [int]::TryParse($webValue, [ref]$webPort) -or $webPort -lt 1 -or $webPort -gt 65535 -or
        -not [int]::TryParse($apiValue, [ref]$apiPort) -or $apiPort -lt 1 -or $apiPort -gt 65535 -or $apiPort -eq $webPort) {
        throw '网页和后端端口必须是不同的 1 到 65535 之间的整数。'
    }
    [pscustomobject]@{ Web = $webPort; Api = $apiPort }
}

function Test-WorkbenchProcessCommand {
    param([string]$Name, [string]$CommandLine, [string]$ProjectRoot)
    if (-not $CommandLine) { return $false }
    $normalized = $CommandLine.Replace('\', '/')
    $rootPath = $ProjectRoot.Replace('\', '/').TrimEnd('/')
    if ($Name -in @('node.exe', 'electron.exe')) {
        return $normalized.IndexOf($rootPath + '/', [System.StringComparison]::OrdinalIgnoreCase) -ge 0
    }
    if ($Name -in @('pwsh.exe', 'powershell.exe', 'cmd.exe')) {
        $launcherPattern = [regex]::Escape($rootPath + '/tools/start-workbench.ps1') + '(?=[\s"'']|$)'
        return [regex]::IsMatch($normalized, $launcherPattern, [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
    }
    return $false
}
