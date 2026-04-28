import { createCrudApi } from './crudFactory';

export interface GlobalSnippet {
  id: string;
  session_id: string | null;
  name: string;
  command: string;
  sort_order: number;
  shared?: boolean;
  owner_name?: string | null;
  is_own?: boolean;
  created_at: string;
}

export interface NewGlobalSnippet {
  name: string;
  command: string;
  shared?: boolean;
}

const api = createCrudApi<GlobalSnippet, NewGlobalSnippet>('/snippets');

export const listGlobalSnippets = api.list;
export const createGlobalSnippet = api.create;
export const deleteGlobalSnippet = api.delete;
