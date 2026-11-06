@echo off
REM WatchTogether - build the Java server on Windows (JDK 11+)
REM Messages are English on purpose: CMD mangles UTF-8 Arabic inside .bat files.
REM The server's own output (banner) stays Arabic - run.bat switches the
REM console to UTF-8 right before launching java.
setlocal
cd /d "%~dp0"

where javac >nul 2>nul
if errorlevel 1 (
  echo [X] javac not found - install JDK 11+ first, then open a NEW cmd window.
  pause
  exit /b 1
)
javac -version

if exist out rmdir /s /q out
mkdir out
if errorlevel 1 (
  echo [X] cannot create the out\ folder.
  pause
  exit /b 1
)

echo -^> Compiling sources...
javac -encoding UTF-8 -d out src\com\watchtogether\*.java
if errorlevel 1 (
  echo [X] Build failed - paste the lines above to me.
  pause
  exit /b 1
)
echo [OK] Compiled into out\

echo -^> Creating JAR...
del /f /q watchtogether.jar >nul 2>nul
> out\manifest.mf echo Manifest-Version: 1.0
>> out\manifest.mf echo Main-Class: com.watchtogether.Main
jar cfm watchtogether.jar out\manifest.mf -C out com
if errorlevel 1 (
  echo [!] JAR skipped - watchtogether.jar is locked by another program.
  echo     This does NOT matter: run.bat starts from the out\ folder.
  echo     To release it, close any running java.exe, or just ignore this.
) else (
  echo [OK] JAR: watchtogether.jar
)
del /q out\manifest.mf >nul 2>nul

echo [OK] Build done.
endlocal
