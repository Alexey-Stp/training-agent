import { EventEmitter } from 'node:events';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createMetrics, type MetricJob, type ObservableWorker } from '../src/observability/metrics';
import { closeServer, startMetricsServer } from '../src/observability/server';

/** Only the event surface the metrics use; the real BullMQ worker is an EventEmitter too */
function fakeWorker(): EventEmitter & ObservableWorker {
  return new EventEmitter() as EventEmitter & ObservableWorker;
}

const BRIEF: MetricJob = { name: 'daily-brief', processedOn: 1_000, finishedOn: 3_500 };

describe('job metrics', () => {
  it('exposes the duration histogram and the completion counter per job name', async () => {
    const metrics = createMetrics();
    const worker = fakeWorker();
    metrics.observeWorker(worker, 'daily-brief');

    worker.emit('completed', BRIEF);

    const text = await metrics.registry.metrics();
    expect(text).toContain(
      'job_duration_seconds_bucket{le="5",job="daily-brief",queue="daily-brief",status="completed"} 1'
    );
    expect(text).toContain(
      'job_duration_seconds_sum{job="daily-brief",queue="daily-brief",status="completed"} 2.5'
    );
    expect(text).toContain('job_completed_total{job="daily-brief",queue="daily-brief"} 1');
  });

  it('counts failed attempts per job name', async () => {
    const metrics = createMetrics();
    const worker = fakeWorker();
    metrics.observeWorker(worker, 'daily-brief');

    worker.emit('failed', BRIEF, new Error('boom'));
    worker.emit('failed', BRIEF, new Error('boom'));
    worker.emit('failed', undefined, new Error('stalled'));

    const text = await metrics.registry.metrics();
    expect(text).toContain('job_failures_total{job="daily-brief",queue="daily-brief"} 2');
    expect(text).toContain('job_failures_total{job="unknown",queue="daily-brief"} 1');
  });

  it('includes the default process metrics', async () => {
    const text = await createMetrics().registry.metrics();
    expect(text).toContain('process_cpu_user_seconds_total');
  });
});

describe('metrics server', () => {
  const servers: Awaited<ReturnType<typeof startMetricsServer>>[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => closeServer(server)));
  });

  it('serves /metrics, /healthz and a 404 elsewhere', async () => {
    const metrics = createMetrics();
    const server = await startMetricsServer(metrics.registry, 0);
    servers.push(server);
    const base = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;

    const scrape = await fetch(base + '/metrics');
    expect(scrape.status).toBe(200);
    expect(await scrape.text()).toContain('process_cpu_user_seconds_total');
    expect((await fetch(base + '/healthz')).status).toBe(200);
    expect((await fetch(base + '/nope')).status).toBe(404);
  });
});
