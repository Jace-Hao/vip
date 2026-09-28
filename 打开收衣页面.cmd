@echo off
setlocal
cd /d "%~dp0"
title 收衣收银系统

rem ---- 确保 Node.js ----
set "NODE_EXE="
if not defined NODE_EXE for /f "delims=" %%i in ('where node 2^>nul') do if not defined NODE_EXE set "NODE_EXE=%%i"
if not defined NODE_EXE if exist "D:\node.js\node.exe" set "NODE_EXE=D:\node.js\node.exe"
if not defined NODE_EXE if exist "D:\autoclaw\resources\node\node.exe" set "NODE_EXE=D:\autoclaw\resources\node\node.exe"

rem ---- 服务已在运行？没有则后台拉起 ----
curl -s -o nul --max-time 2 "http://127.0.0.1:8791/api/status"
if not %errorlevel%==0 (
  if defined NODE_EXE start "收衣服务" /min "%NODE_EXE%" "%~dp0app\orders_server.mjs"
  set /a n=0
  :waitloop
  timeout /t 1 /nobreak >nul
  set /a n+=1
  curl -s -o nul --max-time 2 "http://127.0.0.1:8791/api/status"
  if not %errorlevel%==0 if %n% lss 10 goto :waitloop
)

set /p TOKEN=<"%~dp0.console_token.txt"
start "" "http://127.0.0.1:8791/shop/?token=%TOKEN%"
endlocal