' 会员订单抓取操作台 · 开机后台自启动（无窗口，不打开浏览器）
Option Explicit
Dim sh, fso, nodeExe
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
nodeExe = "D:\node.js\node.exe"
If Not fso.FileExists(nodeExe) Then nodeExe = "node.exe"
sh.CurrentDirectory = "E:\软件开发\洗衣管家会员导出"
sh.Run """" & nodeExe & """ ""app\orders_server.mjs""", 0, False