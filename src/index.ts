import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerSourceTools } from './tools/source.js';
import { registerWorkflowTools } from './tools/workflow.js';
import { registerSkillPrompts } from './tools/skills.js';
import { registerGovernanceTool } from './tools/governance.js';
import { registerProvisionTool } from './tools/provision.js';
import { registerDelegateTool } from './tools/delegate.js';
import { loadInstructions } from './instructions.js';
import { loadManifest, composeInstructions } from './manifest.js';

/** Construct and configure the MCP server. Async because skill prompts are
 * loaded from the guardrails corpus at startup. The caller is responsible for
 * wiring a transport (see bin.ts). */
export async function createServer(): Promise<McpServer> {
  const server = new McpServer(
    {
      name: 'verevoir-mcp',
      version: '0.1.0',
    },
    // Server-level guidance the client injects into the model's context on
    // connect — the lever that makes an agent prefer these tools over its
    // built-in filesystem/shell tools. The universal doctrine is loaded from
    // the packaged doc (instructions.md); the project pointer manifest
    // (aigency.json, per ADR 023) composes a project-specific layer on top
    // naming this project's board + record. No manifest → universal only.
    { instructions: composeInstructions(loadInstructions(), loadManifest()) }
  );

  registerSourceTools(server);
  registerWorkflowTools(server);
  // Surface the project's governance (ADRs + key docs) as a scannable,
  // narrowable index so even a small model finds the right decision.
  registerGovernanceTool(server);
  // The triggered, one-hop "consult the bar" step: returns the practices a
  // piece of work is held to as text (foundational floor + concern-tagged), so
  // a weak model gets the bar in one call and can hand it to a worker it spawns.
  registerProvisionTool(server);
  // The coordinator→worker connector: hand a self-contained sub-task to a
  // configured worker model (local Ollama/LM Studio, or any OpenAI-compatible
  // endpoint) and return its result.
  await registerDelegateTool(server);
  // Best-effort: registers the guardrails reasoning skills as prompts. A load
  // failure (no token, source unreachable) leaves the server running with its
  // tools and no skill prompts rather than failing to start.
  await registerSkillPrompts(server);

  return server;
}
