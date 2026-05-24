import { describe, it, expect } from 'vitest';
import { pickSourceAdapter, pickWorkflowAdapter } from '../src/router.js';

describe('pickSourceAdapter', () => {
  it('returns the github adapter for a github.com URL', async () => {
    const adapter = await pickSourceAdapter('https://github.com/verevoir/context');
    expect(adapter).toBeDefined();
    expect(typeof adapter.readFile).toBe('function');
  });

  it('returns the fs adapter for an absolute path', async () => {
    const adapter = await pickSourceAdapter('/Users/adam/projects/foo');
    expect(adapter).toBeDefined();
    expect(typeof adapter.readFile).toBe('function');
  });

  it('returns the fs adapter for a tilde path', async () => {
    const adapter = await pickSourceAdapter('~/projects/foo');
    expect(adapter).toBeDefined();
    expect(typeof adapter.readFile).toBe('function');
  });

  it('returns the fs adapter for a relative ./ path', async () => {
    const adapter = await pickSourceAdapter('./relative/path');
    expect(adapter).toBeDefined();
    expect(typeof adapter.readFile).toBe('function');
  });

  it('returns the fs adapter for a file:// URL', async () => {
    const adapter = await pickSourceAdapter('file:///tmp/repo');
    expect(adapter).toBeDefined();
    expect(typeof adapter.readFile).toBe('function');
  });

  it('throws for an unsupported URL', async () => {
    await expect(pickSourceAdapter('https://gitlab.com/owner/repo')).rejects.toThrow(
      'Unsupported source URL'
    );
  });

  it('throws for a plain hostname', async () => {
    await expect(pickSourceAdapter('example.com/repo')).rejects.toThrow('Unsupported source URL');
  });
});

describe('pickWorkflowAdapter', () => {
  it('returns the trello adapter for a trello board URL', async () => {
    const adapter = await pickWorkflowAdapter('https://trello.com/b/abc123/my-board');
    expect(adapter).toBeDefined();
    expect(typeof adapter.listColumns).toBe('function');
  });

  it('returns the trello adapter for a bare trello board URL (no slug)', async () => {
    const adapter = await pickWorkflowAdapter('https://trello.com/b/abc123');
    expect(adapter).toBeDefined();
    expect(typeof adapter.listCards).toBe('function');
  });

  it('throws for an unsupported board URL', async () => {
    await expect(pickWorkflowAdapter('https://notion.so/board/xyz')).rejects.toThrow(
      'Unsupported board URL'
    );
  });

  it('throws for a Jira URL', async () => {
    await expect(
      pickWorkflowAdapter('https://myorg.atlassian.net/jira/software/projects/P')
    ).rejects.toThrow('Unsupported board URL');
  });
});
