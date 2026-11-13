// GPX Lane Snapper — track geometry, auto-fit, snapping and GPX read/write.
// No UI here by design: the page (index.html) owns the map, canvas and
// controls. Everything except parseGpx / buildCorrectedGpx is pure maths on
// plain objects; those two use the browser's DOMParser / XMLSerializer.

// ── Track geometry ──────────────────────────────────────────

export const METERS_PER_DEGREE = 111320;
export const DEFAULT_TRACK = { straight: 84.39, kerbRadius: 36.5, laneWidth: 1.22 };
export const STOP_GAP_SECONDS = 10;

export function laneRadius(lane, track)
{
  // Measurement line: 0.30 m from the kerb in lane 1, 0.20 m from the inner line elsewhere
  if (lane === 1)
  {
    return track.kerbRadius + 0.30;
  }
  return track.kerbRadius + track.laneWidth * (lane - 1) + 0.20;
}

export function lapLength(radius, track)
{
  return 2 * track.straight + 2 * Math.PI * radius;
}

export function pointOnTrack(s, radius, straight)
{
  const half = straight / 2;
  const arc = Math.PI * radius;
  const perimeter = 2 * straight + 2 * arc;
  let d = ((s % perimeter) + perimeter) % perimeter;
  if (d < straight)
  {
    return { u: -half + d, v: -radius };
  }
  d -= straight;
  if (d < arc)
  {
    const angle = -Math.PI / 2 + d / radius;
    return { u: half + radius * Math.cos(angle), v: radius * Math.sin(angle) };
  }
  d -= arc;
  if (d < straight)
  {
    return { u: half - d, v: radius };
  }
  d -= straight;
  const angle = Math.PI / 2 + d / radius;
  return { u: -half + radius * Math.cos(angle), v: radius * Math.sin(angle) };
}

export function projectOnTrack(u, v, radius, straight)
{
  const half = straight / 2;
  const arc = Math.PI * radius;
  if (u >= -half && u <= half)
  {
    if (v < 0)
    {
      return { s: u + half, distance: Math.abs(-v - radius) };
    }
    return { s: straight + arc + (half - u), distance: Math.abs(v - radius) };
  }
  if (u > half)
  {
    const angle = Math.atan2(v, u - half);
    return { s: straight + (angle + Math.PI / 2) * radius, distance: Math.abs(Math.hypot(u - half, v) - radius) };
  }
  let angle = Math.atan2(v, u + half);
  if (angle < 0)
  {
    angle += 2 * Math.PI;
  }
  return { s: 2 * straight + arc + (angle - Math.PI / 2) * radius, distance: Math.abs(Math.hypot(u + half, v) - radius) };
}

export function toTrackFrame(x, y, pose)
{
  const dx = x - pose.cx;
  const dy = y - pose.cy;
  const cos = Math.cos(pose.theta);
  const sin = Math.sin(pose.theta);
  return { u: dx * cos + dy * sin, v: -dx * sin + dy * cos };
}

export function fromTrackFrame(u, v, pose)
{
  const cos = Math.cos(pose.theta);
  const sin = Math.sin(pose.theta);
  return { x: pose.cx + u * cos - v * sin, y: pose.cy + u * sin + v * cos };
}

// ── Projection ──────────────────────────────────────────────

export function createProjection(samples)
{
  let latSum = 0;
  let lonSum = 0;
  for (const sample of samples)
  {
    latSum += sample.lat;
    lonSum += sample.lon;
  }
  const lat0 = latSum / samples.length;
  const lon0 = lonSum / samples.length;
  const cosLat = Math.cos(lat0 * Math.PI / 180);
  return {
    toLocal(lat, lon)
    {
      return { x: (lon - lon0) * METERS_PER_DEGREE * cosLat, y: (lat - lat0) * METERS_PER_DEGREE };
    },
    toGeo(x, y)
    {
      return { lat: lat0 + y / METERS_PER_DEGREE, lon: lon0 + x / (METERS_PER_DEGREE * cosLat) };
    }
  };
}

// ── Auto-fit ────────────────────────────────────────────────

