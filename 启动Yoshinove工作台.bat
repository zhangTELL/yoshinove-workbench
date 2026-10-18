@echo off
setlocal
chcp 65001 >nul 2>&1
title Yoshinove 工作台 - 开发服务
where pwsh >nul 2>&1
if errorlevel 1 (
    echo [X] 未检测到 PowerShell 7，请安装后重试。
    pause
    exit /b 1
)
pwsh -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\start-workbench.ps1" %*
set "RESULT=%ERRORLEVEL%"
if not "%RESULT%"=="0" pause
exit /b %RESULT%
