@echo off
setlocal
cd /d "%~dp0"
title 订单抓取操作台

rem ---- 查找 Node.js ----
set "NODE_EXE="
if defined NODE_EXE_OVERRIDE if exist "%NODE_EXE_OVERRIDE%" set "NODE_EXE=%NODE_EXE_OVERRIDE%"
if not defined NODE_EXE for /f "delims=" %%i in ('where node 2^>nul') do if not defined NODE_EXE set "NODE_EXE=%%i"
if not defined NODE_EXE if exist "D:\node.js\node.exe" set "NODE_EXE=D:\node.js\node.exe"
if not defined NODE_EXE if exist "D:\autoclaw\resources\node\node.exe" set "NODE_EXE=D:\autoclaw\resources\node\node.exe"
if not defined NODE_EXE (
  echo.
  echo [错误] 未找到 Node.js 运行环境。
  goto :end
)

rem ---- 若服务已在运行则直接打开 ----
curl -s -o nul --max-time 2 "http://127.0.0.1:8791/api/status"
if %errorlevel%==0 goto :open

rem ---- 启动服务（最小化窗口，关闭该窗口会停止服务）----
start "订单抓取操作台服务" /min "%NODE_EXE%" "%~dp0app\orders_server.mjs"
rem 等待服务就绪（最多 10 秒）
set /a n=0
:waitloop
timeout /t 1 /nobreak >nul
set /a n+=1
curl -s -o nul --max-time 2 "http://127.0.0.1:8791/api/status"
if not %errorlevel%==0 if %n% lss 10 goto :waitloop

:open
if not "%ORDER_UI_NOOPEN%"=="1" start "" "http://127.0.0.1:8791/"
echo.
echo 操作台已在浏览器打开（服务 http://127.0.0.1:8791；最小化的服务窗口请保持开启）。
goto :end

:end
if not "%ORDER_UI_NOPAUSE%"=="1" pause
endlocal
