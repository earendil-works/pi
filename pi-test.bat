@echo off
setlocal

set "SCRIPT_DIR=%~dp0"
set "POWERSHELL_EXE=powershell.exe"

where %POWERSHELL_EXE% >nul 2>nul
if errorlevel 1 (
	>&2 echo powershell.exe not found. Install PowerShell or run pi-test.ps1 directly.
	exit /b 1
)

%POWERSHELL_EXE% -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%pi-test.ps1" %*
exit /b %ERRORLEVEL%
