$ErrorActionPreference = "Stop"
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Runtime.WindowsRuntime

Add-Type -ReferencedAssemblies @("System.Drawing","Accessibility") -TypeDefinition @'
using System;
using Accessibility;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Text;

public sealed class M4Window {
  public long windowId;
  public uint processId;
  public string title;
  public string className;
  public int x;
  public int y;
  public int width;
  public int height;
  public bool foreground;
}

public static class M4Native {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc cb, IntPtr p);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr SetFocus(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr SetActiveWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] static extern bool AttachThreadInput(uint from, uint to, bool attach);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] static extern void keybd_event(byte key, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int command);
  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr h, int x, int y, int w, int hgt, bool repaint);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
  [DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern IntPtr SendMessage(IntPtr h, uint message, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")] static extern IntPtr GetParent(IntPtr h);
  [DllImport("user32.dll")] static extern int GetDlgCtrlID(IntPtr h);
  [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  [DllImport("oleacc.dll")]
  static extern int AccessibleObjectFromWindow(IntPtr hwnd, uint objectId, ref Guid iid,
    [In, Out, MarshalAs(UnmanagedType.IUnknown)] ref object accessible);

  public static List<M4Window> Windows() {
    var result = new List<M4Window>();
    var fg = GetForegroundWindow();
    EnumWindows((h, p) => {
      if (!IsWindowVisible(h)) return true;
      uint pid; GetWindowThreadProcessId(h, out pid);
      var title = new StringBuilder(GetWindowTextLength(h) + 1); GetWindowText(h, title, title.Capacity);
      var cls = new StringBuilder(256); GetClassName(h, cls, cls.Capacity);
      RECT r; if (!GetWindowRect(h, out r)) return true;
      result.Add(new M4Window { windowId=h.ToInt64(), processId=pid, title=title.ToString(),
        className=cls.ToString(), x=r.Left, y=r.Top, width=r.Right-r.Left, height=r.Bottom-r.Top,
        foreground=h==fg });
      return true;
    }, IntPtr.Zero);
    return result;
  }

  public static bool EnableDpiAwareness() { return SetProcessDPIAware(); }
  public static bool Activate(IntPtr h) {
    if (!IsWindow(h)) return false;
    if (GetForegroundWindow() == h) return true;
    uint targetPid, foregroundPid;
    var targetThread = GetWindowThreadProcessId(h, out targetPid);
    var foreground = GetForegroundWindow();
    var foregroundThread = GetWindowThreadProcessId(foreground, out foregroundPid);
    var currentThread = GetCurrentThreadId();
    if (foregroundThread != 0 && foregroundThread != currentThread) AttachThreadInput(currentThread, foregroundThread, true);
    if (targetThread != 0 && targetThread != currentThread) AttachThreadInput(currentThread, targetThread, true);
    ShowWindow(h, 9);
    // A synthetic Alt transition grants this foreground process permission to
    // transfer focus under Windows' foreground-lock rules.
    keybd_event(0x12, 0, 0, UIntPtr.Zero);
    BringWindowToTop(h);
    var ok = SetForegroundWindow(h);
    SetActiveWindow(h);
    SetFocus(h);
    keybd_event(0x12, 0, 2, UIntPtr.Zero);
    if (targetThread != 0 && targetThread != currentThread) AttachThreadInput(currentThread, targetThread, false);
    if (foregroundThread != 0 && foregroundThread != currentThread) AttachThreadInput(currentThread, foregroundThread, false);
    return ok || GetForegroundWindow() == h;
  }

  public static bool IsForeground(IntPtr h) { return IsWindow(h) && GetForegroundWindow() == h; }

  [StructLayout(LayoutKind.Sequential)]
  struct NMHDR { public IntPtr hwndFrom; public UIntPtr idFrom; public int code; }

  public static bool AdvanceTab(IntPtr h) {
    if (!IsWindow(h)) return false;
    const uint TCM_GETITEMCOUNT = 0x1304, TCM_GETCURSEL = 0x130B, TCM_SETCURSEL = 0x130C, WM_NOTIFY = 0x004E;
    var count = SendMessage(h, TCM_GETITEMCOUNT, IntPtr.Zero, IntPtr.Zero).ToInt32();
    var current = SendMessage(h, TCM_GETCURSEL, IntPtr.Zero, IntPtr.Zero).ToInt32();
    if (count < 1) return false;
    var next = (Math.Max(0, current) + 1) % count;
    var parent = GetParent(h);
    var controlId = GetDlgCtrlID(h);
    var header = new NMHDR { hwndFrom = h, idFrom = new UIntPtr(unchecked((uint)controlId)), code = -552 };
    var memory = Marshal.AllocHGlobal(Marshal.SizeOf(header));
    try {
      Marshal.StructureToPtr(header, memory, false);
      if (parent != IntPtr.Zero) SendMessage(parent, WM_NOTIFY, new IntPtr(controlId), memory);
      SendMessage(h, TCM_SETCURSEL, new IntPtr(next), IntPtr.Zero);
      header.code = -551;
      Marshal.StructureToPtr(header, memory, true);
      if (parent != IntPtr.Zero) SendMessage(parent, WM_NOTIFY, new IntPtr(controlId), memory);
    } finally { Marshal.FreeHGlobal(memory); }
    return SendMessage(h, TCM_GETCURSEL, IntPtr.Zero, IntPtr.Zero).ToInt32() == next;
  }

  static IAccessible AccessibleClient(IntPtr h) {
    object value = null;
    var iid = new Guid("618736E0-3C3D-11CF-810C-00AA00389B71");
    var result = AccessibleObjectFromWindow(h, 0xFFFFFFFC, ref iid, ref value);
    return result == 0 ? value as IAccessible : null;
  }

  public static string[] AccessibleChildNames(IntPtr h) {
    var accessible = AccessibleClient(h);
    if (accessible == null) return new string[0];
    var names = new List<string>();
    try {
      for (var index = 1; index <= accessible.accChildCount; index++) {
        try {
          var name = accessible.get_accName(index);
          if (!String.IsNullOrWhiteSpace(name)) names.Add(name);
        } catch {}
      }
    } finally { if (Marshal.IsComObject(accessible)) Marshal.ReleaseComObject(accessible); }
    return names.ToArray();
  }

  public static bool SelectAccessibleChild(IntPtr h, string requestedName) {
    var accessible = AccessibleClient(h);
    if (accessible == null) return false;
    try {
      for (var index = 1; index <= accessible.accChildCount; index++) {
        string name = null;
        try { name = accessible.get_accName(index); } catch {}
        if (String.Equals(name, requestedName, StringComparison.OrdinalIgnoreCase)) {
          accessible.accSelect(0x3, index);
          try { accessible.accDoDefaultAction(index); } catch {}
          return true;
        }
      }
      return false;
    } finally { if (Marshal.IsComObject(accessible)) Marshal.ReleaseComObject(accessible); }
  }

  public static string Capture(int x, int y, int width, int height, string path) {
    if (width < 1 || height < 1 || width > 16384 || height > 16384) throw new ArgumentOutOfRangeException();
    using (var bitmap = new Bitmap(width, height, PixelFormat.Format32bppArgb))
    using (var graphics = Graphics.FromImage(bitmap)) {
      graphics.CopyFromScreen(x, y, 0, 0, new Size(width, height), CopyPixelOperation.SourceCopy);
      bitmap.Save(path, ImageFormat.Png);
    }
    return path;
  }

  public static bool CaptureWindow(IntPtr h, string path) {
    RECT r; if (!IsWindow(h) || !GetWindowRect(h, out r)) return false;
    var width = r.Right-r.Left; var height = r.Bottom-r.Top;
    if (width < 1 || height < 1 || width > 16384 || height > 16384) return false;
    using (var bitmap = new Bitmap(width, height, PixelFormat.Format32bppArgb))
    using (var graphics = Graphics.FromImage(bitmap)) {
      var hdc = graphics.GetHdc();
      bool ok;
      try { ok = PrintWindow(h, hdc, 2) || PrintWindow(h, hdc, 0); }
      finally { graphics.ReleaseHdc(hdc); }
      if (!ok) return false;
      var min = 255; var max = 0;
      for (var y=0; y<height; y+=Math.Max(1,height/8))
        for (var x=0; x<width; x+=Math.Max(1,width/8)) {
          var c=bitmap.GetPixel(x,y); var l=(c.R+c.G+c.B)/3;
          min=Math.Min(min,l); max=Math.Max(max,l);
        }
      if (max-min < 5) return false;
      bitmap.Save(path, ImageFormat.Png);
      return true;
    }
  }
}
'@
[M4Native]::EnableDpiAwareness() | Out-Null

function Wait-WinRt($operation, $resultType) {
  $method = [System.WindowsRuntimeSystemExtensions].GetMethods() |
    Where-Object { $_.Name -eq "AsTask" -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1 } |
    Select-Object -First 1
  $task = $method.MakeGenericMethod($resultType).Invoke($null, @($operation))
  $task.Wait()
  return $task.Result
}

function Read-OcrImage($path, $windowId=$null, $originX=0, $originY=0) {
  [Windows.Storage.StorageFile,Windows.Storage,ContentType=WindowsRuntime] > $null
  [Windows.Storage.Streams.IRandomAccessStream,Windows.Storage.Streams,ContentType=WindowsRuntime] > $null
  [Windows.Graphics.Imaging.BitmapDecoder,Windows.Foundation,ContentType=WindowsRuntime] > $null
  [Windows.Media.Ocr.OcrEngine,Windows.Foundation,ContentType=WindowsRuntime] > $null
  $file = Wait-WinRt ([Windows.Storage.StorageFile]::GetFileFromPathAsync([IO.Path]::GetFullPath($path))) ([Windows.Storage.StorageFile])
  $stream = Wait-WinRt ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
  $decoder = Wait-WinRt ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $bitmap = Wait-WinRt ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
  $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
  if (-not $engine) { return @{ available=$false; reason="windows-ocr-unavailable"; text=""; targets=@() } }
  $recognized = Wait-WinRt ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
  $targets = @()
  foreach ($line in $recognized.Lines) {
    $words = @($line.Words)
    if ($words.Count -eq 0) { continue }
    $left = ($words | ForEach-Object {$_.BoundingRect.X} | Measure-Object -Minimum).Minimum
    $top = ($words | ForEach-Object {$_.BoundingRect.Y} | Measure-Object -Minimum).Minimum
    $right = ($words | ForEach-Object {$_.BoundingRect.X+$_.BoundingRect.Width} | Measure-Object -Maximum).Maximum
    $bottom = ($words | ForEach-Object {$_.BoundingRect.Y+$_.BoundingRect.Height} | Measure-Object -Maximum).Maximum
    $ocrWindowId = if($windowId){[string]$windowId}else{"screen"}
    $targets += [pscustomobject]@{
      targetId=[guid]::NewGuid().ToString();source="OCR";windowId=$ocrWindowId
      name=$line.Text;automationId=$null;controlType="Text"
      boundingRect=@{x=[int]($originX+$left);y=[int]($originY+$top);width=[int]($right-$left);height=[int]($bottom-$top)}
      relativeCoordinates=@{x=[int]$left;y=[int]$top}
      confidence=0.85;observedAt=[DateTime]::UtcNow.ToString("o");evidence=@{path=$path;text=$line.Text}
    }
  }
  return @{ available=$true; text=$recognized.Text; targets=$targets; path=$path }
}

function Get-WindowList {
  @([M4Native]::Windows() | ForEach-Object {
    $process = Get-Process -Id $_.processId -ErrorAction SilentlyContinue
    [pscustomobject]@{
      windowId = [string]$_.windowId
      processId = $_.processId
      processName = if ($process) { $process.ProcessName } else { $null }
      title = $_.title
      className = $_.className
      bounds = @{ x=$_.x; y=$_.y; width=$_.width; height=$_.height }
      foreground = $_.foreground
    }
  })
}

function Resolve-Window($params) {
  $windows = Get-WindowList
  if ($params.windowId) {
    $exact = $windows | Where-Object { $_.windowId -eq [string]$params.windowId } | Select-Object -First 1
    if ($exact) { return @{resolved=$true;window=$exact;confidence=1.0;resolutionMethod="hwnd"} }
  }
  $candidates = @()
  foreach($window in $windows) {
    $score=0;$signals=@()
    if($params.processId -and [int64]$window.processId -eq [int64]$params.processId){$score+=45;$signals+="pid"}
    $processNeedle=if($params.processName){[string]$params.processName}elseif($params.executable){[IO.Path]::GetFileNameWithoutExtension([string]$params.executable)}else{$null}
    if($processNeedle -and $window.processName -and $window.processName.Equals($processNeedle,[StringComparison]::OrdinalIgnoreCase)){$score+=35;$signals+="process"}
    if($params.className -and $window.className -eq [string]$params.className){$score+=25;$signals+="class"}
    if($params.title -and $window.title -eq [string]$params.title){$score+=35;$signals+="title"}
    $partial=if($params.titleContains){[string]$params.titleContains}elseif($params.application){[string]$params.application}else{$null}
    if($partial -and (($window.title -and $window.title.IndexOf($partial,[StringComparison]::OrdinalIgnoreCase)-ge 0) -or ($window.processName -and $window.processName.IndexOf($partial,[StringComparison]::OrdinalIgnoreCase)-ge 0))){$score+=25;$signals+="partial"}
    if($window.foreground){$score+=3}
    if($score -gt 0){$candidates+=@{window=$window;score=$score;signals=$signals;area=([int64]$window.bounds.width*[int64]$window.bounds.height)}}
  }
  if(-not $params.windowId -and -not $params.processId -and -not $params.processName -and -not $params.executable -and -not $params.className -and -not $params.title -and -not $params.titleContains -and -not $params.application){
    $foreground=$windows|Where-Object foreground|Select-Object -First 1
    if($foreground){return @{resolved=$true;window=$foreground;confidence=1.0;resolutionMethod="foreground"}}
  }
  $best=$candidates|Sort-Object @{Expression={$_.score};Descending=$true},@{Expression={$_.area};Descending=$true}|Select-Object -First 1
  if(-not $best -or $best.score -lt 25){return @{resolved=$false;window=$null;confidence=0;resolutionMethod="none"}}
  return @{resolved=$true;window=$best.window;confidence=[Math]::Min(0.99,0.5+($best.score/100));resolutionMethod=($best.signals -join "+")}
}

function Select-Window($params) {
  return (Resolve-Window $params).window
}

function Acquire-Foreground($params) {
  $attempts=@()
  for($i=0;$i -lt 3;$i++){
    $resolved=Resolve-Window $params
    if(-not $resolved.resolved){return @{acquired=$false;reason="window-not-found";attempts=$attempts;resolution=$resolved}}
    $window=$resolved.window;$handle=[IntPtr][Int64]$window.windowId
    if([M4Native]::IsForeground($handle)){return @{acquired=$true;window=$window;attempts=$attempts;resolution=$resolved}}
    [M4Native]::ShowWindow($handle,9)|Out-Null
    $requested=[M4Native]::Activate($handle)
    if(-not [M4Native]::IsForeground($handle)){
      try{[System.Windows.Automation.AutomationElement]::FromHandle($handle).SetFocus()}catch{}
    }
    if(-not [M4Native]::IsForeground($handle)){
      try {
        $shell = New-Object -ComObject WScript.Shell
        $null = $shell.AppActivate([int]$window.processId)
      } catch {}
    }
    Start-Sleep -Milliseconds (80*($i+1))
    $verified=[M4Native]::IsForeground($handle)
    $attempts+=@{attempt=($i+1);windowId=$window.windowId;requested=$requested;verified=$verified;resolutionMethod=$resolved.resolutionMethod}
    if($verified){return @{acquired=$true;window=(Select-Window @{windowId=$window.windowId});attempts=$attempts;resolution=$resolved}}
  }
  return @{acquired=$false;reason="foreground-not-acquired";attempts=$attempts;resolution=(Resolve-Window $params)}
}

function Convert-Element($element, $windowId, $windowIdentity=$null) {
  $r = $element.Current.BoundingRectangle
  $validRect = -not [double]::IsInfinity($r.X) -and -not [double]::IsNaN($r.X) -and
    -not [double]::IsInfinity($r.Y) -and -not [double]::IsNaN($r.Y) -and
    -not [double]::IsInfinity($r.Width) -and -not [double]::IsNaN($r.Width)
  if(-not $validRect){$r=[System.Windows.Rect]::new(0,0,0,0)}
  $patterns = @()
  foreach ($pattern in @(
    [System.Windows.Automation.InvokePattern]::Pattern,
    [System.Windows.Automation.ValuePattern]::Pattern,
    [System.Windows.Automation.SelectionItemPattern]::Pattern,
    [System.Windows.Automation.ExpandCollapsePattern]::Pattern,
    [System.Windows.Automation.TogglePattern]::Pattern,
    [System.Windows.Automation.ScrollItemPattern]::Pattern
  )) { try { if ($element.TryGetCurrentPattern($pattern, [ref]$null)) { $patterns += $pattern.ProgrammaticName } } catch {} }
  $currentValue = try { $element.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).Current.Value } catch { $null }
  $currentToggleState = try { $element.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern).Current.ToggleState.ToString() } catch { $null }
  $currentExpandState = try { $element.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern).Current.ExpandCollapseState.ToString() } catch { $null }
  [pscustomobject]@{
    targetId = [guid]::NewGuid().ToString()
    source = "UIA"
    windowId = [string]$windowId
    automationId = $element.Current.AutomationId
    name = $element.Current.Name
    controlType = $element.Current.ControlType.ProgrammaticName
    className = $element.Current.ClassName
    nativeWindowHandle = $element.Current.NativeWindowHandle
    accessibleChildren = if($element.Current.NativeWindowHandle -ne 0 -and $element.Current.ClassName -match "(?i)TabControl"){
      @([M4Native]::AccessibleChildNames([IntPtr][Int64]$element.Current.NativeWindowHandle))
    }else{@()}
    boundingRect = @{ x=[int]$r.X; y=[int]$r.Y; width=[int]$r.Width; height=[int]$r.Height }
    enabled = $element.Current.IsEnabled
    focused = $element.Current.HasKeyboardFocus
    supportedPatterns = $patterns
    value = $currentValue
    toggleState = $currentToggleState
    expandCollapseState = $currentExpandState
    confidence = 0.95
    observedAt = [DateTime]::UtcNow.ToString("o")
    windowIdentity = if($windowIdentity){@{windowId=$windowIdentity.windowId;processId=$windowIdentity.processId;processName=$windowIdentity.processName;title=$windowIdentity.title;className=$windowIdentity.className}}else{$null}
  }
}

