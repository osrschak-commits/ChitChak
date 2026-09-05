/**
 * Evaluates an expression in the running dev app's renderer, over CDP.
 *
 *   node scripts/cdp.mjs "document.title"
 *   node scripts/cdp.mjs --file probe.js
 *
 * The point of this is to test the real app rather than a lookalike harness.
 * Requires `npm run dev`, which opens the debugging port.
 */
import { readFileSync } from 'node:fs';

const PORT = process.env.CDP_PORT ?? '9222';

const targets = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json());
const page = targets.find((t) => t.type === 'page' && !t.url.startsWith('devtools://'));
if (!page) {
  console.error('No renderer page found. Is `npm run dev` running?');
  process.exit(1);
}

const expression =
  process.argv[2] === '--file' ? readFileSync(process.argv[3], 'utf8') : process.argv[2];

const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true });
  socket.addEventListener('error', reject, { once: true });
});

const result = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('CDP evaluate timed out')), 30_000);
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id !== 1) return;
    clearTimeout(timer);
    resolve(message.result);
  });
  socket.send(
    JSON.stringify({
      id: 1,
      method: 'Runtime.evaluate',
      params: { expression, awaitPromise: true, returnByValue: true },
    }),
  );
});

socket.close();

if (result.exceptionDetails) {
  console.error('EXCEPTION:', result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  process.exit(1);
}
console.log(JSON.stringify(result.result.value, null, 2));
