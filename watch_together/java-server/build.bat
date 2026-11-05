@echo off
REM WatchTogether - build the Java server on Windows (JDK 11+)
REM NOTE: messages are in English on purpose: CMD mangles UTF-8 Arabic in .bat
REM files. The server's own output (banner) stays Arabic.
setlocal
cd /d "%~dp0"
where javac >nul 2>nul || (echo [X] javac not found - install JDK 11+ first & exit /b 1)
if exist out rmdir /s /q out
mkdir out
echo -^> Compiling sources...
javac -encoding UTF-8 -d out src\com\watchtogether\*.java || (echo [X] Build failed & exit /b 1)
echo -^> Creating JAR...
> out\manifest.mf echo Manifest-Version: 1.0
>> out\manifest.mf echo Main-Class: com.watchtogether.Main
jar cfm watchtogether.jar out\manifest.mf -C out com
del out\manifest.mf
echo [OK] Build done: out\  and watchtogether.jar
endlocal
