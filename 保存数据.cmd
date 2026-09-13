@echo off
rem ============================================================
rem  Commit data/ into its LOCAL git repo (data/.git).
rem  This repo has NO remote: history stays on this computer
rem  and is NEVER pushed anywhere.
rem  This file is intentionally ASCII-only (see launcher notes).
rem ============================================================

cd /d "%~dp0data"

where git >nul 2>nul
if errorlevel 1 (
  echo.
  echo   [ERROR] git was not found on PATH.
  echo.
  pause
  exit /b 1
)

if not exist ".git" (
  echo.
  echo   [ERROR] data\.git not found. Run: git init inside data/
  echo.
  pause
  exit /b 1
)

git add -A

git diff --cached --quiet
if errorlevel 1 (
  git commit -m "data snapshot %date% %time%"
  echo.
  echo   Done. data/ has been committed to the LOCAL repo only.
  echo   It is NOT pushed anywhere.
) else (
  echo.
  echo   Nothing new to commit.
)

echo.
pause
exit /b 0
