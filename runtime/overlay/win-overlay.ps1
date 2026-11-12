# dsh-laodi Windows overlay host. JSON lines on stdin/stdout. STA required.
param(
  [double]$X = 80,
  [double]$Y = 80,
  [double]$Width = 300,
  [double]$Height = 220
)
$ErrorActionPreference = 'Continue'
try {
  [Console]::InputEncoding = New-Object System.Text.UTF8Encoding $false
  [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
} catch {}

Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase
[System.Windows.Media.RenderOptions]::ProcessRenderMode = [System.Windows.Interop.RenderMode]::SoftwareOnly

Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class DshPetNative {
  public const int GWL_EXSTYLE = -20;
  public const int WS_EX_TRANSPARENT = 0x00000020;
  public const int WS_EX_TOOLWINDOW = 0x00000080;
  public const int WS_EX_NOACTIVATE = 0x08000000;
  public const int WS_EX_LAYERED = 0x00080000;
  public static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);
  public const uint SWP_NOSIZE = 0x0001;
  public const uint SWP_NOMOVE = 0x0002;
  public const uint SWP_NOACTIVATE = 0x0010;
  public const uint SWP_SHOWWINDOW = 0x0040;
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT lpPoint);
  [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] public static extern IntPtr GetWindowLongPtr(IntPtr hWnd, int nIndex);
  [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW")] public static extern IntPtr SetWindowLongPtr(IntPtr hWnd, int nIndex, IntPtr dwNewLong);
  [DllImport("user32.dll", SetLastError = true)] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
  [DllImport("user32.dll", SetLastError = true)] public static extern bool DestroyIcon(IntPtr hIcon);
  [StructLayout(LayoutKind.Sequential)]
  public struct POINT { public int X; public int Y; }
}
"@

function Emit($obj) {
  try {
    $json = $obj | ConvertTo-Json -Compress -Depth 8
    [Console]::Out.WriteLine($json)
    [Console]::Out.Flush()
  } catch {}
}

$script:currentBounds = @{ x = [int][math]::Round($X); y = [int][math]::Round($Y); width = [int][math]::Round($Width); height = [int][math]::Round($Height) }
$script:shown = $false
$script:mode = 'desktop'
$script:ignoreMouse = $true
$script:hwnd = [IntPtr]::Zero
$script:bubbleTimer = $null
$script:userHidden = $false
$script:tray = $null
$script:trayIconOn = $null
$script:trayIconOff = $null
$script:trayToggleItem = $null
$script:trayItemShow = $null
$script:trayItemHide = $null
$script:trayAvailable = $false

try {
  Add-Type -AssemblyName System.Windows.Forms, System.Drawing
  $script:trayAvailable = $true
} catch {
  $script:trayAvailable = $false
  try { [Console]::Error.WriteLine(("tray assembly failed: {0}" -f $_)) } catch {}
}

$win = New-Object System.Windows.Window
$win.Title = [string]([char]0x966A) + [string]([char]0x73A9)
$win.WindowStyle = [System.Windows.WindowStyle]::None
$win.AllowsTransparency = $true
$win.Background = [System.Windows.Media.Brushes]::Transparent
$win.Topmost = $true
$win.ShowInTaskbar = $false
$win.ResizeMode = [System.Windows.ResizeMode]::NoResize
$win.ShowActivated = $false
$win.WindowStartupLocation = [System.Windows.WindowStartupLocation]::Manual
$win.Width = $Width
$win.Height = $Height
$win.Left = $X
$win.Top = $Y

function New-Brush($hex) {
  return [System.Windows.Media.BrushConverter]::new().ConvertFromString($hex)
}

$root = New-Object System.Windows.Controls.Grid
$root.Background = [System.Windows.Media.Brushes]::Transparent
$col0 = New-Object System.Windows.Controls.ColumnDefinition
$col0.Width = New-Object System.Windows.GridLength(1, [System.Windows.GridUnitType]::Star)
$col1 = New-Object System.Windows.Controls.ColumnDefinition
$col1.Width = New-Object System.Windows.GridLength(112)
$row0 = New-Object System.Windows.Controls.RowDefinition
$row0.Height = New-Object System.Windows.GridLength(1, [System.Windows.GridUnitType]::Star)
$row1 = New-Object System.Windows.Controls.RowDefinition
$row1.Height = [System.Windows.GridLength]::Auto
[void]$root.ColumnDefinitions.Add($col0)
[void]$root.ColumnDefinitions.Add($col1)
[void]$root.RowDefinitions.Add($row0)
[void]$root.RowDefinitions.Add($row1)
$root.Margin = New-Object System.Windows.Thickness(8)

