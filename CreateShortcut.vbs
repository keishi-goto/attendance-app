' Universal Shortcut Generator for Windows
' This file uses only ASCII characters to avoid encoding issues.
' Japanese strings are constructed using ChrW() at runtime.

Dim oWS, sLinkName, sLinkFile, oLink, fso, currentDir, sDesc, sMsg, sTitle

Set oWS = WScript.CreateObject("WScript.Shell")

' "Attendance App" in Japanese (出席確認アプリ)
sLinkName = ChrW(&H51FA) & ChrW(&H5E2D) & ChrW(&H78BA) & ChrW(&H8A8D) & ChrW(&H30A2) & ChrW(&H30D7) & ChrW(&H30EA)
sLinkFile = oWS.SpecialFolders("Desktop") & "\" & sLinkName & ".lnk"

Set oLink = oWS.CreateShortcut(sLinkFile)

Set fso = CreateObject("Scripting.FileSystemObject")
currentDir = fso.GetParentFolderName(WScript.ScriptFullName)

oLink.TargetPath = currentDir & "\index.html"
oLink.IconLocation = currentDir & "\icon.ico"
oLink.WorkingDirectory = currentDir

' "Teacher Attendance App" in Japanese (教員用出席確認アプリ)
sDesc = ChrW(&H6559) & ChrW(&H54E1) & ChrW(&H7528) & sLinkName
oLink.Description = sDesc

oLink.Save

' "Shortcut created on desktop!" in Japanese
' (デスクトップにショートカットを作成しました！)
sMsg = ChrW(&H30C7) & ChrW(&H30B9) & ChrW(&H30AF) & ChrW(&H30C8) & ChrW(&H30C3) & ChrW(&H30D7) & ChrW(&H306B) & _
       ChrW(&H30B7) & ChrW(&H30E7) & ChrW(&H30FC) & ChrW(&H30C8) & ChrW(&H30AB) & ChrW(&H30C3) & ChrW(&H30C8) & _
       ChrW(&H3092) & ChrW(&H4F5C) & ChrW(&H6210) & ChrW(&H3057) & ChrW(&H307E) & ChrW(&H3057) & ChrW(&H305F) & ChrW(&HFF01)

' "Complete" in Japanese (完了)
sTitle = ChrW(&H5B8C) & ChrW(&H4E86)

MsgBox sMsg, 64, sTitle
