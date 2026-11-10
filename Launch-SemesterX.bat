@echo off
title SemesterX Launcher

cd /d "%~dp0semesterx-backend"

:: Check whether SemesterX is already running
powershell -NoProfile -Command "try { Invoke-WebRequest 'http://127.0.0.1:5000/api/health' -UseBasicParsing -TimeoutSec 2 | Out-Null; exit 0 } catch { exit 1 }" >nul 2>&1

if not errorlevel 1 goto OPEN

:: Start the backend
start "SemesterX Backend" cmd /k "npm start"

echo Starting SemesterX...

:: Wait for the backend
for /L %%i in (1,1,30) do (
    powershell -NoProfile -Command "try { Invoke-WebRequest 'http://127.0.0.1:5000/api/health' -UseBasicParsing -TimeoutSec 1 | Out-Null; exit 0 } catch { exit 1 }" >nul 2>&1

    if not errorlevel 1 goto OPEN

    timeout /t 1 /nobreak >nul
)

echo SemesterX failed to start.
pause
exit /b 1

:OPEN
start "" "http://localhost:5000"
exit /b 0