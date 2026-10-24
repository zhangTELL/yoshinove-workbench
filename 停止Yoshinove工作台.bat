@echo off
setlocal
chcp 65001 >nul 2>&1
title Yoshinove Workbench - Stop Services
where pwsh >nul 2>&1
if errorlevel 1 (
    echo [X] PowerShell 7 not found. Install PowerShell 7 and retry.
    pause
    exit /b 1
)
pwsh -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\stop-workbench.ps1" %*
set "RESULT=%ERRORLEVEL%"
pause
exit /b %RESULT%
