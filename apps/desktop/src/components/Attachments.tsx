import type { Attachment } from '@chitchak/protocol';
import { useState } from 'react';
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
  if (files.length === 0) return null;
  return (
    <div className="atts">
      {files.map((file) =>
        RENDERABLE.has(file.mimeType) ? (
          <ImageAttachment key={file.id} file={file} />
        ) : (
          <FileAttachment key={file.id} file={file} />
        ),
      )}
    </div>
  );
}

function ImageAttachment({ file }: { file: Attachment }) {
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

  return (
    <a
      className="att att--image"
      href={`${apiBase}${file.url}`}
      target="_blank"
      rel="noreferrer"
      title={`${file.name} · ${formatBytes(file.bytes)}`}
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
    </a>
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
