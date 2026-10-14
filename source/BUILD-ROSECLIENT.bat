@echo off
setlocal EnableExtensions
cd /d "%~dp0"
echo.
echo ========================================
echo       RoseClient Fabric-Only Build
echo ========================================
echo.

where node >nul 2>nul
if errorlevel 1 (echo ERROR: Node.js is required. Install Node.js LTS and retry.& pause & exit /b 1)
where npm >nul 2>nul
if errorlevel 1 (echo ERROR: npm was not found. Reinstall Node.js LTS.& pause & exit /b 1)
where java >nul 2>nul
if errorlevel 1 (echo ERROR: Java 25 or newer is required for Minecraft 26.1.2.& pause & exit /b 1)
where javac >nul 2>nul
if errorlevel 1 (echo ERROR: A Java JDK is required to compile RoseClient.& pause & exit /b 1)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0check-java.ps1"
if errorlevel 1 (echo ERROR: Minecraft 26.1.2 requires Java 25 or newer. Check the detected version above, then update JAVA_HOME/PATH and retry.& pause & exit /b 1)

echo [1/3] Installing launcher dependencies...
call npm install
if errorlevel 1 goto :failed

echo [2/3] Building Fabric 26.1.2 client mod...
pushd roseclient-mod
call gradlew.bat build
if errorlevel 1 (popd & goto :failed)
if not exist build\libs\roseclient-mod-1.0.0.jar (popd & echo ERROR: Expected Fabric mod JAR was not produced.& goto :failed)
popd
if not exist resources\mods mkdir resources\mods
copy /Y roseclient-mod\build\libs\roseclient-mod-1.0.0.jar resources\mods\roseclient-fabric-26.1.2.jar >nul
if errorlevel 1 goto :failed
rem Remove stale artifacts from previous multi-loader builds.
del /q resources\mods\roseclient-quilt-26.1.2.jar resources\mods\roseclient-neoforge-26.1.2.jar resources\mods\roseclient-forge-1.20.1.jar 2>nul

echo [3/3] Building Windows installer...
call npm run dist
if errorlevel 1 goto :failed

echo.
echo Build finished. The in-game RoseClient mod targets Fabric 26.1.2 only.
echo Installer output is in the release folder.
pause
exit /b 0

:failed
echo.
echo BUILD FAILED. Read the error above and check README.md for requirements.
pause
exit /b 1
