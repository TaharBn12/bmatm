@echo off
REM WatchTogether — تشغيل سيرفر Java على ويندوز
setlocal
cd /d "%~dp0"
if not exist out call build.bat
if "%PORT%"=="" set PORT=8080
echo -^> تشغيل WatchTogether على المنفذ %PORT%  (Ctrl+C للايقاف)
java -Dfile.encoding=UTF-8 -cp out com.watchtogether.Main
endlocal
