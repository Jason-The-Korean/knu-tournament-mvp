export const FAVORITES_KEY = 'knu-arena-favorites-v1';
export function loadFavorites(storage) {
  const raw = storage.getItem(FAVORITES_KEY);
  if (raw === null) return new Set();
  const values = JSON.parse(raw);
  if (!Array.isArray(values) || values.length > 2000 || values.some(value => typeof value !== 'string' || !/^[\w-]{1,100}$/.test(value))) throw new Error('관심 대회 저장 형식이 올바르지 않습니다.');
  return new Set(values);
}
export function saveFavorites(storage, values) {
  if (values.size > 2000) throw new Error('관심 대회는 최대 2,000개까지 저장할 수 있습니다.');
  storage.setItem(FAVORITES_KEY, JSON.stringify([...values].sort()));
}
