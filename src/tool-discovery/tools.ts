// STDIO-517 — Tool-discovery eval: the presented toolset.
//
// The model is shown BOTH options so its first move is a genuine routing
// choice: the real routing tools (enact_capability / delegate / dispatch,
// with their real descriptions + schemas so the eval measures the actual
// surface a session sees) AND plausible inline alternatives (write_file /
// read_file / edit_file). If we only presented the routing tools the model
// would have nowhere to be wrong; the inline tools are what make
// over-delegation and self-generation observable.
//
// STDIO-520 — the toolset also carries a NATIVE competitor (run_shell): the
// direct, ungoverned way a model produces work itself. The old eval offered
// only substrate tools, so it measured "substrate vs nothing" and over-predicted
// routing; the wild run showed models defect to the native shell when it's
// there. Presenting run_shell makes the eval measure the real choice —
// substrate vs native — and predictive of the wild.
//
// The routing descriptions/schemas are lifted from the tools' own source
// (enact.ts / delegate.ts / dispatch.ts) so the eval tracks the real steer
// surface. delegate's live host summary is omitted — the eval presents the
// tool's intent, not one host's configured worker.

import type { ToolDef } from '@verevoir/llm';
import { ENACT_DESCRIPTION } from '../tools/enact.js';
import { DELEGATE_DESCRIPTION } from '../tools/delegate.js';
import { DISPATCH_DESCRIPTION } from '../tools/dispatch.js';

const OBJECT = 'object' as const;

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
      verify: {
        type: 'string',
        description: 'Set true to review the output on the reasoning tier before returning.',
      },
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
      model: {
        type: 'string',
        description: 'The worker model, by family or id (e.g. "deepseek").',
      },
      source: { type: 'string', description: 'The source the worker reads from.' },
    },
    required: ['prompt', 'model', 'source'],
  },
};

const WRITE_FILE_TOOL: ToolDef = {
  name: 'write_file',
  description:
    "Write a file's full contents to a source, creating or overwriting it. Use for producing a file inline yourself.",
  input_schema: {
    type: OBJECT,
    properties: {
      path: { type: 'string', description: 'File path within the source.' },
      content: { type: 'string', description: 'Full file content to write.' },
    },
    required: ['path', 'content'],
  },
};

const READ_FILE_TOOL: ToolDef = {
  name: 'read_file',
  description: "Read a file's full contents from a source.",
  input_schema: {
    type: OBJECT,
    properties: { path: { type: 'string', description: 'File path within the source.' } },
    required: ['path'],
  },
};

const EDIT_FILE_TOOL: ToolDef = {
  name: 'edit_file',
  description:
    'Replace an exact oldString with newString in a file. Use for a small, surgical inline change.',
  input_schema: {
    type: OBJECT,
    properties: {
      path: { type: 'string', description: 'File path within the source.' },
      oldString: { type: 'string', description: 'Exact text to replace.' },
      newString: { type: 'string', description: 'Replacement text.' },
    },
    required: ['path', 'oldString', 'newString'],
  },
};

const RUN_SHELL_TOOL: ToolDef = {
  name: 'run_shell',
  description:
    "Run a shell command to fetch, read, transform, or produce files yourself — the native, direct way (does not go through the substrate's bar, tiering, or gate).",
  input_schema: {
    type: OBJECT,
    properties: {
      command: { type: 'string', description: 'The shell command to run.' },
    },
    required: ['command'],
  },
};

/** The native competitor: producing work directly in-host, bypassing the
 * substrate's governed/tiered/gated path entirely. On a `route` task, reaching
 * for this is a DEFECTION to native — the wild failure the eval now measures. */
export const NATIVE_TOOLS = ['run_shell'] as const;

/** The full toolset presented to the model: routing tools first, then the
 * inline alternatives, then the native competitor — the model has a real choice
 * between substrate and native on every task. */
export const PRESENTED_TOOLS: ToolDef[] = [
  ENACT_TOOL,
  DELEGATE_TOOL,
  DISPATCH_TOOL,
  WRITE_FILE_TOOL,
  READ_FILE_TOOL,
  EDIT_FILE_TOOL,
  RUN_SHELL_TOOL,
];
