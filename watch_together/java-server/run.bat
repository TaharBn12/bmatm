@echo off
REM WatchTogether - run the Java server on Windows
REM NOTE: messages are in English on purpose (CMD mangles UTF-8 Arabic here).
REM The last line switches the console to UTF-8 so the server banner prints
REM Arabic correctly; everything else stays ASCII.
setlocal
cd /d "%~dp0"
where java >nul 2>nul || (echo [X] java not found - install JDK 11+ first & exit /b 1)
if not exist out call build.bat
if not exist out exit /b 1
if "%PORT%"=="" set PORT=8080
echo -^> Starting WatchTogether on port %PORT%   (Ctrl+C to stop)
echo    Open in your browser: http://localhost:%PORT%/
chcp 65001 >nul 2>nul & java -Dfile.encoding=UTF-8 -cp out com.watchtogether.Main
endlocal
