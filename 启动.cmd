@echo off
rem ============================================================
rem  Fund Workbench launcher
rem  This file is intentionally ASCII-only to avoid codepage
rem  corruption on Chinese Windows consoles (GBK / cp936).
rem  Chinese output is produced by server.js under chcp 65001.
rem ============================================================

rem Set working directory BEFORE switching codepage, so that the
rem non-ASCII folder name expands correctly under the native codepage.
cd /d "%~dp0"

rem Switch console to UTF-8 so Node's Chinese log renders correctly.
chcp 65001 >nul 2>nul

title Fund Workbench

set "NODE_EXE="

rem 1) Prefer node already on PATH
where node >nul 2>nul
if not errorlevel 1 set "NODE_EXE=node"

rem 2) Fall back to common install locations
if not defined NODE_EXE if exist "C:\Program Files\nodejs\node.exe" set "NODE_EXE=C:\Program Files\nodejs\node.exe"
if not defined NODE_EXE if exist "C:\Program Files (x86)\nodejs\node.exe" set "NODE_EXE=C:\Program Files (x86)\nodejs\node.exe"
if not defined NODE_EXE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE_EXE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if not defined NODE_EXE if exist "%APPDATA%\npm\node.exe" set "NODE_EXE=%APPDATA%\npm\node.exe"
if not defined NODE_EXE if exist "%USERPROFILE%\.workbuddy\binaries\node\versions\22.22.2-3\node.exe" set "NODE_EXE=%USERPROFILE%\.workbuddy\binaries\node\versions\22.22.2-3\node.exe"

if not defined NODE_EXE goto NO_NODE

echo.
echo   ============================================
echo     Fund Workbench  -  local server starting
echo   ============================================
echo.

"%NODE_EXE%" server.js

echo.
echo   Server has stopped.
echo.
pause
exit /b 0

:NO_NODE
echo.
echo   [ERROR] Node.js was not found on this computer.
echo.
echo   Please install Node.js, then run this file again:
echo     https://nodejs.org
echo.
pause
exit /b 1