$bubble = New-Object System.Windows.Controls.Border
$bubble.Background = New-Brush '#E016100C'
$bubble.CornerRadius = New-Object System.Windows.CornerRadius(14)
$bubble.Padding = New-Object System.Windows.Thickness(10, 10, 12, 10)
$bubble.Margin = New-Object System.Windows.Thickness(0, 0, 8, 6)
$bubble.Visibility = [System.Windows.Visibility]::Collapsed
$bubble.IsHitTestVisible = $false
$bubble.MaxHeight = 140
$bubble.VerticalAlignment = [System.Windows.VerticalAlignment]::Bottom
[System.Windows.Controls.Grid]::SetColumn($bubble, 0)
[System.Windows.Controls.Grid]::SetRow($bubble, 0)
$bubbleStack = New-Object System.Windows.Controls.StackPanel
$who = New-Object System.Windows.Controls.TextBlock
$who.Text = $win.Title
$who.FontSize = 11
$who.Foreground = New-Brush '#FFC48A'
$who.Margin = New-Object System.Windows.Thickness(0, 0, 0, 4)
$bubbleText = New-Object System.Windows.Controls.TextBlock
$bubbleText.TextWrapping = [System.Windows.TextWrapping]::Wrap
$bubbleText.Foreground = New-Brush '#FFF4F6FF'
$bubbleText.FontSize = 14
$bubbleText.FontFamily = New-Object System.Windows.Media.FontFamily('Microsoft YaHei, Segoe UI')
[void]$bubbleStack.Children.Add($who)
[void]$bubbleStack.Children.Add($bubbleText)
$bubble.Child = $bubbleStack
[void]$root.Children.Add($bubble)

$pet = New-Object System.Windows.Controls.Grid
$pet.Width = 104
$pet.Height = 104
$pet.HorizontalAlignment = [System.Windows.HorizontalAlignment]::Right
$pet.VerticalAlignment = [System.Windows.VerticalAlignment]::Bottom
$pet.Cursor = [System.Windows.Input.Cursors]::Hand
$pet.Tag = 'hit'
[System.Windows.Controls.Grid]::SetColumn($pet, 1)
[System.Windows.Controls.Grid]::SetRow($pet, 0)

$face = New-Object System.Windows.Media.RadialGradientBrush
$face.GradientOrigin = New-Object System.Windows.Point(0.38, 0.32)
$face.Center = New-Object System.Windows.Point(0.38, 0.32)
$face.RadiusX = 0.7
$face.RadiusY = 0.7
$s0 = New-Object System.Windows.Media.GradientStop ((New-Brush '#FFE7C2').Color), 0
$s1 = New-Object System.Windows.Media.GradientStop ((New-Brush '#F3B56A').Color), 0.55
$s2 = New-Object System.Windows.Media.GradientStop ((New-Brush '#E08A3C').Color), 1
[void]$face.GradientStops.Add($s0)
[void]$face.GradientStops.Add($s1)
[void]$face.GradientStops.Add($s2)

$circle = New-Object System.Windows.Shapes.Ellipse
$circle.Width = 104
$circle.Height = 104
$circle.Fill = $face
$circle.Stroke = New-Brush '#7A3B16'
$circle.StrokeThickness = 3.25
[void]$pet.Children.Add($circle)

function Add-Dot($x, $y, $w, $h, $color) {
  $e = New-Object System.Windows.Shapes.Ellipse
  $e.Width = $w; $e.Height = $h
  $e.Fill = New-Brush $color
  $e.HorizontalAlignment = 'Left'
  $e.VerticalAlignment = 'Top'
  $e.Margin = New-Object System.Windows.Thickness($x, $y, 0, 0)
  $e.IsHitTestVisible = $false
  [void]$pet.Children.Add($e)
}
$k = 0.8125
Add-Dot (46*$k-6*$k) (58*$k-8*$k) (12*$k) (16*$k) '#2B2118'
Add-Dot (82*$k-6*$k) (58*$k-8*$k) (12*$k) (16*$k) '#2B2118'
Add-Dot (44*$k-2*$k) (56*$k-2*$k) (4*$k) (4*$k) '#FFF8EE'
Add-Dot (80*$k-2*$k) (56*$k-2*$k) (4*$k) (4*$k) '#FFF8EE'

