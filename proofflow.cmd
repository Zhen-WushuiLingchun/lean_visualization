@echo off
setlocal EnableExtensions
title ProofFlow
rem ProofFlow one-click launcher (Windows).
rem   proofflow.cmd                      -> serves the bundled example (examples\toy)
rem   proofflow.cmd D:\path\to\project   -> serves that Lean project
rem   proofflow.cmd D:\proj --port 4871  -> extra flags are passed to `proofflow serve`
rem Builds the TypeScript packages on first run, then opens the web UI in your browser.

set "ROOT=%~dp0"
set "PATH=%USERPROFILE%\.elan\bin;%PATH%"

where node >nul 2>nul
if errorlevel 1 (
  echo [ProofFlow] Node.js 22 or newer is required. Install it from https://nodejs.org and retry.
  pause
  exit /b 1
)
where pnpm >nul 2>nul
if errorlevel 1 (
  echo [ProofFlow] pnpm is required. Run:  npm install -g pnpm   ^(or: corepack enable^)
  pause
  exit /b 1
)
where lake >nul 2>nul
if errorlevel 1 (
  echo [ProofFlow] Lean's `lake` was not found on PATH or in %%USERPROFILE%%\.elan\bin.
  echo [ProofFlow] Install elan from https://github.com/leanprover/elan and retry.
  pause
  exit /b 1
)

pushd "%ROOT%"
if not exist "node_modules\" (
  echo [ProofFlow] Installing dependencies ^(first run^)...
  call pnpm install || goto :fail
)
if not exist "packages\server\dist\cli.js" goto :build
if not exist "packages\web\dist\index.html" goto :build
goto :built
:build
echo [ProofFlow] Building packages ^(first run^)...
call pnpm build || goto :fail
:built
popd

set "PROJECT=%~1"
if "%PROJECT%"=="" (
  set "PROJECT=%ROOT%examples\toy"
) else (
  shift
)
set "REST="
:collect
if "%~1"=="" goto :run
set "REST=%REST% %1"
shift
goto :collect

:run
echo [ProofFlow] Project: %PROJECT%
echo [ProofFlow] Starting server on http://127.0.0.1:4870 ^(Ctrl+C to stop^)...
node "%ROOT%packages\server\dist\cli.js" serve --project "%PROJECT%" --open%REST%
set "CODE=%ERRORLEVEL%"
if not "%CODE%"=="0" (
  echo [ProofFlow] Server exited with code %CODE%.
  pause
)
exit /b %CODE%

:fail
popd
echo [ProofFlow] Setup failed. See the messages above.
pause
exit /b 1
