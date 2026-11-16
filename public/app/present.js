// Blits an indexed Framebuffer onto a <canvas> through the 256-colour palette.
import { paletteRGBA32 } from '/src/gfx/palette.mjs';

export function createPresenter(canvas) {
  const ctx = canvas.getContext('2d', { alpha: false });
  const lut = paletteRGBA32();
  let image = null, view = null;

  return {
    /** Draw fb to the canvas, resizing the canvas backing store when the size changes. */
    present(fb) {
      if (!image || image.width !== fb.w || image.height !== fb.h) {
        canvas.width = fb.w; canvas.height = fb.h;
        image = ctx.createImageData(fb.w, fb.h);
        view = new Uint32Array(image.data.buffer);
      }
      fb.toRGBA32(view, lut);
      ctx.putImageData(image, 0, 0);
    },
  };
}
