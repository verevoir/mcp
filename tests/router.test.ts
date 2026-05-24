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

  it('returns the notion adapter for a notion.so URL', async () => {
    const adapter = await pickSourceAdapter(
      'https://www.notion.so/myws/Root-aabbccdd11223344556677889900aabb'
    );
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

  it('returns the notion adapter for a notion.so database URL', async () => {
    const adapter = await pickWorkflowAdapter(
      'https://www.notion.so/myws/369772cdbf9f80ab8900e7b7a96c5422?v=abcdef'
    );
    expect(adapter).toBeDefined();
    expect(typeof adapter.listColumns).toBe('function');
  });

  it('throws for a Jira URL', async () => {
    await expect(
      pickWorkflowAdapter('https://myorg.atlassian.net/jira/software/projects/P')
    ).rejects.toThrow('Unsupported board URL');
  });
});
