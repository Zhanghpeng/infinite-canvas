import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import "@/i18n";
import type { VideoRange } from "@/lib/canvas/video-timeline";
import { CanvasVideoTimeline } from "../canvas-video-timeline";

const ranges: VideoRange[] = [
    { startMs: 0, endMs: 6000, sceneStart: true },
    { startMs: 6000, endMs: 12_000, sceneStart: true },
    { startMs: 12_000, endMs: 20_000, sceneStart: false },
];

function render(extra: Partial<React.ComponentProps<typeof CanvasVideoTimeline>> = {}) {
    return renderToStaticMarkup(
        <CanvasVideoTimeline
            durationMs={20_000}
            frames={[]}
            cuts={[]}
            ranges={ranges}
            selection={null}
            currentTimeMs={0}
            onSeek={() => undefined}
            onSelectionChange={() => undefined}
            {...extra}
        />,
    );
}

/** 段边界手柄的数量：每个内部边界一个，不能把片尾也算进去。 */
function handleCount(html: string): number {
    return (html.match(/role="separator"/g) ?? []).length;
}

describe("时间轴上的段边界手柄", () => {
    it("内部边界各一个手柄，片尾不算边界", () => {
        expect(handleCount(render({ onBoundaryMove: () => undefined }))).toBe(ranges.length - 1);
    });

    it("没给回调就不渲染手柄（只读场景不该有可拖的暗示）", () => {
        expect(handleCount(render())).toBe(0);
    });

    it("手柄按时间比例定位", () => {
        const html = render({ onBoundaryMove: () => undefined });
        // 6000/20000 = 30%，12000/20000 = 60%
        expect(html).toContain("left:30%");
        expect(html).toContain("left:60%");
        // 片尾 20000 投影成 100%，若被当成边界会多出一条贴边的线
        expect(html).not.toContain("left:100%");
    });

    it("给了删除回调才提示双击合并", () => {
        const withoutRemove = render({ onBoundaryMove: () => undefined });
        const withRemove = render({ onBoundaryMove: () => undefined, onBoundaryRemove: () => undefined });
        // i18n 文案不同：一个说"拖动调整边界"，另一个连双击合并一起说
        expect(withoutRemove).not.toContain("双击");
        expect(withRemove).toContain("双击");
    });
});
