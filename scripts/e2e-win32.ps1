# Windows helpers for the E2E smoke test (scripts/e2e-smoke.mjs). Test-only.
#
#   windows <pid>  List the top-level windows of a process: class|title|visible|display affinity
#   probe          Report whether this process can read screen pixels ("screen=ok" or "screen=fail").
#                  Automation sandboxes often run on a desktop that is not shown, where it cannot.
#   hotkey         Press and release Ctrl+Alt+Shift+S (DevTrace's default capture shortcut).
#                  Only used with --interactive: injected keys reach the user's active desktop.
#   target         Show a window with a known title and solid color to capture (blocks)
#   changing       Show a window that switches between two solid colors every 4 s (blocks)
#   pdf            Render page 1 of the PDF at -Path to a PNG at -Out with the Windows PDF renderer
#                  and report "pages=<n>;width=<dip>;height=<dip>"
param(
  [Parameter(Mandatory = $true)][ValidateSet("windows", "probe", "hotkey", "target", "changing", "pdf")][string]$Action,
  [int]$ProcessId = 0,
  [string]$Path = "",
  [string]$Out = "",
  [int]$PageIndex = 0
)
$ErrorActionPreference = "Stop"

Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class DevTraceE2E {
  public delegate bool EnumProc(IntPtr hwnd, IntPtr lParam);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc callback, IntPtr lParam);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd, StringBuilder name, int max);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int max);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool GetWindowDisplayAffinity(IntPtr hwnd, out uint affinity);
  [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);

  public static List<string> Windows(uint pid) {
    var found = new List<string>();
    EnumWindows((hwnd, lParam) => {
      uint owner;
      GetWindowThreadProcessId(hwnd, out owner);
      if (owner == pid) {
        var name = new StringBuilder(256);
        GetClassName(hwnd, name, name.Capacity);
        var title = new StringBuilder(512);
        GetWindowText(hwnd, title, title.Capacity);
        uint affinity;
        if (!GetWindowDisplayAffinity(hwnd, out affinity)) affinity = 0;
        found.Add(name + "|" + title + "|" + (IsWindowVisible(hwnd) ? 1 : 0) + "|" + affinity);
      }
      return true;
    }, IntPtr.Zero);
    return found;
  }

  public static void Chord(byte[] keys) {
    const uint KEYUP = 2;
    foreach (var key in keys) keybd_event(key, 0, 0, UIntPtr.Zero);
    System.Threading.Thread.Sleep(80);
    for (int i = keys.Length - 1; i >= 0; i--) keybd_event(keys[i], 0, KEYUP, UIntPtr.Zero);
  }
}
"@

switch ($Action) {
  "windows" {
    [DevTraceE2E]::Windows([uint32]$ProcessId) | ForEach-Object { Write-Output $_ }
  }
  "probe" {
    Add-Type -AssemblyName System.Drawing
    try {
      $bitmap = New-Object System.Drawing.Bitmap 1, 1
      $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
      $graphics.CopyFromScreen(0, 0, 0, 0, (New-Object System.Drawing.Size 1, 1))
      Write-Output "screen=ok"
    } catch {
      Write-Output "screen=fail"
    }
  }
  "hotkey" {
    # VK_CONTROL, VK_MENU (Alt), VK_SHIFT, S
    [DevTraceE2E]::Chord([byte[]](0x11, 0x12, 0x10, 0x53))
  }
  "target" {
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
    $form = New-Object System.Windows.Forms.Form
    $form.Text = "E2E capture target"
    $form.BackColor = [System.Drawing.Color]::FromArgb(70, 130, 180)
    $form.StartPosition = "Manual"
    $form.Left = 60
    $form.Top = 60
    $form.Width = 640
    $form.Height = 480
    [System.Windows.Forms.Application]::Run($form)
  }
  "changing" {
    # Alternates between two solid colors every 4 seconds: a screen that changes and then settles.
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
    $form = New-Object System.Windows.Forms.Form
    $form.Text = "E2E changing target"
    $form.BackColor = [System.Drawing.Color]::FromArgb(46, 139, 87)
    $form.StartPosition = "Manual"
    $form.Left = 120
    $form.Top = 120
    $form.Width = 560
    $form.Height = 420
    $timer = New-Object System.Windows.Forms.Timer
    $timer.Interval = 4000
    $timer.Add_Tick({
        if ($form.BackColor.G -eq 139) {
          $form.BackColor = [System.Drawing.Color]::FromArgb(255, 215, 0)
        } else {
          $form.BackColor = [System.Drawing.Color]::FromArgb(46, 139, 87)
        }
      })
    $timer.Start()
    [System.Windows.Forms.Application]::Run($form)
  }
  "pdf" {
    Add-Type -AssemblyName System.Runtime.WindowsRuntime
    $null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
    $null = [Windows.Data.Pdf.PdfDocument, Windows.Data.Pdf, ContentType = WindowsRuntime]
    $null = [Windows.Storage.Streams.InMemoryRandomAccessStream, Windows.Storage.Streams, ContentType = WindowsRuntime]
    $extensions = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq "AsTask" -and $_.GetParameters().Count -eq 1 }
    $asTaskOf = $extensions | Where-Object { $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' } | Select-Object -First 1
    $asTask = $extensions | Where-Object { $_.GetParameters()[0].ParameterType.Name -eq "IAsyncAction" } | Select-Object -First 1
    function Wait-Operation($operation, [Type]$type) {
      $task = $asTaskOf.MakeGenericMethod($type).Invoke($null, @($operation))
      $task.Wait()
      $task.Result
    }
    $file = Wait-Operation ([Windows.Storage.StorageFile]::GetFileFromPathAsync($Path)) ([Windows.Storage.StorageFile])
    $document = Wait-Operation ([Windows.Data.Pdf.PdfDocument]::LoadFromFileAsync($file)) ([Windows.Data.Pdf.PdfDocument])
    $page = $document.GetPage([uint32]$PageIndex)
    $options = New-Object Windows.Data.Pdf.PdfPageRenderOptions
    $options.DestinationWidth = [uint32]($page.Size.Width * 1.5)
    $stream = New-Object Windows.Storage.Streams.InMemoryRandomAccessStream
    $asTask.Invoke($null, @($page.RenderToStreamAsync($stream, $options))).Wait()
    $rendered = [System.IO.WindowsRuntimeStreamExtensions]::AsStreamForRead($stream.GetInputStreamAt(0))
    $output = [System.IO.File]::Create($Out)
    $rendered.CopyTo($output)
    $output.Close()
    Write-Output ("pages={0};width={1};height={2}" -f $document.PageCount, [math]::Round($page.Size.Width), [math]::Round($page.Size.Height))
  }
}
