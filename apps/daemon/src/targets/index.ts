export {
  CONNECTED_TARGET_METADATA_KEY,
  CONNECTED_TARGET_SNAPSHOT_KEY,
  bindConnectedTarget,
  readConnectedTarget,
  readTargetSnapshot,
  unbindConnectedTarget,
} from './registry.js';
export {
  normalizeStoredTarget,
  parseBindRequest,
  parseGithubOwnerRepo,
  parseGithubTargetSource,
  sameConnectedTarget,
} from './parse.js';
export { resolveLocalTargetFolder } from './local-folder.js';
export {
  captureFolderManifest,
  captureGitHead,
  captureTargetSnapshot,
  detectTargetDrift,
  diffManifest,
} from './snapshot.js';
export type { TargetBaseSnapshot, TargetDriftReport } from './snapshot.js';
export {
  driftHasConflict,
  parsePromoteBody,
  promoteTarget,
  promotionBranch,
  promotionSlug,
  readPromotionHistory,
} from './promote.js';
export type { GhRunner, PromoteRequest, PromoteResult } from './promote.js';
export {
  assertResolvedWriteOutsideBoundTarget,
  assertWriteOutsideBoundTarget,
  boundLocalPath,
  pathIsInsideBoundTarget,
} from './write-guard.js';
export { listPromotionAudits, recordPromotionGate } from './promotion-audit.js';
export type { DriftDecision, PromotionAuditRecord } from './promotion-audit.js';
export { listPromotions, migratePromotions } from './promotion-store.js';
export type { PromotionRecord } from './promotion-store.js';
