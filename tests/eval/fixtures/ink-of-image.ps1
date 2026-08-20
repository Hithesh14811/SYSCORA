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
# Transparency is flattened onto WHITE first, because a canvas that was never
# drawn on is saved as fully transparent by some encoders, and every transparent
# pixel is identical — which would read as a uniform image and report BLANK for
# the right reason by luck rather than by measurement. Flattening makes it the
# same question as a real canvas: how much of this differs from its background.

param([Parameter(Mandatory = $true)][string]$Path)

if (-not (Test-Path -LiteralPath $Path)) { Write-Output 'MISSING'; exit }

Add-Type -AssemblyName System.Drawing
$temp = [IO.Path]::Combine([IO.Path]::GetTempPath(), 'syscora-ink-' + [Guid]::NewGuid().ToString('N') + '.bmp')

try {
  $image = [System.Drawing.Image]::FromFile($Path)
} catch {
  Write-Output ("UNREADABLE {0}" -f $_.Exception.Message)
  exit
}

try {
  $flat = New-Object System.Drawing.Bitmap $image.Width, $image.Height
  $graphics = [System.Drawing.Graphics]::FromImage($flat)
  $graphics.Clear([System.Drawing.Color]::White)
  $graphics.DrawImage($image, 0, 0, $image.Width, $image.Height)
  $graphics.Dispose()
  $flat.Save($temp, [System.Drawing.Imaging.ImageFormat]::Bmp)
  $flat.Dispose()
} catch {
  Write-Output ("UNREADABLE {0}" -f $_.Exception.Message)
  exit
} finally {
  $image.Dispose()
}

& node (Join-Path $PSScriptRoot 'ink-check.mjs') $temp
Remove-Item -LiteralPath $temp -Force -ErrorAction SilentlyContinue
