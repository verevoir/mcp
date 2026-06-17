import { describe, it, expect, afterEach } from 'vitest';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import {
  agentCard,
  jobToTask,
  statusUpdateEvent,
  contextIdFor,
  A2AService,
  serveA2A,
  RPC,
  type A2ADeps,
} from '../src/a2a.js';
import type { DispatchJob, DispatchInput } from '../src/tools/dispatch.js';

// A controllable dispatch backend: start() stamps a job we pre-seed per id, and
// poll() reads it back — so the A2A surface can be driven deterministically
// without a real worker model.
function fakeBackend(seed: (input: DispatchInput) => DispatchJob): A2ADeps {
  const jobs = new Map<string, DispatchJob>();
  return {
    start: (input) => {
      const job = seed(input);
      jobs.set(job.id, job);
      return job;
    },
    poll: (handle) => jobs.get(handle) ?? { error: `no job "${handle}"` },
  };
}

const working: DispatchJob = {
  id: 'disp-1',
  status: 'running',
  progress: ['round 1: read_file', 'round 2: provision'],
};
const completed: DispatchJob = {
  id: 'disp-2',
  status: 'done',
  progress: ['round 1: read_file'],
  result: 'the finished work',
};
const broken: DispatchJob = {
  id: 'disp-3',
  status: 'failed',
  progress: [],
  error: 'provider not configured',
};

describe('agentCard (STDIO-382)', () => {
  it('advertises streaming and a dispatch skill so a client can discover the agent', () => {
    expect(agentCard({ url: 'http://host/', version: '1.2.3' })).toMatchObject({
      name: 'verevoir-dispatch',
      url: 'http://host/',
      version: '1.2.3',
      capabilities: { streaming: true },
      skills: [{ id: 'dispatch' }],
    });
  });
});

describe('jobToTask — DispatchJob → A2A Task', () => {
  it('maps a running job to working, with the latest progress line as the status message', () => {
    const task = jobToTask(working);
    expect(task).toMatchObject({
      id: 'disp-1',
      contextId: 'ctx-disp-1',
      kind: 'task',
      status: { state: 'working', message: { parts: [{ text: 'round 2: provision' }] } },
      artifacts: [],
    });
  });

  it('maps a done job to completed, with the result as a text artifact', () => {
    expect(jobToTask(completed)).toMatchObject({
      status: { state: 'completed' },
      artifacts: [{ name: 'result', parts: [{ kind: 'text', text: 'the finished work' }] }],
    });
  });

  it('maps a failed job to failed, surfacing the error as the status message', () => {
    expect(jobToTask(broken)).toMatchObject({
      status: { state: 'failed', message: { parts: [{ text: 'provider not configured' }] } },
      artifacts: [],
    });
  });

  it('gives the task an opaque, stable contextId derived from the handle', () => {
    expect(jobToTask(working).contextId).toBe(contextIdFor('disp-1'));
  });
});

describe('statusUpdateEvent — stream events', () => {
  it('marks a terminal state final so a stream knows to close', () => {
    expect(statusUpdateEvent(completed).final).toBe(true);
  });
  it('leaves a running state non-final', () => {
    expect(statusUpdateEvent(working).final).toBe(false);
  });
});

describe('A2AService.send — message/send validation', () => {
  const service = () => new A2AService(fakeBackend(() => working));

  it('rejects a request with no message', () => {
    expect(service().send({}).error).toMatchObject({ code: RPC.INVALID_PARAMS });
  });

  it('rejects a message with no text part', () => {
    expect(service().send({ message: { parts: [] } }).error).toMatchObject({
      code: RPC.INVALID_PARAMS,
    });
  });

  it('rejects a message missing the model/source metadata dispatch needs', () => {
    const out = service().send({
      message: { parts: [{ kind: 'text', text: 'review this' }], metadata: { model: 'deepseek' } },
    });
    expect(out.error).toMatchObject({ code: RPC.INVALID_PARAMS });
  });

  it('submits a task and returns it with the inbound message as history', () => {
    const out = service().send({
      message: {
        parts: [{ kind: 'text', text: 'review this' }],
        metadata: { model: 'deepseek', source: '/repo' },
      },
    });
    expect(out.result).toMatchObject({
      id: 'disp-1',
      status: { state: 'working' },
      history: [{ role: 'user', parts: [{ text: 'review this' }] }],
    });
  });

  it('passes the prompt, model, and source through to dispatch', () => {
    let seen: DispatchInput | undefined;
    const svc = new A2AService(
      fakeBackend((input) => {
        seen = input;
        return working;
      })
    );
    svc.send({
      message: {
        parts: [{ kind: 'text', text: 'do the thing' }],
        metadata: { model: 'deepseek', source: '/repo' },
      },
    });
    expect(seen).toEqual({ prompt: 'do the thing', model: 'deepseek', source: '/repo' });
  });
});

