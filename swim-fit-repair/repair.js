// Swim FIT repair — parse, model, detect, fix, recompute, encode.
// No DOM here by design: this module only ever sees FIT bytes in, FIT bytes
// out, so it could move into a Worker (or Node) unchanged. See ../TODO-swim-fit-repair.md.

import { Decoder, Encoder, Stream, Profile } from 'https://cdn.jsdelivr.net/npm/@garmin/fitsdk/+esm';

const LENGTH_MESG_NUM = Profile.MesgNum.LENGTH;

// ── Decode ──────────────────────────────────────────────────

/**
 * Decode a FIT file's bytes into a chronological message list plus the
 * type-grouped dictionary fitsdk normally returns. Both reference the same
 * mutable message objects, so edits made via one are visible in the other.
 * @param {ArrayBuffer} arrayBuffer
 */
export function decodeFit(arrayBuffer) {
  const stream = Stream.fromArrayBuffer(arrayBuffer);
  if (!Decoder.isFIT(stream)) throw new Error('Not a FIT file');

  const decoder = new Decoder(stream);
  if (!decoder.checkIntegrity()) throw new Error('FIT file failed integrity check (corrupt or truncated)');

  const order = [];
  const { messages, errors } = decoder.read({
    mesgListener: (num, msg) => order.push({ num, msg })
  });
  if (errors.length) throw new Error('FIT decode error: ' + errors.map(String).join('; '));

  return { order, messages };
}

// ── Model ───────────────────────────────────────────────────

/**
 * Build a session → laps → lengths model. Lap membership is derived from
 * gaps between consecutive laps' first_length_index, not from num_lengths —
 * Garmin sets num_lengths to 0 on a dedicated rest lap even though it still
 * owns one (idle) length record, so num_lengths can't be trusted for grouping.
 */
export function buildModel(messages) {
  const session = messages.sessionMesgs?.[0];
  if (!session) throw new Error('No session message found — is this a pool swim activity?');
  if (session.subSport && session.subSport !== 'lapSwimming' && session.sport !== 'swimming')
    throw new Error('This does not look like a pool swim activity');

  const laps = messages.lapMesgs ?? [];
  const lengths = messages.lengthMesgs ?? [];
  if (!laps.length || !lengths.length) throw new Error('No laps or lengths found in this file');

  const lapGroups = laps.map((lap, i) => {
    const start = lap.firstLengthIndex ?? 0;
    const end = i + 1 < laps.length ? (laps[i + 1].firstLengthIndex ?? lengths.length) : lengths.length;
    return { lap, lengths: lengths.slice(start, end) };
  });

  return { session, laps: lapGroups };
}

// ── Stats helpers ───────────────────────────────────────────