function Add-Stroke($data) {
  $p = New-Object System.Windows.Shapes.Path
  $p.Stroke = New-Brush '#7A3B16'
  $p.StrokeThickness = 3.25
  $p.StrokeStartLineCap = 'Round'
  $p.StrokeEndLineCap = 'Round'
  $p.Data = [System.Windows.Media.Geometry]::Parse($data)
  $p.IsHitTestVisible = $false
  [void]$pet.Children.Add($p)
}
Add-Stroke ("M {0} {1} C {2} {3} {4} {5} {6} {7}" -f (46*$k),(82*$k),(52*$k),(90*$k),(76*$k),(90*$k),(82*$k),(82*$k))
Add-Stroke ("M {0} {1} C {2} {3} {4} {5} {6} {7}" -f (40*$k),(40*$k),(46*$k),(32*$k),(54*$k),(32*$k),(58*$k),(38*$k))
Add-Stroke ("M {0} {1} C {2} {3} {4} {5} {6} {7}" -f (88*$k),(40*$k),(82*$k),(32*$k),(74*$k),(32*$k),(70*$k),(38*$k))
[void]$root.Children.Add($pet)

$composer = New-Object System.Windows.Controls.Grid
$composer.Margin = New-Object System.Windows.Thickness(0, 8, 0, 0)
$composer.Tag = 'hit'
[System.Windows.Controls.Grid]::SetColumn($composer, 0)
[System.Windows.Controls.Grid]::SetColumnSpan($composer, 2)
[System.Windows.Controls.Grid]::SetRow($composer, 1)
$c0 = New-Object System.Windows.Controls.ColumnDefinition
$c0.Width = New-Object System.Windows.GridLength(1, [System.Windows.GridUnitType]::Star)
$c1 = New-Object System.Windows.Controls.ColumnDefinition
$c1.Width = [System.Windows.GridLength]::Auto
[void]$composer.ColumnDefinitions.Add($c0)
[void]$composer.ColumnDefinitions.Add($c1)

$inputBox = New-Object System.Windows.Controls.TextBox
$inputBox.Height = 32
$inputBox.FontSize = 13
$inputBox.FontFamily = $bubbleText.FontFamily
$inputBox.Foreground = New-Brush '#FFF4F6FF'
$inputBox.Background = New-Brush '#E016100C'
$inputBox.BorderThickness = New-Object System.Windows.Thickness(0)
$inputBox.Padding = New-Object System.Windows.Thickness(12, 6, 12, 6)
$inputBox.MaxLength = 200
$inputBox.VerticalContentAlignment = 'Center'
$inputBox.Tag = 'hit'
[System.Windows.Controls.Grid]::SetColumn($inputBox, 0)

$sendBtn = New-Object System.Windows.Controls.Button
$sendBtn.Content = [string]([char]0x53D1) + [char]0x9001
$sendBtn.Height = 32
$sendBtn.Margin = New-Object System.Windows.Thickness(6, 0, 0, 0)
$sendBtn.Padding = New-Object System.Windows.Thickness(12, 0, 12, 0)
$sendBtn.Background = New-Brush '#E08A3C'
$sendBtn.Foreground = New-Brush '#2B1608'
$sendBtn.BorderThickness = New-Object System.Windows.Thickness(0)
$sendBtn.Cursor = [System.Windows.Input.Cursors]::Hand
$sendBtn.Tag = 'hit'
[System.Windows.Controls.Grid]::SetColumn($sendBtn, 1)
[void]$composer.Children.Add($inputBox)
[void]$composer.Children.Add($sendBtn)
[void]$root.Children.Add($composer)
$win.Content = $root

function Get-PrefPath {
  $home = if ($env:DSH_HOME -and $env:DSH_HOME.Trim()) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
  return (Join-Path $home 'dsh-laodi-pet.json')
}

