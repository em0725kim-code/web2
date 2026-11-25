@echo off
setlocal
cd /d "%~dp0"
set "FUEL_APP_NODE=node.exe"
if exist "%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" set "FUEL_APP_NODE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
"%FUEL_APP_NODE%" "%~dp0server.mjs"
if errorlevel 1 pause
