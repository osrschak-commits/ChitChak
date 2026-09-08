import type { Attachment } from '@chitchak/protocol';
import { useEffect, useState } from 'react';
import { apiBase } from '../lib/api.js';

/**
 * Files on a sent message, and files waiting to be sent.
 *
 * Images render in place; everything else is a row you download. That split is
 * decided by the server, which sends anything outside a short allowlist with
 * `Content-Disposition: attachment` - so this only has to agree with it, never
 * guess.
 */

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

const RENDERABLE = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/** The largest an image is drawn at in the conversation. */
const MAX_W = 420;
const MAX_H = 320;

export function MessageAttachments({ files }: { files: Attachment[] }) {
  /*
    Which image is open full size, by id.

    Held per message rather than globally: the arrows step through the pictures
    in the message you clicked, which is the set somebody means by "the next
    one". A viewer that walked the whole channel would be a different feature.
  */
  const [viewing, setViewing] = useState<string | null>(null);
  if (files.length === 0) return null;

  const images = files.filter((file) => RENDERABLE.has(file.mimeType));

  return (
    <div className="atts">
      {files.map((file) =>
        RENDERABLE.has(file.mimeType) ? (
          <ImageAttachment key={file.id} file={file} onOpen={() => setViewing(file.id)} />
        ) : (
          <FileAttachment key={file.id} file={file} />
        ),
      )}

      {viewing && (
        <ImageViewer images={images} startId={viewing} onClose={() => setViewing(null)} />
      )}
    </div>
  );
}

function ImageAttachment({ file, onOpen }: { file: Attachment; onOpen(): void }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <FileAttachment file={file} note="Could not be shown" />;

  /*
    The box is sized from the dimensions the server read out of the header, so
    the space is reserved before a byte of the image arrives. Without it every
    picture pops in at its natural size and shoves the conversation you are
    reading down the screen.
  */
  const scale = file.width && file.height
    ? Math.min(1, MAX_W / file.width, MAX_H / file.height)
    : null;

  /*
    A button, not a link.

    An anchor to the file is what sent people out to their browser: Electron
    hands every target=_blank to the system browser, so clicking a picture in a
    chat window opened Chrome. The picture belongs in the app it was sent to.
  */
  return (
    <button
      type="button"
      className="att att--image"
      onClick={onOpen}
      title={`${file.name} · ${formatBytes(file.bytes)}`}
      aria-label={`View ${file.name}`}
      style={
        scale && file.width && file.height
          ? { width: Math.round(file.width * scale), height: Math.round(file.height * scale) }
          : undefined
      }
    >
      <img
        src={`${apiBase}${file.url}`}
        alt={file.name}
        loading="lazy"
        draggable={false}
        onError={() => setFailed(true)}
      />
    </button>
  );
}

/**
 * One picture, full size, over the app.
 *
 * Escape or a click on the background closes it; the arrows move through the
 * other pictures in the same message. Clicking the image itself switches
 * between fitting the window and actual size, because the whole reason for
 * opening a screenshot is usually to read something in it, and a 1700-pixel
 * image scaled into a chat column cannot be read.
 */
