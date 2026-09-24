@echo off
chcp 936 >nul
schtasks /Create /F /TN "XQY-Orders-Console" /TR "wscript.exe \"%~dp0开机自启-操作台服务.vbs\"" /SC ONLOGON /DELAY 0000:30 /RL LIMITED
if %errorlevel%==0 (
  echo [OK] 已注册开机自启：登录 Windows 后 30 秒，操作台服务将在后台自动启动（无窗口）。
) else (
  echo [失败] 注册未成功，请右键"以管理员身份运行"本脚本再试。
)
echo.
pause