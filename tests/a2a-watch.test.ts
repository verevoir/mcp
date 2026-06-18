import { describe, it, expect, afterEach } from 'vitest';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { serveA2A } from '../src/a2a.js';
import { watchA2A, formatStreamLine } from '../src/a2a-watch.js';
import type { DispatchJob, DispatchInput } from '../src/tools/dispatch.js';

function fakeBackend(seed: (i: DispatchInput) => DispatchJob) {
  const jobs = new Map<string, DispatchJob>();
  return {
    start: (i: DispatchInput) => {
      const j = seed(i);
      jobs.set(j.id, j);
      return j;
    },
    poll: (h: string) => jobs.get(h) ?? { error: `no job ${h}` },
  };
}

describe('formatStreamLine (STDIO-395)', () => {
  it('renders a task with its state', () => {
    expect(
      formatStreamLine({ kind: 'task', id: 'disp-x', status: { state: 'working' } })
    ).toContain('working');
  });

  it('shows the result artifact once the task has completed', () => {
    const line = formatStreamLine({
      kind: 'task',
      id: 'd',
      status: { state: 'completed' },
      artifacts: [{ parts: [{ text: 'the answer' }] }],
    });
    expect(line).toContain('the answer');
  });

  it('renders a status-update and flags the terminal one', () => {
    const line = formatStreamLine({
      kind: 'status-update',
      status: { state: 'completed' },
      final: true,
    });
    expect(line).toContain('completed');
    expect(line).toContain('final');
  });
});

describe('watchA2A — streams a dispatch over the A2A surface (STDIO-395)', () => {
  let close: (() => void) | undefined;
  afterEach(() => close?.());

  it('renders the streamed events through to the terminal one', async () => {
    const completed: DispatchJob = {
      id: 'disp-1',
      status: 'done',
      progress: ['round 1: read_file'],
      result: 'reviewed',
    };
    const server = serveA2A({ port: 0, streamIntervalMs: 5, ...fakeBackend(() => completed) });
    close = () => server.close();
    await once(server, 'listening');
    const { port } = server.address() as AddressInfo;

    const lines: string[] = [];
    await watchA2A({
      baseUrl: `http://127.0.0.1:${port}`,
      prompt: 'review',
      model: 'deepseek',
      source: '/repo',
      render: (l) => lines.push(l),
    });

    const all = lines.join('\n');
    expect(all).toContain('reviewed'); // the result artifact streamed through
    expect(all).toContain('final'); // the terminal status-update was seen
  });

  it('renders a JSON-RPC error frame rather than throwing', async () => {
    const completed: DispatchJob = { id: 'disp-1', status: 'done', progress: [], result: 'x' };
    const server = serveA2A({ port: 0, streamIntervalMs: 5, ...fakeBackend(() => completed) });
    close = () => server.close();
    await once(server, 'listening');
    const { port } = server.address() as AddressInfo;

    const lines: string[] = [];
    await watchA2A({
      baseUrl: `http://127.0.0.1:${port}`,
      prompt: 'review',
      model: 'deepseek',
      source: '', // missing source → server returns a JSON-RPC error on the stream
      render: (l) => lines.push(l),
    });

    expect(lines.join('\n')).toContain('error');
  });
});