function Get-UiElements($params) {
  $window = Select-Window $params
  if (-not $window) { return @{ window=$null; targets=@() } }
  $requestedLimit = if ($null -ne $params.maxElements) { [int]$params.maxElements } else { 200 }
  $limit = [Math]::Min(1000, [Math]::Max(1, $requestedLimit))
  $root = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr][Int64]$window.windowId)
  $all = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
  $targets = @()
  foreach ($element in $all) {
    try {
      $r = $element.Current.BoundingRectangle
      $nativeNavigationContainer = $element.Current.NativeWindowHandle -ne 0 -and
        ($element.Current.ClassName -match '(?i)(TabControl|Toolbar|Menu|TreeView|ListView)')
      if (-not $element.Current.IsOffscreen -and $r.Width -gt 0 -and $r.Height -gt 0 -and
        ($element.Current.Name -or $element.Current.AutomationId -or $nativeNavigationContainer)) {
        $targets += Convert-Element $element $window.windowId $window
        if ($targets.Count -ge $limit) { break }
      }
    } catch {}
  }
  return @{ window=$window; targets=$targets }
}

function Find-UiElement($params) {
  $window = Select-Window $params
  if (-not $window) { return @{ found=$false; reason="window-not-found" } }
  $root = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr][Int64]$window.windowId)
  $selector = if ($params.selector) { $params.selector } elseif ($params.target) { $params.target } else { $params }
  $all = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
  $hits = @()
  foreach ($element in $all) {
    try {
      $name = $element.Current.Name
      $r = $element.Current.BoundingRectangle
      $finite = -not [double]::IsInfinity($r.X) -and -not [double]::IsNaN($r.X) -and -not [double]::IsInfinity($r.Y) -and -not [double]::IsNaN($r.Y)
      $ok = -not $element.Current.IsOffscreen -and $element.Current.IsEnabled -and $finite
      if ($selector.automationId -and $element.Current.AutomationId -ne [string]$selector.automationId) { $ok=$false }
      if ($selector.name -and $name -ne [string]$selector.name) { $ok=$false }
      if ($selector.nameContains -and $name.IndexOf([string]$selector.nameContains, [StringComparison]::OrdinalIgnoreCase) -lt 0) { $ok=$false }
      if ($selector.controlType) {
        $expectedControlType = [string]$selector.controlType
        if (-not $expectedControlType.StartsWith("ControlType.", [StringComparison]::OrdinalIgnoreCase)) {
          $expectedControlType = "ControlType." + $expectedControlType
        }
        if (-not $element.Current.ControlType.ProgrammaticName.Equals($expectedControlType, [StringComparison]::OrdinalIgnoreCase)) { $ok=$false }
      }
      if ($selector.className -and $element.Current.ClassName -ne [string]$selector.className) { $ok=$false }
      if ($ok -and ($selector.withinName -or $selector.parentName)) {
        $ancestor = [System.Windows.Automation.TreeWalker]::ControlViewWalker.GetParent($element)
        $inside = $false
        $ancestorNeedle = if($selector.withinName){[string]$selector.withinName}else{[string]$selector.parentName}
        for($depth=0;$depth -lt 10 -and $ancestor;$depth++){
          if($ancestor.Current.Name.IndexOf($ancestorNeedle,[StringComparison]::OrdinalIgnoreCase) -ge 0){$inside=$true;break}
          $ancestor=[System.Windows.Automation.TreeWalker]::ControlViewWalker.GetParent($ancestor)
        }
        if(-not $inside){$ok=$false}
      }
      if ($ok -and $selector.relativeTo) {
        $anchorParams=@{windowId=$window.windowId;selector=$selector.relativeTo}
        $anchor=Find-UiElement $anchorParams
        if(-not $anchor.found){$ok=$false}else{
          $ar=$anchor.target.boundingRect
          $direction=[string]$selector.direction
          if($direction -eq "right" -and $r.X -lt ($ar.x+$ar.width)){$ok=$false}
          if($direction -eq "left" -and ($r.X+$r.Width) -gt $ar.x){$ok=$false}
          if($direction -eq "below" -and $r.Y -lt ($ar.y+$ar.height)){$ok=$false}
          if($direction -eq "above" -and ($r.Y+$r.Height) -gt $ar.y){$ok=$false}
        }
      }
      if ($ok) { $hits += ,$element }
    } catch {}
  }
  if ($hits.Count -eq 0) { return @{ found=$false; reason="target-not-found"; matchCount=0; window=$window } }
  $index = if ($null -ne $selector.occurrence) { [Math]::Max(0,[int]$selector.occurrence) } else { 0 }
  if ($index -ge $hits.Count) { return @{ found=$false; reason="occurrence-not-found"; matchCount=$hits.Count; window=$window } }
  return @{ found=$true; matchCount=$hits.Count; ambiguous=($hits.Count -gt 1 -and $null -eq $selector.occurrence); target=(Convert-Element $hits[$index] $window.windowId $window); window=$window }
}

