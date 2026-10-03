# IS THERE ANYTHING DRAWN IN THIS IMAGE, WHATEVER FORMAT IT TURNED OUT TO BE?
#
#   & ink-of-image.ps1 -Path C:\somewhere\circle.bmp
#
# Prints MISSING, UNREADABLE <why>, BLANK, or `INK <percent>`.
#
# THE HARNESS MUST NOT FAIL A RUN THAT DID THE WORK. Measured 21 Aug 2026: asked
# to save as `circle.bmp`, Paint wrote a PNG under that name — its Save-As dialog
# keeps its own idea of the format and the extension does not decide it. The
# drawing was real and on disk, and a checker that read raw bitmap headers called
# it "UNREADABLE not-a-bitmap" and marked the row failed. That is the same defect
# as the tab-in-a-path one recorded in 09-app-type-and-save: the agent was right
# and the eval was wrong, which is the most expensive kind of wrong there is.
#
# So the format question is handed to Windows, which has decoders for all of
# them, and the pixel question stays in ink-check.mjs. Neither is code the agent
# runs, which is what a verification has to be.
#
# AND "WINDOWS" HAS TO MEAN WIC, NOT JUST GDI+. Measured 3 Oct 2026: asked for
# `circle.bmp`, Paint wrote a HEIF image under that name -- magic bytes
# `ftypmif1`, 1826x856, perfectly valid. System.Drawing is GDI+, which decodes
# BMP/PNG/JPEG/GIF/TIFF and has never heard of HEIF, so it threw "Parameter is
# not valid" and the row failed with the drawing sitting on disk. The same defect
# as the PNG-under-a-.bmp-name one above, one format further on: a checker that
# knows fewer formats than the application does will keep failing correct work.
# WIC is the OS codec set the Photos app uses, so the fallback inherits every
# decoder the machine has, including ones that ship later.
#
# Transparency is flattened onto WHITE first, because a canvas that was never
# drawn on is saved as fully transparent by some encoders, and every transparent
# pixel is identical — which would read as a uniform image and report BLANK for
# the right reason by luck rather than by measurement. Flattening makes it the
# same question as a real canvas: how much of this differs from its background.
#
# AND IT MUST NOT RACE THE SAVE. Measured 3 Oct 2026: `draw-shape-in-paint` failed
# 1 of 3 with `UNREADABLE Exception calling "FromFile" with "1" argument(s)` while
# Test-Path had already succeeded — the file existed and Paint had not finished
# with it. A half-written file is worse than an unreadable one, because it decodes
# to a blank canvas and reports BLANK: a confident wrong answer rather than an
# error. So this keeps looking until it finds ink or runs out of time:
#
#   * opened through a FileShare::ReadWrite handle and copied into memory, so a
#     process still holding the file cannot fail the read and the decoder never
#     keeps a handle of its own (Image::FromFile takes an exclusive read, which
#     is what threw);
#   * retried until ink is found, because BLANK is indistinguishable from a
#     partial write and only one of those two gets better by waiting;
#   * bounded, because a check that waits forever is a hang and not a
#     verification. A canvas that really is blank is a FAILING row either way, so
#     the only thing this costs is a few seconds on a row that was already red.

param(
  [Parameter(Mandatory = $true)][string]$Path,
  [int]$TimeoutSeconds = 8
)

if (-not (Test-Path -LiteralPath $Path)) { Write-Output 'MISSING'; exit }

Add-Type -AssemblyName System.Drawing

function Convert-WithWic {
  param([string]$From, [string]$To)
  # Returns $null on success, or the reason WIC could not read it either.
  # Decoded to a plain BMP so the flatten-and-count path below stays one
  # implementation rather than two that can disagree.
  try {
    Add-Type -AssemblyName PresentationCore -ErrorAction Stop
    $decoder = [Windows.Media.Imaging.BitmapDecoder]::Create(
      (New-Object System.Uri $From), 'None', 'OnLoad')
    $encoder = New-Object Windows.Media.Imaging.BmpBitmapEncoder
    $encoder.Frames.Add([Windows.Media.Imaging.BitmapFrame]::Create($decoder.Frames[0]))
    $out = [IO.File]::Open($To, [IO.FileMode]::Create, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try { $encoder.Save($out) } finally { $out.Dispose() }
    return $null
  } catch {
    if ($_.Exception.InnerException) { return $_.Exception.InnerException.Message }
    return $_.Exception.Message
  }
}

function Read-FlattenedCopy {
  param([string]$From, [string]$To)
  # Returns $null on success, or the reason it could not be read.
  $stream = $null
  $image = $null
  try {
    $stream = [IO.File]::Open($From, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
    $buffer = New-Object IO.MemoryStream
    $stream.CopyTo($buffer)
    $buffer.Position = 0
    $image = [System.Drawing.Image]::FromStream($buffer)
    $flat = New-Object System.Drawing.Bitmap $image.Width, $image.Height
    $graphics = [System.Drawing.Graphics]::FromImage($flat)
    $graphics.Clear([System.Drawing.Color]::White)
    $graphics.DrawImage($image, 0, 0, $image.Width, $image.Height)
    $graphics.Dispose()
    $flat.Save($To, [System.Drawing.Imaging.ImageFormat]::Bmp)
    $flat.Dispose()
    return $null
  } catch {
    # Windows PowerShell 5.1 has no ternary operator.
    if ($_.Exception.InnerException) { return $_.Exception.InnerException.Message }
    return $_.Exception.Message
  } finally {
    if ($image) { $image.Dispose() }
    if ($stream) { $stream.Dispose() }
  }
}

$temp = [IO.Path]::Combine([IO.Path]::GetTempPath(), 'syscora-ink-' + [Guid]::NewGuid().ToString('N') + '.bmp')
$checker = Join-Path $PSScriptRoot 'ink-check.mjs'
$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
$answer = $null
$lastError = 'never attempted'

while ($true) {
  $size = (Get-Item -LiteralPath $Path).Length
  if ($size -gt 0) {
    $failure = Read-FlattenedCopy -From $Path -To $temp
    if ($failure) {
      # GDI+ could not read it. Before believing that, ask WIC -- Paint has
      # already been caught writing both PNG and HEIF under a .bmp name.
      $viaWic = [IO.Path]::ChangeExtension($temp, '.wic.bmp')
      $wicFailure = Convert-WithWic -From $Path -To $viaWic
      if (-not $wicFailure) {
        $failure = Read-FlattenedCopy -From $viaWic -To $temp
        Remove-Item -LiteralPath $viaWic -Force -ErrorAction SilentlyContinue
      } else {
        $failure = "$failure; WIC also: $wicFailure"
      }
    }
    if ($failure) {
      $lastError = "$failure (at $size bytes)"
    } else {
      $verdict = (& node $checker $temp | Out-String).Trim()
      Remove-Item -LiteralPath $temp -Force -ErrorAction SilentlyContinue
      # Ink is a final answer. BLANK is not: it is what a half-written file looks
      # like, and the only way to tell them apart is to look again.
      if ($verdict -like 'INK*') { Write-Output $verdict; exit }
      $answer = $verdict
      $lastError = "decoded, but $verdict"
    }
  } else {
    $lastError = 'zero bytes so far'
  }
  if ((Get-Date) -ge $deadline) { break }
  Start-Sleep -Milliseconds 400
}

if ($answer) { Write-Output $answer; exit }
Write-Output ("UNREADABLE after {0}s, {1} bytes: {2}" -f $TimeoutSeconds, (Get-Item -LiteralPath $Path).Length, $lastError)
