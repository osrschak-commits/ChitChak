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
