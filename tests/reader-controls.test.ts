import { afterEach, describe, expect, it, vi } from "vitest";
import { clampZoom, resizeBox, wheelZoom } from "../src/core/geometry";
import { textStyle } from "../src/core/annotations";
import { PdfReader } from "../src/pdf/reader";

afterEach(() => vi.unstubAllGlobals());

describe("reader controls", () => {
  it("limits zoom and normalizes trackpad, line and page deltas", () => {
    expect(clampZoom(NaN)).toBe(1);
    expect(clampZoom(Infinity)).toBe(1);
    expect(clampZoom(0)).toBe(0.25);
    expect(clampZoom(10)).toBe(4);
    expect(wheelZoom(1, -10, 0)).toBeGreaterThan(1);
    expect(wheelZoom(1, 16, 0)).toBe(wheelZoom(1, 1, 1));
    expect(wheelZoom(1, 800, 0)).toBe(wheelZoom(1, 1, 2));
  });

  it("keeps a resized box's top left, enforces minimum size and page bounds", () => {
    expect(resizeBox([20, 30, 100, 90], [50, 60], [600, 800], [24, 18]))
      .toEqual([20, 30, 150, 150]);
    expect(resizeBox([20, 30, 100, 90], [-500, -500], [600, 800], [24, 18]))
      .toEqual([20, 30, 44, 48]);
    expect(resizeBox([20, 30, 100, 90], [900, 900], [600, 800], [24, 18]))
      .toEqual([20, 30, 600, 800]);
  });

  it("keeps legacy text black and respects styled text", () => {
    const item = { id: "old", kind: "text" as const, page: 1,
      text: "中文", rects: [], color: [1, 1, 0] as [number, number, number] };
    expect(textStyle(item)).toEqual({ fontSize: 12, color: [0.1, 0.1, 0.1] });
    expect(textStyle({ ...item, fontSize: 24 }))
      .toEqual({ fontSize: 24, color: [1, 1, 0] });
  });

  it("leaves scrolling alone and coalesces pinch events before updating zoom", () => {
    const frames = new Map<number, FrameRequestCallback>();
    let index = 0;
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      frames.set(++index, cb); return index;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
    class Observer { observe() {} }
    vi.stubGlobal("IntersectionObserver", Observer);
    vi.stubGlobal("ResizeObserver", Observer);
    const listeners = new Map<string, (event: WheelEvent) => void>();
    const reader = new PdfReader({ classList: { add() {} }, dataset: {},
      setAttribute() {}, getBoundingClientRect: () => ({ left: 0, top: 0 }),
      addEventListener: (type: string, callback: (event: WheelEvent) => void) => listeners.set(type, callback),
    } as unknown as HTMLElement, "/test/resources");
    const wheel = listeners.get("wheel")!;
    const zoom = vi.fn();
    reader.onZoom = zoom;
    const preventDefault = vi.fn();
    wheel({ ctrlKey: false, preventDefault } as unknown as WheelEvent);
    expect(preventDefault).not.toHaveBeenCalled();
    for (let i = 0; i < 2; i++) wheel({ ctrlKey: true, deltaY: -10,
      deltaMode: 0, preventDefault } as unknown as WheelEvent);
    expect(preventDefault).toHaveBeenCalledTimes(2);
    expect(frames.size).toBe(1);
    [...frames.values()][0]!(0);
    expect(zoom).toHaveBeenCalledExactlyOnceWith(wheelZoom(wheelZoom(1, -10, 0), -10, 0));
  });
});
