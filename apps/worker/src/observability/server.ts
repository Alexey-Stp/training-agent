import { createServer, type Server } from 'node:http';
import type { Registry } from 'prom-client';

/** Serves `/metrics` (Prometheus text format) and `/healthz`; everything else is a 404 */
export function startMetricsServer(registry: Registry, port: number): Promise<Server> {
  const server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    if (req.method === 'GET' && path === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'text/plain' }).end('ok');
      return;
    }
    if (req.method === 'GET' && path === '/metrics') {
      registry
        .metrics()
        .then((body) => res.writeHead(200, { 'Content-Type': registry.contentType }).end(body))
        .catch(() => res.writeHead(500).end());
      return;
    }
    res.writeHead(404).end();
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, () => resolve(server));
  });
}

export function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}
