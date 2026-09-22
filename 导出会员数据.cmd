@echo off
setlocal
cd /d "%~dp0"
title 洗衣管家会员导出

rem ---- 查找 Node.js ----
set "NODE_EXE="
if defined NODE_EXE_OVERRIDE if exist "%NODE_EXE_OVERRIDE%" set "NODE_EXE=%NODE_EXE_OVERRIDE%"
if not defined NODE_EXE for /f "delims=" %%i in ('where node 2^>nul') do if not defined NODE_EXE set "NODE_EXE=%%i"
if not defined NODE_EXE if exist "D:\node.js\node.exe" set "NODE_EXE=D:\node.js\node.exe"
if not defined NODE_EXE if exist "D:\autoclaw\resources\node\node.exe" set "NODE_EXE=D:\autoclaw\resources\node\node.exe"
if not defined NODE_EXE (
  echo.
  echo [错误] 未找到 Node.js 运行环境，无法运行导出工具。
  goto :end
)

"%NODE_EXE%" "%~dp0app\export.mjs"
if errorlevel 1 goto :fail

rem ---- 查找 Python（用于生成 Excel）----
set "PY_EXE="
if exist "%LOCALAPPDATA%\Python\bin\python.exe" set "PY_EXE=%LOCALAPPDATA%\Python\bin\python.exe"
if not defined PY_EXE for /f "delims=" %%i in ('where py 2^>nul') do if not defined PY_EXE set "PY_EXE=%%i"
if not defined PY_EXE for /f "delims=" %%i in ('where python 2^>nul') do if not defined PY_EXE set "PY_EXE=%%i"
if not defined PY_EXE (
  echo.
  echo [提示] 未找到 Python 运行环境，未生成 Excel；CSV 文件已经可用。
  goto :ok
)

"%PY_EXE%" "%~dp0app\make_xlsx.py"
if errorlevel 1 (
  echo.
  echo [提示] Excel 生成失败，CSV 文件已经可用。
  goto :ok
)

:ok
rem 刷新会员查询页面数据（若已生成过页面）
if defined PY_EXE if exist "%~dp0查询页面\index.html" "%PY_EXE%" "%~dp0app\build_viewer.py" >nul 2>nul
if not "%LAUNDRY_EXPORT_NOOPEN%"=="1" start "" "%~dp0导出结果"
echo.
echo 全部完成。
goto :end

:fail
echo.
echo 导出失败，请查看上方错误信息。若反复失败请联系工具维护者。

:end
if not "%LAUNDRY_EXPORT_NOPAUSE%"=="1" pause
endlocal