function Read-PetVisiblePref {
  try {
    $pref = Get-PrefPath
    if (Test-Path -LiteralPath $pref) {
      $json = Get-Content -LiteralPath $pref -Raw -Encoding UTF8 | ConvertFrom-Json
      if ($null -ne $json.visible) { return [bool]$json.visible }
    }
  } catch {}
  return $true
}

function Save-PetVisiblePref {
  try {
    $pref = Get-PrefPath
    $dir = Split-Path $pref -Parent
    if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    $json = (@{ visible = [bool](-not $script:userHidden) } | ConvertTo-Json -Compress)
    [System.IO.File]::WriteAllText($pref, $json, (New-Object System.Text.UTF8Encoding $false))
  } catch {}
}

function New-PetTrayIcon([bool]$dimmed) {
  $size = 32
  $bmp = New-Object System.Drawing.Bitmap $size, $size, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.Clear([System.Drawing.Color]::Transparent)
  if ($dimmed) {
    $face = [System.Drawing.Color]::FromArgb(255, 176, 176, 176)
    $line = [System.Drawing.Color]::FromArgb(255, 90, 90, 90)
  } else {
    $face = [System.Drawing.Color]::FromArgb(255, 224, 138, 60)
    $line = [System.Drawing.Color]::FromArgb(255, 122, 59, 22)
  }
  $brush = New-Object System.Drawing.SolidBrush $face
  $pen = New-Object System.Drawing.Pen $line, 2.2
  $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
  $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
  $g.FillEllipse($brush, 1, 1, 29, 29)
  $g.DrawEllipse($pen, 1, 1, 29, 29)
  $eye = New-Object System.Drawing.SolidBrush $line
  $g.FillEllipse($eye, 9, 11, 4, 6)
  $g.FillEllipse($eye, 19, 11, 4, 6)
  $g.DrawArc($pen, 9, 13, 14, 11, 25, 130)
  $g.Dispose()
  $brush.Dispose()
  $pen.Dispose()
  $eye.Dispose()
  $handle = $bmp.GetHicon()
  $tmp = [System.Drawing.Icon]::FromHandle($handle)
  $icon = [System.Drawing.Icon]$tmp.Clone()
  [void][DshPetNative]::DestroyIcon($handle)
  $bmp.Dispose()
  return $icon
}

function Get-TrayLabel([string]$kind) {
  switch ($kind) {
    'title' { return [string]([char]0x966A) + [char]0x73A9 }
    'show'  { return [string]([char]0x663E) + [char]0x793A + [char]0x684C + [char]0x5BA0 }
    'hide'  { return [string]([char]0x9690) + [char]0x85CF + [char]0x684C + [char]0x5BA0 }
    'tip'   { return (([string]([char]0x966A) + [char]0x73A9) + ' - ' + [char]0x53F3 + [char]0x952E + [char]0x6253 + [char]0x5F00 + [char]0x83DC + [char]0x5355) }
    default { return '' }
  }
}

function Update-Tray {
  if (-not $script:tray) { return }
  $visible = [bool]$script:shown
  try {
    $script:tray.Icon = if ($visible) { $script:trayIconOn } else { $script:trayIconOff }
    $script:tray.Text = Get-TrayLabel 'tip'
    if ($script:trayItemShow) {
      $script:trayItemShow.Checked = $visible
      $script:trayItemShow.Enabled = -not $visible
    }
    if ($script:trayItemHide) {
      $script:trayItemHide.Checked = -not $visible
      $script:trayItemHide.Enabled = $visible
    }
  } catch {}
}

# Build the tray context menu in one place so later items can be added here.
function Build-TrayMenu {
  $menu = New-Object System.Windows.Forms.ContextMenu

  $itemShow = New-Object System.Windows.Forms.MenuItem
  $itemShow.Text = Get-TrayLabel 'show'
  $itemShow.RadioCheck = $true
  $itemShow.Add_Click({ Set-PetVisible $true 'tray' })
  $script:trayItemShow = $itemShow
  [void]$menu.MenuItems.Add($itemShow)

  $itemHide = New-Object System.Windows.Forms.MenuItem
  $itemHide.Text = Get-TrayLabel 'hide'
  $itemHide.RadioCheck = $true
  $itemHide.Add_Click({ Set-PetVisible $false 'tray' })
  $script:trayItemHide = $itemHide
  [void]$menu.MenuItems.Add($itemHide)

  # Future menu items go below a separator, e.g.:
  # [void]$menu.MenuItems.Add('-')
  # $itemFoo = New-Object System.Windows.Forms.MenuItem
  # $itemFoo.Text = '...'
  # $itemFoo.Add_Click({ ... })
  # [void]$menu.MenuItems.Add($itemFoo)

  return $menu
}

