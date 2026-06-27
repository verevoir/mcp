import { appendFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

// AUDIT LOG (STDIO-486) — per-session JSONL file, OpenTelemetry-shaped spans.
//
// Three modes, set via AIGENCY_AUDIT:
//   'off'     — nothing written (default).
//   'on'      — span fields only: trace_id, span_id, parent_span_id, name,
//               kind, start, end, duration_ms.
//   'verbose' — the above plus an `attributes` object: model, tokens_in,
//               tokens_out, cached, cost per span, and a capability-level
//               cost rollup on the root span.
//
// Session: a burst of activity within AIGENCY_AUDIT_SESSION_GAP seconds of
// the previous entry (default 120s). A gap wider than that starts a new file
// named by the session-start ISO timestamp. One prompt's whole cascade lands
// in one file so the parent_span_id chain is reconstructable.
//
// Zero dependencies: timestamps, append, gap-detection — pure Node stdlib.
// The verbose attributes record only usage the provider already returned;
// no tokens are spent to produce them.

export type AuditMode = 'off' | 'on' | 'verbose';
const AUDIT_MODES: AuditMode[] = ['off', 'on', 'verbose'];

/** Span kinds in the cascade. */
export type SpanKind = 'capability' | 'tool' | 'model';

/** The shape of one JSONL entry (OTel-shaped). `attributes` is present only
 * in verbose mode and only when the span has usage to report. */
export interface AuditSpan {
  trace_id: string;
  span_id: string;
  parent_span_id?: string;
  name: string;
  kind: SpanKind;
  start: string; // ISO 8601
  end: string; // ISO 8601
  duration_ms: number;
  attributes?: {
    model?: string;
    tokens_in?: number;
    tokens_out?: number;
    cached?: number;
    cost?: number;
    cost_rollup?: number; // capability-level total cost
  };
}

/** Resolved audit configuration, derived from env at startup. */
export interface AuditConfig {
  mode: AuditMode;
  dir: string;
  sessionGapMs: number;
}

/** Resolve audit config from env. Safe to call at module load — reads process.env
 * lazily, so tests can set vars before the first call. */
export function resolveAuditConfig(): AuditConfig {
  const raw = process.env.AIGENCY_AUDIT?.trim() as AuditMode | undefined;
  const mode: AuditMode = raw && AUDIT_MODES.includes(raw) ? raw : 'off';
  const dir = process.env.AIGENCY_AUDIT_DIR?.trim() || './aigency-audit';
  const gapRaw = Number(process.env.AIGENCY_AUDIT_SESSION_GAP ?? '');
  const sessionGapMs = Number.isFinite(gapRaw) && gapRaw > 0 ? gapRaw * 1000 : 120_000;
  return { mode, dir, sessionGapMs };
}

// ── Session state ─────────────────────────────────────────────────────────────
// In-process: one MCP server process = one audit writer. State is intentionally
// module-level so the session file accumulates across tool calls in a single
// session and resets only when the gap-detection fires.

let _config: AuditConfig | null = null;
let _sessionFile: string | null = null;
let _sessionId: string | null = null;
let _lastEntryAt = 0;

/** The config, resolved once and cached. Injectable for tests via resetAudit(). */
function config(): AuditConfig {
  if (!_config) _config = resolveAuditConfig();
  return _config;
}

/** Ensure the session is current, starting a new one if the gap has expired.
 * Returns the current session file path, or null when mode is off. On a new
 * session the `_sessionId` and `_sessionFile` are refreshed; the directory is
 * NOT created here — that happens lazily in `appendSpan`, so a bad dir can't
 * surface as a mkdirSync error from inside `openSpan`.
 *
 * Gap check: a span is "within the session" if we've seen an entry recently —
 * either an appended span (`_lastEntryAt` set by appendSpan) OR an opened-but-
 * not-yet-finished span (`_sessionActive` is true). This covers the window
 * between openSpan and its corresponding finish() call. */
let _sessionActive = false; // true while at least one span is open

function sessionFile(): string | null {
  const cfg = config();
  if (cfg.mode === 'off') return null;
  const now = Date.now();
  const withinGap =
    _sessionFile && _sessionId && (now - _lastEntryAt < cfg.sessionGapMs || _sessionActive);
  if (withinGap) {
    return _sessionFile;
  }
  // New session: a gap wider than the threshold, or first call ever.
  _sessionId = randomUUID();
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = resolve(cfg.dir);
  _sessionFile = join(dir, `session-${ts}.jsonl`);
  // Seed _lastEntryAt so the gap check stays within this session from the
  // first openSpan to the first appendSpan (which would otherwise see an
  // epoch-relative gap of billions of ms and start a NEW session on write).
  _lastEntryAt = Date.now();
  return _sessionFile;
}

/** The current session trace_id (= session id). Null when audit is off or
 * before the first span of a session. */
export function currentSessionId(): string | null {
  return _sessionId;
}

/** Test seam: reset all session state and optionally override the config. */
export function resetAudit(cfg?: AuditConfig): void {
  _config = cfg ?? null;
  _sessionFile = null;
  _sessionId = null;
  _lastEntryAt = 0;
  _sessionActive = false;
}

// ── Write ─────────────────────────────────────────────────────────────────────

/** Append one span to the current session file. No-op when mode is 'off' or
 * the write fails (best-effort: audit must never interfere with tool results).
 * The directory is created lazily here, not in sessionFile(), so a bad dir
 * is caught and silently dropped rather than surfaced as an error mid-tool. */
export function appendSpan(span: AuditSpan): void {
  const file = sessionFile();
  if (!file) return;
  _lastEntryAt = Date.now();
  try {
    mkdirSync(resolve(config().dir), { recursive: true });
    appendFileSync(file, JSON.stringify(span) + '\n');
  } catch {
    // Silently drop: a permissions issue or a full disk must not surface as a
    // tool error — the audit log is observability, not the main path.
  }
}

// ── Span builder ──────────────────────────────────────────────────────────────

/** Millisecond-precision ISO timestamp. */
function nowIso(): string {
  return new Date().toISOString();
}

/** Open a span, returning a `finish` function that writes it. Usage is
 * optional; when supplied and the mode is verbose it lands in `attributes`.
 * `traceId` defaults to the current session id; `parentId` threads the
 * cascade so the flame chart reconstructs from parent refs. */
export function openSpan(
  name: string,
  kind: SpanKind,
  opts: {
    traceId?: string;
    parentId?: string;
  } = {}
): {
  spanId: string;
  traceId: string;
  finish: (attrs?: AuditSpan['attributes']) => void;
} {
  const startMs = Date.now();
  const startIso = nowIso();
  const spanId = randomUUID();
  // Ensure the session is initialised BEFORE reading _sessionId, so that the
  // first call of a new session has _sessionId set before we capture traceId.
  sessionFile();
  // Mark a span as open so the session gap check knows the session is active
  // even before finish() triggers appendSpan (which updates _lastEntryAt).
  _sessionActive = true;
  const traceId = opts.traceId ?? _sessionId ?? randomUUID();

  return {
    spanId,
    traceId,
    finish: (attrs?: AuditSpan['attributes']) => {
      _sessionActive = false;
      const endMs = Date.now();
      const endIso = new Date(endMs).toISOString();
      const span: AuditSpan = {
        trace_id: traceId,
        span_id: spanId,
        ...(opts.parentId ? { parent_span_id: opts.parentId } : {}),
        name,
        kind,
        start: startIso,
        end: endIso,
        duration_ms: endMs - startMs,
      };
      if (attrs && Object.keys(attrs).length > 0) {
        const cfg = config();
        if (cfg.mode === 'verbose') {
          span.attributes = attrs;
        }
      }
      appendSpan(span);
    },
  };
}

// ── Context propagation helpers ───────────────────────────────────────────────
// Thread trace_id + parent_span_id from the capability root through every
// nested span, so the parent_span_id chain reconstructs the cascade.

export interface SpanContext {
  traceId: string;
  parentId?: string;
}

/** Build a child context from a parent span, for threading into nested calls. */
export function childContext(parent: { traceId: string; spanId: string }): SpanContext {
  return { traceId: parent.traceId, parentId: parent.spanId };
}
