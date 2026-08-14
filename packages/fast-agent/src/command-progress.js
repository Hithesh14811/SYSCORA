// Turning an installer's redrawn console line into a number.
//
// `winget install` is the one command in ordinary use that routinely takes a
// minute, and for that whole minute the transcript showed a spinner and the
// command line. There was no way to tell a 180 MB download from a hung one, and
// nothing on screen changed until it was over — at which point the entire
// buffered output arrived at once, progress bar and all.
//
// winget already says exactly where it is. It prints a bar and a byte count and
// redraws them in place with a carriage return, so the information was arriving
// the whole time and being thrown away. This reads the last redraw out of each
// chunk and reports it as a percentage and a label.
//
// Nothing here is speculative: every pattern below is a line winget actually
// prints. A chunk that matches none of them produces no progress rather than a
// guess, because a made-up bar is worse than no bar — it would claim to know a
// duration nobody knows.

// "  ██████████████  12.5 MB / 180 MB" — the byte counter beside the bar. This
// is the authoritative one when it is present, because it is exact.
const BYTES = /([\d.]+)\s*(B|KB|MB|GB)\s*\/\s*([\d.]+)\s*(B|KB|MB|GB)/i;
// A bare percentage, which winget uses for the install phase where there is no
// byte total to count against.
const PERCENT = /(?:^|\s)(\d{1,3})%(?:\s|$)/;
// The phase headings winget prints on their own lines before each bar.
const PHASE = /^\s*(Downloading|Verifying|Installing|Starting package install|Extracting|Restoring)\b/im;

const UNITS = { b: 1, kb: 1024, mb: 1024 * 1024, gb: 1024 * 1024 * 1024 };

function toBytes(value, unit) {
  return Number(value) * (UNITS[String(unit).toLowerCase()] ?? 1);
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return null;
  if (bytes >= UNITS.gb) return `${(bytes / UNITS.gb).toFixed(1)} GB`;
  if (bytes >= UNITS.mb) return `${(bytes / UNITS.mb).toFixed(1)} MB`;
  if (bytes >= UNITS.kb) return `${Math.round(bytes / UNITS.kb)} KB`;
  return `${Math.round(bytes)} B`;
}

// The console is redrawn in place, so one chunk can hold several frames
// separated by carriage returns. Only the last one is current.
function lastFrame(text) {
  const frames = String(text ?? "").split(/[\r\n]+/).filter((frame) => frame.trim());
  return frames[frames.length - 1] ?? "";
}

/**
 * Read a chunk of a command's output and report where it has got to.
 *
 * @returns {{percent: number|null, label: string, phase: string|null}|null}
 *   null when this chunk says nothing about progress.
 */
export function readProgress(chunk, previous = {}) {
  const text = String(chunk ?? "");
  if (!text.trim()) return null;
  const phaseMatch = PHASE.exec(text);
  // A phase heading with no bar yet is still worth showing: "Downloading" the
  // moment it starts beats a blank row until the first frame arrives.
  const phase = phaseMatch
    ? phaseMatch[1].replace(/^Starting package install$/i, "Installing")
    : (previous.phase ?? null);

  const frame = lastFrame(text);
  const bytes = BYTES.exec(frame) ?? BYTES.exec(text);
  if (bytes) {
    const done = toBytes(bytes[1], bytes[2]);
    const total = toBytes(bytes[3], bytes[4]);
    if (total > 0) {
      return {
        percent: Math.max(0, Math.min(100, Math.round((done / total) * 100))),
        label: `${formatBytes(done)} of ${formatBytes(total)}`,
        phase
      };
    }
  }
  const percent = PERCENT.exec(frame) ?? PERCENT.exec(text);
  if (percent) {
    const value = Number(percent[1]);
    if (Number.isFinite(value) && value <= 100) {
      return { percent: value, label: `${value}%`, phase };
    }
  }
  // A phase change with no measurable progress still moves the row on — but it
  // starts from nothing, not from the last phase's number. Carrying the
  // download's 100% into "Installing" drew a full bar over a step that had not
  // begun, which is the one thing a progress bar must never say.
  if (phaseMatch) {
    return { percent: phase === previous.phase ? (previous.percent ?? null) : null, label: "", phase };
  }
  return null;
}

/**
 * A stateful reader for one command, with the throttling that makes it usable.
 *
 * winget redraws its bar many times a second. Emitting every redraw would put
 * hundreds of events through the same channel the model's own words use, for a
 * bar that can only move a hundred times. So: report when the percentage
 * actually changed, or when the phase did, and never more than ten times a
 * second.
 */
export function createProgressReader({ minIntervalMs = 100 } = {}) {
  let last = { percent: null, phase: null };
  let lastAt = 0;
  return function read(chunk) {
    const progress = readProgress(chunk, last);
    if (!progress) return null;
    const now = Date.now();
    const movedPhase = progress.phase !== last.phase;
    const movedPercent = progress.percent !== last.percent;
    if (!movedPhase && !movedPercent) return null;
    if (!movedPhase && now - lastAt < minIntervalMs) return null;
    // 100% is always worth reporting: it is the frame the user is waiting for,
    // and dropping it to a throttle leaves the bar stuck at 97 for ever.
    if (progress.percent !== 100 && !movedPhase && now - lastAt < minIntervalMs) return null;
    last = { percent: progress.percent, phase: progress.phase };
    lastAt = now;
    return progress;
  };
}

// Commands worth watching. A progress bar under `Get-Process` would be noise;
// under a package install it is the only thing the user wants to see.
const WATCHED = /(^|[\s;|])(winget|choco|scoop|pip3?|npm|pnpm|yarn|curl|wget|docker)\b/i;

export function reportsProgress(command) {
  return WATCHED.test(String(command ?? ""));
}
