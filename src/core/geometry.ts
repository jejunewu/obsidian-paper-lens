export interface Position { page: number; fraction: number }
export interface PageLayout { top: number; height: number }
export function locatePosition(offset: number, layouts: PageLayout[]): Position {
  let index = 0;
  for (let i = 0; i < layouts.length; i++) if (offset >= (layouts[i]?.top ?? 0)) index = i;
  const layout = layouts[index];
  return { page: index + 1, fraction: layout ? Math.min(1, Math.max(0, (offset - layout.top) / layout.height)) : 0 };
}
export function positionOffset(pos: Position, layouts: PageLayout[]): number {
  const layout = layouts[pos.page - 1]; return layout ? layout.top + layout.height * pos.fraction : 0;
}
interface Box { x: number; y: number; width: number; height: number; rotation: number }
export function viewportPoint(point: [number, number], box: Box, scale: number): [number, number] {
  const x = point[0] - box.x, y = point[1] - box.y;
  switch ((box.rotation % 360 + 360) % 360) {
    case 90: return [y * scale, x * scale];
    case 180: return [(box.width - x) * scale, y * scale];
    case 270: return [(box.height - y) * scale, (box.width - x) * scale];
    default: return [x * scale, (box.height - y) * scale];
  }
}
export function pdfPoint(point: [number, number], box: Box, scale: number): [number, number] {
  const x = point[0] / scale, y = point[1] / scale;
  switch ((box.rotation % 360 + 360) % 360) {
    case 90: return [box.x + y, box.y + x];
    case 180: return [box.x + box.width - x, box.y + y];
    case 270: return [box.x + box.width - y, box.y + box.height - x];
    default: return [box.x + x, box.y + box.height - y];
  }
}
