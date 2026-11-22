@echo off
setlocal DisableDelayedExpansion
set "ps=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if exist "%SystemRoot%\Sysnative\WindowsPowerShell\v1.0\powershell.exe" set "ps=%SystemRoot%\Sysnative\WindowsPowerShell\v1.0\powershell.exe"
"%ps%" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0restore-7.1.15.ps1"
set "rc=%errorlevel%"
if not "%rc%"=="0" if not defined CI pause
exit /b %rc%
