import type { AddressRow, AddressFilters } from './types.js';

const collator = new Intl.Collator('ru', { numeric: true, sensitivity: 'base' });

export const ADDRESS_PAGE_SIZE = 25;
export const ADDRESS_SELECTION_LIMIT = 5_000;

export interface SelectedAddress {
  id: number;
  url: string;
  version: number;
  matchesFilter: boolean;
}

export interface DeleteAllPreview {
  projectName: string;
  addresses: number;
  running: number;
  queued: number;
  transferActive: boolean;
  confirmation: string;
}

export interface DeleteAllOutcome { deleted: number; stopped: number }

export const defaultFilters: AddressFilters = { q: '', status: 'all', sort: 'url', direction: 'asc' };

export function selectAddresses(addresses: AddressRow[], filters: AddressFilters) {
  const query = filters.q.trim().toLocaleLowerCase('ru');
  const values = (entry: AddressRow) => {
    switch (filters.sort) {
      case 'url': return entry.url;
      case 'label': return entry.label || null;
      case 'status': return entry.latest?.status ?? null;
      case 'httpCode': return entry.latest?.httpCode ?? null;
      case 'durationMs': return entry.latest?.durationMs ?? null;
      case 'checkedAt': return entry.latest?.checkedAt ?? null;
    }
  };
  return addresses.filter(entry => {
    const status = entry.latest?.status ?? 'unchecked';
    return (filters.status === 'all' || filters.status === status)
      && (entry.url.toLowerCase().includes(query) || entry.label.toLocaleLowerCase('ru').includes(query));
  }).sort((first, second) => {
    const a = values(first);
    const b = values(second);
    if (a === null || b === null) return a === b ? first.id - second.id : a === null ? 1 : -1;
    const comparison = typeof a === 'number' && typeof b === 'number'
      ? a - b : collator.compare(String(a), String(b));
    return comparison * (filters.direction === 'desc' ? -1 : 1) || first.id - second.id;
  });
}
