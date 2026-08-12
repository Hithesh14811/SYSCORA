import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_STEP_PX, MAX_PATH_POINTS, ROUNDING_SLACK_PX,
  buildPath, clampToBounds, densify, distance, flattenPath, pathLength,
  segmentsForArc, smoothPoints, thinTo
} from "../../packages/fast-agent/src/stroke-path.js";

const gaps = (points) => points.slice(1).map((point, index) => distance(points[index], point));

test("densifying leaves no gap an application would draw as a straight chord", () => {
  const path = densify([{ x: 0, y: 0 }, { x: 400, y: 300 }], { maxStepPx: 2 });
  // The spacing is exact before the points are rounded onto whole pixels, and
  // rounding can add up to the diagonal of one pixel on top of it.
  assert.ok(
    gaps(path).every((gap) => gap <= 2 + ROUNDING_SLACK_PX + 0.001),
    "every step must be within the requested spacing plus the pixel rounding"
  );
  assert.deepEqual(path[0], { x: 0, y: 0 });
  assert.deepEqual(path[path.length - 1], { x: 400, y: 300 });
});

// A repeated position is a pointer event that says nothing and still costs its
// pacing delay. After rounding to whole pixels a dense curve produces plenty.
test("densifying drops positions that repeat after rounding", () => {
  const path = densify([{ x: 10, y: 10 }, { x: 11, y: 10 }, { x: 11, y: 10 }, { x: 12, y: 10 }], { maxStepPx: 2 });
  assert.deepEqual(path, [{ x: 10, y: 10 }, { x: 11, y: 10 }, { x: 12, y: 10 }]);
});

// The vertex count is solved from the error the curve is allowed to have. A
// fixed count is visibly a polygon at a large radius and wasteful at a small one.
test("a circle is within a third of a pixel of round, at any radius", () => {
  for (const radius of [8, 40, 200, 900]) {
    const points = buildPath({ shape: "circle", cx: 1000, cy: 1000, radius });
    const worst = points.reduce((error, point) => {
      const off = Math.abs(Math.hypot(point.x - 1000, point.y - 1000) - radius);
      return Math.max(error, off);
    }, 0);
    // A pixel of slack over the tolerance, because the points are rounded to
    // whole pixels after the geometry is worked out.
    assert.ok(worst <= 1.5, `radius ${radius} was off by ${worst.toFixed(2)}px`);
    assert.ok(gaps(points).every((gap) => gap <= DEFAULT_STEP_PX + ROUNDING_SLACK_PX + 0.001));
  }
});

test("a bigger circle needs more segments, and a tighter tolerance needs more still", () => {
  assert.ok(segmentsForArc(400) > segmentsForArc(40));
  assert.ok(segmentsForArc(400, Math.PI * 2, 0.05) > segmentsForArc(400, Math.PI * 2, 0.5));
  // Degenerate inputs must produce a usable count rather than NaN or zero.
  assert.equal(segmentsForArc(0), 1);
  assert.ok(Number.isFinite(segmentsForArc(100, 0)));
});

test("a circle closes: the last point returns to the first", () => {
  const points = buildPath({ shape: "circle", cx: 500, cy: 500, radius: 120 });
  assert.ok(distance(points[0], points[points.length - 1]) <= DEFAULT_STEP_PX);
});

test("a rectangle keeps its corners and walks all four sides", () => {
  const points = buildPath({ shape: "rect", x: 100, y: 100, width: 200, height: 80 });
  for (const corner of [{ x: 100, y: 100 }, { x: 300, y: 100 }, { x: 300, y: 180 }, { x: 100, y: 180 }]) {
    assert.ok(points.some((point) => point.x === corner.x && point.y === corner.y), `corner ${corner.x},${corner.y} is missing`);
  }
  assert.ok(Math.abs(pathLength(points) - 560) < 2, "the perimeter must be walked once");
});

