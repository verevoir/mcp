// STDIO-519 — Mistral-coordinator harness: the presented toolset.
//
// The coordinator is given the three routing tools (enact_capability /
// delegate / dispatch) plus the two light inline tools (read_file /
// write_file). What makes this an "inverted tier" observation is the `model`
// property added to each routing tool's input_schema: the coordinator can
// override the tier the work runs on — `"opus"` to escalate a reasoning
// decision UP, `"haiku"` to push light work DOWN. We watch which tool it picks
// AND which model it names, so up/down routing is directly observable in the
// trace.
//
// The routing descriptions are lifted from the tools' own source (enact.ts /
// delegate.ts / dispatch.ts) so the harness presents the real steer surface a
// session sees. delegate's live host-worker summary is omitted — we present the
// tool's intent, not one host's configured worker.

import type { ToolDef } from '@verevoir/llm';
import { ENACT_DESCRIPTION } from '../tools/enact.js';
import { DELEGATE_DESCRIPTION } from '../tools/delegate.js';
import { DISPATCH_DESCRIPTION } from '../tools/dispatch.js';

const OBJECT = 'object' as const;

/** The tier-override field shared by every routing tool. Its description is the
 * plain steer the coordinator reads to route up or down. */
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
  description: "Read a file's full contents from a source. Light, inline work you do yourself.",
  input_schema: {
    type: OBJECT,
    properties: { path: { type: 'string', description: 'File path within the source.' } },
    required: ['path'],
  },
};

const WRITE_FILE_TOOL: ToolDef = {
  name: 'write_file',
  description:
    "Write a file's full contents to a source, creating or overwriting it. Light, inline work you do yourself.",
  input_schema: {
    type: OBJECT,
    properties: {
      path: { type: 'string', description: 'File path within the source.' },
      content: { type: 'string', description: 'Full file content to write.' },
    },
    required: ['path', 'content'],
  },
};

/** The toolset presented to the coordinator: three routing tools (each with a
 * tier override) then the two light inline tools. */
export const COORDINATOR_TOOLS: ToolDef[] = [
  ENACT_TOOL,
  DELEGATE_TOOL,
  DISPATCH_TOOL,
  READ_FILE_TOOL,
  WRITE_FILE_TOOL,
];

/** The routing tools — handing work OFF to a governed / tiered path. */
export const ROUTING_TOOLS = ['enact_capability', 'delegate', 'dispatch'] as const;
