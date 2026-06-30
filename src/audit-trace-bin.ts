#!/usr/bin/env node
// verevoir-audit-trace (STDIO-486/STDIO-489) — convert a session JSONL audit
// file into a format suitable for interactive flame-chart inspection.
//
// Usage:
//   verevoir-audit-trace <session.jsonl>              # → Chrome Trace JSON (stdout)
//   verevoir-audit-trace <session.jsonl> --otlp       # → OTLP JSON (stdout)
//   verevoir-audit-trace <session.jsonl> -o out.json  # write to file instead of stdout
//   verevoir-audit-trace <session.jsonl> --elide-notes  # suppress note/purpose in output
//
// Open the Chrome Trace output at:
//   speedscope.app  (drop the file)
//   Perfetto        (ui.perfetto.dev → Open Trace File)
//   chrome://tracing → Load
//
// Open the OTLP output in Datadog / Jaeger / Grafana Tempo after importing.
//
// Pure transform, no deps beyond stdlib.
//
// Sensitive-data note (STDIO-489 / telemetry-excludes-sensitive-data):
//   The `note` field on spans derived from task/prompt args may contain
//   excerpts of LLM prompt content (truncated to 120 chars, first line only).
//   Path-derived notes are structural identifiers and are safe.
//   When exporting to an OTLP backend (Datadog / Jaeger / Tempo), prompt
//   excerpts travel outside the local machine. Operators who treat prompt
//   content as sensitive should pass `--elide-notes` to suppress note and
//   purpose fields from the OTLP export. The local JSONL is unaffected.

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AuditSpan } from './audit.js';
import { auditSpansToOtlp } from './otlp.js';

// ── Arg parsing ───────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

function usage(): void {
  process.stderr.write(
    'Usage: verevoir-audit-trace <session.jsonl> [--otlp] [--elide-notes] [-o <output.json>]\n' +
      '\n' +
      'Converts a session audit JSONL file to a flame-chart format.\n' +
      '\n' +
      'Options:\n' +
      '  --otlp           Emit OTLP JSON instead of Chrome Trace format.\n' +
      '  --elide-notes    Omit note and purpose fields from output (for OTLP\n' +
      '                   export when prompt content is considered sensitive).\n' +
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
const elideNotes = args.includes('--elide-notes');
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

function toChromeTrace(
  spans: AuditSpan[],
  opts: { elideNotes?: boolean } = {}
): { traceEvents: ChromeTraceEvent[] } {
  const traceEvents: ChromeTraceEvent[] = spans.map((s) => {
    const startMs = Date.parse(s.start);
    const pid = hashPid(s.trace_id);
    const tid = KIND_TID[s.kind] ?? 4;
    const args: Record<string, unknown> = {
      span_id: s.span_id,
      ...(s.parent_span_id ? { parent_span_id: s.parent_span_id } : {}),
      ...(s.attributes ?? {}),
    };
    // Include note and purpose in Chrome Trace args so speedscope / Perfetto
    // display them in the detail panel when a frame is selected.
    if (!opts.elideNotes) {
      if (s.note) args['note'] = s.note;
      if (s.purpose) args['purpose'] = s.purpose;
    }
    // Enrich the displayed frame name with the note so it is visible in the
    // timeline without opening the detail panel (e.g. "write_file → src/a.ts").
    const name = !opts.elideNotes && s.note ? `${s.name} → ${s.note}` : s.name;
    return {
      name,
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

// OTLP mapping now lives in ./otlp.ts (shared with the live exporter in
// audit.ts — STDIO-502). See `auditSpansToOtlp`, imported above.

// ── Main ──────────────────────────────────────────────────────────────────────

const spans = loadSpans(inputFile);
if (spans.length === 0) {
  process.stderr.write('warn: no spans found in the input file.\n');
}

const converterOpts = { elideNotes };
const output = otlpMode
  ? auditSpansToOtlp(spans, converterOpts)
  : toChromeTrace(spans, converterOpts);
const json = JSON.stringify(output, null, 2);

if (outputFile) {
  writeFileSync(resolve(outputFile), json, 'utf8');
  process.stderr.write(`wrote ${spans.length} span(s) to ${outputFile}\n`);
} else {
  process.stdout.write(json + '\n');
}