function median(values) {
  const s = [...values].sort((a, b) => a - b);
  const n = s.length;
  if (n === 0) return null;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

function dominantStroke(activeLengths) {
  const strokes = new Set(activeLengths.map(l => l.swimStroke));
  return strokes.size === 1 ? [...strokes][0] : 'mixed';
}

// ── Detection ───────────────────────────────────────────────

/**
 * Find likely recording mistakes. Returns issues in file order, each with a
 * stable id (based on the length's *original* message_index, before any
 * renumbering) so the UI can track checkbox selection across a preview.
 */
export function detectIssues(model) {
  const { session, laps } = model;
  const poolLength = session.poolLength;
  const allActive = laps.flatMap(g => g.lengths.filter(l => l.lengthType === 'active'));
  const issues = [];

  for (const g of laps) {
    const activeInLap = g.lengths.filter(l => l.lengthType === 'active');
    if (activeInLap.length === 0) continue; // dedicated rest lap — nothing to flag

    const lapMedTime = median(activeInLap.map(l => l.totalTimerTime));
    const lapMedStrokes = median(activeInLap.map(l => l.totalStrokes));

    for (const l of g.lengths) {
      // Issue A: a swimming length recorded as rest
      if (l.lengthType === 'idle' && (l.totalStrokes ?? 0) === 0 && lapMedTime) {
        const ratio = l.totalTimerTime / lapMedTime;
        if (ratio >= 0.8 && ratio <= 1.2) {
          const avgSpeed = poolLength / l.totalTimerTime;
          issues.push({
            id: `A-${l.messageIndex}`,
            type: 'A',
            confidence: 'medium',
            defaultOn: false,
            lapIndex: g.lap.messageIndex,
            length: l,
            summary: `Length ${l.messageIndex}: recorded as rest (${l.totalTimerTime.toFixed(1)}s) but matches this lap's swim pace`,
            proposed: {
              lengthType: 'active',
              swimStroke: dominantStroke(activeInLap),
              totalStrokes: Math.round(lapMedStrokes),
              avgSpeed,
              enhancedAvgSpeed: avgSpeed,
            },
          });
        }
      }

      // Issue B: a missed turn, N lengths merged into one
      if (l.lengthType === 'active') {
        const localSiblings = activeInLap.filter(x => x !== l);
        const refPool = localSiblings.length > 0 ? localSiblings : allActive.filter(x => x !== l);
        const refTime = median(refPool.map(x => x.totalTimerTime));
        const refStrokes = median(refPool.map(x => x.totalStrokes));
        if (refTime && refStrokes) {
          const n = Math.round(l.totalTimerTime / refTime);
          if (n >= 2) {
            const timeRatio = Math.abs(l.totalTimerTime / refTime - n) / n;
            const strokeRatio = refStrokes ? Math.abs(l.totalStrokes / refStrokes - n) / n : Infinity;
            if (timeRatio <= 0.15 && strokeRatio <= 0.15) {
              issues.push({
                id: `B-${l.messageIndex}`,
                type: 'B',
                confidence: 'high',
                defaultOn: true,
                lapIndex: g.lap.messageIndex,
                length: l,
                n,
                summary: `Length ${l.messageIndex}: ${l.totalTimerTime.toFixed(1)}s / ${l.totalStrokes} strokes is ~${n}x a normal length — likely a missed turn`,
                proposed: splitLength(l, n, poolLength),
              });
            }
          }
        }
      }
    }
  }

  return issues;
}

// ── Fixes ───────────────────────────────────────────────────

function splitLength(target, n, poolLength) {
  const totalMs = Math.round(target.totalTimerTime * 1000);
  const baseMs = Math.floor(totalMs / n);
  const remMs = totalMs - baseMs * n;

  const totalStrokes = target.totalStrokes ?? 0;
  const baseStrokes = Math.floor(totalStrokes / n);
  const remStrokes = totalStrokes - baseStrokes * n;

  let cursor = target.startTime;
  const parts = [];
  for (let i = 0; i < n; i++) {
    const isLast = i === n - 1;
    const partMs = baseMs + (isLast ? remMs : 0);
    const partStrokes = baseStrokes + (isLast ? remStrokes : 0);
    const partSec = partMs / 1000;
    const avgSpeed = poolLength / partSec;

    const clone = Object.assign({}, target);
    clone.totalElapsedTime = partSec;
    clone.totalTimerTime = partSec;
    clone.totalStrokes = partStrokes;
    clone.avgSpeed = avgSpeed;
    if ('enhancedAvgSpeed' in target) clone.enhancedAvgSpeed = avgSpeed;
    clone.startTime = new Date(cursor.getTime());
    clone.timestamp = new Date(cursor.getTime() + partMs);
    parts.push(clone);

    cursor = new Date(cursor.getTime() + partMs);
  }
  return parts;
}

/**
 * Apply the selected issues' fixes to the model and chronological order in
 * place, then recompute every lap and the session from the edited lengths.
 * @param {{order: Array}} decoded  the object returned by decodeFit()
 * @param {ReturnType<typeof buildModel>} model
 * @param {ReturnType<typeof detectIssues>} issues
 * @param {Set<string>} selectedIds
 */
export function applyFixes(decoded, model, issues, selectedIds) {
  const poolLength = model.session.poolLength;

  for (const issue of issues) {
    if (!selectedIds.has(issue.id)) continue;

    if (issue.type === 'A') {
      Object.assign(issue.length, issue.proposed);
      continue;
    }

    // Issue B: replace the one merged length with N split lengths, in both
    // the lap's length array and the file's chronological message order.
    const newLengths = splitLength(issue.length, issue.n, poolLength);

    const group = model.laps.find(g => g.lengths.includes(issue.length));
    const posInLap = group.lengths.indexOf(issue.length);
    group.lengths.splice(posInLap, 1, ...newLengths);

    const orderIdx = decoded.order.findIndex(o => o.msg === issue.length);
    decoded.order.splice(orderIdx, 1, ...newLengths.map(msg => ({ num: LENGTH_MESG_NUM, msg })));
  }

  recomputeAll(model);
}

/**
 * Rewrite lengths' message_index, and every lap/session total derived from
 * them. Total elapsed/timer time is untouched at lap and session level —
 * both fixes only reclassify or split existing time, never change it.
 */
export function recomputeAll(model) {
  const { session, laps } = model;
  const poolLength = session.poolLength;

  let counter = 0;
  for (const g of laps) {
    g.lap.firstLengthIndex = counter;
    for (const l of g.lengths) l.messageIndex = counter++;

    const activeLens = g.lengths.filter(l => l.lengthType === 'active');
    g.lap.numActiveLengths = activeLens.length;
    // Garmin's own convention: a lap with no active lengths (pure rest) reports 0.
    g.lap.numLengths = activeLens.length > 0 ? g.lengths.length : 0;
    g.lap.totalDistance = activeLens.length * poolLength;

    if (activeLens.length > 0) {
      g.lap.totalStrokes = activeLens.reduce((s, l) => s + (l.totalStrokes ?? 0), 0);
      const activeTt = activeLens.reduce((s, l) => s + l.totalTimerTime, 0);
      g.lap.avgSpeed = g.lap.totalDistance / activeTt;
      if ('enhancedAvgSpeed' in g.lap) g.lap.enhancedAvgSpeed = g.lap.avgSpeed;
      g.lap.swimStroke = dominantStroke(activeLens);
    }
  }

  session.totalDistance = laps.reduce((s, g) => s + g.lap.totalDistance, 0);
  session.numLengths = laps.reduce((s, g) => s + g.lap.numLengths, 0);
  session.numActiveLengths = laps.reduce((s, g) => s + g.lap.numActiveLengths, 0);

  const allActive = laps.flatMap(g => g.lengths.filter(l => l.lengthType === 'active'));
  if (allActive.length > 0) {
    const activeTtSum = allActive.reduce((s, l) => s + l.totalTimerTime, 0);
    session.avgSpeed = session.totalDistance / activeTtSum;
    if ('enhancedAvgSpeed' in session) session.enhancedAvgSpeed = session.avgSpeed;
    if ('swimStroke' in session) session.swimStroke = dominantStroke(allActive);
  }
}

// ── Encode ──────────────────────────────────────────────────

/**
 * Re-encode the chronological message list back into FIT bytes. Messages
 * that decoded to zero fields (some devices emit near-empty zones_target /
 * user_profile records) are dropped — the encoder can't write a message
 * with no fields, and they carry no information either way.
 */
export function encodeFit(order) {
  const encoder = new Encoder();
  for (const { num, msg } of order) {
    if (Object.keys(msg).length === 0) continue;
    encoder.writeMesg({ mesgNum: num, ...msg });
  }
  return encoder.close();
}

// ── Summary ─────────────────────────────────────────────────

export function summarize(model) {
  const { session, laps } = model;
  return {
    poolLength: session.poolLength,
    totalDistance: session.totalDistance,
    totalElapsedTime: session.totalElapsedTime,
    numLaps: laps.length,
    numLengths: session.numLengths,
    numActiveLengths: session.numActiveLengths,
  };
}
