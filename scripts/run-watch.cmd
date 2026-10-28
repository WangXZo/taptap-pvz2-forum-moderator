@echo off
rem ============================================================
rem Launcher for the watch daemon (called by Windows Task Scheduler)
rem
rem Why this file exists:
rem  1) A scheduled task may start with a different working directory -> cd to skill root
rem  2) We want the output written to a log file, with simple rotation
rem  3) We want the exit code recorded, to tell crash from normal exit
rem
rem NOTE: keep this file ASCII-only. cmd.exe mishandles UTF-8 BOM / non-ASCII bytes.
rem ============================================================
setlocal
cd /d "%~dp0.."

set "SKILL=%~dp0.."
set "LOGDIR=%SKILL%\logs"
if not exist "%LOGDIR%" mkdir "%LOGDIR%" >nul 2>&1
set "LOG=%LOGDIR%\watch.log"

rem rotate when log exceeds 5 MB
if exist "%LOG%" (
  for %%A in ("%LOG%") do if %%~zA GTR 5242880 (
    if exist "%LOG%.1" del /q "%LOG%.1" >nul 2>&1
    move /y "%LOG%" "%LOG%.1" >nul 2>&1
  )
)

rem node path: install-schedule writes node-path.txt (task env may lack PATH)
set "NODEEXE=node"
if exist "%~dp0node-path.txt" set /p NODEEXE=<"%~dp0node-path.txt"

echo [%date% %time%] ===== watch start (node=%NODEEXE%) ===== >> "%LOG%"
"%NODEEXE%" "%~dp0watch.mjs" >> "%LOG%" 2>&1
set "RC=%ERRORLEVEL%"
echo [%date% %time%] ===== watch exit code=%RC% ===== >> "%LOG%"
endlocal & exit /b %RC%
