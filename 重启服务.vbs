' 重启服务：以「无窗口」方式延迟拉起新的 orders_server.mjs 实例。
' 由 /api/hub/restart 调用（wscript 启动本脚本，自身无控制台窗口）。
' 延迟 3 秒等待旧实例释放 8791 端口，避免新实例因端口占用启动失败。
Option Explicit
Dim sh, fso, nodeExe, scriptPath, root
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

If WScript.Arguments.Count < 2 Then WScript.Quit 1
nodeExe = WScript.Arguments(0)      ' 传入当前服务的 node.exe 绝对路径（process.execPath）
scriptPath = WScript.Arguments(1)   ' 传入 app\orders_server.mjs 绝对路径

If Not fso.FileExists(nodeExe) Then
  nodeExe = "node.exe"              ' 兜底：交给 PATH 解析
End If

root = fso.GetParentFolderName(fso.GetParentFolderName(scriptPath)) ' 脚本所在 app\ 的上一级 = 项目根
sh.CurrentDirectory = root

WScript.Sleep 3000                  ' 等旧实例退出并释放端口
sh.Run """" & nodeExe & """ """ & scriptPath & """", 0, False   ' 0 = 不显示窗口
