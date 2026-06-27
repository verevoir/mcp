import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  resolveAuditConfig,
  resetAudit,
  openSpan,
  appendSpan,
  currentSessionId,
  childContext,
  type AuditSpan,
} from '../src/audit.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function tmpDir(): string {
  const dir = join(tmpdir(), `audit-test-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function readSpans(dir: string): AuditSpan[] {
  const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  const spans: AuditSpan[] = [];
  for (const f of files) {
    const lines = readFileSync(join(dir, f), 'utf8').split('\n').filter(Boolean);
    for (const l of lines) spans.push(JSON.parse(l) as AuditSpan);
  }
  return spans;
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

let tmpAuditDir = '';

beforeEach(() => {
  tmpAuditDir = tmpDir();
  // Reset to a clean state before each test.
  resetAudit();
  delete process.env.AIGENCY_AUDIT;
  delete process.env.AIGENCY_AUDIT_DIR;
  delete process.env.AIGENCY_AUDIT_SESSION_GAP;
});

afterEach(() => {
  resetAudit();
  delete process.env.AIGENCY_AUDIT;
  delete process.env.AIGENCY_AUDIT_DIR;
  delete process.env.AIGENCY_AUDIT_SESSION_GAP;
  try {
    rmSync(tmpAuditDir, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
});

// ── resolveAuditConfig ────────────────────────────────────────────────────────

describe('resolveAuditConfig', () => {
  it('defaults to off when AIGENCY_AUDIT is not set', () => {
    expect(resolveAuditConfig().mode).toBe('off');
  });

  it('resolves "on" from AIGENCY_AUDIT env', () => {
    process.env.AIGENCY_AUDIT = 'on';
    expect(resolveAuditConfig().mode).toBe('on');
  });

  it('resolves "verbose" from AIGENCY_AUDIT env', () => {
    process.env.AIGENCY_AUDIT = 'verbose';
    expect(resolveAuditConfig().mode).toBe('verbose');
  });

  it('falls back to "off" for an unrecognised AIGENCY_AUDIT value', () => {
    process.env.AIGENCY_AUDIT = 'loud';
    expect(resolveAuditConfig().mode).toBe('off');
  });

  it('uses ./aigency-audit as the default dir', () => {
    expect(resolveAuditConfig().dir).toBe('./aigency-audit');
  });

  it('respects AIGENCY_AUDIT_DIR override', () => {
    process.env.AIGENCY_AUDIT_DIR = '/custom/dir';
    expect(resolveAuditConfig().dir).toBe('/custom/dir');
  });

  it('defaults sessionGapMs to 120 000 ms', () => {
    expect(resolveAuditConfig().sessionGapMs).toBe(120_000);
  });

  it('respects AIGENCY_AUDIT_SESSION_GAP (seconds)', () => {
    process.env.AIGENCY_AUDIT_SESSION_GAP = '30';
    expect(resolveAuditConfig().sessionGapMs).toBe(30_000);
  });
});

// ── openSpan / appendSpan (mode=off) ─────────────────────────────────────────

describe('when audit mode is off (default)', () => {
  it('openSpan finish() writes nothing', () => {
    const { finish } = openSpan('test', 'tool');
    finish();
    // No file created — off mode produces no output.
    const files = readdirSync(tmpAuditDir).filter((f) => f.endsWith('.jsonl'));
    expect(files).toHaveLength(0);
  });
});

// ── openSpan / appendSpan (mode=on) ──────────────────────────────────────────

describe('when audit mode is "on"', () => {
  beforeEach(() => {
    resetAudit({ mode: 'on', dir: tmpAuditDir, sessionGapMs: 120_000 });
  });

  it('finish() writes a JSONL span file', () => {
    const { finish } = openSpan('tool:delegate', 'tool');
    finish();
    const spans = readSpans(tmpAuditDir);
    expect(spans).toHaveLength(1);
  });

  it('written span has the required OTel fields', () => {
    const { finish } = openSpan('tool:dispatch', 'tool');
    finish();
    const [s] = readSpans(tmpAuditDir);
    expect(s).toMatchObject({
      trace_id: expect.any(String),
      span_id: expect.any(String),
      name: 'tool:dispatch',
      kind: 'tool',
      start: expect.any(String),
      end: expect.any(String),
      duration_ms: expect.any(Number),
    });
  });

  it('duration_ms is non-negative', () => {
    const { finish } = openSpan('tool:delegate', 'tool');
    finish();
    const [s] = readSpans(tmpAuditDir);
    expect(s.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it('does NOT include attributes in on mode even when supplied', () => {
    const { finish } = openSpan('dispatch:model:X', 'model');
    finish({ model: 'DeepSeek-V3.2', tokens_in: 100, tokens_out: 50 });
    const [s] = readSpans(tmpAuditDir);
    expect(s.attributes).toBeUndefined();
  });

  it('parent_span_id is set when parentId is supplied', () => {
    const parent = openSpan('tool:delegate', 'tool');
    const child = openSpan('delegate:model:X', 'model', {
      traceId: parent.traceId,
      parentId: parent.spanId,
    });
    child.finish();
    parent.finish();
    const spans = readSpans(tmpAuditDir);
    const childSpan = spans.find((s) => s.name === 'delegate:model:X')!;
    expect(childSpan.parent_span_id).toBe(parent.spanId);
    expect(childSpan.trace_id).toBe(parent.traceId);
  });

  it('multiple spans share a trace_id within a session', () => {
    const a = openSpan('a', 'tool');
    a.finish();
    const b = openSpan('b', 'capability');
    b.finish();
    const spans = readSpans(tmpAuditDir);
    expect(spans[0].trace_id).toBe(spans[1].trace_id);
  });

  it('currentSessionId() returns the trace_id after the first span', () => {
    const { traceId, finish } = openSpan('t', 'tool');
    finish();
    expect(currentSessionId()).toBe(traceId);
  });
});

// ── Verbose mode attributes ───────────────────────────────────────────────────

describe('when audit mode is "verbose"', () => {
  beforeEach(() => {
    resetAudit({ mode: 'verbose', dir: tmpAuditDir, sessionGapMs: 120_000 });
  });

  it('finish() includes attributes when supplied', () => {
    const { finish } = openSpan('dispatch:model:DeepSeek', 'model');
    finish({ model: 'DeepSeek-V3.2', tokens_in: 200, tokens_out: 80, cached: 50 });
    const [s] = readSpans(tmpAuditDir);
    expect(s.attributes).toMatchObject({
      model: 'DeepSeek-V3.2',
      tokens_in: 200,
      tokens_out: 80,
      cached: 50,
    });
  });

  it('finish() with no attributes omits the attributes key', () => {
    const { finish } = openSpan('tool:delegate', 'tool');
    finish();
    const [s] = readSpans(tmpAuditDir);
    expect(s.attributes).toBeUndefined();
  });

  it('cost_rollup on a capability span is captured', () => {
    const { finish } = openSpan('delegate', 'capability');
    finish({ cost_rollup: 0.0012 });
    const [s] = readSpans(tmpAuditDir);
    expect(s.attributes?.cost_rollup).toBeCloseTo(0.0012);
  });
});

// ── Session gap ───────────────────────────────────────────────────────────────

describe('session gap detection', () => {
  it('a gap wider than the threshold starts a new session file', async () => {
    // Use a 0ms gap so the second span always triggers a new session.
    resetAudit({ mode: 'on', dir: tmpAuditDir, sessionGapMs: 0 });
    const a = openSpan('a', 'tool');
    a.finish();
    // Wait a tick so the wall clock advances.
    await new Promise((r) => setTimeout(r, 2));
    const b = openSpan('b', 'tool');
    b.finish();
    const files = readdirSync(tmpAuditDir).filter((f) => f.endsWith('.jsonl'));
    expect(files.length).toBeGreaterThanOrEqual(2);
  });

  it('spans within the gap land in the same file', () => {
    resetAudit({ mode: 'on', dir: tmpAuditDir, sessionGapMs: 60_000 });
    const a = openSpan('a', 'tool');
    a.finish();
    const b = openSpan('b', 'tool');
    b.finish();
    const files = readdirSync(tmpAuditDir).filter((f) => f.endsWith('.jsonl'));
    expect(files).toHaveLength(1);
  });
});

// ── childContext ──────────────────────────────────────────────────────────────

describe('childContext', () => {
  it('builds a SpanContext with the parent trace_id and span_id as parentId', () => {
    const ctx = childContext({ traceId: 'trace-1', spanId: 'span-1' });
    expect(ctx).toEqual({ traceId: 'trace-1', parentId: 'span-1' });
  });
});

// ── appendSpan write failure ──────────────────────────────────────────────────

describe('appendSpan write failure', () => {
  it('does not throw when the dir cannot be created (parent is a file)', () => {
    // Create a regular file at a path, then use a subpath as the audit dir.
    // mkdirSync will fail with ENOTDIR; appendSpan must swallow it.
    const blockingFile = join(tmpAuditDir, 'not-a-dir');
    writeFileSync(blockingFile, 'x');
    resetAudit({ mode: 'on', dir: join(blockingFile, 'subdir'), sessionGapMs: 120_000 });
    expect(() => {
      const { finish } = openSpan('t', 'tool');
      finish(); // triggers appendSpan, which tries mkdirSync and fails
    }).not.toThrow();
  });
});
