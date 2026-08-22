"""Measure pyautogui on this machine, for a like-for-like comparison.

Only pointer MOVEMENT is measured here: no button is pressed and nothing is
typed, so running it cannot click on or drag anything. The cursor is put back
where it was found.

The numbers that matter for drawing are how many distinct positions reach the
application and how long they take, because an application draws a straight
segment between the positions it is told about.
"""
import time
import pyautogui

pyautogui.FAILSAFE = False


def circle(cx, cy, r, n):
    import math
    return [(int(cx + r * math.cos(2 * math.pi * i / n)), int(cy + r * math.sin(2 * math.pi * i / n)))
            for i in range(n)]


start = pyautogui.position()
width, height = pyautogui.size()
print("screen %dx%d, pyautogui %s" % (width, height, pyautogui.__version__))
print("PAUSE=%s MINIMUM_DURATION=%s MINIMUM_SLEEP=%s" % (pyautogui.PAUSE, pyautogui.MINIMUM_DURATION, pyautogui.MINIMUM_SLEEP))
print()

# 1. Default settings, as anyone gets them out of the box.
points = circle(900, 600, 200, 20)
t0 = time.perf_counter()
for (x, y) in points:
    pyautogui.moveTo(x, y)
default_ms = (time.perf_counter() - t0) * 1000
print("default settings   : %4d moves in %8.1f ms  (%6.3f ms/point, %5d points/sec)"
      % (len(points), default_ms, default_ms / len(points), len(points) / (default_ms / 1000)))

# 2. PAUSE disabled, which is the fastest pyautogui can be made to go.
pyautogui.PAUSE = 0
points = circle(900, 600, 200, 1000)
t0 = time.perf_counter()
for (x, y) in points:
    pyautogui.moveTo(x, y)
fast_ms = (time.perf_counter() - t0) * 1000
print("PAUSE disabled     : %4d moves in %8.1f ms  (%6.3f ms/point, %5d points/sec)"
      % (len(points), fast_ms, fast_ms / len(points), len(points) / (fast_ms / 1000)))

# 3. Does the pointer land on the pixel it was sent to?
probes = [(7, 11), (400, 400), (1279, 719), (1919, 1079), (1920, 1080), (2559, 1439)]
exact = 0
for (x, y) in probes:
    pyautogui.moveTo(x, y)
    got = pyautogui.position()
    if (got.x, got.y) == (x, y):
        exact += 1
    else:
        print("  MISS asked %d,%d -> got %d,%d" % (x, y, got.x, got.y))
print("exactness          : %d/%d landed on the exact pixel" % (exact, len(probes)))

# 4. How many positions a smooth move actually delivers. This is the number that
#    decides whether a drag can draw a curve, and it comes straight from the
#    library's own arithmetic: a duration at or under MINIMUM_DURATION is a
#    single jump, and above it the count is duration / MINIMUM_SLEEP.
for duration in (0.0, 0.1, 0.5, 1.0, 3.0):
    if duration > pyautogui.MINIMUM_DURATION:
        num_steps = max(width, height)
        if duration / num_steps < pyautogui.MINIMUM_SLEEP:
            num_steps = int(duration / pyautogui.MINIMUM_SLEEP)
        steps = num_steps + 1
    else:
        steps = 1
    print("moveTo(duration=%.1f): delivers %d intermediate position%s (along a straight line only)"
          % (duration, steps, "" if steps == 1 else "s"))

pyautogui.moveTo(start.x, start.y)
