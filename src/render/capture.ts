/** JPEG data-url capture of a rendered canvas, cropped to 16:10. */

const TARGET_W = 640;
const TARGET_H = 400;
const QUALITY = 0.82;

function cropRect(width: number, height: number) {
  const aspect = TARGET_W / TARGET_H;
  let sw = width;
  let sh = height;
  if (sw / sh > aspect) sw = Math.round(sh * aspect);
  else sh = Math.round(sw / aspect);
  return {
    sx: Math.max(0, Math.round((width - sw) / 2)),
    sy: Math.max(0, Math.round((height - sh) / 2)),
    sw,
    sh,
  };
}

export function captureMainCanvas(source: HTMLCanvasElement): string | null {
  if (!source.width || !source.height) return null;
  const { sx, sy, sw, sh } = cropRect(source.width, source.height);
  const out = document.createElement('canvas');
  out.width = TARGET_W;
  out.height = TARGET_H;
  const ctx = out.getContext('2d');
  if (!ctx) return null;
  ctx.drawImage(source, sx, sy, sw, sh, 0, 0, TARGET_W, TARGET_H);
  try {
    return out.toDataURL('image/jpeg', QUALITY);
  } catch {
    return null;
  }
}

/**
 * Worker version: the copy into a 2D OffscreenCanvas happens synchronously,
 * then the JPEG encode runs asynchronously off the main thread.
 */
export async function captureOffscreenCanvas(source: OffscreenCanvas): Promise<string | null> {
  if (!source.width || !source.height) return null;
  const { sx, sy, sw, sh } = cropRect(source.width, source.height);
  const out = new OffscreenCanvas(TARGET_W, TARGET_H);
  const ctx = out.getContext('2d');
  if (!ctx) return null;
  ctx.drawImage(source, sx, sy, sw, sh, 0, 0, TARGET_W, TARGET_H);

  let blob: Blob;
  try {
    blob = await out.convertToBlob({ type: 'image/jpeg', quality: QUALITY });
  } catch {
    return null;
  }

  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  try {
    return `data:image/jpeg;base64,${btoa(binary)}`;
  } catch {
    return null;
  }
}
