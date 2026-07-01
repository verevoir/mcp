// STDIO-521 — coordinator cost×quality harness: the presented toolset.
//
// The same routing tools the sibling STDIO-519 harness presents (enact /
// delegate / dispatch, each with a `model` tier override, descriptions lifted
// from the tools' own source), plus the inline `read_file` / `grep` /
// `write_file` the un-stubbed executor actually runs. The difference from
// STDIO-519 is downstream: here the executor really enacts, delegates, reads,
// and captures writes — this module only presents the surface.

import type { ToolDef } from '@verevoir/llm';
import { ENACT_DESCRIPTION } from '../tools/enact.js';
import { DELEGATE_DESCRIPTION } from '../tools/delegate.js';
import { DISPATCH_DESCRIPTION } from '../tools/dispatch.js';

const OBJECT = 'object' as const;

/** The tier-override field shared by every routing tool. */
const MODEL_FIELD = {
  type: 'string',
  description:
    'Model / tier override — sets the tier this work runs on. opus is the reasoning tier, haiku the light tier — set this to route up or down.',
} as const;

const ENACT_TOOL: ToolDef = {
  name: 'enact_capability',
  description: ENACT_DESCRIPTION,
  input_schema: {
    type: OBJECT,
    properties: {
      capability: {
        type: 'string',
        description:
          'The capability to enact — a corpus descriptor type (e.g. "convert-design-system").',
      },
      directive: {
        type: 'string',
        description: "What to produce, in this project's terms — the specific task.",
      },
      context: { type: 'string', description: 'Optional extra context the worker needs.' },
      model: MODEL_FIELD,
    },
    required: ['capability', 'directive'],
  },
};

const DELEGATE_TOOL: ToolDef = {
  name: 'delegate',
  description: DELEGATE_DESCRIPTION,
  input_schema: {
    type: OBJECT,
    properties: {
      prompt: {
        type: 'string',
        description: 'The full, self-contained task for the worker — it sees only this.',
      },
      system: { type: 'string', description: 'Optional system instruction for the worker.' },
      model: MODEL_FIELD,
    },
    required: ['prompt'],
  },
};

const DISPATCH_TOOL: ToolDef = {
  name: 'dispatch',
  description: DISPATCH_DESCRIPTION,
  input_schema: {
    type: OBJECT,
    properties: {
      prompt: { type: 'string', description: 'The task for the worker — what to produce.' },
      source: { type: 'string', description: 'The source the worker reads from.' },
      model: MODEL_FIELD,
    },
    required: ['prompt'],
  },
};

const READ_FILE_TOOL: ToolDef = {
  name: 'read_file',
  description:
    "Read a file's full contents from a source (a local path, a GitHub repo, or a URL). Light, inline work you do yourself.",
  input_schema: {
    type: OBJECT,
    properties: {
      source: {
        type: 'string',
        description:
          'The source to read from — a repo URL or local path. Defaults to the run source.',
      },
      path: { type: 'string', description: 'File path within the source.' },
    },
    required: ['path'],
  },
};

const GREP_TOOL: ToolDef = {
  name: 'grep',
  description:
    'Search a source for a pattern and return the matching lines. Light, inline work you do yourself.',
  input_schema: {
    type: OBJECT,
    properties: {
      source: {
        type: 'string',
        description: 'The source to search — a repo URL or local path. Defaults to the run source.',
      },
      pattern: { type: 'string', description: 'The plain-text pattern to search for.' },
    },
    required: ['pattern'],
  },
};

const WRITE_FILE_TOOL: ToolDef = {
  name: 'write_file',
  description:
    "Write a file's full contents into the run workspace, creating or overwriting it. Light, inline work you do yourself.",
  input_schema: {
    type: OBJECT,
    properties: {
      path: { type: 'string', description: 'File path within the workspace.' },
      content: { type: 'string', description: 'Full file content to write.' },
    },
    required: ['path', 'content'],
  },
};

/** The toolset presented to the coordinator: three routing tools (each with a
 * tier override) then the inline read / grep / write tools. */
export const COORDINATOR_TOOLS: ToolDef[] = [
  ENACT_TOOL,
  DELEGATE_TOOL,
  DISPATCH_TOOL,
  READ_FILE_TOOL,
  GREP_TOOL,
  WRITE_FILE_TOOL,
];
