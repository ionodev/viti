// Zooming with the wheel, smoothly. A touchpad pinch on Windows and Mac arrives as a stream of tiny Ctrl+scroll
// steps, and those are applied at once. A mouse wheel, and a pinch turned into Ctrl+scroll by a gesture tool on
// Linux, arrives in whole notches (50 to 120 pixels each): one notch is a fixed, modest step, spread over a few
// frames so the view glides there.

const NOTCH = 0.22; // one notch zooms by e^0.22, about 1.25×

// whole notches (lines or pages, or a big pixel jump) rather than the fine steps of a touchpad
export const isNotch = (e) => e.deltaMode !== 0 || Math.abs(e.deltaY) >= 40;

// wheelZoomer(apply, perPixel): returns (e, x, y) to call from a wheel handler. apply(x, y, factor) zooms by factor
// around the point (x, y); perPixel is how strongly a pixel of fine scrolling zooms.
export function wheelZoomer(apply, perPixel) {
  let pending = 0; // still to zoom, as a logarithm of the factor
  let x = 0;
  let y = 0;
  let raf = 0;
  const tick = () => {
    const step = Math.abs(pending) < 0.004 ? pending : pending * 0.5;
    pending -= step;
    apply(x, y, Math.exp(step));
    raf = pending ? requestAnimationFrame(tick) : 0;
  };
  const zoomer = (e, px, py) => {
    if (!isNotch(e)) return apply(px, py, Math.exp(-e.deltaY * perPixel));
    // the glide of the notch before is finished at once, so notches never pile up and the view stops when the
    // fingers or the wheel do
    if (pending) apply(x, y, Math.exp(pending));
    x = px;
    y = py;
    pending = -Math.sign(e.deltaY) * NOTCH;
    if (!raf) raf = requestAnimationFrame(tick);
  };
  // something else moved the view (a flight, a fit): drop what was still to come
  zoomer.cancel = () => {
    cancelAnimationFrame(raf);
    raf = 0;
    pending = 0;
  };
  return zoomer;
}