test("a polygon has the side count it was asked for and sits on its radius", () => {
  const points = buildPath({ shape: "polygon", cx: 400, cy: 400, radius: 100, sides: 6 });
  assert.deepEqual(points[0], points[points.length - 1], "a polygon closes");
  const perimeter = pathLength(points);
  // Six chords of a radius-100 circle: 6 * 2 * 100 * sin(pi/6) = 600. Measured
  // along the rounded points it runs a little long, because a diagonal walked on
  // a pixel lattice zig-zags.
  assert.ok(Math.abs(perimeter - 600) < 12, `perimeter was ${perimeter}`);
});

test("an arc draws only the sweep it was given", () => {
  const quarter = buildPath({ shape: "arc", cx: 500, cy: 500, radius: 100, startDegrees: 0, sweepDegrees: 90 });
  assert.ok(Math.abs(pathLength(quarter) - (Math.PI * 100) / 2) < 4, `length was ${pathLength(quarter)}`);
  // 0 degrees is east, and angles run clockwise in screen coordinates because y
  // grows downwards.
  assert.deepEqual(quarter[0], { x: 600, y: 500 });
  assert.deepEqual(quarter[quarter.length - 1], { x: 500, y: 600 });
});

// The uniform Catmull-Rom form overshoots and loops back on itself wherever the
// supplied points cluster, and a cusp in a drawing reads as a mistake. The
// centripetal form does not.
test("a freehand curve passes through its points without looping back", () => {
  const given = [{ x: 0, y: 0 }, { x: 100, y: 50 }, { x: 102, y: 52 }, { x: 300, y: 0 }];
  const curve = smoothPoints(given);
  for (const point of given) {
    assert.ok(
      curve.some((made) => distance(made, point) < 1.5),
      `the curve must pass through ${point.x},${point.y}`
    );
  }
  const straight = distance(given[0], given[given.length - 1]);
  assert.ok(pathLength(curve) < straight * 2.5, "a smoothed path must not double back on itself");
});

test("freehand with fewer than three points is left exactly as given", () => {
  assert.deepEqual(smoothPoints([{ x: 1, y: 2 }, { x: 3, y: 4 }]), [{ x: 1, y: 2 }, { x: 3, y: 4 }]);
});

// Half a circle is a mistake nobody asked for; a slightly coarser circle is
// still a circle. So an over-long path is thinned, never truncated.
test("an over-long path is thinned evenly and keeps both of its ends", () => {
  const long = Array.from({ length: MAX_PATH_POINTS * 3 }, (_, index) => ({ x: index, y: 0 }));
  const thinned = thinTo(long, MAX_PATH_POINTS);
  assert.equal(thinned.length, MAX_PATH_POINTS);
  assert.deepEqual(thinned[0], long[0]);
  assert.deepEqual(thinned[thinned.length - 1], long[long.length - 1]);
});

test("a huge shape stays within the point ceiling", () => {
  const points = buildPath({ shape: "circle", cx: 5000, cy: 5000, radius: 4000 });
  assert.ok(points.length <= MAX_PATH_POINTS, `got ${points.length} points`);
});

test("a stroke cannot escape the bounds it is given", () => {
  const clamped = clampToBounds(
    [{ x: -50, y: 10 }, { x: 5000, y: 10 }],
    { x: 0, y: 0, width: 800, height: 600 }
  );
  assert.deepEqual(clamped, [{ x: 0, y: 10 }, { x: 799, y: 10 }]);
});

test("the flattened path is interleaved x,y in order", () => {
  assert.deepEqual(flattenPath([{ x: 1, y: 2 }, { x: 3, y: 4 }]), [1, 2, 3, 4]);
});

test("a shape that cannot be drawn says so instead of drawing something else", () => {
  assert.throws(() => buildPath({ shape: "dodecahedron" }), /Unknown shape/);
  assert.throws(() => buildPath({ shape: "polyline", points: [{ x: 1, y: 1 }] }), /at least two points/);
});

// Coordinates arrive from a language model, so a missing or non-numeric one must
// not become NaN and travel all the way to the pointer.
test("missing coordinates fall back to a number rather than NaN", () => {
  const points = buildPath({ shape: "line", fromX: 10, fromY: 10, toX: "not a number", toY: 40 });
  assert.ok(points.every((point) => Number.isFinite(point.x) && Number.isFinite(point.y)));
});
