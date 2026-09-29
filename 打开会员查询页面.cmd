@echo off
setlocal
cd /d "%~dp0"
title 会员查询页面

rem ---- 刷新查询页数据（Python）----
set "PY_EXE="
if exist "%LOCALAPPDATA%\Python\bin\python.exe" set "PY_EXE=%LOCALAPPDATA%\Python\bin\python.exe"
if not defined PY_EXE for /f "delims=" %%i in ('where py 2^>nul') do if not defined PY_EXE set "PY_EXE=%%i"
if not defined PY_EXE for /f "delims=" %%i in ('where python 2^>nul') do if not defined PY_EXE set "PY_EXE=%%i"
if defined PY_EXE (
  "%PY_EXE%" "%~dp0app\build_viewer.py"
) else (
  echo [提示] 未找到 Python，跳过刷新（数据可能不是最新）。
)

rem ---- 确保本地服务在运行 ----
set "NODE_EXE="
if not defined NODE_EXE for /f "delims=" %%i in ('where node 2^>nul') do if not defined NODE_EXE set "NODE_EXE=%%i"
if not defined NODE_EXE if exist "D:\node.js\node.exe" set "NODE_EXE=D:\node.js\node.exe"
if not defined NODE_EXE if exist "D:\autoclaw\resources\node\node.exe" set "NODE_EXE=D:\autoclaw\resources\node\node.exe"
curl -s -o nul --max-time 2 "http://127.0.0.1:8791/api/status"
if not %errorlevel%==0 (
  if defined NODE_EXE start "查询页服务" /min "%NODE_EXE%" "%~dp0app\orders_server.mjs"
  set /a n=0
  :waitloop
  timeout /t 1 /nobreak >nul
  set /a n+=1
  curl -s -o nul --max-time 2 "http://127.0.0.1:8791/api/status"
  if not %errorlevel%==0 if %n% lss 10 goto :waitloop
)

set /p TOKEN=<"%~dp0.console_token.txt"
if not "%LAUNDRY_EXPORT_NOOPEN%"=="1" start "" "http://127.0.0.1:8791/查询页面/index.html?token=%TOKEN%"
echo.
echo 查询页已在浏览器打开（通过本地服务，可直接跳转收衣系统）。
goto :end

:end
if not "%LAUNDRY_EXPORT_NOPAUSE%"=="1" pause
endlocal