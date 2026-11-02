export interface CleanupItem { id: string; title: string; inTrash: boolean }
export interface CleanupFailure { stage: string; itemId?: string; code: string; detail: string }
export interface CleanupPlan {
  token: string; confirmation: string; expiresAt: number;
  notes: CleanupItem[]; folders: { id: string; title: string }[];
  metadataKeys: number; warnings: string[]; blocked: boolean; lastFailure?: CleanupFailure;
}
export interface CleanupResult { cleanedNotes: number; cleanedFolders: number; removedKeys: number }
