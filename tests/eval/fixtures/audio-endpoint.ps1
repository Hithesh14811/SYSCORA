# A binding to the Windows audio endpoint, for the eval's own use.
#
# WHY IT IS SEPARATE FROM THE AGENT'S. The eval's one rule is that a verification
# must not share a code path with the thing it verifies (tests/eval/README.md).
# SYSCORA sets the volume through a C# endpoint compiled into its long-lived
# PowerShell host; if this asked that same host, a shim that reports 42% while
# the device sits at 8% would confirm itself — which is the exact class of bug
# the honesty invariant exists for, and it has happened here before ("Volume is
# 28% (muted)" reported twice while music played).
#
# WHY IT EXISTS AT ALL. The volume task's verify was `Get-AudioDevice`, from the
# third-party AudioDeviceCmdlets module, which is not installed on this machine.
# The check printed 'unreadable' on every run, so the task could never pass
# whatever the agent did. Found 19 Aug 2026, by running it.
#
# Dot-source this; it defines [EvalAudio] and prints nothing.

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

// The vtable order below is the published IAudioEndpointVolume ABI. The unnamed
// slots are RegisterControlChangeNotify, UnregisterControlChangeNotify,
// GetChannelCount and the four per-channel volume calls. They are never invoked,
// but they must be declared: COM dispatch is by POSITION, so one missing entry
// does not fail to compile, it silently calls the wrong function.
[Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IAudioEndpointVolume {
  int Slot0(); int Slot1(); int Slot2();
  int SetMasterVolumeLevel(float level, Guid context);
  int SetMasterVolumeLevelScalar(float level, Guid context);
  int GetMasterVolumeLevel(out float level);
  int GetMasterVolumeLevelScalar(out float level);
  int Slot7(); int Slot8(); int Slot9(); int Slot10();
  int SetMute(bool mute, Guid context);
  int GetMute(out bool mute);
}

[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IMMDevice {
  int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, out IAudioEndpointVolume volume);
}

[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IMMDeviceEnumerator {
  int Slot0();
  int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice endpoint);
}

[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
public class MMDeviceEnumerator { }

public static class EvalAudio {
  private static IAudioEndpointVolume Endpoint() {
    IMMDeviceEnumerator enumerator = (IMMDeviceEnumerator)(new MMDeviceEnumerator());
    IMMDevice device;
    // eRender = 0, eMultimedia = 1 — the endpoint Windows plays media through,
    // which is the one the user hears and the one the task is about.
    Marshal.ThrowExceptionForHR(enumerator.GetDefaultAudioEndpoint(0, 1, out device));
    Guid iid = typeof(IAudioEndpointVolume).GUID;
    IAudioEndpointVolume volume;
    Marshal.ThrowExceptionForHR(device.Activate(ref iid, 23 /* CLSCTX_ALL */, IntPtr.Zero, out volume));
    return volume;
  }

  public static int Percent() {
    float scalar;
    Marshal.ThrowExceptionForHR(Endpoint().GetMasterVolumeLevelScalar(out scalar));
    return (int)Math.Round(scalar * 100.0);
  }

  public static void SetPercent(int percent) {
    if (percent < 0) percent = 0;
    if (percent > 100) percent = 100;
    Marshal.ThrowExceptionForHR(Endpoint().SetMasterVolumeLevelScalar(percent / 100.0f, Guid.Empty));
  }

  public static bool Muted() {
    bool muted;
    Marshal.ThrowExceptionForHR(Endpoint().GetMute(out muted));
    return muted;
  }
}
'@ -ErrorAction Stop
