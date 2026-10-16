'  Majin - double-click to open. No command window, nothing to babysit.
'  First run installs two tiny packages, then shows Majin in its OWN app window
'  (Chrome/Edge --app mode: dedicated window, no browser tabs, no address bar,
'  its own taskbar icon). After that it just wakes Majin up. If Majin is already
'  running it only opens another app window. Uses 127.0.0.1 so it works even when
'  "localhost" resolves to IPv6. It also registers a "Majin" shortcut on your Desktop
'  AND in the Start Menu (press the Windows key, type Majin) — created once.
Option Explicit

Dim fso, sh, here, q, port, url, firstRun
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh  = CreateObject("WScript.Shell")
here = fso.GetParentFolderName(WScript.ScriptFullName)
q = Chr(34)

' which port? read it from .env if present, else 3000
port = 3000
If fso.FileExists(here & "\.env") Then
  Dim ts, line
  Set ts = fso.OpenTextFile(here & "\.env", 1)
  Do While Not ts.AtEndOfStream
    line = Trim(ts.ReadLine)
    If Left(line, 5) = "PORT=" Then port = Trim(Replace(Mid(line, 6), Chr(34), ""))
  Loop
  ts.Close
End If
url = "http://127.0.0.1:" & port

' make sure the launch shortcuts exist (done once, never overwrite one the user edited)
EnsureShortcuts

' already up? then just open the app window and quit
If MajinUp(port) Then
  OpenAppWindow url
  WScript.Quit
End If

' not running - make sure Node is installed
If Not HasNode() Then
  MsgBox "Majin needs Node.js (free, one install)." & vbCrLf & _
         "Download the LTS installer from https://nodejs.org/ , run it, then double-click Majin again.", _
         vbOKOnly + vbCritical, "Majin - Node.js not found"
  WScript.Quit
End If

' one-time dependency install (this console window is shown only the very first time)
firstRun = Not fso.FolderExists(here & "\node_modules\express")
If firstRun Then
  sh.Run "cmd /c cd /d " & q & here & q & " && npm install --omit=dev --no-fund --no-audit", 1, True
  If Not fso.FolderExists(here & "\node_modules\express") Then
    MsgBox "Majin could not install its small helper packages." & vbCrLf & _
           "Check your internet connection and try again.", vbOKOnly + vbCritical, "Majin"
    WScript.Quit
  End If
End If

' start the server quietly in the background (hidden window, no taskbar clutter)
sh.CurrentDirectory = here
sh.Run "cmd /c cd /d " & q & here & q & " && node server.js", 0, False

' wait for it to answer, then open the app window
Dim i
For i = 1 To 40
  If MajinUp(port) Then Exit For
  WScript.Sleep 250
Next
OpenAppWindow url

' --- helpers ---
Sub EnsureShortcuts
  Dim win, ico, wscript, desktop, startMenu
  On Error Resume Next
  win = sh.ExpandEnvironmentStrings("%WINDIR%")
  wscript = win & "\System32\WScript.exe"
  ico = here & "\desktop\majin.ico"

  desktop = sh.SpecialFolders("Desktop")
  If desktop <> "" Then MakeShortcut(desktop & "\Majin.lnk", wscript, ico, win & "\System32\shell32.dll,137")

  ' Start Menu (user scope) -> appears when you press the Windows key and type "Majin"
  startMenu = sh.ExpandEnvironmentStrings("%APPDATA%") & "\Microsoft\Windows\Start Menu\Programs"
  If fso.FolderExists(sh.ExpandEnvironmentStrings("%APPDATA%")) Then MakeShortcut(startMenu & "\Majin.lnk", wscript, ico, win & "\System32\shell32.dll,137")
End Sub

Sub MakeShortcut(lnkPath, wscript, ico, fallbackIco)
  Dim sc
  On Error Resume Next
  If fso.FileExists(lnkPath) Then Exit Sub            ' respect any shortcut the user moved/edited
  Set sc = sh.CreateShortcut(lnkPath)
  sc.TargetPath = wscript
  sc.Arguments = q & here & "\Majin.vbs" & q
  sc.WorkingDirectory = here
  If fso.FileExists(ico) Then
    sc.IconLocation = ico & ",0"
  Else
    sc.IconLocation = fallbackIco
  End If
  sc.Description = "Majin - Personal AI assistant"
  sc.Save
End Sub

Sub OpenAppWindow(theUrl)
  Dim exe, profileDir, cmd
  profileDir = here & "\.majin-profile"
  If Not fso.FolderExists(profileDir) Then fso.CreateFolder(profileDir)
  exe = FindBrowser()
  If exe <> "" Then
    ' dedicated chromeless window, isolated profile => its own taskbar identity,
    ' never merged into your everyday browser tabs
    cmd = q & exe & q & " --app=" & q & theUrl & q & _
          " --user-data-dir=" & q & profileDir & q & _
          " --no-first-run --no-default-browser-check"
    sh.Run cmd, 1, False
  Else
    sh.Run theUrl                     ' no Chrome/Edge found: open in default browser
  End If
End Sub

Function FindBrowser()
  Dim pf, pf8, la, i
  pf  = sh.ExpandEnvironmentStrings("%ProgramFiles%")
  pf8 = sh.ExpandEnvironmentStrings("%ProgramFiles(x86)%")
  la  = sh.ExpandEnvironmentStrings("%LOCALAPPDATA%")
  Dim list
  list = Array( _
    pf8  & "\Google\Chrome\Application\chrome.exe", _
    pf   & "\Google\Chrome\Application\chrome.exe", _
    la   & "\Google\Chrome\Application\chrome.exe", _
    pf8  & "\Microsoft\Edge\Application\msedge.exe", _
    pf   & "\Microsoft\Edge\Application\msedge.exe")
  For i = 0 To UBound(list)
    If fso.FileExists(list(i)) Then
      FindBrowser = list(i)
      Exit Function
    End If
  Next
  FindBrowser = ""
End Function

Function MajinUp(p)
  On Error Resume Next
  Dim http
  Set http = CreateObject("WinHttp.WinHttpRequest.5.1")
  Err.Clear
  http.Open "GET", "http://127.0.0.1:" & p & "/api/status", False
  http.Send
  If Err.Number = 0 Then MajinUp = (http.Status = 200) Else MajinUp = False
End Function

Function HasNode()
  On Error Resume Next
  Dim e
  Set e = sh.Exec("cmd /c node -v")
  Err.Clear
  HasNode = (Err.Number = 0)
End Function
