import { createServer, type Server } from 'node:http';
import {
  startDispatch,
  dispatchResult,
  type DispatchJob,
  type DispatchInput,
} from './tools/dispatch.js';

// A2A — an Agent2Agent surface over the dispatch runtime (STDIO-382).
//
// `dispatch` already IS agent-to-agent delegation (a coordinator hands a task to
// a frontier worker and gets work back), and its async job lifecycle
// (`dispatch_start`/`dispatch_result`) already mirrors A2A's task lifecycle. This
// module puts that runtime behind the *protocol*: Google's open A2A — an Agent
// Card for discovery, JSON-RPC `message/send` to submit a task, `tasks/get` to
// poll, and `message/stream` (SSE) to watch progress. It's a thin adapter: the
// execution backend is the existing dispatch job store; this layer maps
// `DispatchJob` ↔ A2A `Task` and speaks the wire.
//
// Deliberately a separate, opt-in surface (its own server, started via the
// `verevoir-a2a` bin) — the stdio MCP is untouched. The point is to make the
// "agents as standalone runtimes" trigger from the card exercisable today: when
// a dispatched agent becomes a remote runtime, this is the seam dispatch speaks
// to, cross-vendor, for free.

// ── A2A protocol shapes (a2a v0.2.x, the subset we serve) ───────────────────

/** The lifecycle states we map onto. A2A defines more (input-required,
 * canceled, …); a dispatch run only ever submits, works, completes, or fails. */
export type A2ATaskState = 'submitted' | 'working' | 'completed' | 'failed';

export interface TextPart {
  kind: 'text';
  text: string;
}

export interface Message {
  role: 'user' | 'agent';
  parts: TextPart[];
  messageId: string;
  taskId?: string;
  contextId?: string;
  kind: 'message';
  metadata?: Record<string, unknown>;
}

export interface Artifact {
  artifactId: string;
  name?: string;
  parts: TextPart[];
}

export interface TaskStatus {
  state: A2ATaskState;
  timestamp?: string;
  message?: Message;
}

export interface Task {
  id: string;
  contextId: string;
  status: TaskStatus;
  history: Message[];
  artifacts: Artifact[];
  kind: 'task';
}

/** Streamed over SSE for `message/stream`: one per state/progress change, the
 * last carrying `final: true`. */
export interface TaskStatusUpdateEvent {
  taskId: string;
  contextId: string;
  kind: 'status-update';
  status: TaskStatus;
  final: boolean;
}

export interface AgentSkill {
  id: string;
  name: string;
  description: string;
  tags: string[];
}

export interface AgentCard {
  protocolVersion: string;
  name: string;
  description: string;
  url: string;
  version: string;
  capabilities: { streaming: boolean; pushNotifications: boolean };
  defaultInputModes: string[];
  defaultOutputModes: string[];
  skills: AgentSkill[];
}

// ── JSON-RPC envelope ───────────────────────────────────────────────────────

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: string | number | null;
  method: string;
  params?: unknown;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: JsonRpcError;
}

/** JSON-RPC + A2A error codes. A2A reserves -32001 for an unknown task, which
 * keeps "the task isn't here" distinguishable from "I didn't understand you"
 * (-32600/-32602) — a not-found that a caller can branch on. */
export const RPC = {
  PARSE: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  TASK_NOT_FOUND: -32001,
} as const;

// ── Mapping: DispatchJob ↔ A2A Task ─────────────────────────────────────────

const STATE: Record<DispatchJob['status'], A2ATaskState> = {
  running: 'working',
  done: 'completed',
  failed: 'failed',
};

/** A2A contextId for a dispatch job — stable, opaque, derived from the (opaque)
 * dispatch handle so a caller can resolve a task from its id alone. */
export function contextIdFor(taskId: string): string {
  return `ctx-${taskId}`;
}

interface MapOpts {
  history?: Message[];
  now?: string;
}

/** Map a dispatch job to an A2A Task. The task id IS the dispatch handle (opaque,
 * stable); the result becomes a text artifact when the run completes; the latest
 * progress line becomes the status message while it works. */
export function jobToTask(job: DispatchJob, opts: MapOpts = {}): Task {
  const state = STATE[job.status];
  const last = job.progress[job.progress.length - 1];
  const statusMessage: Message | undefined =
    state === 'working' && last
      ? {
          role: 'agent',
          parts: [{ kind: 'text', text: last }],
          messageId: `${job.id}-progress-${job.progress.length}`,
          taskId: job.id,
          contextId: contextIdFor(job.id),
          kind: 'message',
        }
      : state === 'failed' && job.error
        ? {
            role: 'agent',
            parts: [{ kind: 'text', text: job.error }],
            messageId: `${job.id}-error`,
            taskId: job.id,
            contextId: contextIdFor(job.id),
            kind: 'message',
          }
        : undefined;
  const artifacts: Artifact[] =
    state === 'completed' && job.result
      ? [
          {
            artifactId: `${job.id}-result`,
            name: 'result',
            parts: [{ kind: 'text', text: job.result }],
          },
        ]
      : [];
  return {
    id: job.id,
    contextId: contextIdFor(job.id),
    status: {
      state,
      ...(opts.now ? { timestamp: opts.now } : {}),
      ...(statusMessage ? { message: statusMessage } : {}),
    },
    history: opts.history ?? [],
    artifacts,
    kind: 'task',
  };
}

