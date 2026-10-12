import type { CatalogRelation } from "@ai-data/contracts";

/** 预览和编辑按关系方向共用分层规则，节点间距由各自卡片尺寸决定。 */
function layoutRelations(
  objects: readonly string[],
  relations: readonly Pick<CatalogRelation, "object_id" | "target_object_id">[],
  spacing = { x: 440, y: 260 },
): Map<string, { x: number; y: number }> {
  const ids = [...new Set(objects)].sort();
  const targets = new Map(ids.map((id) => [id, new Set<string>()]));
  const incoming = new Map(ids.map((id) => [id, 0]));
  const linked = new Set<string>();
  for (const row of relations) {
    const next = targets.get(row.object_id);
    if (!next || !targets.has(row.target_object_id) || next.has(row.target_object_id)) continue;
    next.add(row.target_object_id);
    incoming.set(row.target_object_id, incoming.get(row.target_object_id)! + 1);
    linked.add(row.object_id);
    linked.add(row.target_object_id);
  }
  const remaining = new Set(ids.filter((id) => linked.has(id)));
  const ranks = new Map(ids.map((id) => [id, 0]));
  while (remaining.size) {
    // 无环部分逐层向右；已有环以稳定顺序保留回边，避免无限推进层级。
    const source =
      [...remaining].find((id) => incoming.get(id) === 0) ?? remaining.values().next().value!;
    remaining.delete(source);
    for (const target of targets.get(source)!) {
      if (!remaining.has(target)) continue;
      ranks.set(target, Math.max(ranks.get(target)!, ranks.get(source)! + 1));
      incoming.set(target, incoming.get(target)! - 1);
    }
  }
  // 尚未建立关系的对象沿添加顺序放到空列，便于继续拖线。
  let nextRank = Math.max(-1, ...[...linked].map((id) => ranks.get(id)!)) + 1;
  for (const id of new Set(objects)) if (!linked.has(id)) ranks.set(id, nextRank++);
  const layers = new Map<number, string[]>();
  for (const id of ids) {
    const rank = ranks.get(id)!;
    layers.set(rank, [...(layers.get(rank) ?? []), id]);
  }
  const rows = Math.max(0, ...[...layers.values()].map((layer) => layer.length));
  const positions = new Map<string, { x: number; y: number }>();
  for (const [rank, layer] of layers) {
    const stagger = rows === 1 ? (rank % 2) / 2 : 0;
    layer.forEach((id, row) =>
      positions.set(id, {
        x: rank * spacing.x,
        y: (row + (rows - layer.length) / 2 + stagger) * spacing.y,
      }),
    );
  }
  return positions;
}

export { layoutRelations };
