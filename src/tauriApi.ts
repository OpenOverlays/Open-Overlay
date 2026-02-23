import { invoke } from '@tauri-apps/api/core';
import type { WorkspaceConfig } from './types';

export interface WorkspaceSummary {
  id: string;
  name: string;
  updated_at: string;
}

/** List all saved workspaces */
export async function listWorkspaces(): Promise<WorkspaceSummary[]> {
  return invoke<WorkspaceSummary[]>('list_overlays');
}

/** Get a full workspace by ID */
export async function getWorkspace(id: string): Promise<{ config: WorkspaceConfig } | null> {
  return invoke<{ config: WorkspaceConfig } | null>('get_overlay', { id });
}

/** Save (upsert) a workspace */
export async function saveWorkspace(ws: WorkspaceConfig): Promise<void> {
  return invoke('save_overlay', {
    args: { id: ws.id, name: ws.name, config: ws },
  });
}

/** Delete a workspace */
export async function deleteWorkspace(id: string): Promise<void> {
  return invoke('delete_overlay', { id });
}

/** Get OBS browser source URL for a specific widget */
export async function getWidgetObsUrl(widgetId: string): Promise<string> {
  return invoke<string>('get_obs_url', { id: widgetId });
}
