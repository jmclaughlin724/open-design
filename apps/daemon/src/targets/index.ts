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
