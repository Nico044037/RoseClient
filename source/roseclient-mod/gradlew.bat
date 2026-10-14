@echo off
setlocal EnableExtensions
set "GRADLE_VERSION=9.4.0"
set "GRADLE_HOME=%USERPROFILE%\.gradle\roseclient-bootstrap\gradle-%GRADLE_VERSION%"
set "GRADLE_ZIP=%TEMP%\roseclient-gradle-%GRADLE_VERSION%-bin.zip"

if exist "%GRADLE_HOME%\bin\gradle.bat" goto run_gradle

echo RoseClient: Gradle %GRADLE_VERSION% not found; downloading it now...
if not exist "%USERPROFILE%\.gradle\roseclient-bootstrap" mkdir "%USERPROFILE%\.gradle\roseclient-bootstrap"

powershell -NoProfile -ExecutionPolicy Bypass -Command "$ProgressPreference='SilentlyContinue'; Invoke-WebRequest -UseBasicParsing -Uri 'https://services.gradle.org/distributions/gradle-%GRADLE_VERSION%-bin.zip' -OutFile '%GRADLE_ZIP%'"
if errorlevel 1 (
  echo ERROR: Could not download Gradle. Check internet access and try again.
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -Command "Expand-Archive -LiteralPath '%GRADLE_ZIP%' -DestinationPath '%USERPROFILE%\.gradle\roseclient-bootstrap' -Force"
if errorlevel 1 (
  echo ERROR: Could not extract Gradle.
  exit /b 1
)

:run_gradle
call "%GRADLE_HOME%\bin\gradle.bat" %*
exit /b %ERRORLEVEL%
