# Prints the system output volume as one whole number, and nothing else.
#
# One bare number on stdout: the runner's check is a SUBSTRING match, so anything
# else printed here — a warning, a blank line, a type name — is another string
# "42" could accidentally match inside.
#
# See audio-endpoint.ps1 for why this does not ask SYSCORA's own audio shim.
. (Join-Path $PSScriptRoot 'audio-endpoint.ps1')
try { [EvalAudio]::Percent() } catch { "unreadable: $($_.Exception.Message)" }
