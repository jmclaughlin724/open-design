/**
 * @module design
 *
 * Barrel for daemon design lifecycle modules: finalize-design (finalize an
 * agent design run), handoff-design (synthesize a handoff prompt), and
 * claude-design-import (import a Claude Design zip or loose HTML files),
 * and design-context (HTML → agent-consumable design context).
 */
export * from './finalize-design.js';
export * from './handoff-design.js';
export * from './claude-design-import.js';
export * from './design-context.js';