function Invoke-UiAction($params) {
  $originalBounds = $params.target.boundingRect
  if($params.target.windowIdentity){
    foreach($field in @("processId","processName","title","className")){
      if(-not $params.$field -and $params.target.windowIdentity.$field){$params|Add-Member -NotePropertyName $field -NotePropertyValue $params.target.windowIdentity.$field -Force}
    }
  }
  $resolvedWindow = Resolve-Window $params
  if (-not $resolvedWindow.resolved) { return @{ performed=$false; reason="window-not-found"; resolution=$resolvedWindow } }
  $params.windowId = $resolvedWindow.window.windowId
  $found = $null
  for($groundAttempt=0;$groundAttempt -lt 3 -and (-not $found -or -not $found.found);$groundAttempt++){
    if($groundAttempt -gt 0){Start-Sleep -Milliseconds (120*$groundAttempt)}
    $found = Find-UiElement $params
  }
  if (-not $found.found) { return $found }
  if ($found.ambiguous -and -not $params.allowFirst) { return @{ performed=$false; reason="ambiguous-target"; matchCount=$found.matchCount; target=$found.target } }
  $window = Select-Window @{ windowId=$found.target.windowId }
  $root = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr][Int64]$window.windowId)
  $all = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
  $hit = $null
  foreach ($el in $all) {
    try {
      if ($found.target.automationId -and $el.Current.AutomationId -eq $found.target.automationId -and $el.Current.Name -eq $found.target.name) { $hit=$el;break }
      if (-not $found.target.automationId -and $el.Current.Name -eq $found.target.name -and
        $el.Current.ControlType.ProgrammaticName -eq $found.target.controlType -and
        (-not $found.target.className -or $el.Current.ClassName -eq $found.target.className)) { $hit=$el;break }
    } catch {}
  }
  if (-not $hit) { return @{ performed=$false; reason="stale-target"; target=$found.target } }
  $foreground=$null
  $currentBounds = $found.target.boundingRect
  $geometryChanged = [bool]($originalBounds -and $currentBounds -and (
    [int]$originalBounds.x -ne [int]$currentBounds.x -or
    [int]$originalBounds.y -ne [int]$currentBounds.y -or
    [int]$originalBounds.width -ne [int]$currentBounds.width -or
    [int]$originalBounds.height -ne [int]$currentBounds.height
  ))
  $action = [string]$params.action
  $method = $null
  try {
    switch ($action) {
      "invoke" { $hit.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke(); $method="InvokePattern" }
      "click" {
        try { $hit.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke(); $method="InvokePattern" }
        catch {
          $nativeHandle=[IntPtr][Int64]$hit.Current.NativeWindowHandle
          if($nativeHandle -ne [IntPtr]::Zero){
            [M4Native]::SendMessage($nativeHandle,0x00F5,[IntPtr]::Zero,[IntPtr]::Zero)|Out-Null
            $method="BM_CLICK"
          } else {
            $foreground=Acquire-Foreground @{windowId=$window.windowId;processId=$window.processId;title=$window.title;className=$window.className}
            if(-not $foreground.acquired){return @{performed=$false;reason="foreground-not-acquired";target=$found.target;foreground=$foreground}}
            $r=$hit.Current.BoundingRectangle; [M4Native]::SetCursorPos([int]($r.X+$r.Width/2),[int]($r.Y+$r.Height/2))|Out-Null; [M4Native]::mouse_event(2,0,0,0,[UIntPtr]::Zero);[M4Native]::mouse_event(4,0,0,0,[UIntPtr]::Zero);$method="bounded-pointer"
          }
        }
      }
      "focus" { $hit.SetFocus(); $method="SetFocus" }
      "setValue" { $hit.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).SetValue([string]$params.text); $method="ValuePattern" }
      "type" { try{$hit.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).SetValue([string]$params.text);$method="ValuePattern"}catch{$hit.SetFocus();[System.Windows.Forms.SendKeys]::SendWait([string]$params.text);$method="SendKeys"} }
      "select" { $hit.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern).Select(); $method="SelectionItemPattern" }
      "expand" { $hit.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern).Expand(); $method="ExpandCollapsePattern" }
      "collapse" { $hit.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern).Collapse(); $method="ExpandCollapsePattern" }
      "toggle" { $hit.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern).Toggle(); $method="TogglePattern" }
      "scrollIntoView" { $hit.GetCurrentPattern([System.Windows.Automation.ScrollItemPattern]::Pattern).ScrollIntoView(); $method="ScrollItemPattern" }
      "nextSection" {
        $nativeHandle=[IntPtr][Int64]$hit.Current.NativeWindowHandle
        $tabCount=if($nativeHandle -ne [IntPtr]::Zero){[M4Native]::SendMessage($nativeHandle,0x1304,[IntPtr]::Zero,[IntPtr]::Zero).ToInt32()}else{0}
        if($nativeHandle -eq [IntPtr]::Zero -or -not [M4Native]::AdvanceTab($nativeHandle)){throw "Native section navigation failed (class=$($hit.Current.ClassName), handle=$nativeHandle, count=$tabCount)"}
        $method="native-tab-next"
      }
      "selectAccessibleChild" {
        $nativeHandle=[IntPtr][Int64]$hit.Current.NativeWindowHandle
        if($nativeHandle -eq [IntPtr]::Zero -or -not [M4Native]::SelectAccessibleChild($nativeHandle,[string]$params.text)){throw "Accessible child selection failed"}
        $method="MSAA-accSelect"
      }
      default { throw "Unsupported UI action $action" }
    }
    return @{ performed=$true; method=$method; target=(Convert-Element $hit $window.windowId $window); foreground=$foreground; reGrounded=$true; geometryChanged=$geometryChanged; groundingAttempts=($groundAttempt+1) }
  } catch { return @{ performed=$false; reason=$_.Exception.Message; target=$found.target; foreground=$foreground; reGrounded=$true; geometryChanged=$geometryChanged; groundingAttempts=($groundAttempt+1) } }
}