export function fitCost(points, pose, radius, straight)
{
  // Truncated squared error keeps a few wild GPS fixes from dragging the fit
  const CAP = 40 * 40;
  let total = 0;
  for (const point of points)
  {
    const local = toTrackFrame(point.x, point.y, pose);
    const distance = projectOnTrack(local.u, local.v, radius, straight).distance;
    total += Math.min(distance * distance, CAP);
  }
  return total / points.length;
}

export function minimizeNelderMead(costFunction, start, steps, iterations)
{
  const size = start.length;
  let simplex = [start.slice()];
  for (let i = 0; i < size; i++)
  {
    const vertex = start.slice();
    vertex[i] += steps[i];
    simplex.push(vertex);
  }
  let scores = simplex.map(costFunction);
  for (let iteration = 0; iteration < iterations; iteration++)
  {
    const order = scores.map((score, index) => index).sort((a, b) => scores[a] - scores[b]);
    simplex = order.map((index) => simplex[index]);
    scores = order.map((index) => scores[index]);
    const centroid = new Array(size).fill(0);
    for (let i = 0; i < size; i++)
    {
      for (let j = 0; j < size; j++)
      {
        centroid[j] += simplex[i][j] / size;
      }
    }
    const worst = simplex[size];
    const lerp = (factor) => centroid.map((value, j) => value + factor * (worst[j] - value));
    const reflected = lerp(-1);
    const reflectedScore = costFunction(reflected);
    if (reflectedScore < scores[0])
    {
      const expanded = lerp(-2);
      const expandedScore = costFunction(expanded);
      if (expandedScore < reflectedScore)
      {
        simplex[size] = expanded;
        scores[size] = expandedScore;
      }
      else
      {
        simplex[size] = reflected;
        scores[size] = reflectedScore;
      }
    }
    else if (reflectedScore < scores[size - 1])
    {
      simplex[size] = reflected;
      scores[size] = reflectedScore;
    }
    else
    {
      const contracted = lerp(0.5);
      const contractedScore = costFunction(contracted);
      if (contractedScore < scores[size])
      {
        simplex[size] = contracted;
        scores[size] = contractedScore;
      }
      else
      {
        for (let i = 1; i <= size; i++)
        {
          simplex[i] = simplex[i].map((value, j) => simplex[0][j] + 0.5 * (value - simplex[0][j]));
          scores[i] = costFunction(simplex[i]);
        }
      }
    }
  }
  const bestIndex = scores.indexOf(Math.min(...scores));
  return { values: simplex[bestIndex], score: scores[bestIndex] };
}

export function autoFitPose(points, radius, straight)
{
  let cx = 0;
  let cy = 0;
  for (const point of points)
  {
    cx += point.x;
    cy += point.y;
  }
  cx /= points.length;
  cy /= points.length;
  const candidates = [];
  for (let degree = 0; degree < 180; degree += 3)
  {
    const pose = { cx, cy, theta: degree * Math.PI / 180 };
    candidates.push({ pose, score: fitCost(points, pose, radius, straight) });
  }
  candidates.sort((a, b) => a.score - b.score);
  let best = null;
  for (const candidate of candidates.slice(0, 4))
  {
    const result = minimizeNelderMead(
      (values) => fitCost(points, { cx: values[0], cy: values[1], theta: values[2] }, radius, straight),
      [candidate.pose.cx, candidate.pose.cy, candidate.pose.theta],
      [5, 5, 0.1],
      120
    );
    if (!best || result.score < best.score)
    {
      best = result;
    }
  }
  const theta = ((best.values[2] % Math.PI) + Math.PI) % Math.PI;
  return { pose: { cx: best.values[0], cy: best.values[1], theta }, rms: Math.sqrt(best.score) };
}

// ── Snap ────────────────────────────────────────────────────

export function markStops(samples)
{
  return samples.map((sample, index) =>
  {
    if (sample.cadence === 0)
    {
      return true;
    }
    const next = samples[index + 1];
    return Boolean(next && next.time - sample.time > STOP_GAP_SECONDS * 1000);
  });
}

