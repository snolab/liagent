/**
 * Detents: a drag quantised into levels, each one a cell of travel, with a
 * light magnetic hold and hysteresis: the feel of a card swipe, and of the
 * chat's tree button.
 *
 * While dragging, the thing follows a smooth staircase of the finger:
 *   t = f / cell,   x = unit · (t − snap·sin(2πt) / 2π)
 * whose slope is 1 − snap on a level (it holds, yet gives a little) and
 * 1 + snap between levels (it slides into the next one). Past the last level
 * it stretches at `stretch` (rubber band) up to `stop`.
 */
export type DetentFeel = {
  /** Finger travel per level, px. */
  cell: number;
  /** The visual unit (px moved per level). */
  unit: number;
  /** Levels each way (or `[min, max]` levels when the two sides differ). */
  max: number;
  min?: number;
  /** How strongly a level holds (0..<1). */
  snap: number;
  /** Past the last level the thing follows this much of the finger… */
  stretch: number;
  /** …up to this far out, px. */
  stop: number;
};

/** The thing's position for a finger travel: the snapping staircase, then the rubber band. */
export function snapDetent(finger: number, o: DetentFeel): number {
  const max = finger >= 0 ? o.max : -(o.min ?? -o.max);
  const f = Math.abs(finger);
  const top = max * o.cell;
  const x =
    f <= top
      ? o.unit * (f / o.cell - (o.snap * Math.sin((2 * Math.PI * f) / o.cell)) / (2 * Math.PI))
      : Math.min(o.stop, max * o.unit + (f - top) * o.stretch);
  return Math.sign(finger) * x;
}

/**
 * The level after `t` cells of travel, from level `from`, with hysteresis
 * both ways: it moves on only `hysteresis` past a midpoint, so a finger
 * resting on a boundary never flickers.
 */
export function detentLevel(
  t: number,
  from: number,
  o: { min: number; max: number; hysteresis: number },
): number {
  let k = from;
  while (k < o.max && t > k + 0.5 + o.hysteresis) k++;
  while (k > o.min && t < k - 0.5 - o.hysteresis) k--;
  return k;
}
