// The shape of a stroke, worked out before a single pointer event is sent.
//
// A pointer that can only be told "press here, release there" can draw exactly
// one thing: a straight line. Every curve then has to be approximated by the
// caller as a series of separate drags, and because the button comes up between
// them the result is not a curve at all — it is N disconnected chords, N entries
// in the application's undo stack, and N round trips through the model.
//
// So the geometry lives here, in plain JavaScript, and the whole figure travels
// to the pointer as ONE path in ONE call. Two decisions carry most of the
// quality:
//
//   1. HOW MANY VERTICES A CURVE NEEDS is derived from the error it is allowed
//      to have, not guessed. A circle drawn with a fixed 36 segments is visibly
//      a polygon at 400px radius and wasteful at 8px. Solving for the sagitta
//      instead gives whatever count holds the curve within a fraction of a pixel
//      at any size.
//
//   2. HOW FAR APART CONSECUTIVE POINTS MAY BE is a separate question from how
//      many vertices the shape has, and conflating the two is the classic
//      freehand-drawing defect. An application draws a straight segment between
//      the mouse positions it is told about; if the pointer jumps 200px between
//      two samples, the canvas gets a 200px straight line no matter how curved
//      the intent was. Densifying by DISTANCE — never more than a couple of
//      pixels between injected positions — is what makes a drawn curve look
//      drawn rather than folded.
//
// Nothing here touches the OS. It is arithmetic on points, so it can be tested
// exactly, and the host is left with one job: deliver these positions faithfully.

// Largest gap allowed between two consecutive injected positions. Two pixels is
// below the width of every default brush and pencil, so no application can tell
// the difference between this and a continuous motion, and it is large enough
// that an ordinary figure stays a few hundred points rather than tens of
// thousands.
export const DEFAULT_STEP_PX = 2;
// How far a curve may sit from where it should be, in pixels, at its worst
// point. A third of a pixel is under one screen pixel after anti-aliasing, so
// the polygon that approximates a circle cannot be seen as one.
export const DEFAULT_TOLERANCE_PX = 0.35;
// A hard ceiling on the points in one stroke. At the default pacing a path this
// long already takes several seconds to deliver; beyond it the stroke stops
// being an action and becomes a job. Paths that would exceed it are thinned
// evenly rather than truncated, because half a circle is worse than a slightly
// coarser one.
export const MAX_PATH_POINTS = 6000;
// How much further apart than requested two consecutive positions can end up
// once they are rounded onto whole pixels: each moves by up to half a pixel on
// each axis, so the gap between two can grow by the diagonal of one pixel.
export const ROUNDING_SLACK_PX = Math.SQRT2;

const TAU = Math.PI * 2;

function point(x, y) {
  return { x: Math.round(x), y: Math.round(y) };
}

