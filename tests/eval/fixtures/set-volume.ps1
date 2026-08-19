# Sets the system output volume, for the volume task's setup and teardown.
#
# The setup moves the volume AWAY from the target before the agent runs. Without
# that the check is vacuous: the machine sat at 42% after a previous run, so
# "set the volume to 42" would have passed with the agent doing nothing at all —
# the same shape of defect as a verify that cannot fail.
#
# The teardown puts back whatever the setup recorded. These run unattended and
# the volume is something the user can hear.
param([Parameter(Mandatory = $true)][int] $Percent)
. (Join-Path $PSScriptRoot 'audio-endpoint.ps1')
[EvalAudio]::SetPercent($Percent)