/** The status-update event for a job's current state — what `message/stream`
 * emits per change; terminal states carry `final: true`. */
export function statusUpdateEvent(job: DispatchJob, now?: string): TaskStatusUpdateEvent {
  const task = jobToTask(job, { now });
  return {
    taskId: job.id,
    contextId: task.contextId,
    kind: 'status-update',
    status: task.status,
    final: job.status !== 'running',
  };
}

// ── Agent Card ──────────────────────────────────────────────────────────────

export function agentCard(opts: { url: string; version: string }): AgentCard {
  return {
    protocolVersion: '0.2.5',
    name: 'verevoir-dispatch',
    description:
      'Hand a whole coding task to a frontier worker model and let it drive — it gets a toolbelt (read, grep, find-symbol, provision, write, edit) and works autonomously over a source, pulling its own practices and producing or changing code.',
    url: opts.url,
    version: opts.version,
    capabilities: { streaming: true, pushNotifications: false },
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    skills: [
      {
        id: 'dispatch',
        name: 'Dispatch a task to a frontier worker',
        description:
          "Send a task as the message text, with `model` (family or id, e.g. 'deepseek') and `source` (repo/path) in the message metadata. The worker explores the source and produces the result.",
        tags: ['delegation', 'coding', 'agent'],
      },
    ],
  };
}

// ── Service: JSON-RPC over the dispatch job store ───────────────────────────

export interface A2ADeps {
  start?: (input: DispatchInput) => DispatchJob;
  poll?: (handle: string) => DispatchJob | { error: string };
}

function ok(id: JsonRpcRequest['id'], result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result };
}
function fail(id: JsonRpcRequest['id'], code: number, message: string): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function textOf(parts: unknown): string | null {
  if (!Array.isArray(parts)) return null;
  const texts = parts
    .filter((p): p is TextPart => !!p && typeof p === 'object' && (p as TextPart).kind === 'text')
    .map((p) => p.text);
  return texts.length ? texts.join('\n') : null;
}

/**
 * The A2A service: validates JSON-RPC requests at the boundary and runs them
 * against the dispatch job store. Holds each task's inbound message + contextId
 * so `tasks/get` can return faithful history without touching dispatch's core.
 * `start`/`poll` are injectable for tests.
 */
export class A2AService {
  private readonly start: (input: DispatchInput) => DispatchJob;
  private readonly poll: (handle: string) => DispatchJob | { error: string };
  private readonly history = new Map<string, Message[]>();

  constructor(deps: A2ADeps = {}) {
    this.start = deps.start ?? startDispatch;
    this.poll = deps.poll ?? dispatchResult;
  }

  /** Resolve a job by handle, or null when no such task. */
  private job(handle: string): DispatchJob | null {
    const j = this.poll(handle);
    return 'id' in j ? j : null;
  }

  /** `message/send` — submit a dispatch task. The message text is the prompt;
   * `model` + `source` come from the message metadata. Returns the new Task. */
  send(params: unknown): { result?: Task; error?: { code: number; message: string } } {
    const p = params as { message?: unknown } | undefined;
    const message = p?.message as
      | { parts?: unknown; metadata?: Record<string, unknown>; messageId?: unknown }
      | undefined;
    if (!message || typeof message !== 'object') {
      return { error: { code: RPC.INVALID_PARAMS, message: 'params.message is required' } };
    }
    const prompt = textOf(message.parts);
    if (!prompt) {
      return {
        error: { code: RPC.INVALID_PARAMS, message: 'message.parts must include a text part' },
      };
    }
    const meta = message.metadata ?? {};
    const model = typeof meta.model === 'string' ? meta.model.trim() : '';
    const source = typeof meta.source === 'string' ? meta.source.trim() : '';
    if (!model || !source) {
      return {
        error: {
          code: RPC.INVALID_PARAMS,
          message: 'message.metadata.model and message.metadata.source are required',
        },
      };
    }
    const job = this.start({ prompt, model, source });
    const userMessage: Message = {
      role: 'user',
      parts: [{ kind: 'text', text: prompt }],
      messageId: typeof message.messageId === 'string' ? message.messageId : `${job.id}-in`,
      taskId: job.id,
      contextId: contextIdFor(job.id),
      kind: 'message',
    };
    this.history.set(job.id, [userMessage]);
    return { result: jobToTask(job, { history: [userMessage] }) };
  }

  /** `tasks/get` — poll a task by id. A2A TaskNotFound (-32001) when unknown. */
  get(params: unknown): { result?: Task; error?: { code: number; message: string } } {
    const id = (params as { id?: unknown } | undefined)?.id;
    if (typeof id !== 'string' || !id) {
      return { error: { code: RPC.INVALID_PARAMS, message: 'params.id is required' } };
    }
    const job = this.job(id);
    if (!job) {
      return { error: { code: RPC.TASK_NOT_FOUND, message: `no task with id "${id}"` } };
    }
    return { result: jobToTask(job, { history: this.history.get(id) ?? [] }) };
  }

