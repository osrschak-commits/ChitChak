import {
  GatewayCloseCode,
  type ClientMessage,
  type ServerMessage,
} from '@chitchak/protocol';
import { api, apiBase } from './api.js';

/**
 * Gateway client: one WebSocket, reconnecting.
 *
 * Reconnection is the interesting part. A server restart or a laptop lid means
 * every client comes back at once, so backoff is exponential *with jitter* -
 * without the jitter they all retry in lockstep and hammer the server in waves
 * at exactly the moment it is least able to cope.
 */

type Listener = (message: ServerMessage) => void;
type StatusListener = (status: GatewayStatus) => void;

export type GatewayStatus = 'idle' | 'connecting' | 'ready' | 'reconnecting' | 'closed';

const BASE_RETRY_MS = 1_000;
const MAX_RETRY_MS = 30_000;

export class GatewayClient {
  private socket: WebSocket | null = null;
  private listeners = new Set<Listener>();
  private statusListeners = new Set<StatusListener>();
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private attempts = 0;
  private seq = 0;
  private deliberatelyClosed = false;
  private status: GatewayStatus = 'idle';

  onMessage(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onStatus(listener: StatusListener): () => void {
    this.statusListeners.add(listener);
    listener(this.status);
    return () => this.statusListeners.delete(listener);
  }

  async connect(): Promise<void> {
    // Idempotent: a second call while a socket is open or opening is a no-op.
    // Two gateway sockets would mean every server event applied twice.
    if (
      this.socket &&
      (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }

    this.deliberatelyClosed = false;
    clearTimeout(this.reconnectTimer);

    const token = await api.freshAccessToken();
    if (!token) {
      this.setStatus('closed');
      return;
    }

    this.setStatus(this.attempts === 0 ? 'connecting' : 'reconnecting');

    const url = `${apiBase.replace(/^http/, 'ws')}/gateway`;
    const socket = new WebSocket(url);
    this.socket = socket;

    socket.addEventListener('open', () => {
      // The token travels in the first frame rather than in the URL: query
      // strings are logged by proxies and servers, and an access token in a log
      // is a credential in a log.
      this.send({ op: 'identify', d: { token } });
    });

    socket.addEventListener('message', (event) => {
      let message: ServerMessage;
      try {
        message = JSON.parse(String(event.data)) as ServerMessage;
      } catch {
        return;
      }

      if (message.op === 'hello') {
        this.startHeartbeat(message.d.heartbeatIntervalMs);
      }
      if (message.op === 'ready') {
        // Only reset backoff once the connection is genuinely usable. Resetting
        // on `open` would produce a hot loop against a server that accepts
        // sockets but rejects every identify.
        this.attempts = 0;
        this.setStatus('ready');
      }

      for (const listener of this.listeners) listener(message);
    });

    socket.addEventListener('close', (event) => {
      this.stopHeartbeat();
      this.socket = null;
      if (this.deliberatelyClosed) {
        this.setStatus('closed');
        return;
      }
      // A rejected token will be rejected again immediately; refreshing
      // credentials first is the only thing that can change the outcome.
      if (event.code === GatewayCloseCode.AuthenticationFailed) {
        void api.freshAccessToken().then((refreshed) => {
          if (refreshed) this.scheduleReconnect();
          else this.setStatus('closed');
        });
        return;
      }
      this.scheduleReconnect();
    });

    socket.addEventListener('error', () => {
      // 'close' always follows; reconnection is handled there so it happens once.
    });
  }

  close(): void {
    this.deliberatelyClosed = true;
    clearTimeout(this.reconnectTimer);
    this.stopHeartbeat();
    this.socket?.close(1000, 'client shutdown');
    this.socket = null;
    this.setStatus('closed');
  }

  send(message: ClientMessage): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify(message));
  }

  private scheduleReconnect(): void {
    this.attempts += 1;
    this.setStatus('reconnecting');

    const backoff = Math.min(BASE_RETRY_MS * 2 ** (this.attempts - 1), MAX_RETRY_MS);
    // Full jitter. Every client picking a random point in [0, backoff) spreads
    // a thundering herd out instead of synchronising it.
    const delay = Math.random() * backoff;

    this.reconnectTimer = setTimeout(() => void this.connect(), delay);
  }

  private startHeartbeat(intervalMs: number): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this.seq += 1;
      this.send({ op: 'heartbeat', d: { seq: this.seq } });
    }, intervalMs);
  }

  private stopHeartbeat(): void {
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
  }

  private setStatus(status: GatewayStatus): void {
    if (this.status === status) return;
    this.status = status;
    for (const listener of this.statusListeners) listener(status);
  }
}

export const gateway = new GatewayClient();
