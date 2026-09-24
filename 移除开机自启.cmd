@echo off
chcp 936 >nul
schtasks /Delete /TN "XQY-Orders-Console" /F
echo 已移除开机自启（计划任务 XQY-Orders-Console）。
echo.
pause