function Show-TrayMenu {
  if (-not $script:tray) { return }
  try {
    $flags = [System.Reflection.BindingFlags]::Instance -bor [System.Reflection.BindingFlags]::NonPublic
    $mi = $script:tray.GetType().GetMethod('ShowContextMenu', $flags)
    if ($mi) { [void]$mi.Invoke($script:tray, @()) }
  } catch {}
}

function Set-PetVisible([bool]$visible, [string]$source = 'tray') {
  if ($visible) {
    $script:userHidden = $false
    $script:shown = $true
    $win.Opacity = 1
    $win.Show()
    $win.Topmost = $true
    Apply-ExStyle
  } else {
    if ($source -eq 'tray' -or $source -eq 'pref') { $script:userHidden = $true }
    $script:shown = $false
    if ($win.IsVisible) { $win.Hide() }
  }
  if ($source -eq 'tray') { Save-PetVisiblePref }
  Update-Tray
  Emit @{ event = 'visibility'; visible = [bool]$visible; source = $source }
  try { [Console]::Error.WriteLine(("pet visible={0} source={1}" -f $visible, $source)) } catch {}
}

function Toggle-PetVisible {
  Set-PetVisible (-not $script:shown) 'tray'
}

function Dispose-Tray {
  try {
    if ($script:tray) {
      $script:tray.Visible = $false
      $script:tray.Dispose()
    }
  } catch {}
  $script:tray = $null
  try { if ($script:trayIconOn) { $script:trayIconOn.Dispose() } } catch {}
  try { if ($script:trayIconOff) { $script:trayIconOff.Dispose() } } catch {}
  $script:trayIconOn = $null
  $script:trayIconOff = $null
}

function Start-Tray {
  if (-not $script:trayAvailable) { return }
  try {
    $script:trayIconOn = New-PetTrayIcon $false
    $script:trayIconOff = New-PetTrayIcon $true
    $tray = New-Object System.Windows.Forms.NotifyIcon
    $tray.Icon = $script:trayIconOn
    $tray.Visible = $true
    $tray.Text = Get-TrayLabel 'tip'
    $tray.ContextMenu = Build-TrayMenu
    # Visibility is controlled from the context menu only.
    # Left-click opens the same menu so the entries are easy to find.
    $tray.Add_MouseUp({
      param($sender, $e)
      if ($e.Button -eq [System.Windows.Forms.MouseButtons]::Left) { Show-TrayMenu }
    })
    $script:tray = $tray
    Update-Tray
    try { [Console]::Error.WriteLine('tray ready') } catch {}
  } catch {
    $script:trayAvailable = $false
    try { [Console]::Error.WriteLine(("tray start failed: {0}" -f $_)) } catch {}
  }
}

function Apply-ExStyle {
  if ($script:hwnd -eq [IntPtr]::Zero) { return }
  $style = [DshPetNative]::GetWindowLongPtr($script:hwnd, [DshPetNative]::GWL_EXSTYLE).ToInt64()
  # Do not add WS_EX_LAYERED: WPF AllowsTransparency already uses UpdateLayeredWindow;
  # SetWindowLongPtr(LAYERED) blanks the window so the pet is invisible.
  $style = $style -bor [DshPetNative]::WS_EX_TOOLWINDOW -bor [DshPetNative]::WS_EX_NOACTIVATE
  if ($script:ignoreMouse) { $style = $style -bor [DshPetNative]::WS_EX_TRANSPARENT }
  else { $style = $style -band (-bnot [DshPetNative]::WS_EX_TRANSPARENT) }
  [void][DshPetNative]::SetWindowLongPtr($script:hwnd, [DshPetNative]::GWL_EXSTYLE, [IntPtr]$style)
  [void][DshPetNative]::SetWindowPos($script:hwnd, [DshPetNative]::HWND_TOPMOST, 0, 0, 0, 0, ([DshPetNative]::SWP_NOMOVE -bor [DshPetNative]::SWP_NOSIZE -bor [DshPetNative]::SWP_NOACTIVATE -bor 0x0020))
}

