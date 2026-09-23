import { describe, expect, it } from 'vitest';

import { TOOL_DEFS } from '../src/mcp.js';

describe('design teaching-loop MCP tools', () => {
  it('lists check_design_system, renderProbe, and getDesignContext', () => {
    const names = TOOL_DEFS.map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining([
      'check_design_system',
      'renderProbe',
      'getDesignContext',
    ]));

    expect(TOOL_DEFS.find((tool) => tool.name === 'renderProbe')?.inputSchema).toMatchObject({
      required: ['file', 'expression'],
    });
    expect(TOOL_DEFS.find((tool) => tool.name === 'getDesignContext')?.inputSchema).toMatchObject({
      required: ['file'],
    });
    expect(
      TOOL_DEFS.find((tool) => tool.name === 'check_design_system')?.annotations,
    ).toMatchObject({
      readOnlyHint: true,
    });
  });
});
