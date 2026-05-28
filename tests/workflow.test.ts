import { describe, it, expect } from 'vitest';
import { definedOnly } from '../src/tools/workflow.js';

describe('definedOnly', () => {
  it('drops keys whose value is undefined', () => {
    expect(definedOnly({ title: 'x', body: undefined, columnId: undefined })).toEqual({
      title: 'x',
    });
  });

  it('keeps falsy-but-defined values — an empty body or empty label set are meaningful writes', () => {
    expect(definedOnly({ body: '', labelIds: [] })).toEqual({ body: '', labelIds: [] });
  });

  it('returns an empty object when every field is undefined', () => {
    expect(definedOnly({ title: undefined, body: undefined })).toEqual({});
  });
});
