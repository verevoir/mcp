// Ambient types for `@verevoir/design-gate` — the zero-dependency design
// verifier published from the guardrails `tooling/` dir. The package ships
// `.mjs` only (no bundled types), so declare the slice the MCP imports.
declare module '@verevoir/design-gate' {
  /** One finding from the design gate, model-actionable for a re-produce. */
  export interface DesignFinding {
    kind: string;
    file?: string;
    where?: string;
    message: string;
  }
  /** Verify a produced design pack held as an in-memory `{ path → content }`
   * map: DTCG validity, generated-view drift, value-drift. Pure. */
  export function verifyFiles(files: Record<string, string>): {
    ok: boolean;
    findings: DesignFinding[];
  };
  /** Render the generated value view (`.tokens.md`) for a token source. */
  export function renderTokenView(tokens: unknown): string;
}
