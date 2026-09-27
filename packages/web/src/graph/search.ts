/**
 * Small fuzzy matcher over declaration ids. Scores exact and substring matches highest, then
 * in-order subsequences, rewarding matches at name-component boundaries and consecutive runs.
 */

export interface SearchHit {
  id: string;
  score: number;
}

const BOUNDARY = new Set([".", "_", "'", " "]);

export function fuzzyScore(query: string, id: string): number | null {
  const q = query.trim().toLowerCase();
  if (!q) return null;
  const s = id.toLowerCase();
  if (s === q) return 10_000;
  const last = s.slice(s.lastIndexOf(".") + 1);
  if (last === q) return 9_000 - s.length;
  const sub = s.indexOf(q);
  if (sub >= 0) {
    const atBoundary = sub === 0 || BOUNDARY.has(s[sub - 1] ?? "");
    const inLast = sub >= s.length - last.length;
    return 5_000 + (atBoundary ? 500 : 0) + (inLast ? 300 : 0) - s.length;
  }
  let score = 0;
  let qi = 0;
  let run = 0;
  for (let i = 0; i < s.length && qi < q.length; i++) {
    if (s[i] === q[qi]) {
      qi++;
      run++;
      score += 10 + run * 5 + (i === 0 || BOUNDARY.has(s[i - 1] ?? "") ? 25 : 0);
    } else run = 0;
  }
  if (qi < q.length) return null;
  return score - s.length;
}

export function fuzzySearch(query: string, ids: readonly string[], limit = 40): SearchHit[] {
  const hits: SearchHit[] = [];
  for (const id of ids) {
    const score = fuzzyScore(query, id);
    if (score !== null) hits.push({ id, score });
  }
  hits.sort((a, b) => b.score - a.score || a.id.length - b.id.length || a.id.localeCompare(b.id));
  return hits.slice(0, limit);
}
