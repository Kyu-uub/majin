'  Majin — double-click to close. Quietly stops the background server.
Option Explicit

Dim fso, sh, here, port
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh  = CreateObject("WScript.Shell")
here = fso.GetParentFolderName(WScript.ScriptFullName)

port = 3000
If fso.FileExists(here & "\.env") Then
  Dim ts, ln
  Set ts = fso.OpenTextFile(here & "\.env", 1)
  Do While Not ts.AtEndOfStream
    ln = Trim(ts.ReadLine)
    If Left(ln, 5) = "PORT=" Then port = Trim(Replace(Mid(ln, 6), Chr(34), ""))
  Loop
  ts.Close
End If

' find the process id(s) listening on the port and kill them
Dim e, txt, parts, i, pid, seen, killed
Set e = sh.Exec("cmd /c netstat -ano | findstr /r /c:" & Chr(34) & ":" & port & " " & Chr(34) & " | findstr LISTENING")
txt = e.StdOut.ReadAll
seen = ","
killed = False
Dim lines
lines = Split(txt, vbLf)
For i = 0 To UBound(lines)
  ln = Trim(lines(i))
  If InStr(ln, "LISTENING") > 0 Then
    parts = Split(ln)
    If UBound(parts) >= 4 Then
      pid = Trim(parts(UBound(parts)))
      If IsNumeric(pid) And InStr(seen, "," & pid & ",") = 0 Then
        seen = seen & pid & ","
        sh.Run "cmd /c taskkill /PID " & pid & " /F >nul 2>&1", 0, True
        killed = True
      End If
    End If
  End If
Next

If Not killed Then
  MsgBox "Majin was not running on port " & port & ".", vbInformation, "Majin"
End If
