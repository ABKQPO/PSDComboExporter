export interface SearchableNode {
  id: string;
  text: string;
}

export function searchNodes<T extends SearchableNode>(nodes: T[], query: string): T[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [];
  return nodes.filter((node) => node.text.toLocaleLowerCase().includes(needle));
}

export function nextSearchIndex(current: number, count: number, direction: 1 | -1): number {
  if (!count) return -1;
  if (current < 0) return direction > 0 ? 0 : count - 1;
  return (current + direction + count) % count;
}
