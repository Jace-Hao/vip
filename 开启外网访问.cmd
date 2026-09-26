@echo off
setlocal
cd /d "%~dp0"
title 外网访问隧道

set "CF=%~dp0app\cloudflared.exe"
if not exist "%CF%" (
  echo [错误] 未找到 cloudflared.exe（app 目录）。
  goto :end
)

tasklist /FI "IMAGENAME eq cloudflared.exe" 2>nul | find /I "cloudflared.exe" >nul
if %errorlevel%==0 (
  echo 隧道已在运行中。
  goto :end
)

echo 正在建立外网隧道，公网地址将显示在下方（https://xxxx.trycloudflare.com）
echo 首次打开需输入访问口令（见 .console_token.txt）。关闭本窗口即断开外网访问。
echo.
"%CF%" tunnel --url http://127.0.0.1:8791 --no-autoupdate

:end
if not "%LAUNDRY_EXPORT_NOPAUSE%"=="1" pause
endlocal