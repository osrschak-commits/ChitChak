/**
 * Client-side image preparation for avatars and server icons.
 *
 * Resizing here rather than on the server means uploads are tens of kilobytes
 * instead of megabytes, the server needs no image pipeline, and the user gets
 * immediate feedback if their file is not usable.
 */

const TARGET_SIZE = 256;

export async function prepareSquareImage(file: File): Promise<string> {
  if (!file.type.startsWith('image/')) {
    throw new Error('Choose an image file');
  }
  // Generous ceiling: this is the file on disk, before we shrink it. A 25MB
  // camera photo is fine; a 500MB video renamed to .png is not.
  if (file.size > 25 * 1024 * 1024) {
    throw new Error('That file is too large to read');
  }

  const bitmap = await createImageBitmap(file).catch(() => {
    throw new Error('That image could not be read');
  });

  const canvas = document.createElement('canvas');
  canvas.width = TARGET_SIZE;
  canvas.height = TARGET_SIZE;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Your system could not process that image');

  // Centre crop to a square, so a wide photo does not arrive squashed.
  const side = Math.min(bitmap.width, bitmap.height);
  const sx = (bitmap.width - side) / 2;
  const sy = (bitmap.height - side) / 2;

  context.imageSmoothingQuality = 'high';
  context.drawImage(bitmap, sx, sy, side, side, 0, 0, TARGET_SIZE, TARGET_SIZE);
  bitmap.close();

  // JPEG at 0.85: visually clean at this size and a fraction of PNG's weight.
  // The server re-checks the decoded bytes against the declared type anyway.
  const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
  if (dataUrl.length > 700_000) throw new Error('That image is too large');
  return dataUrl;
}

/**
 * Re-encodes a PNG or JPEG down to fit under `maxBytes`, for the emoji
 * uploader - a different shape of problem to the one above. An avatar always
 * ends up exactly 256x256; an emoji has to keep its own aspect ratio and hit
 * an exact byte ceiling rather than a fixed size, so this backs off quality
 * first and then, if that alone is not enough, the canvas itself, trying the
 * quality ladder again at each size rather than jumping straight to the
 * smallest one that might fit.
 *
 * WebP rather than JPEG: an emoji is often not a photograph, and flattening
 * its transparency to a JPEG's solid background would be a worse trade than
 * the file staying a little larger. WebP keeps the alpha channel and still
 * compresses hard.
 *
 * GIF and WebP are refused rather than shrunk - either can be animated, and
 * a canvas only ever sees one frame. Silently deleting someone's animation
 * to make it smaller is a worse surprise than asking them to resize it
 * themselves.
 */
export async function shrinkImageToFit(file: File, maxBytes: number): Promise<Blob> {
  if (file.type !== 'image/png' && file.type !== 'image/jpeg') {
    throw new Error('Only a PNG or JPEG can be shrunk automatically - a GIF or WebP might be animated');
  }
  if (file.size > 25 * 1024 * 1024) {
    throw new Error('That file is too large to read');
  }

  const bitmap = await createImageBitmap(file).catch(() => {
    throw new Error('That image could not be read');
  });

  let width = bitmap.width;
  let height = bitmap.height;
  const QUALITIES = [0.9, 0.75, 0.6, 0.45, 0.3];

  try {
    // Six sizes, five qualities each: comfortably enough passes to reach a
    // few hundred pixels square, which nothing meant to be read at emoji
    // size should ever need.
    for (let pass = 0; pass < 6; pass++) {
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(width));
      canvas.height = Math.max(1, Math.round(height));
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Your system could not process that image');
      context.imageSmoothingQuality = 'high';
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);

      for (const quality of QUALITIES) {
        const blob = await new Promise<Blob | null>((resolve) =>
          canvas.toBlob(resolve, 'image/webp', quality),
        );
        if (blob && blob.size <= maxBytes) return blob;
      }

      width *= 0.75;
      height *= 0.75;
      if (width < 16 || height < 16) break;
    }
  } finally {
    bitmap.close();
  }

  throw new Error('Could not shrink that image enough - try a smaller picture');
}
