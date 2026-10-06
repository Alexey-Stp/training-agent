import type { Server } from 'node:http';
import type { Queue } from 'bullmq';
import type { RequestHandler } from 'express';

const LOCAL_HOST = '127.0.0.1';
const BOARD_PATH = '/admin/queues';

/**
 * Local queue inspector. The packages are imported on demand so a worker with the flag off never
 * loads express. It binds to loopback only: the board can retry and delete jobs.
 */
export async function startBullBoard(queues: readonly Queue[], port: number): Promise<Server> {
  const [{ createBullBoard }, { BullMQAdapter }, { ExpressAdapter }, { default: express }] =
    await Promise.all([
      import('@bull-board/api'),
      import('@bull-board/api/bullMQAdapter'),
      import('@bull-board/express'),
      import('express'),
    ]);
  const adapter = new ExpressAdapter();
  adapter.setBasePath(BOARD_PATH);
  createBullBoard({
    queues: queues.map((queue) => new BullMQAdapter(queue)),
    serverAdapter: adapter,
  });
  const app = express();
  // getRouter() is typed `any` by bull-board; it is an express router
  app.use(BOARD_PATH, adapter.getRouter() as RequestHandler);
  return new Promise((resolve, reject) => {
    const server = app.listen(port, LOCAL_HOST, () => resolve(server));
    server.once('error', reject);
  });
}