function Point-HitsInteractive($pt) {
  try {
    $el = [System.Windows.Media.VisualTreeHelper]::HitTest($win, $pt)
    if (-not $el) { return $false }
    $vis = $el.VisualHit
    while ($null -ne $vis) {
      if ($vis -eq $pet -or $vis -eq $composer -or $vis -eq $inputBox -or $vis -eq $sendBtn) { return $true }
      if ($vis -is [System.Windows.FrameworkElement] -and $vis.Tag -eq 'hit') { return $true }
      $vis = [System.Windows.Media.VisualTreeHelper]::GetParent($vis)
    }
  } catch {}
  return $false
}

function Sync-HitTest {
  try {
    $p = New-Object DshPetNative+POINT
    if (-not [DshPetNative]::GetCursorPos([ref]$p)) { return }
    $sp = New-Object System.Windows.Point $p.X, $p.Y
    $lp = $win.PointFromScreen($sp)
    $inside = ($lp.X -ge 0 -and $lp.Y -ge 0 -and $lp.X -le $win.ActualWidth -and $lp.Y -le $win.ActualHeight)
    $hit = $false
    if ($inside -and $script:shown) { $hit = Point-HitsInteractive $lp }
    $ignore = -not $hit
    if ($ignore -ne $script:ignoreMouse) {
      $script:ignoreMouse = $ignore
      Apply-ExStyle
    }
  } catch {}
}

function Set-Bubble($text) {
  $t = [string]$text
  if ([string]::IsNullOrWhiteSpace($t)) { return }
  $bubbleText.Text = $t
  $bubble.Visibility = [System.Windows.Visibility]::Visible
  if ($script:bubbleTimer) { $script:bubbleTimer.Stop() }
  $script:bubbleTimer = New-Object System.Windows.Threading.DispatcherTimer
  $script:bubbleTimer.Interval = [TimeSpan]::FromSeconds(12)
  $script:bubbleTimer.Add_Tick({
    $bubble.Visibility = [System.Windows.Visibility]::Collapsed
    $script:bubbleTimer.Stop()
  })
  $script:bubbleTimer.Start()
}

function Apply-Mode($next) {
  if ($next -eq 'game') { $script:mode = 'game'; $composer.Visibility = [System.Windows.Visibility]::Collapsed }
  else { $script:mode = 'desktop'; $composer.Visibility = [System.Windows.Visibility]::Visible }
}

function Apply-Bounds($x, $y, $w, $h) {
  if ($null -ne $w -and $w -gt 0) { $win.Width = [double]$w }
  if ($null -ne $h -and $h -gt 0) { $win.Height = [double]$h }
  if ($null -ne $x) { $win.Left = [double]$x }
  if ($null -ne $y) { $win.Top = [double]$y }
  $script:currentBounds = @{ x = [int][math]::Round($win.Left); y = [int][math]::Round($win.Top); width = [int][math]::Round($win.Width); height = [int][math]::Round($win.Height) }
  try { [Console]::Error.WriteLine(("bounds applied {0},{1} {2}x{3}" -f $script:currentBounds.x, $script:currentBounds.y, $script:currentBounds.width, $script:currentBounds.height)) } catch {}
}

function Emit-Moved {
  Emit @{ event = 'moved'; x = [int][math]::Round($win.Left); y = [int][math]::Round($win.Top); width = [int][math]::Round($win.Width); height = [int][math]::Round($win.Height) }
}

function Send-Chat {
  $text = ([string]$inputBox.Text).Trim()
  if (-not $text) { return }
  $inputBox.Text = ''
  Emit @{ event = 'chat'; text = $text }
}

