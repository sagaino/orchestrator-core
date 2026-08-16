export function createEventHub({ heartbeatIntervalMs = 15000 } = {}) {
  const clients = new Set();
  let heartbeatTimer = null;

  const startHeartbeat = () => {
    if (heartbeatTimer) return;
    heartbeatTimer = setInterval(() => {
      for (const client of clients) {
        try {
          client.res.write(`: heartbeat ${new Date().toISOString()}\n\n`);
        } catch {
          clients.delete(client);
        }
      }
    }, heartbeatIntervalMs);
    if (heartbeatTimer.unref) heartbeatTimer.unref();
  };

  const stopHeartbeat = () => {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  };

  const addClient = (req, res) => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "Access-Control-Allow-Origin": "*",
      "X-Accel-Buffering": "no",
    });

    const client = { req, res, connectedAt: new Date().toISOString() };
    clients.add(client);

    res.write(`event: connected\ndata: ${JSON.stringify({ connectedAt: client.connectedAt })}\n\n`);

    if (clients.size === 1) {
      startHeartbeat();
    }

    req.on("close", () => {
      clients.delete(client);
      if (clients.size === 0) {
        stopHeartbeat();
      }
    });

    return client;
  };

  const broadcast = (eventType, payload = {}) => {
    const data = typeof payload === "string" ? payload : JSON.stringify(payload);
    const message = `event: ${eventType}\ndata: ${data}\n\n`;
    for (const client of clients) {
      try {
        client.res.write(message);
      } catch {
        clients.delete(client);
      }
    }
  };

  const close = () => {
    stopHeartbeat();
    for (const client of clients) {
      try {
        client.res.end();
      } catch {}
    }
    clients.clear();
  };

  return {
    addClient,
    broadcast,
    close,
    get clientCount() {
      return clients.size;
    },
  };
}
