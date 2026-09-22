@echo off
setlocal
cd /d "%~dp0"
title 会员查询页面

rem ---- 查找 Python（用于生成页面数据）----
set "PY_EXE="
if exist "%LOCALAPPDATA%\Python\bin\python.exe" set "PY_EXE=%LOCALAPPDATA%\Python\bin\python.exe"
if not defined PY_EXE for /f "delims=" %%i in ('where py 2^>nul') do if not defined PY_EXE set "PY_EXE=%%i"
if not defined PY_EXE for /f "delims=" %%i in ('where python 2^>nul') do if not defined PY_EXE set "PY_EXE=%%i"

if defined PY_EXE (
  "%PY_EXE%" "%~dp0app\build_viewer.py"
) else (
  echo [提示] 未找到 Python，将直接打开现有页面（数据可能不是最新）。
)

if not exist "%~dp0查询页面\index.html" (
  echo [错误] 未找到 查询页面\index.html，请确认工具目录完整。
  goto :end
)

if not "%LAUNDRY_EXPORT_NOOPEN%"=="1" start "" "%~dp0查询页面\index.html"
echo.
echo 查询页面已在浏览器中打开（数据已刷新为最新一次导出）。
goto :end

:end
if not "%LAUNDRY_EXPORT_NOPAUSE%"=="1" pause
endlocal
