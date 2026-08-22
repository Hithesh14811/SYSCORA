"""Draw a given point list with pyautogui, held down, at a chosen pace.

The second argument is the sleep between points in seconds. PAUSE=0 is
pyautogui's fastest setting; a deliberate sleep is how a pyautogui user paces a
stroke so the application can keep up.
"""
import json
import sys
import time
import pyautogui

pyautogui.FAILSAFE = False
pyautogui.PAUSE = 0

points = json.load(open(sys.argv[1]))
pace = float(sys.argv[2]) if len(sys.argv) > 2 else 0.0
pyautogui.moveTo(points[0][0], points[0][1])
time.sleep(0.05)
t0 = time.perf_counter()
pyautogui.mouseDown()
try:
    for (x, y) in points[1:]:
        pyautogui.moveTo(x, y)
        if pace:
            time.sleep(pace)
finally:
    pyautogui.mouseUp()
ms = (time.perf_counter() - t0) * 1000
print("pyautogui : %d points issued in %.0fms wall (%d points/sec), pace=%.4fs"
      % (len(points), ms, len(points) / (ms / 1000), pace))