describe('A2AService.get — tasks/get', () => {
  function submitted() {
    const svc = new A2AService(fakeBackend(() => working));
    svc.send({
      message: {
        parts: [{ kind: 'text', text: 'review this' }],
        metadata: { model: 'deepseek', source: '/repo' },
      },
    });
    return svc;
  }

  it('returns TASK_NOT_FOUND for an unknown id — distinct from a malformed request', () => {
    expect(submitted().get({ id: 'nope' }).error).toMatchObject({ code: RPC.TASK_NOT_FOUND });
  });

  it('rejects a get with no id', () => {
    expect(submitted().get({}).error).toMatchObject({ code: RPC.INVALID_PARAMS });
  });

  it('returns the task with its stored history', () => {
    expect(submitted().get({ id: 'disp-1' }).result).toMatchObject({
      id: 'disp-1',
      history: [{ role: 'user', parts: [{ text: 'review this' }] }],
    });
  });
});

describe('A2AService.handle — JSON-RPC envelope', () => {
  const service = () => new A2AService(fakeBackend(() => working));

  it('rejects a non-2.0 request as an invalid request', () => {
    expect(service().handle({ jsonrpc: '1.0', method: 'tasks/get', id: 1 }).error).toMatchObject({
      code: RPC.INVALID_REQUEST,
    });
  });

  it('rejects an unknown method', () => {
    expect(
      service().handle({ jsonrpc: '2.0', method: 'tasks/frobnicate', id: 1 }).error
    ).toMatchObject({ code: RPC.METHOD_NOT_FOUND });
  });

  it('points message/stream at the SSE endpoint rather than handling it inline', () => {
    expect(
      service().handle({ jsonrpc: '2.0', method: 'message/stream', id: 1 }).error
    ).toMatchObject({ code: RPC.INVALID_REQUEST });
  });

  it('echoes the request id back on the response', () => {
    expect(
      service().handle({ jsonrpc: '2.0', method: 'tasks/get', params: { id: 'x' }, id: 42 }).id
    ).toBe(42);
  });
});

describe('serveA2A — HTTP surface', () => {
  let close: (() => void) | undefined;
  afterEach(() => close?.());

  async function start(deps: A2ADeps & { streamIntervalMs?: number }) {
    const server = serveA2A({ port: 0, version: '9.9.9', ...deps });
    close = () => server.close();
    await once(server, 'listening');
    const { port } = server.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  }

  it('serves the Agent Card at the well-known path', async () => {
    const base = await start(fakeBackend(() => working));
    const card = await (await fetch(`${base}/.well-known/agent.json`)).json();
    expect(card).toMatchObject({ name: 'verevoir-dispatch', version: '9.9.9' });
  });

  it('runs a message/send → tasks/get round trip over JSON-RPC', async () => {
    const base = await start(fakeBackend(() => working));
    const send = await (
      await fetch(`${base}/`, {
        method: 'POST',
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'message/send',
          params: {
            message: {
              parts: [{ kind: 'text', text: 'review this' }],
              metadata: { model: 'deepseek', source: '/repo' },
            },
          },
        }),
      })
    ).json();
    expect(send.result).toMatchObject({ id: 'disp-1', status: { state: 'working' } });

    const got = await (
      await fetch(`${base}/`, {
        method: 'POST',
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'tasks/get',
          params: { id: 'disp-1' },
        }),
      })
    ).json();
    expect(got.result).toMatchObject({ id: 'disp-1', status: { state: 'working' } });
  });

  it('returns a JSON-RPC parse error for a malformed body', async () => {
    const base = await start(fakeBackend(() => working));
    const res = await (await fetch(`${base}/`, { method: 'POST', body: 'not json' })).json();
    expect(res.error).toMatchObject({ code: RPC.PARSE });
  });

  it('streams status-update events over SSE, ending with a final event', async () => {
    const base = await start({ ...fakeBackend(() => completed), streamIntervalMs: 5 });
    const res = await fetch(`${base}/`, {
      method: 'POST',
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'message/stream',
        params: {
          message: {
            parts: [{ kind: 'text', text: 'review this' }],
            metadata: { model: 'deepseek', source: '/repo' },
          },
        },
      }),
    });
    const body = await res.text();
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    expect(body).toContain('"kind":"status-update"');
    expect(body).toContain('"final":true');
  });
});