  /** Resolve a job for streaming (used by the SSE route), or null. */
  jobFor(id: string): DispatchJob | null {
    return this.job(id);
  }

  historyFor(id: string): Message[] {
    return this.history.get(id) ?? [];
  }

  /** Dispatch a parsed JSON-RPC request to the right method. Pure given the
   * injected start/poll — the HTTP layer only parses the body and writes the
   * response (streaming is handled separately, in the server). */
  handle(req: unknown): JsonRpcResponse {
    if (!req || typeof req !== 'object') {
      return fail(null, RPC.INVALID_REQUEST, 'request must be a JSON object');
    }
    const r = req as Partial<JsonRpcRequest>;
    const id = r.id ?? null;
    if (r.jsonrpc !== '2.0' || typeof r.method !== 'string') {
      return fail(id, RPC.INVALID_REQUEST, 'invalid JSON-RPC 2.0 request');
    }
    switch (r.method) {
      case 'message/send': {
        const out = this.send(r.params);
        return out.error ? fail(id, out.error.code, out.error.message) : ok(id, out.result);
      }
      case 'tasks/get': {
        const out = this.get(r.params);
        return out.error ? fail(id, out.error.code, out.error.message) : ok(id, out.result);
      }
      case 'message/stream':
        // Streaming is served over SSE by the HTTP layer, not this method.
        return fail(id, RPC.INVALID_REQUEST, 'message/stream must be sent to the SSE endpoint');
      default:
        return fail(id, RPC.METHOD_NOT_FOUND, `unknown method "${r.method}"`);
    }
  }
}

// ── HTTP / SSE server ───────────────────────────────────────────────────────

const AGENT_CARD_PATH = '/.well-known/agent.json';

async function readBody(req: import('node:http').IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

export interface ServeOptions extends A2ADeps {
  port?: number;
  version?: string;
  /** Poll interval (ms) for the SSE stream. Small by default; injectable so a
   * test can drive it fast. */
  streamIntervalMs?: number;
}

/**
 * Start the A2A HTTP server over the dispatch runtime. Serves the Agent Card at
 * {@link AGENT_CARD_PATH}, JSON-RPC at `POST /`, and SSE streaming for
 * `message/stream`. Returns the live server (call `.close()` to stop).
 */
export function serveA2A(opts: ServeOptions = {}): Server {
  const version = opts.version ?? '0.0.0';
  const service = new A2AService(opts);
  const intervalMs = opts.streamIntervalMs ?? 500;

  const server = createServer((req, res) => {
    const url = req.url ?? '/';
    if (req.method === 'GET' && url.startsWith(AGENT_CARD_PATH)) {
      const card = agentCard({ url: `http://${req.headers.host ?? 'localhost'}/`, version });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(card));
      return;
    }
    if (req.method !== 'POST' || url !== '/') {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
      return;
    }
    void handlePost(req, res, service, intervalMs);
  });

  if (opts.port !== undefined) server.listen(opts.port);
  return server;
}

async function handlePost(
  req: import('node:http').IncomingMessage,
  res: import('node:http').ServerResponse,
  service: A2AService,
  intervalMs: number
): Promise<void> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readBody(req));
  } catch {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(fail(null, RPC.PARSE, 'invalid JSON')));
    return;
  }
  const method = (parsed as { method?: unknown } | null)?.method;
  if (method === 'message/stream') {
    streamTask(parsed, res, service, intervalMs);
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(service.handle(parsed)));
}

/** Serve `message/stream` as Server-Sent Events: submit the task, then emit a
 * status-update event per change until a terminal state, which carries
 * `final: true`. The connection closes when the run ends. */
function streamTask(
  req: unknown,
  res: import('node:http').ServerResponse,
  service: A2AService,
  intervalMs: number
): void {
  const r = req as Partial<JsonRpcRequest>;
  const id = r.id ?? null;
  const sent = service.send(r.params);
  if (sent.error || !sent.result) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify(
        fail(id, sent.error?.code ?? RPC.INVALID_PARAMS, sent.error?.message ?? 'bad request')
      )
    );
    return;
  }
  const taskId = sent.result.id;
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  const event = (result: unknown) =>
    res.write(`data: ${JSON.stringify({ jsonrpc: '2.0', id, result })}\n\n`);

  // First event: the task itself, then status-updates as it progresses.
  event(sent.result);
  let lastSig = '';
  const tick = () => {
    const job = service.jobFor(taskId);
    if (!job) {
      clearInterval(timer);
      res.end();
      return;
    }
    const ev = statusUpdateEvent(job);
    const sig = `${ev.status.state}:${job.progress.length}`;
    if (sig !== lastSig) {
      lastSig = sig;
      event(ev);
    }
    if (ev.final) {
      clearInterval(timer);
      res.end();
    }
  };
  const timer = setInterval(tick, intervalMs);
  res.on('close', () => clearInterval(timer));
}