export function smoothByTime(times, values, mask, windowSeconds)
{
  if (windowSeconds <= 0)
  {
    return values.slice();
  }
  const halfWindow = windowSeconds * 1000;
  const result = values.slice();
  let left = 0;
  for (let i = 0; i < values.length; i++)
  {
    if (mask[i])
    {
      continue;
    }
    while (times[i] - times[left] > halfWindow)
    {
      left++;
    }
    let weightSum = 0;
    let valueSum = 0;
    for (let j = left; j < values.length && times[j] - times[i] <= halfWindow; j++)
    {
      if (mask[j])
      {
        continue;
      }
      const weight = 1 - Math.abs(times[j] - times[i]) / (halfWindow + 1);
      weightSum += weight;
      valueSum += weight * values[j];
    }
    result[i] = valueSum / weightSum;
  }
  return result;
}

export function applyEvenPacePerLap(progress, times, stops, perimeter, direction)
{
  // A lopsided GPS loop makes the projected speed swing within each lap.
  // Lap crossings are reliable, so spread movement evenly in moving time between them.
  const start = progress[0];
  const covered = progress.map((value) => (value - start) * direction);
  const movingClock = [0];
  for (let i = 1; i < times.length; i++)
  {
    movingClock.push(movingClock[i - 1] + (stops[i - 1] ? 0 : times[i] - times[i - 1]));
  }
  const anchors = [{ clock: 0, distance: 0 }];
  let lap = 1;
  for (let i = 1; i < covered.length; i++)
  {
    while (covered[i] >= lap * perimeter)
    {
      const span = covered[i] - covered[i - 1];
      const fraction = span > 0 ? (lap * perimeter - covered[i - 1]) / span : 1;
      anchors.push({ clock: movingClock[i - 1] + fraction * (movingClock[i] - movingClock[i - 1]), distance: lap * perimeter });
      lap++;
    }
  }
  const last = covered.length - 1;
  if (movingClock[last] > anchors[anchors.length - 1].clock)
  {
    anchors.push({ clock: movingClock[last], distance: covered[last] });
  }
  let segment = 0;
  for (let i = 0; i < progress.length; i++)
  {
    while (segment < anchors.length - 2 && movingClock[i] > anchors[segment + 1].clock)
    {
      segment++;
    }
    const from = anchors[segment];
    const to = anchors[Math.min(segment + 1, anchors.length - 1)];
    const span = to.clock - from.clock;
    const fraction = span > 0 ? Math.min(1, Math.max(0, (movingClock[i] - from.clock) / span)) : 0;
    progress[i] = start + direction * (from.distance + fraction * (to.distance - from.distance));
  }
}

export function computeSnap(samples, localPoints, options)
{
  const track = options.track;
  const radius = laneRadius(options.lane, track);
  const perimeter = lapLength(radius, track);
  const stops = markStops(samples);
  const times = samples.map((sample) => sample.time);
  const unwrapped = [];
  const residuals = [];
  let previous = null;
  for (const point of localPoints)
  {
    const local = toTrackFrame(point.x, point.y, options.pose);
    const projected = projectOnTrack(local.u, local.v, radius, track.straight);
    residuals.push(projected.distance);
    if (previous === null)
    {
      unwrapped.push(projected.s);
    }
    else
    {
      let delta = projected.s - previous;
      if (delta > perimeter / 2)
      {
        delta -= perimeter;
      }
      else if (delta < -perimeter / 2)
      {
        delta += perimeter;
      }
      unwrapped.push(unwrapped[unwrapped.length - 1] + delta);
    }
    previous = projected.s;
  }
  const direction = unwrapped[unwrapped.length - 1] >= unwrapped[0] ? 1 : -1;
  const smoothed = smoothByTime(times, unwrapped, stops, options.smoothSeconds);
  const progress = [];
  let held = smoothed[0] * direction;
  for (let i = 0; i < smoothed.length; i++)
  {
    const value = smoothed[i] * direction;
    if (!stops[i] && value > held)
    {
      held = value;
    }
    progress.push(held * direction);
  }
  const startProgress = progress[0];
  if (options.evenPace)
  {
    applyEvenPacePerLap(progress, times, stops, perimeter, direction);
  }
  let total = Math.abs(progress[progress.length - 1] - startProgress);
  if (options.wholeLaps)
  {
    const laps = Math.max(1, Math.round(total / perimeter));
    const scale = (laps * perimeter) / total;
    for (let i = 0; i < progress.length; i++)
    {
      progress[i] = startProgress + (progress[i] - startProgress) * scale;
    }
    total = laps * perimeter;
  }
  const snapped = progress.map((value) =>
  {
    const onTrack = pointOnTrack(value, radius, track.straight);
    return fromTrackFrame(onTrack.u, onTrack.v, options.pose);
  });
  const distances = progress.map((value) => Math.abs(value - startProgress));
  const laps = [];
  let lapIndex = 1;
  for (let i = 1; i < distances.length; i++)
  {
    while (distances[i] >= lapIndex * perimeter - 1e-6)
    {
      const target = lapIndex * perimeter;
      const span = distances[i] - distances[i - 1];
      const fraction = span > 0 ? (target - distances[i - 1]) / span : 1;
      laps.push(times[i - 1] + fraction * (times[i] - times[i - 1]));
      lapIndex++;
    }
  }
  const sortedResiduals = residuals.slice().sort((a, b) => a - b);
  return {
    radius,
    perimeter,
    direction,
    snapped,
    distances,
    stops,
    total,
    lapCount: total / perimeter,
    lapTimes: laps,
    medianResidual: sortedResiduals[Math.floor(sortedResiduals.length / 2)]
  };
}

