'use strict';
/** Minimal in-process event bus feeding the SSE stream. */

const clients = new Set();

function subscribe(res) {
  const client = { res, id: Math.random().toString(36).slice(2) };
  clients.add(client);
  return () => clients.delete(client);
}

/** Broadcast a lightweight change notification. Payloads are intentionally
 *  event-free: clients re-fetch their own authorised snapshot. */
function broadcast(entity, id, actor) {
  const payload = { type: 'change', entity, id: id || null, actor: actor || null, at: new Date().toISOString() };
  const line = `data: ${JSON.stringify(payload)}\n\n`;
  for (const c of clients) {
    try {
      c.res.write(line);
    } catch {
      clients.delete(c);
    }
  }
}

function heartbeat() {
  for (const c of clients) {
    try {
      c.res.write(': ping\n\n');
    } catch {
      clients.delete(c);
    }
  }
}

setInterval(heartbeat, 20000).unref?.();

module.exports = { subscribe, broadcast, count: () => clients.size };
