#!/usr/bin/env node
// verevoir-audit-trace (STDIO-486) — convert a session JSONL audit file into
// a format suitable for interactive flame-chart inspection.
//
// Usage:
//   verevoir-audit-trace <session.jsonl>              # → Chrome Trace JSON (stdout)
//   verevoir-audit-trace <session.jsonl> --otlp       # → OTLP JSON (stdout)
//   verevoir-audit-trace <session.jsonl> -o out.json  # write to file instead of stdout
//
// Open the Chrome Trace output at:
//   speedscope.app  (drop the file)
//   Perfetto        (ui.perfetto.dev → Open Trace File)
//   chrome://tracing → Load
//
// Open the OTLP output in Datadog / Jaeger / Grafana Tempo after importing.
//
// Pure transform, no deps beyond stdlib.

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AuditSpan } from './audit.js';

// ── Arg parsing ───────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

function usage(): void {
  process.stderr.write(
    'Usage: verevoir-audit-trace <session.jsonl> [--otlp] [-o <output.json>]\n' +
      '\n' +
      'Converts a session audit JSONL file to a flame-chart format.\n' +
      '\n' +
      'Options:\n' +
      '  --otlp           Emit OTLP JSON instead of Chrome Trace format.\n' +
      '  -o <file>        Write output to <file> instead of stdout.\n' +
      '\n' +
      'View Chrome Trace output at speedscope.app, Perfetto (ui.perfetto.dev),\n' +
      'or chrome://tracing.\n' +
      'View OTLP JSON in Datadog, Jaeger, or Grafana Tempo.\n'
  );
}

if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
  usage();
  process.exit(args.length === 0 ? 1 : 0);
}

const otlpMode = args.includes('--otlp');
const outIdx = args.indexOf('-o');
const outputFile = outIdx >= 0 ? args[outIdx + 1] : null;
const inputFile = args.find((a) => !a.startsWith('-') && a !== (outputFile ?? ''));

if (!inputFile) {
  process.stderr.write('Error: no input file specified.\n');
  usage();
  process.exit(1);
}

// ── Load spans ────────────────────────────────────────────────────────────────

function loadSpans(path: string): AuditSpan[] {
  const text = readFileSync(resolve(path), 'utf8');
  const spans: AuditSpan[] = [];
  for (const line of text.split('\n')) {
    const l = line.trim();
    if (!l) continue;
    try {
      spans.push(JSON.parse(l) as AuditSpan);
    } catch {
      process.stderr.write(`warn: skipping malformed JSONL line: ${l.slice(0, 80)}\n`);
    }
  }
  return spans;
}

// ── Chrome Trace Event format ─────────────────────────────────────────────────
// https://docs.google.com/document/d/1CvAClvFfyA5R-PhYUmn5OOQtYMH4h6I0nSsKchNAySU
// "X" = complete events (start + duration). Each span → one "X" event.
// `pid`/`tid` are used by chrome://tracing / speedscope for swim-lane grouping:
//   pid = the trace_id hash (one process per session)
//   tid = a stable integer per span kind (tool=1, capability=2, model=3)
// This puts the cascade in one swim lane per kind, with the duration bar showing
// parent-child nesting via the `id`/`pid_for_stack` fields (not standard but
// speedscope handles it gracefully).

interface ChromeTraceEvent {
  name: string;
  ph: 'X';
  ts: number; // microseconds from epoch
  dur: number; // microseconds
  pid: number;
  tid: number;
  args?: Record<string, unknown>;
}

const KIND_TID: Record<string, number> = { tool: 1, capability: 2, model: 3 };

function toChromeTrace(spans: AuditSpan[]): { traceEvents: ChromeTraceEvent[] } {
  const traceEvents: ChromeTraceEvent[] = spans.map((s) => {
    const startMs = Date.parse(s.start);
    const pid = hashPid(s.trace_id);
    const tid = KIND_TID[s.kind] ?? 4;
    const args: Record<string, unknown> = {
      span_id: s.span_id,
      ...(s.parent_span_id ? { parent_span_id: s.parent_span_id } : {}),
      ...(s.attributes ?? {}),
    };
    return {
      name: s.name,
      ph: 'X',
      ts: startMs * 1000, // ms → µs
      dur: s.duration_ms * 1000,
      pid,
      tid,
      args,
    };
  });
  return { traceEvents };
}

/** Stable 31-bit hash of a string — used as Chrome Trace `pid` so sessions
 * have distinct swim lanes. Not cryptographic; collision is cosmetic only. */
function hashPid(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h) & 0x7fffffff;
}

// ── OTLP JSON format ──────────────────────────────────────────────────────────
// https://opentelemetry.io/docs/specs/otlp/
// ExportTraceServiceRequest → resourceSpans[] → scopeSpans[] → spans[]
// Each AuditSpan → one OTLP Span (nanosecond timestamps, hex ids).

interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number; // SpanKind enum: 1=INTERNAL, 2=SERVER, 3=CLIENT
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: Array<{ key: string; value: { stringValue?: string; intValue?: string } }>;
  status: { code: number }; // 0=UNSET
}

const OTLP_KIND: Record<string, number> = { tool: 3, capability: 1, model: 3 };

function toOtlp(spans: AuditSpan[]): unknown {
  const otlpSpans: OtlpSpan[] = spans.map((s) => {
    const startNs = BigInt(Date.parse(s.start)) * BigInt(1_000_000);
    const endNs = startNs + BigInt(s.duration_ms) * BigInt(1_000_000);
    const attrs: OtlpSpan['attributes'] = [
      { key: 'span.kind.label', value: { stringValue: s.kind } },
    ];
    if (s.attributes) {
      for (const [k, v] of Object.entries(s.attributes)) {
        if (v === undefined || v === null) continue;
        if (typeof v === 'number') {
          attrs.push({ key: k, value: { intValue: String(Math.round(v)) } });
        } else {
          attrs.push({ key: k, value: { stringValue: String(v) } });
        }
      }
    }
    return {
      traceId: uuidToHex(s.trace_id),
      spanId: uuidToHex(s.span_id).slice(0, 16),
      ...(s.parent_span_id ? { parentSpanId: uuidToHex(s.parent_span_id).slice(0, 16) } : {}),
      name: s.name,
      kind: OTLP_KIND[s.kind] ?? 1,
      startTimeUnixNano: String(startNs),
      endTimeUnixNano: String(endNs),
      attributes: attrs,
      status: { code: 0 },
    };
  });

  return {
    resourceSpans: [
      {
        resource: { attributes: [{ key: 'service.name', value: { stringValue: 'verevoir-mcp' } }] },
        scopeSpans: [
          { scope: { name: 'verevoir-audit-trace', version: '1.0.0' }, spans: otlpSpans },
        ],
      },
    ],
  };
}

/** Strip hyphens from a UUID for OTel hex ids. */
function uuidToHex(uuid: string): string {
  return uuid.replace(/-/g, '');
}

// ── Main ──────────────────────────────────────────────────────────────────────

const spans = loadSpans(inputFile);
if (spans.length === 0) {
  process.stderr.write('warn: no spans found in the input file.\n');
}

const output = otlpMode ? toOtlp(spans) : toChromeTrace(spans);
const json = JSON.stringify(output, null, 2);

if (outputFile) {
  writeFileSync(resolve(outputFile), json, 'utf8');
  process.stderr.write(`wrote ${spans.length} span(s) to ${outputFile}\n`);
} else {
  process.stdout.write(json + '\n');
}