function ImageViewer({
  images,
  startId,
  onClose,
}: {
  images: Attachment[];
  startId: string;
  onClose(): void;
}) {
  const [at, setAt] = useState(() => Math.max(0, images.findIndex((i) => i.id === startId)));
  const [actualSize, setActualSize] = useState(false);
  const file = images[at];

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        // Stopped, so closing the picture does not also close whatever else on
        // the screen listens for Escape.
        event.stopPropagation();
        onClose();
        return;
      }
      if (images.length < 2) return;
      if (event.key === 'ArrowRight') setAt((i) => (i + 1) % images.length);
      if (event.key === 'ArrowLeft') setAt((i) => (i - 1 + images.length) % images.length);
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [images.length, onClose]);

  // Back to fitting when moving to another picture: actual size is a decision
  // about the one being looked at, not a mode.
  useEffect(() => setActualSize(false), [at]);

  if (!file) return null;

  return (
    <div className="viewer" role="dialog" aria-modal="true" aria-label={file.name} onClick={onClose}>
      <div className="viewer__bar" onClick={(e) => e.stopPropagation()}>
        <span className="viewer__name">{file.name}</span>
        <span className="viewer__meta mono">
          {formatBytes(file.bytes)}
          {file.width && file.height ? ` · ${file.width}×${file.height}` : ''}
          {images.length > 1 ? ` · ${at + 1} of ${images.length}` : ''}
        </span>
        <a
          className="viewer__action"
          href={`${apiBase}${file.url}`}
          download={file.name}
          title="Save this picture"
        >
          Download
        </a>
        <button type="button" className="viewer__action" onClick={onClose} aria-label="Close">
          ✕
        </button>
      </div>

      {images.length > 1 && (
        <>
          <button
            type="button"
            className="viewer__step viewer__step--back"
            aria-label="Previous picture"
            onClick={(e) => { e.stopPropagation(); setAt((i) => (i - 1 + images.length) % images.length); }}
          >
            ‹
          </button>
          <button
            type="button"
            className="viewer__step viewer__step--next"
            aria-label="Next picture"
            onClick={(e) => { e.stopPropagation(); setAt((i) => (i + 1) % images.length); }}
          >
            ›
          </button>
        </>
      )}

      <div className={`viewer__stage ${actualSize ? 'viewer__stage--actual' : ''}`}>
        <img
          className="viewer__image"
          src={`${apiBase}${file.url}`}
          alt={file.name}
          draggable={false}
          onClick={(e) => { e.stopPropagation(); setActualSize((v) => !v); }}
          title={actualSize ? 'Fit to the window' : 'Actual size'}
        />
      </div>
    </div>
  );
}

function FileAttachment({ file, note }: { file: Attachment; note?: string }) {
  return (
    <a
      className="att att--file"
      href={`${apiBase}${file.url}`}
      target="_blank"
      rel="noreferrer"
      download={file.name}
    >
      <span className="att__glyph" aria-hidden="true">
        📄
      </span>
      <span className="att__meta">
        <span className="att__name">{file.name}</span>
        <span className="att__size mono">
          {note ? `${note} · ` : ''}
          {formatBytes(file.bytes)}
        </span>
      </span>
    </a>
  );
}

/* --- Waiting to be sent ---------------------------------------------------- */

export interface Pending {
  key: string;
  name: string;
  bytes: number;
  /** 0..1 while uploading. */
  progress: number;
  /** Set once the server has it; this is what the message will carry. */
  attachment?: Attachment;
  error?: string;
  /** A local object URL, so an image previews before it has finished uploading. */
  preview?: string;
}

export function PendingAttachments({
  items,
  onRemove,
}: {
  items: Pending[];
  onRemove(key: string): void;
}) {
  if (items.length === 0) return null;

  return (
    <div className="tray">
      {items.map((item) => (
        <div key={item.key} className={`tray__item ${item.error ? 'tray__item--failed' : ''}`}>
          {item.preview ? (
            <img className="tray__thumb" src={item.preview} alt="" draggable={false} />
          ) : (
            <span className="tray__thumb tray__thumb--file" aria-hidden="true">
              📄
            </span>
          )}

          <span className="tray__meta">
            <span className="tray__name">{item.name}</span>
            <span className="tray__size mono">
              {item.error ?? (item.attachment ? formatBytes(item.bytes) : `${Math.round(item.progress * 100)}%`)}
            </span>
          </span>

          {/* Still uploading: a bar rather than a spinner, because the useful
              question is how much longer, not whether something is happening. */}
          {!item.attachment && !item.error && (
            <span className="tray__bar">
              <span className="tray__fill" style={{ width: `${Math.round(item.progress * 100)}%` }} />
            </span>
          )}

          <button
            type="button"
            className="tray__remove"
            title="Remove"
            aria-label={`Remove ${item.name}`}
            onClick={() => onRemove(item.key)}
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}
