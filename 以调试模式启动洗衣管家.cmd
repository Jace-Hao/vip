@echo off
setlocal
cd /d "%~dp0"
title 以调试模式启动洗衣管家

set "APP=D:\Blending_Release-6.1.17\xygjwinapp.exe"

rem 检查调试端口是否已经可用
curl -s -o nul --max-time 3 "http://127.0.0.1:9222/json/version"
if %errorlevel%==0 (
  echo 洗衣管家正在运行，且调试端口正常，无需重新启动。
  echo 直接双击“导出会员数据.cmd”即可导出。
  goto :end
)

rem 检查洗衣管家是否已在运行（未开调试端口的情况）
tasklist /FI "IMAGENAME eq xygjwinapp.exe" 2>nul | find /I "xygjwinapp.exe" >nul
if %errorlevel%==0 (
  echo 洗衣管家正在运行，但没有开启调试端口。
  echo 请先手动完全退出洗衣管家（关闭软件窗口），再运行本脚本。
  goto :end
)

if not exist "%APP%" (
  echo [错误] 找不到洗衣管家程序：%APP%
  goto :end
)

start "" "%APP%" --remote-debugging-port=9222
echo 已启动洗衣管家（调试模式）。
echo 请等待软件完全打开并登录后，再运行“导出会员数据.cmd”。

:end
if not "%LAUNDRY_EXPORT_NOPAUSE%"=="1" pause
endlocal
