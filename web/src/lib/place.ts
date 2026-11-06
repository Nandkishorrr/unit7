// Where a hover card goes: under its trigger when it fits, else above when that fits, else whichever side has more
// room; slid sideways and clamped so it stays inside the window (pad px from every edge).
export interface Rect { left: number; top: number; width: number; height: number }
export interface Size { width: number; height: number }

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(n, hi));

export function placeCard(trigger: Rect, card: Size, view: Size, gap = 8, pad = 8): { left: number; top: number; side: 'top' | 'bottom' } {
  const below = trigger.top + trigger.height + gap;
  const above = trigger.top - gap - card.height;
  const roomBelow = view.height - pad - below, roomAbove = trigger.top - gap - pad;
  const side = card.height <= roomBelow ? 'bottom' : card.height <= roomAbove ? 'top' : roomBelow >= roomAbove ? 'bottom' : 'top';
  return {
    side,
    top: clamp(side === 'bottom' ? below : above, pad, view.height - pad - card.height),
    left: clamp(trigger.left + trigger.width / 2 - card.width / 2, pad, view.width - pad - card.width),
  };
}
