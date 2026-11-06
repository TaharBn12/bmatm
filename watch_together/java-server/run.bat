@echo off
REM WatchTogether - run the Java server on Windows
REM Messages are English on purpose (CMD mangles UTF-8 Arabic here).
REM The last line switches the console to UTF-8 so the server banner prints
REM Arabic correctly; everything else stays ASCII.
setlocal
cd /d "%~dp0"

where java >nul 2>nul
if errorlevel 1 (
  echo [X] java not found - install JDK 11+ first, then open a NEW cmd window.
  pause
  exit /b 1
)
java -version

if not exist out (
  echo -^> out\ is missing - building first...
  call build.bat
)
if not exist out (
  echo [X] folder out\ is still missing - the build failed.
  pause
  exit /b 1
)

if "%PORT%"=="" set PORT=8080
echo.
echo -^> Starting WatchTogether on port %PORT%   (Ctrl+C to stop)
echo    After it starts, open:  http://localhost:%PORT%/
echo    If the window closes immediately, read the message below.
echo.

chcp 65001 >nul 2>nul & java -Dfile.encoding=UTF-8 -cp out com.watchtogether.Main
set EXITCODE=%ERRORLEVEL%

echo.
echo [!] The server stopped. Java exit code: %EXITCODE%
if not "%EXITCODE%"=="0" (
  echo     Copy everything in this window and send it to me.
  echo     Common causes: port %PORT% already used by another program,
  echo     or a second copy of the server is still running.
)
pause
endlocal
