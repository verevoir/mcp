import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** The project pointer manifest (`aigency.json`), per ADR 023. A thin file in
 * the project's git presence that points at where the project record actually
 * lives (Notion). We read only the fields we compose into doctrine; unknown
 * fields are ignored so the manifest can grow without breaking the server. */
/** A governance source the find_governance index spans alongside the Notion
 * record — e.g. the guardrails corpus repo. Each path is either a directory
 * (whose `.md` files are listed) or a single `.md` file within the source;
 * every entry is read back the same way via read_file. Governance comes from
 * more than one source the way code does (filesystem or GitHub) — they index
 * together. */
export interface GovernanceSource {
  source: string;
  paths: string[];
}

export interface AigencyManifest {
  notion?: {
    workspaceRootPageId?: string;
    databases?: Record<string, string>;
    pages?: Record<string, string>;
  };
  /** Extra governance sources indexed by find_governance alongside the record. */
  governance?: GovernanceSource[];
}

/** Resolve where to read the manifest from, per ADR 023: an explicit
 * `--manifest <path>` arg wins; otherwise `aigency.json` in the working
 * directory the server was launched in. A `--manifest` with no path (or
 * followed by another flag) throws rather than silently falling back — a
 * botched launch arg should fail loudly, not quietly start the server in
 * no-project mode. `argv` / `cwd` are injectable for testing. */
export function manifestPath(argv: string[] = process.argv, cwd: string = process.cwd()): string {
  const i = argv.indexOf('--manifest');
  if (i !== -1) {
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('-')) {
      throw new Error(
        '--manifest requires a path argument (e.g. --manifest /path/to/aigency.json)'
      );
    }
    return resolve(value);
  }
  return resolve(cwd, 'aigency.json');
}

/** Load the project manifest. Returns `null` in "no-project mode" — the file
 * is absent, unreadable, or not valid JSON — so the server still starts with
 * only the universal doctrine. `path` is injectable for testing. */
export function loadManifest(path: string = manifestPath()): AigencyManifest | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed as AigencyManifest;
  } catch {
    return null;
  }
}

/** Notion page/database id → workspace URL the verevoir Notion tools accept. */
function notionUrl(id: string): string {
  return `https://www.notion.so/${id.replace(/-/g, '')}`;
}

/** Render the project-specific doctrine section from a manifest, or `null` if
 * the manifest carries nothing we can point an agent at. This is the
 * project-specific layer that composes onto the universal doctrine: it names
 * *this* project's board and record so the "read the board / put work on the
 * board" steer resolves to concrete URLs rather than staying abstract. */
export function renderProjectDoctrine(manifest: AigencyManifest): string | null {
  const notion = manifest.notion;
  if (!notion) return null;

  const board = notion.databases?.work_tracker;
  const adrs = notion.databases?.adrs;
  const record = notion.workspaceRootPageId ?? notion.pages?.['start_here'];

  const lines: string[] = [];
  if (board) {
    lines.push(
      `- **Work tracker (the board):** ${notionUrl(board)} — read this first for project state; put work-shaped items here as cards.`
    );
  }
  if (record) {
    lines.push(
      `- **Project record (intent, futurespective, onboarding):** ${notionUrl(record)} — the project's durable context lives here.`
    );
  }
  if (adrs) {
    lines.push(`- **Decision records (ADRs):** ${notionUrl(adrs)}.`);
  }
  if (lines.length === 0) return null;

  return [
    '## This project',
    '',
    'Resolved from the project manifest (`aigency.json`). Reach all of these through the verevoir Notion tools (`list_cards` / `read_file` / `list_files`), not the local git tree:',
    '',
    ...lines,
  ].join('\n');
}

/** Compose the universal doctrine with this project's manifest-derived layer.
 * No-project mode (null manifest, or a manifest with nothing to point at)
 * returns the base doctrine unchanged. */
export function composeInstructions(base: string, manifest: AigencyManifest | null): string {
  const section = manifest ? renderProjectDoctrine(manifest) : null;
  return section ? `${base}\n\n${section}` : base;
}
