@echo off
REM WatchTogether — بناء سيرفر Java على ويندوز (JDK 11+)
setlocal
cd /d "%~dp0"
where javac >nul 2>nul || (echo [X] javac غير موجود — ثبّت JDK 11 أو أحدث & exit /b 1)
if exist out rmdir /s /q out
mkdir out
echo -^> ترجمة المصادر...
javac -encoding UTF-8 -d out src\com\watchtogether\*.java || (echo [X] فشل الترجمة & exit /b 1)
echo -^> انشاء JAR...
> out\manifest.mf echo Manifest-Version: 1.0
>> out\manifest.mf echo Main-Class: com.watchtogether.Main
jar cfm watchtogether.jar out\manifest.mf -C out com
del out\manifest.mf
echo [OK] تم البناء: out\  و watchtogether.jar
endlocal
