@echo off
setlocal
cd /d "%~dp0"
title 洗衣管家会员导出（含详情）

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

echo.
echo 本次为「含详情」导出：除常规数据外，还会逐会员抓取详细资料
echo （标签、卡券、订单明细、充值信息等），预计需要几分钟（视会员数量而定）。
echo 期间请保持洗衣管家开启且不要退出登录；如中途中断或被要求重新登录，登录后重新运行本脚本即可接着抓取。
echo.

"%NODE_EXE%" "%~dp0app\export.mjs" --deep
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