function finite(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

/** Straight-line distance between two points. */
export function distance(from, to) {
  return Math.hypot(to.x - from.x, to.y - from.y);
}

/** Total length along a path, in pixels. */
export function pathLength(points) {
  let total = 0;
  for (let index = 1; index < points.length; index += 1) total += distance(points[index - 1], points[index]);
  return total;
}

/**
 * Insert points so that no two consecutive positions are further apart than
 * `maxStepPx`.
 *
 * This is the step that turns a description of a shape into something an
 * application can actually render as that shape. It also de-duplicates: after
 * rounding to whole pixels a dense curve produces repeats, and a repeated
 * position is a pointer event that says nothing and still costs its pacing
 * delay.
 *
 * The spacing is exact before rounding and approximate after it. A pointer
 * position is a whole pixel, so every point shifts by up to half a pixel on each
 * axis on the way to the lattice, and two consecutive points can end up as much
 * as √2 further apart than was asked for. At the default spacing that is a
 * worst case of about three and a half pixels — still narrower than any default
 * brush, so no application can render it as anything but continuous. Claiming
 * the tighter bound would be claiming something this cannot deliver.
 */
export function densify(points, { maxStepPx = DEFAULT_STEP_PX } = {}) {
  const step = Math.max(0.5, finite(maxStepPx, DEFAULT_STEP_PX));
  const source = (points ?? []).map((p) => ({ x: finite(p.x, 0), y: finite(p.y, 0) }));
  if (source.length === 0) return [];
  const result = [point(source[0].x, source[0].y)];
  const push = (x, y) => {
    const next = point(x, y);
    const last = result[result.length - 1];
    if (next.x === last.x && next.y === last.y) return;
    result.push(next);
  };
  for (let index = 1; index < source.length; index += 1) {
    const from = source[index - 1];
    const to = source[index];
    const span = Math.hypot(to.x - from.x, to.y - from.y);
    const steps = Math.max(1, Math.ceil(span / step));
    for (let n = 1; n <= steps; n += 1) {
      push(from.x + ((to.x - from.x) * n) / steps, from.y + ((to.y - from.y) * n) / steps);
    }
  }
  return result;
}

/**
 * Drop points evenly until the path fits within `max`, always keeping the first
 * and the last.
 *
 * Truncating instead would deliver a partial figure and report it as complete,
 * which is the worse of the two failures by a wide margin: a slightly coarser
 * circle is still a circle, and three quarters of a circle is a mistake nobody
 * asked for.
 */
export function thinTo(points, max = MAX_PATH_POINTS) {
  if (points.length <= max) return points;
  const kept = [];
  const stride = (points.length - 1) / (max - 1);
  for (let index = 0; index < max; index += 1) kept.push(points[Math.round(index * stride)]);
  kept[kept.length - 1] = points[points.length - 1];
  return kept;
}

/**
 * How many straight segments a circular arc of this radius needs before the gap
 * between the polygon and the true curve falls under `tolerancePx`.
 *
 * The worst error of a chord is its sagitta, r(1 - cos(θ/2)) for a segment
 * spanning angle θ. Setting that equal to the tolerance and solving for the
 * count is one line of trigonometry and removes the magic number that would
 * otherwise be wrong at every radius but one.
 */
export function segmentsForArc(radius, sweep = TAU, tolerancePx = DEFAULT_TOLERANCE_PX) {
  const r = Math.abs(finite(radius, 0));
  const angle = Math.abs(finite(sweep, TAU));
  const tolerance = Math.max(0.05, finite(tolerancePx, DEFAULT_TOLERANCE_PX));
  if (r <= tolerance || angle === 0) return 1;
  // A tolerance at or above the radius would permit any polygon at all; the
  // acos below is only defined while the ratio stays inside the unit interval.
  const ratio = Math.min(1, Math.max(-1, 1 - tolerance / r));
  const perSegment = Math.acos(ratio) * 2;
  if (!Number.isFinite(perSegment) || perSegment <= 0) return 1;
  return Math.max(1, Math.ceil(angle / perSegment));
}

/** An arc of an ellipse, from `startAngle` through `sweep` radians. */
export function arcPoints({
  cx, cy, radiusX, radiusY = radiusX, startAngle = -Math.PI / 2, sweep = TAU,
  tolerancePx = DEFAULT_TOLERANCE_PX, rotation = 0
} = {}) {
  const rx = Math.abs(finite(radiusX, 0));
  const ry = Math.abs(finite(radiusY, rx));
  // The larger radius sets the vertex count for the whole arc. Sizing it from
  // the smaller one would satisfy the tolerance on the flat sides of an ellipse
  // and miss it everywhere the curve is tight.
  const segments = segmentsForArc(Math.max(rx, ry), sweep, tolerancePx);
  const cosine = Math.cos(rotation);
  const sine = Math.sin(rotation);
  const points = [];
  for (let index = 0; index <= segments; index += 1) {
    const angle = startAngle + (sweep * index) / segments;
    const x = Math.cos(angle) * rx;
    const y = Math.sin(angle) * ry;
    points.push({ x: cx + x * cosine - y * sine, y: cy + x * sine + y * cosine });
  }
  return points;
}

/**
 * Smooth a hand-specified sequence of points into a curve that passes through
 * every one of them.
 *
 * Centripetal Catmull-Rom, which is the variant that does not loop back on
 * itself when two supplied points sit close together — the uniform form
 * produces cusps exactly where a hand-drawn path is most likely to have
 * clustered points, and a cusp in a drawing reads as a mistake.
 *
 * A caller that wants the corners it asked for — a rectangle, a zig-zag — must
 * not use this; that is what a plain polyline is for.
 */
export function smoothPoints(points, { tolerancePx = DEFAULT_TOLERANCE_PX } = {}) {
  const source = (points ?? []).map((p) => ({ x: finite(p.x, 0), y: finite(p.y, 0) }));
  if (source.length < 3) return source;
  const knots = [source[0], ...source, source[source.length - 1]];
  const result = [source[0]];
  for (let index = 1; index + 2 < knots.length; index += 1) {
    const [p0, p1, p2, p3] = [knots[index - 1], knots[index], knots[index + 1], knots[index + 2]];
    // Centripetal parametrisation: each knot's spacing is the square root of
    // the distance to the next, which is what keeps the curve from overshooting.
    const t = [0, 0, 0, 0];
    for (let n = 1; n < 4; n += 1) {
      const previous = [p0, p1, p2, p3][n - 1];
      const current = [p0, p1, p2, p3][n];
      t[n] = t[n - 1] + Math.sqrt(Math.hypot(current.x - previous.x, current.y - previous.y)) || t[n - 1] + 1e-6;
    }
    const span = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    const steps = Math.max(2, segmentsForArc(Math.max(span, 1), Math.PI / 2, tolerancePx));
    for (let n = 1; n <= steps; n += 1) {
      const time = t[1] + ((t[2] - t[1]) * n) / steps;
      const a1 = interpolate(p0, p1, t[0], t[1], time);
      const a2 = interpolate(p1, p2, t[1], t[2], time);
      const a3 = interpolate(p2, p3, t[2], t[3], time);
      const b1 = interpolate(a1, a2, t[0], t[2], time);
      const b2 = interpolate(a2, a3, t[1], t[3], time);
      result.push(interpolate(b1, b2, t[1], t[2], time));
    }
  }
  return result;
}

function interpolate(from, to, tFrom, tTo, time) {
  const span = tTo - tFrom;
  if (!Number.isFinite(span) || span === 0) return { x: to.x, y: to.y };
  const ratio = (time - tFrom) / span;
  return { x: from.x + (to.x - from.x) * ratio, y: from.y + (to.y - from.y) * ratio };
}

/** Keep every point inside a rectangle, so a stroke cannot escape its canvas. */
export function clampToBounds(points, bounds) {
  if (!bounds || !Number.isFinite(Number(bounds.width)) || !Number.isFinite(Number(bounds.height))) return points;
  const left = Number(bounds.x);
  const top = Number(bounds.y);
  const right = left + Number(bounds.width) - 1;
  const bottom = top + Number(bounds.height) - 1;
  return points.map((p) => ({
    x: Math.min(right, Math.max(left, p.x)),
    y: Math.min(bottom, Math.max(top, p.y))
  }));
}

/**
 * Turn a described shape into the positions the pointer will visit.
 *
 * Shapes are named the way the request is phrased — "circle", "rectangle",
 * "line" — because the alternative is asking a language model to emit sixty
 * coordinate pairs for a circle. It gets them wrong, it costs hundreds of
 * tokens, and the arithmetic belongs on this side anyway.
 */
export function buildPath(spec = {}) {
  const tolerancePx = finite(spec.tolerancePx, DEFAULT_TOLERANCE_PX);
  const shape = String(spec.shape ?? (spec.points ? "freehand" : "line")).toLowerCase();
  const closed = spec.closed !== false;
  let points;

  switch (shape) {
    case "line": {
      points = [
        { x: finite(spec.fromX, 0), y: finite(spec.fromY, 0) },
        { x: finite(spec.toX, 0), y: finite(spec.toY, 0) }
      ];
      break;
    }
    case "circle": {
      const radius = finite(spec.radius, Math.min(finite(spec.width, 0), finite(spec.height, 0)) / 2);
      points = arcPoints({ cx: finite(spec.cx, 0), cy: finite(spec.cy, 0), radiusX: radius, radiusY: radius, tolerancePx });
      break;
    }
    case "ellipse":
    case "oval": {
      points = arcPoints({
        cx: finite(spec.cx, 0), cy: finite(spec.cy, 0),
        radiusX: finite(spec.radiusX, finite(spec.width, 0) / 2),
        radiusY: finite(spec.radiusY, finite(spec.height, 0) / 2),
        rotation: finite(spec.rotation, 0),
        tolerancePx
      });
      break;
    }
    case "arc": {
      points = arcPoints({
        cx: finite(spec.cx, 0), cy: finite(spec.cy, 0),
        radiusX: finite(spec.radius, finite(spec.radiusX, 0)),
        radiusY: finite(spec.radiusY, finite(spec.radius, finite(spec.radiusX, 0))),
        startAngle: (finite(spec.startDegrees, 0) * Math.PI) / 180,
        sweep: (finite(spec.sweepDegrees, 360) * Math.PI) / 180,
        tolerancePx
      });
      break;
    }
    case "rect":
    case "rectangle":
    case "square": {
      const x = finite(spec.x, finite(spec.fromX, 0));
      const y = finite(spec.y, finite(spec.fromY, 0));
      const width = finite(spec.width, finite(spec.toX, x) - x);
      const height = finite(spec.height, shape === "square" ? width : finite(spec.toY, y) - y);
      points = [
        { x, y }, { x: x + width, y }, { x: x + width, y: y + height }, { x, y: y + height }, { x, y }
      ];
      break;
    }
    case "polygon": {
      const sides = Math.max(3, Math.round(finite(spec.sides, 3)));
      const radius = finite(spec.radius, 0);
      const rotation = (finite(spec.rotationDegrees, -90) * Math.PI) / 180;
      points = Array.from({ length: sides + 1 }, (_, index) => {
        const angle = rotation + (TAU * (index % sides)) / sides;
        return { x: finite(spec.cx, 0) + Math.cos(angle) * radius, y: finite(spec.cy, 0) + Math.sin(angle) * radius };
      });
      break;
    }
    case "polyline":
    case "path": {
      points = (spec.points ?? []).map((p) => ({ x: finite(p.x, 0), y: finite(p.y, 0) }));
      if (closed && points.length > 2 && spec.closed === true) points.push(points[0]);
      break;
    }
    case "freehand":
    case "curve": {
      const given = (spec.points ?? []).map((p) => ({ x: finite(p.x, 0), y: finite(p.y, 0) }));
      if (spec.closed === true && given.length > 2) given.push(given[0]);
      points = smoothPoints(given, { tolerancePx });
      break;
    }
    default:
      throw new Error(
        `Unknown shape "${spec.shape}". Use line, circle, ellipse, arc, rect, square, polygon, polyline or freehand.`
      );
  }

  if (points.length < 2) throw new Error("A stroke needs at least two points. Check the coordinates given.");
  const bounded = clampToBounds(points, spec.bounds);
  return thinTo(densify(bounded, { maxStepPx: finite(spec.maxStepPx, DEFAULT_STEP_PX) }), MAX_PATH_POINTS);
}

/**
 * A stroke's positions flattened for transport.
 *
 * One array of interleaved x,y rather than an array of objects: for a few
 * thousand points the JSON is a third of the size, and it is the shape the host
 * hands straight to the native call without rebuilding it.
 */
export function flattenPath(points) {
  const flat = new Array(points.length * 2);
  for (let index = 0; index < points.length; index += 1) {
    flat[index * 2] = points[index].x;
    flat[index * 2 + 1] = points[index].y;
  }
  return flat;
}

/** Roughly how long delivering this path will take, for choosing a timeout. */
export function estimateDurationMs(pointCount, pacingMicros) {
  return Math.ceil((pointCount * Math.max(0, pacingMicros)) / 1000);
}