function Handle-Command($line) {
  if ([string]::IsNullOrWhiteSpace($line)) { return }
  try { $cmd = $line | ConvertFrom-Json } catch { return }
  $op = [string]$cmd.op
  switch ($op) {
    'show' {
      if ($script:userHidden) {
        try { [Console]::Error.WriteLine('show ignored: user hidden') } catch {}
      } else {
        Set-PetVisible $true 'host'
      }
    }
    'hide' {
      Set-PetVisible $false 'host'
    }
    'bounds' { Apply-Bounds $cmd.x $cmd.y $cmd.width $cmd.height }
    'ignoreMouse' { $script:ignoreMouse = [bool]$cmd.ignore; Apply-ExStyle }
    'state' {
      if ($cmd.state) {
        if ($cmd.state.mode) { Apply-Mode ([string]$cmd.state.mode) }
        if ($cmd.state.bubble) { Set-Bubble ([string]$cmd.state.bubble) }
      }
    }
    'channel' {
      $ch = [string]$cmd.channel
      if ($ch -eq 'dsh:bubble' -or $ch -like '*bubble') { Set-Bubble $cmd.payload.text }
      elseif ($ch -like '*visibility') {
        if ($cmd.payload.visible -eq $false) { Handle-Command '{"op":"hide"}' }
      }
    }
    'quit' { try { $win.Close() } catch {}; try { $app.Shutdown() } catch {} }
  }
}

$pet.Add_MouseLeftButtonDown({
  try {
    $script:ignoreMouse = $false
    Apply-ExStyle
    $win.DragMove()
    Emit-Moved
  } catch {}
})

$sendBtn.Add_Click({ Send-Chat })
$inputBox.Add_KeyDown({
  param($s, $e)
  if ($e.Key -eq 'Return') { Send-Chat; $e.Handled = $true }
})

$win.Add_LocationChanged({ if ($script:shown) { Emit-Moved } })
$win.Add_Closed({ Dispose-Tray; Emit @{ event = 'closed' } })

$hitTimer = New-Object System.Windows.Threading.DispatcherTimer
$hitTimer.Interval = [TimeSpan]::FromMilliseconds(50)
$hitTimer.Add_Tick({ if ($script:shown) { Sync-HitTest } })
$hitTimer.Start()

$main = [System.Windows.Threading.Dispatcher]::CurrentDispatcher
[void][System.Threading.Tasks.Task]::Run([action]{
  try {
    $stdin = [Console]::In
    while ($true) {
      $line = $stdin.ReadLine()
      if ($null -eq $line) { break }
      $captured = $line
      [void]$main.BeginInvoke([action]{ Handle-Command $captured })
    }
  } catch {}
  try { [void]$main.BeginInvoke([action]{ $win.Close() }) } catch {}
})

$app = New-Object System.Windows.Application
$app.ShutdownMode = [System.Windows.ShutdownMode]::OnExplicitShutdown
$app.MainWindow = $win
$script:shown = $false
$helper = New-Object System.Windows.Interop.WindowInteropHelper($win)
$win.Add_SourceInitialized({
  $script:hwnd = $helper.Handle
  Apply-ExStyle
})
$wa = [System.Windows.SystemParameters]::WorkArea
# EnsureHandle + Apply-ExStyle before Show() used to blank the layered window.
# Show first, then announce ready so the host can send bounds/show.
Start-Tray
if (-not (Read-PetVisiblePref)) { $script:userHidden = $true }
$script:shown = $true
$win.Show()
$script:hwnd = $helper.Handle
Apply-ExStyle
if ($script:userHidden) {
  $script:shown = $false
  $win.Hide()
}
Update-Tray
Emit @{
  event = 'ready'
  hwnd = [int64]$script:hwnd
  workArea = @{ x = [int]$wa.X; y = [int]$wa.Y; width = [int]$wa.Width; height = [int]$wa.Height }
  visible = [bool]$script:shown
}
try { [Console]::Error.WriteLine(("init {0},{1} {2}x{3} visible={4} userHidden={5}" -f $script:currentBounds.x, $script:currentBounds.y, $script:currentBounds.width, $script:currentBounds.height, $win.IsVisible, $script:userHidden)) } catch {}
$topTimer = New-Object System.Windows.Threading.DispatcherTimer
$topTimer.Interval = [TimeSpan]::FromSeconds(1)
$topTimer.Add_Tick({ if ($script:shown) { $win.Topmost = $false; $win.Topmost = $true } })
$topTimer.Start()
[void]$app.Run()
