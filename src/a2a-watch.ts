// A2A stream viewer (STDIO-395) — a thin client that opens an A2A `message/stream`
// against a running `verevoir-a2a` server and renders the dispatch's
// `status-update` events as they arrive, ending on the terminal (`final`) event.
//
// The server side (STDIO-382) already maps a `DispatchJob`'s progress to SSE
// status-updates; this turns that wire into something watchable — "see the
// polling rendered over A2A". `fetchImpl` is injectable for tests.

export interface WatchOptions {
  baseUrl: string;
  prompt: string;
  model: string;
  source: string;
  /** Bearer token sent as `Authorization: Bearer <token>`. Defaults to the
   * `A2A_AUTH_TOKEN` env; omit when the server is unauthenticated. */
  authToken?: string;
  /** Called once per rendered line as events stream in. */
  render: (line: string) => void;
  fetchImpl?: typeof fetch;
}

/** A streamed A2A result — either the initial `Task` or a `status-update` event. */
export interface StreamResult {
  kind?: string;
  id?: string;
  status?: { state?: string; message?: { parts?: { text?: string }[] } };
  artifacts?: { parts?: { text?: string }[] }[];
  final?: boolean;
}

/** Render one streamed A2A result as a human line: a task shows its state (and
 * its result artifact once completed); a status-update shows the state, the
 * latest progress message, and whether it is the terminal event. */
export function formatStreamLine(r: StreamResult): string {
  if (r.kind === 'task') {
    const artifact = (r.artifacts ?? [])
      .flatMap((a) => a.parts ?? [])
      .map((p) => p.text)
      .filter(Boolean)
      .join('\n');
    return (
      `task ${r.id ?? ''} — ${r.status?.state ?? 'submitted'}`.trim() +
      (artifact ? `\n${artifact}` : '')
    );
  }
  const message = (r.status?.message?.parts ?? [])
    .map((p) => p.text)
    .filter(Boolean)
    .join(' ');
  return `  ${r.status?.state ?? 'unknown'}${message ? ` — ${message}` : ''}${r.final ? ' (final)' : ''}`;
}

/**
 * Open an A2A `message/stream` for a dispatch task and render each event via
 * `opts.render` as it arrives. Resolves when the stream ends (the server closes
 * it on the terminal event). Throws if the response has no body.
 */
export async function watchA2A(opts: WatchOptions): Promise<void> {
  const doFetch = opts.fetchImpl ?? fetch;
  const authToken = opts.authToken ?? process.env.A2A_AUTH_TOKEN?.trim();
  const res = await doFetch(`${opts.baseUrl.replace(/\/+$/, '')}/`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(authToken ? { authorization: `Bearer ${authToken}` } : {}),
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'message/stream',
      params: {
        message: {
          parts: [{ kind: 'text', text: opts.prompt }],
          metadata: { model: opts.model, source: opts.source },
        },
      },
    }),
  });
  if (!res.body) throw new Error('A2A stream returned no body');

  // The server rejects a bad stream request with a plain JSON-RPC response
  // (content-type application/json) rather than an SSE stream — surface it.
  if (!(res.headers.get('content-type') ?? '').includes('text/event-stream')) {
    const text = await res.text();
    try {
      const parsed = JSON.parse(text) as { result?: StreamResult; error?: { message?: string } };
      if (parsed.error) opts.render(`error: ${parsed.error.message ?? 'unknown'}`);
      else if (parsed.result) opts.render(formatStreamLine(parsed.result));
    } catch {
      opts.render(`error: ${text.slice(0, 200)}`);
    }
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    // SSE frames are separated by a blank line.
    let boundary: number;
    while ((boundary = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const dataLine = frame.split('\n').find((l) => l.startsWith('data:'));
      if (!dataLine) continue;
      let parsed: { result?: StreamResult; error?: { message?: string } };
      try {
        parsed = JSON.parse(dataLine.slice('data:'.length).trim());
      } catch {
        continue; // skip a malformed frame rather than abort the stream
      }
      if (parsed.error) {
        opts.render(`error: ${parsed.error.message ?? 'unknown'}`);
        continue;
      }
      if (parsed.result) opts.render(formatStreamLine(parsed.result));
    }
  }
}
