import type { ImageContent } from '../llm/core';

interface AnnotationBox { x1: number; y1: number; x2: number; y2: number; marker: number }
interface Rect { x: number; y: number; w: number; h: number }
export interface AnnotationMark {
    marker: number;
    text: Rect;
    frame: Rect;
    label: { x: number; y: number; r: number };
    margin: boolean;
}
export interface AnnotationPlan {
    width: number; height: number;
    content: ImageContent;
    font: number;
    marks: AnnotationMark[];
}

const overlaps = (a: Rect, b: Rect): boolean =>
    a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const grow = (r: Rect, pad: number): Rect => ({ x: r.x - pad, y: r.y - pad, w: r.w + pad * 2, h: r.h + pad * 2 });
const labelRect = (x: number, y: number, r: number): Rect => ({ x: x - r, y: y - r, w: r * 2, h: r * 2 });

// Layout is in scaled-page pixels. Labels exclude every detected text rectangle;
// unavailable local positions get a separate right margin, never an inward clamp.
export function planAnnotations(boxes: AnnotationBox[], width: number, height: number, font: number): AnnotationPlan {
    const digits = Math.max(1, ...boxes.map(box => String(box.marker).length));
    const r = Math.ceil(Math.max(font * 0.9, digits * font * 0.33 + 3));
    const pad = r + 7, gap = 3;
    const content = { x: pad, y: pad, w: width, h: height };
    const imageW = width + pad * 2, imageH = height + pad * 2;
    const texts = boxes.map(box => {
        const x1 = Math.max(0, Math.min(width, box.x1)), y1 = Math.max(0, Math.min(height, box.y1));
        const x2 = Math.max(x1, Math.min(width, box.x2)), y2 = Math.max(y1, Math.min(height, box.y2));
        return { x: x1 + pad, y: y1 + pad, w: x2 - x1, h: y2 - y1 };
    });
    const protectedText = texts.map(text => grow(text, 2));
    const labels: Rect[] = [];
    const pending: AnnotationMark[] = [];
    const marks = boxes.map((box, i) => {
        const text = texts[i], frame = grow(text, gap);
        const left = frame.x - r - gap, right = frame.x + frame.w + r + gap;
        const top = frame.y - r - gap, bottom = frame.y + frame.h + r + gap;
        const candidates = [
            [frame.x + r, top], [left, frame.y + r],
            [frame.x + frame.w - r, top], [right, frame.y + r],
            [frame.x + r, bottom], [left, frame.y + frame.h - r],
            [frame.x + frame.w - r, bottom], [right, frame.y + frame.h - r],
        ];
        let label: AnnotationMark['label'] | undefined;
        for (const [cx, cy] of candidates) {
            const x = Math.max(r + 1, Math.min(imageW - r - 1, cx));
            const y = Math.max(r + 1, Math.min(imageH - r - 1, cy));
            const bounds = labelRect(x, y, r + 1);
            if ([...protectedText, ...labels].some(area => overlaps(bounds, area))) continue;
            label = { x, y, r };
            labels.push(bounds);
            break;
        }
        const mark: AnnotationMark = { marker: box.marker, text, frame,
            label: label ?? { x: 0, y: 0, r }, margin: !label };
        if (!label) pending.push(mark);
        return mark;
    });
    const step = (r + 2) * 2 + gap;
    const rows = Math.max(1, Math.floor((imageH - gap * 2) / step));
    pending.sort((a, b) => a.text.y - b.text.y).forEach((mark, i) => {
        mark.label.x = imageW + gap + r + 1 + Math.floor(i / rows) * step;
        mark.label.y = gap + r + 1 + (i % rows) * step;
    });
    return { width: imageW + Math.ceil(pending.length / rows) * step,
        height: imageH, content, font, marks };
}

// Frames/callouts may cross another region, so restore source pixels through the
// protected text clips before drawing the collision-free labels.
export function drawAnnotations(ctx: CanvasRenderingContext2D, plan: AnnotationPlan, restoreSource: () => void): void {
    ctx.save();
    ctx.beginPath();
    for (const mark of plan.marks) {
        const frame = mark.frame;
        ctx.rect(frame.x, frame.y, frame.w, frame.h);
        if (mark.margin) {
            const y = frame.y + frame.h / 2;
            ctx.moveTo(frame.x + frame.w, y);
            ctx.lineTo(mark.label.x - mark.label.r - 2, y);
            ctx.lineTo(mark.label.x - mark.label.r, mark.label.y);
        }
    }
    ctx.lineWidth = 3.5; ctx.strokeStyle = '#fff'; ctx.stroke();
    ctx.lineWidth = 1.25; ctx.strokeStyle = '#e02020'; ctx.stroke();
    ctx.save();
    ctx.beginPath();
    for (const mark of plan.marks) {
        const text = grow(mark.text, 1);
        ctx.rect(text.x, text.y, text.w, text.h);
    }
    ctx.clip();
    restoreSource();
    ctx.restore();
    ctx.font = `bold ${plan.font}px sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (const { marker, label } of plan.marks) {
        ctx.beginPath(); ctx.arc(label.x, label.y, label.r, 0, Math.PI * 2);
        ctx.fillStyle = '#e02020'; ctx.fill();
        ctx.lineWidth = 1.5; ctx.strokeStyle = '#fff'; ctx.stroke();
        ctx.fillStyle = '#fff'; ctx.fillText(String(marker), label.x, label.y + plan.font * 0.04);
    }
    ctx.restore();
}

// Extra coordinates are measured on the annotated image, including its padding.
// Ignore annotations/margins and map only the original content back to source pixels.
export function sourceExtras<T extends { x1: number; y1: number; x2: number; y2: number }>(
    extras: T[], content: ImageContent, sourceW: number, sourceH: number,
): T[] {
    if (!(content.w > 0 && content.h > 0)) return [];
    return extras.filter(extra => [extra.x1, extra.y1, extra.x2, extra.y2].every(Number.isFinite)
        && extra.x2 > extra.x1 && extra.y2 > extra.y1
        && extra.x1 >= content.x && extra.y1 >= content.y
        && extra.x2 <= content.x + content.w && extra.y2 <= content.y + content.h)
        .map(extra => ({ ...extra,
            x1: (extra.x1 - content.x) * sourceW / content.w,
            y1: (extra.y1 - content.y) * sourceH / content.h,
            x2: (extra.x2 - content.x) * sourceW / content.w,
            y2: (extra.y2 - content.y) * sourceH / content.h }));
}
