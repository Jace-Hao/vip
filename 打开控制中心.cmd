@echo off
setlocal
cd /d "%~dp0"
title 控制中心
set "NODE_EXE="
if not defined NODE_EXE for /f "delims=" %%i in ('where node 2^>nul') do if not defined NODE_EXE set "NODE_EXE=%%i"
if not defined NODE_EXE if exist "D:\node.js\node.exe" set "NODE_EXE=D:\node.js\node.exe"
curl -s -o nul --max-time 2 "http://127.0.0.1:8791/api/status"
if %errorlevel%==0 goto :open
if not defined NODE_EXE (
  echo [错误] 未找到 Node.js。
  goto :end
)
start "控制中心服务" /min "%NODE_EXE%" "%~dp0app\orders_server.mjs"
set /a n=0
:waitloop
timeout /t 1 /nobreak >nul
set /a n+=1
curl -s -o nul --max-time 2 "http://127.0.0.1:8791/api/status"
if not %errorlevel%==0 if %n% lss 10 goto :waitloop
:open
set /p TOKEN=<"%~dp0.console_token.txt"
if not "%LAUNDRY_EXPORT_NOOPEN%"=="1" start "" "http://127.0.0.1:8791/home/?token=%TOKEN%"
echo.
echo 控制中心已在浏览器打开。
goto :end
:end
if not "%LAUNDRY_EXPORT_NOPAUSE%"=="1" pause
endlocal