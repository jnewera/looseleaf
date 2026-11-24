' Double-click to open Looseleaf.
' Starts the local server (hidden) if it isn't running, then opens Edge in app mode.
Option Explicit

Const URL = "http://127.0.0.1:4317"
Dim shell, fso, here, i
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)

Function ServerUp()
  Dim http
  ServerUp = False
  On Error Resume Next
  Set http = CreateObject("MSXML2.ServerXMLHTTP.6.0")
  http.setTimeouts 500, 500, 500, 500
  http.open "GET", URL & "/api/health", False
  http.send
  If Err.Number = 0 Then ServerUp = (http.status = 200)
  On Error GoTo 0
End Function

If Not ServerUp() Then
  shell.CurrentDirectory = here
  ' 0 = hidden window, False = don't wait
  shell.Run "node """ & here & "\server\server.js""", 0, False
  For i = 1 To 40
    WScript.Sleep 150
    If ServerUp() Then Exit For
  Next
  If Not ServerUp() Then
    MsgBox "Could not start the Looseleaf server." & vbCrLf & _
           "Make sure Node.js is installed, then try 'npm start' in " & here, vbExclamation, "Looseleaf"
    WScript.Quit 1
  End If
End If

shell.Run "msedge --app=" & URL, 1, False