// ── GPX in / out ────────────────────────────────────────────

export function parseGpx(text)
{
  const xmlDoc = new DOMParser().parseFromString(text, 'application/xml');
  if (xmlDoc.getElementsByTagName('parsererror').length > 0)
  {
    throw new Error('This file is not valid XML. Check that it is a .gpx export.');
  }
  const points = Array.from(xmlDoc.getElementsByTagNameNS('*', 'trkpt'));
  if (points.length < 20)
  {
    throw new Error('This GPX has ' + points.length + ' track points. At least 20 are needed to fit a track.');
  }
  const samples = points.map((point, index) =>
  {
    const timeNode = point.getElementsByTagNameNS('*', 'time')[0];
    const cadenceNode = point.getElementsByTagNameNS('*', 'cad')[0];
    const heartNode = point.getElementsByTagNameNS('*', 'hr')[0];
    const parsedTime = timeNode ? Date.parse(timeNode.textContent) : NaN;
    return {
      lat: parseFloat(point.getAttribute('lat')),
      lon: parseFloat(point.getAttribute('lon')),
      time: isNaN(parsedTime) ? index * 1000 : parsedTime,
      cadence: cadenceNode ? parseInt(cadenceNode.textContent, 10) : null,
      heartRate: heartNode ? parseInt(heartNode.textContent, 10) : null
    };
  });
  return { xmlDoc, points, samples };
}

export function buildCorrectedGpx(xmlDoc, projection, snapped, flatten)
{
  const points = Array.from(xmlDoc.getElementsByTagNameNS('*', 'trkpt'));
  let flatElevation = null;
  if (flatten)
  {
    const elevations = points
      .map((point) => point.getElementsByTagNameNS('*', 'ele')[0])
      .filter(Boolean)
      .map((node) => parseFloat(node.textContent))
      .sort((a, b) => a - b);
    flatElevation = elevations.length ? elevations[Math.floor(elevations.length / 2)] : null;
  }
  const originals = points.map((point) =>
  {
    const elevationNode = point.getElementsByTagNameNS('*', 'ele')[0];
    return { lat: point.getAttribute('lat'), lon: point.getAttribute('lon'), ele: elevationNode ? elevationNode.textContent : null };
  });
  points.forEach((point, index) =>
  {
    const geo = projection.toGeo(snapped[index].x, snapped[index].y);
    point.setAttribute('lat', geo.lat.toFixed(9));
    point.setAttribute('lon', geo.lon.toFixed(9));
    const elevationNode = point.getElementsByTagNameNS('*', 'ele')[0];
    if (elevationNode && flatElevation !== null)
    {
      elevationNode.textContent = flatElevation.toFixed(1);
    }
  });
  let text = new XMLSerializer().serializeToString(xmlDoc);
  points.forEach((point, index) =>
  {
    point.setAttribute('lat', originals[index].lat);
    point.setAttribute('lon', originals[index].lon);
    const elevationNode = point.getElementsByTagNameNS('*', 'ele')[0];
    if (elevationNode && originals[index].ele !== null)
    {
      elevationNode.textContent = originals[index].ele;
    }
  });
  if (!text.startsWith('<?xml'))
  {
    text = '<?xml version="1.0" encoding="UTF-8"?>\n' + text;
  }
  return text;
}
