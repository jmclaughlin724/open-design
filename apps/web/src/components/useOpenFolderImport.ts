import { useCallback, useState } from 'react';
import {
  isOpenDesignHostAvailable,
  pickAndImportHostProject,
  type OpenDesignHostProjectImportSuccess,
} from '@open-design/host';
import { pickLocalFolderPath } from '../state/projects';
import { resolvedWorkspaceContextForWrite } from '../state/projects';
import { useWorkspaceContext } from '../collab/useWorkspaceContext';
import { formatPickAndImportFailure } from '../utils/pickAndImportError';

interface UseOpenFolderImportArgs {
  skillId?: string | null;
  onImportFolder?: (baseDir: string) => Promise<void> | void;
  onImportFolderResponse?: (response: OpenDesignHostProjectImportSuccess) => Promise<void> | void;
}

export type FolderImportOutcome = 'imported' | 'canceled' | 'unavailable' | 'error';

export function useOpenFolderImport({
  skillId,
  onImportFolder,
  onImportFolderResponse,
}: UseOpenFolderImportArgs) {
  const workspaceContextState = useWorkspaceContext();
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<{ message: string; details?: string } | null>(null);
  const hasHostPickAndImport = isOpenDesignHostAvailable();
  const available = hasHostPickAndImport ? Boolean(onImportFolderResponse) : Boolean(onImportFolder);

  const openFolder = useCallback(async (): Promise<FolderImportOutcome> => {
    if (hasHostPickAndImport) {
      if (!onImportFolderResponse) return 'unavailable';
      setError(null);
      setImporting(true);
      try {
        const result = await pickAndImportHostProject({
          skillId: skillId ?? null,
          workspaceContext: resolvedWorkspaceContextForWrite(workspaceContextState),
        });
        if (!result) return 'canceled';
        if (result.ok === true) {
          await onImportFolderResponse(result);
          return 'imported';
        }
        if ('canceled' in result && result.canceled === true) return 'canceled';
        setError(formatPickAndImportFailure(result));
        return 'error';
      } catch (err) {
        setError({
          message: err instanceof Error ? err.message : 'Failed to import folder',
        });
        return 'error';
      } finally {
        setImporting(false);
      }
    }

    if (!onImportFolder) return 'unavailable';
    setError(null);
    setImporting(true);
    try {
      const selectedPath = await pickLocalFolderPath();
      if (!selectedPath) return 'canceled';
      await onImportFolder(selectedPath);
      return 'imported';
    } catch (err) {
      setError({
        message: err instanceof Error ? err.message : 'Failed to import folder',
      });
      return 'error';
    } finally {
      setImporting(false);
    }
  }, [
    hasHostPickAndImport,
    onImportFolder,
    onImportFolderResponse,
    skillId,
    workspaceContextState,
  ]);

  return {
    available,
    clearError: () => setError(null),
    error,
    importing,
    openFolder,
  };
}