function Invoke-Operation($operation, $params) {
  switch ($operation) {
    "host.health" { return @{ ok=$true; pid=$PID; protocol="m4-windows-host/1"; sta=([Threading.Thread]::CurrentThread.ApartmentState.ToString()) } }
    "window.enumerate" { return @{ windows=(Get-WindowList) } }
    "window.resolve" { return Resolve-Window $params }
    "window.wait" {
      $timeout=[Math]::Min(20000,[Math]::Max(100,[int]$params.timeoutMs));$watch=[Diagnostics.Stopwatch]::StartNew();$found=$null
      while($watch.ElapsedMilliseconds -lt $timeout -and -not $found){$found=Select-Window $params;if(-not $found){Start-Sleep -Milliseconds 100}}
      $waitReason=if($found){$null}else{"window-timeout"}
      return @{found=[bool]$found;window=$found;elapsedMs=$watch.ElapsedMilliseconds;reason=$waitReason}
    }
    "window.activate" { $focus=Acquire-Foreground $params;$current=[M4Native]::GetForegroundWindow().ToInt64();return @{performed=$focus.acquired;reason=$focus.reason;foregroundWindowId=[string]$current;window=$focus.window;attempts=$focus.attempts;resolution=$focus.resolution} }
    "window.state" { $w=Select-Window $params;if(-not $w){return @{performed=$false;reason="window-not-found"}};$commands=@{minimize=6;maximize=3;restore=9};$cmd=$commands[[string]$params.state];if(-not $cmd){throw "Unsupported window state"};return @{performed=[M4Native]::ShowWindow([IntPtr][Int64]$w.windowId,$cmd);windowId=$w.windowId;state=$params.state} }
    "window.moveResize" { $w=Select-Window $params;if(-not $w){return @{performed=$false;reason="window-not-found"}};return @{performed=[M4Native]::MoveWindow([IntPtr][Int64]$w.windowId,[int]$params.x,[int]$params.y,[int]$params.width,[int]$params.height,$true);windowId=$w.windowId} }
    "ui.inspect" { return Get-UiElements $params }
    "ui.find" { return Find-UiElement $params }
    "ui.action" { return Invoke-UiAction $params }
    "pointer.move" { return @{performed=[M4Native]::SetCursorPos([int]$params.x,[int]$params.y);x=[int]$params.x;y=[int]$params.y} }
    "pointer.click" { if($params.windowId -or $params.application){$focus=Acquire-Foreground $params;if(-not $focus.acquired){return @{performed=$false;reason=$focus.reason;foreground=$focus}};$w=$focus.window};$button=if($params.button){[string]$params.button}else{"left"};[M4Native]::SetCursorPos([int]$params.x,[int]$params.y)|Out-Null;$flags=if($button -eq "right"){8}else{2};[M4Native]::mouse_event($flags,0,0,0,[UIntPtr]::Zero);[M4Native]::mouse_event(($flags*2),0,0,0,[UIntPtr]::Zero);return @{performed=$true;x=$params.x;y=$params.y;button=$button;windowId=if($w){$w.windowId}else{$null};foreground=$focus} }
    "pointer.wheel" {
      if($params.windowId -or $params.application){$focus=Acquire-Foreground $params;if(-not $focus.acquired){return @{performed=$false;reason=$focus.reason;foreground=$focus}};$w=$focus.window}
      $delta=[Math]::Max(-1200,[Math]::Min(1200,[int]$params.delta))
      [M4Native]::mouse_event(0x0800,0,0,[uint32]$delta,[UIntPtr]::Zero)
      return @{performed=$true;delta=$delta;windowId=if($w){$w.windowId}else{$null}}
    }
    "pointer.drag" {
      if($params.windowId -or $params.application){$focus=Acquire-Foreground $params;if(-not $focus.acquired){return @{performed=$false;reason=$focus.reason;foreground=$focus}};$w=$focus.window}
      [M4Native]::SetCursorPos([int]$params.fromX,[int]$params.fromY)|Out-Null
      [M4Native]::mouse_event(2,0,0,0,[UIntPtr]::Zero)
      $steps=10
      for($i=1;$i -le $steps;$i++){
        $x=[int]($params.fromX+(($params.toX-$params.fromX)*$i/$steps))
        $y=[int]($params.fromY+(($params.toY-$params.fromY)*$i/$steps))
        [M4Native]::SetCursorPos($x,$y)|Out-Null;Start-Sleep -Milliseconds 12
      }
      [M4Native]::mouse_event(4,0,0,0,[UIntPtr]::Zero)
      return @{performed=$true;from=@{x=$params.fromX;y=$params.fromY};to=@{x=$params.toX;y=$params.toY};windowId=if($w){$w.windowId}else{$null}}
    }
    "keyboard.type" {
      if($params.windowId -or $params.application){$focus=Acquire-Foreground $params;if(-not $focus.acquired){return @{performed=$false;reason=$focus.reason;foreground=$focus}};$w=$focus.window}
      [System.Windows.Forms.SendKeys]::SendWait([string]$params.text);$inputWindowId=if($w){$w.windowId}else{$null};return @{performed=$true;length=([string]$params.text).Length;windowId=$inputWindowId;foreground=$focus}
    }
    "keyboard.press" {
      if($params.windowId -or $params.application){$focus=Acquire-Foreground $params;if(-not $focus.acquired){return @{performed=$false;reason=$focus.reason;foreground=$focus}};$w=$focus.window}
      [System.Windows.Forms.SendKeys]::SendWait([string]$params.keys);$inputWindowId=if($w){$w.windowId}else{$null};return @{performed=$true;keys=$params.keys;windowId=$inputWindowId;foreground=$focus}
    }
    "clipboard.read" { return @{text=[System.Windows.Forms.Clipboard]::GetText()} }
    "clipboard.write" { $previous=[System.Windows.Forms.Clipboard]::GetText();[System.Windows.Forms.Clipboard]::SetText([string]$params.text);return @{written=$true;previousText=$previous} }
    "screen.capture" {
      $w = if ($params.windowId -or $params.application) { Select-Window $params } else { $null }
      if(($params.windowId -or $params.application) -and -not $w){return @{captured=$false;reason="window-not-found"}}
      if ($w) { $r=$w.bounds } elseif ($params.region) { $r=$params.region } else { $b=[System.Windows.Forms.SystemInformation]::VirtualScreen;$r=@{x=$b.X;y=$b.Y;width=$b.Width;height=$b.Height} }
      $target=[IO.Path]::GetFullPath([string]$params.path);[IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($target))|Out-Null
      $method="screen-region"
      if($w -and [M4Native]::CaptureWindow([IntPtr][Int64]$w.windowId,$target)){$method="PrintWindow"}
      else{[M4Native]::Capture([int]$r.x,[int]$r.y,[int]$r.width,[int]$r.height,$target)|Out-Null}
      $capturedWindowId = if($w){$w.windowId}else{$null}
      return @{captured=$true;path=$target;bounds=$r;windowId=$capturedWindowId;method=$method;timestamp=[DateTime]::UtcNow.ToString("o")}
    }
    "ocr.read" {
      return Read-OcrImage ([string]$params.path) $params.windowId ([int]$params.originX) ([int]$params.originY)
    }
    "vision.locate" {
      $w = Select-Window $params
      if(($params.windowId -or $params.application) -and -not $w){return @{found=$false;reason="window-not-found";target=$null;matches=@()}}
      $capturePath = if($params.path){[IO.Path]::GetFullPath([string]$params.path)}else{[IO.Path]::Combine([IO.Path]::GetTempPath(),"syscora-m4","vision-"+[guid]::NewGuid().ToString()+".png")}
      if(-not $params.path){
        [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($capturePath))|Out-Null
        $r=if($w){$w.bounds}else{@{x=0;y=0;width=[System.Windows.Forms.SystemInformation]::VirtualScreen.Width;height=[System.Windows.Forms.SystemInformation]::VirtualScreen.Height}}
        $direct=$false
        if($w){$direct=[M4Native]::CaptureWindow([IntPtr][Int64]$w.windowId,$capturePath)}
        if(-not $direct){[M4Native]::Capture([int]$r.x,[int]$r.y,[int]$r.width,[int]$r.height,$capturePath)|Out-Null}
      } else { $r=@{x=[int]$params.originX;y=[int]$params.originY} }
      $ocr=Read-OcrImage $capturePath $(if($w){$w.windowId}else{$params.windowId}) ([int]$r.x) ([int]$r.y)
      $query=[string]$params.query
      $pattern="(?i)(?<!\p{L})"+[regex]::Escape($query)+"(?!\p{L})"
      $matches=@($ocr.targets|Where-Object{[regex]::IsMatch([string]$_.name,$pattern)})
      $matchedTarget=if($matches.Count){$matches[0]}else{$null}
      $reason=if($matches.Count){$null}else{"visual-target-not-found"}
      return @{found=($matches.Count -gt 0);target=$matchedTarget;matches=$matches;ocrText=$ocr.text;capturePath=$capturePath;reason=$reason}
    }
    default { throw "Unknown host operation: $operation" }
  }
}

while ($null -ne ($line = [Console]::In.ReadLine())) {
  if (-not $line.Trim()) { continue }
  $id = $null
  try {
    $request = $line | ConvertFrom-Json
    $id = $request.id
    $result = Invoke-Operation ([string]$request.operation) $request.params
    [Console]::Out.WriteLine((@{id=$id;ok=$true;result=$result} | ConvertTo-Json -Compress -Depth 12))
  } catch {
    [Console]::Out.WriteLine((@{id=$id;ok=$false;error=$_.Exception.Message} | ConvertTo-Json -Compress -Depth 5))
  }
  [Console]::Out.Flush()
}
