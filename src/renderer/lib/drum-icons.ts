/**
 * Line-art kit icons for the gameplay lanes.
 *
 * WHY VECTOR, NOT PNG. These are watermarks behind falling notes, so they must
 * take the lane's own colour, sit at whatever alpha keeps notes legible, and
 * stay sharp at any lane width on any display. A raster asset would need a set
 * per colour and per scale, and would be one more thing in the bundle. Canvas
 * paths cost roughly a dozen operations each per frame — nothing against the
 * note loop that runs beside them.
 *
 * Each icon is drawn in a unit box centred on the origin, spanning about
 * -1..1, then scaled by the caller. They are silhouettes first: at 12% opacity
 * behind moving notes, fine detail is invisible, so each shape is built to be
 * recognisable by outline alone and to differ from its neighbours in outline —
 * which is why crash is tilted and ride is flat, and why the tom is a narrower,
 * deeper drum than the snare rather than a smaller copy of it.
 */

import type { DrumType } from "../../shared/types.js";

function ellipse(ctx: CanvasRenderingContext2D, x: number, y: number, rx: number, ry: number) {
  ctx.beginPath();
  ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
  ctx.stroke();
}

/** A drum seen from the side: two rims joined by the shell. */
function shell(ctx: CanvasRenderingContext2D, halfWidth: number, top: number, bottom: number) {
  const ry = halfWidth * 0.3;
  ellipse(ctx, 0, top, halfWidth, ry);
  ctx.beginPath();
  ctx.moveTo(-halfWidth, top);
  ctx.lineTo(-halfWidth, bottom);
  ctx.moveTo(halfWidth, top);
  ctx.lineTo(halfWidth, bottom);
  ctx.stroke();
  // Only the front of the lower rim — the back edge is hidden by the shell,
  // and drawing it makes a solid drum read as a wire cylinder.
  ctx.beginPath();
  ctx.ellipse(0, bottom, halfWidth, ry, 0, 0, Math.PI);
  ctx.stroke();
}

/** A cymbal on a stand: tilt 0 reads as a ride, a tilt reads as a crash. */
function cymbal(ctx: CanvasRenderingContext2D, tilt: number, halfWidth: number, bell: number) {
  ctx.save();
  ctx.rotate(tilt);
  ellipse(ctx, 0, -0.35, halfWidth, halfWidth * 0.17);
  if (bell > 0) ellipse(ctx, 0, -0.35, bell, bell * 0.5);
  ctx.restore();
  ctx.beginPath();
  ctx.moveTo(0, -0.3);
  ctx.lineTo(0, 0.85);
  ctx.moveTo(-0.35, 0.85);
  ctx.lineTo(0.35, 0.85);
  ctx.stroke();
}

const DRAW: Record<DrumType, (ctx: CanvasRenderingContext2D) => void> = {
  // Front-on bass drum: the one kit piece nobody sees from the side.
  kick: (ctx) => {
    ellipse(ctx, 0, 0, 0.95, 0.95);
    ellipse(ctx, 0, 0, 0.4, 0.4);
  },
  // Wide and shallow, with the strainer line that only a snare has.
  snare: (ctx) => {
    shell(ctx, 0.9, -0.35, 0.3);
    ctx.beginPath();
    ctx.moveTo(-0.9, 0.02);
    ctx.lineTo(0.9, 0.02);
    ctx.stroke();
  },
  // Narrower and deeper than the snare, so the outlines don't collide.
  tom: (ctx) => {
    shell(ctx, 0.68, -0.55, 0.45);
  },
  // Two cymbals face to face on a rod — unmistakable in silhouette, but only
  // if they read as two. At the first spacing their outlines nearly touched
  // and merged into one blurred shape at watermark opacity, so they are
  // thinner and further apart than a real closed hi-hat.
  hihat: (ctx) => {
    ellipse(ctx, 0, -0.38, 0.92, 0.13);
    ellipse(ctx, 0, 0.06, 0.92, 0.13);
    ctx.beginPath();
    ctx.moveTo(0, -0.58);
    ctx.lineTo(0, 0.85);
    ctx.moveTo(-0.35, 0.85);
    ctx.lineTo(0.35, 0.85);
    ctx.stroke();
  },
  crash: (ctx) => cymbal(ctx, -0.22, 0.95, 0),
  ride: (ctx) => cymbal(ctx, 0, 1, 0.22),
};

/**
 * Draw a kit piece centred at (cx, cy), `size` tall, in `color`.
 *
 * The caller owns alpha: these are backdrops, and a note crossing one must stay
 * the brightest thing in the lane.
 */
export function drawDrumIcon(
  ctx: CanvasRenderingContext2D,
  drum: DrumType,
  cx: number,
  cy: number,
  size: number,
  color: string,
  alpha: number,
): void {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(1.5, size * 0.035);
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.translate(cx, cy);
  ctx.scale(size / 2, size / 2);
  // Scaling the context scales the pen too; undo that so every icon keeps the
  // same stroke weight regardless of lane width.
  ctx.lineWidth /= size / 2;
  DRAW[drum](ctx);
  ctx.restore();
}
