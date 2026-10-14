// Auto follows the visible spread and the next N pages in reading order.
export function autoWindow<T>(pages: T[], ahead: number, overlap: (page: T) => number): T[] {
    const visible = pages.map((page, index) => ({ index, area: overlap(page) })).filter(p => p.area > 0);
    if (!visible.length) return [];
    const first = visible[0].index;
    const last = visible[visible.length - 1].index;
    return pages.slice(first, last + 1 + Math.max(0, Math.min(30, Math.round(ahead))));
}
