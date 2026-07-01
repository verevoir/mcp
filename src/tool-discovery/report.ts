// STDIO-517 — Tool-discovery eval: rendering the result. PURE over a
// ModelResult[] — no I/O — so the layout is testable and the bin just prints
// what this returns.

import { TASKS, type Task } from './tasks.js';
import { NATIVE_TOOLS } from './tools.js';
import type { CellResult, ModelResult } from './run.js';

const PASS = '✓';
const FAIL = '✗';

/** How a `route` task's failure went — the distinction the wild run surfaced.
 * `native` = defected to the native shell (run_shell); `self` = produced the
 * work inline itself (write_file / edit_file); `other` = any other non-routing
 * miss (e.g. a plain reply). Named so the report can show which way, since
 * native-shell defection specifically is the finding. */
export function routeFailureKind(cell: CellResult): 'native' | 'self' | 'other' {
  if ((NATIVE_TOOLS as readonly string[]).includes(cell.firstMove)) return 'native';
  if (cell.firstMove === 'write_file' || cell.firstMove === 'edit_file') return 'self';
  return 'other';
}

/** The report label for each route-failure kind. */
const ROUTE_FAILURE_LABEL: Record<ReturnType<typeof routeFailureKind>, string> = {
  native: 'native-shell',
  self: 'self-inline',
  other: 'other',
};

/** A cell's matrix glyph: ✓/✗ for a real verdict, `–` for a run failure
 * (unsupported / error) that could neither pass nor fail. */
function glyph(cell: CellResult): string {
  if (cell.firstMove === 'unsupported' || cell.firstMove.startsWith('error:')) return '–';
  return cell.score.pass ? PASS : FAIL;
}

/** A cell rendered for the matrix: the glyph plus the actual first move, so the
 * table shows both the verdict and what the model reached for. */
function cellText(cell: CellResult): string {
  const move = cell.firstMove.startsWith('error:') ? 'error' : cell.firstMove;
  return `${glyph(cell)} ${move}`;
}

function pad(s: string, width: number): string {
  return s.length >= width ? s : s + ' '.repeat(width - s.length);
}

/** The matrix table — rows are models, columns are tasks, each cell ✓/✗ + the
 * model's actual first move. */
export function renderMatrix(results: ModelResult[], tasks: Task[] = TASKS): string {
  const cellFor = (r: ModelResult, taskId: string) => r.cells.find((c) => c.taskId === taskId);

  const modelColWidth = Math.max(5, ...results.map((r) => r.model.length));
  const colWidths = tasks.map((t) => {
    const cells = results.map((r) => {
      const c = cellFor(r, t.id);
      return c ? cellText(c).length : 0;
    });
    return Math.max(t.id.length, ...cells) + 1;
  });

  const header =
    pad('model', modelColWidth) + '  ' + tasks.map((t, i) => pad(t.id, colWidths[i])).join('  ');
  const rows = results.map((r) => {
    const cells = tasks.map((t, i) => {
      const c = cellFor(r, t.id);
      return pad(c ? cellText(c) : '', colWidths[i]);
    });
    return pad(r.model, modelColWidth) + '  ' + cells.join('  ');
  });
  return [header, ...rows].join('\n');
}

/** A model "gets it" only when it passes ALL tasks — routes the big work AND
 * keeps the small work inline. An unavailable model does not get it. */
export function getsIt(r: ModelResult): boolean {
  return !r.unavailable && r.cells.length > 0 && r.cells.every((c) => c.score.pass);
}

/** One line per model: how many tasks it passed, or why it couldn't run. */
export function renderSummaries(results: ModelResult[]): string {
  return results
    .map((r) => {
      if (r.unavailable) return `${r.model}: unavailable — ${r.unavailable}`;
      const passed = r.cells.filter((c) => c.score.pass).length;
      const idBit = r.modelId ? ` (${r.modelId})` : '';
      const verdict = getsIt(r) ? ' — gets it' : '';
      return `${r.model}${idBit}: ${passed}/${r.cells.length} passed${verdict}`;
    })
    .join('\n');
}

/** The overall line: which models got it (passed every task). */
export function renderGetsItLine(results: ModelResult[]): string {
  const winners = results.filter(getsIt).map((r) => r.model);
  return winners.length
    ? `Models that get it (routed big work AND kept small work inline): ${winners.join(', ')}`
    : 'No model got it (none passed every task).';
}

/** Heuristic tag over the model's own reasoning — a coarse pointer at the fix,
 * secondary to the raw text (always kept). `salience` = the tool didn't surface;
 * `trust` = it saw it but distrusted the cheap path; `legitimate` = it argues the
 * call was genuinely inline; `unclear` when nothing keys. */
export function tagReasoning(reasoning: string): 'salience' | 'trust' | 'legitimate' | 'unclear' {
  const t = reasoning.toLowerCase();
  const saw =
    /\b(saw|aware|considered|noticed|weighed|knew about|did see|was aware|recognized|recognised)\b/.test(
      t
    );
  const didntSurface =
    /(didn'?t (surface|occur|come to mind|register)|not (surface|occur)|overlook|forgot|didn'?t (think|consider)|wasn'?t (aware|obvious)|didn'?t notice)/.test(
      t
    );
  const distrust =
    /(trust|overkill|too heavy|simpler|faster inline|not worth|unnecessary|overhead|didn'?t need|no need|myself|directly|straightforward enough)/.test(
      t
    );
  const legitimate =
    /(genuinely|small|trivial|surgical|one file|one line|inline (was|is) (right|correct|fine|appropriate))/.test(
      t
    );

  if (didntSurface && !saw) return 'salience';
  if (legitimate) return 'legitimate';
  if (distrust) return 'trust';
  if (saw) return 'trust';
  return 'unclear';
}

/** The failures + reasoning section: for each failed cell, the model's own
 * candid account of why, with a coarse tag. Empty string when nothing failed
 * with a captured reason. */
export function renderFailures(results: ModelResult[], tasks: Task[] = TASKS): string {
  const taskById = new Map(tasks.map((t) => [t.id, t]));
  const lines: string[] = [];
  for (const r of results) {
    const failed = r.cells.filter((c) => !c.score.pass && c.reasoning);
    if (failed.length === 0) continue;
    lines.push(`\n${r.model}:`);
    for (const c of failed) {
      const task = taskById.get(c.taskId);
      const tag = tagReasoning(c.reasoning ?? '');
      // On a route task, name which way the failure went — native-shell
      // defection vs self-produced inline — since that's the interesting split.
      const wayBit =
        task?.verdict === 'route' ? ` (${ROUTE_FAILURE_LABEL[routeFailureKind(c)]})` : '';
      lines.push(`  • [${c.taskId}]${wayBit} ${c.score.reason}  (tag: ${tag})`);
      if (task) lines.push(`    task: ${task.prompt}`);
      lines.push(`    reasoning: ${c.reasoning}`);
    }
  }
  if (lines.length === 0) return '';
  return `Failures + reasoning\n${'─'.repeat(20)}${lines.join('\n')}`;
}

/** The full report: matrix, per-model summaries, the gets-it line, and the
 * failures + reasoning section. */
export function renderReport(
  results: ModelResult[],
  meta: { steer: string; tasks?: Task[] }
): string {
  const tasks = meta.tasks ?? TASKS;
  const parts = [
    `Tool-discovery eval — ${meta.steer}`,
    '',
    renderMatrix(results, tasks),
    '',
    renderSummaries(results),
    '',
    renderGetsItLine(results),
  ];
  const failures = renderFailures(results, tasks);
  if (failures) {
    parts.push('', failures);
  }
  return parts.join('\n');
}
