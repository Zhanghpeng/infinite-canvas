import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import i18n from "@/i18n";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import { CanvasNodePromptPanel } from "../canvas-node-prompt-panel";

const node: CanvasNodeData = {
    id: "t1",
    type: CanvasNodeType.Text,
    title: "夜街",
    position: { x: 0, y: 0 },
    width: 340,
    height: 240,
    metadata: { content: "深夜街头，男的靠着路灯抽烟，女的从远处走近", status: "success", fontSize: 14 },
};

function render(extra: Partial<React.ComponentProps<typeof CanvasNodePromptPanel>> = {}) {
    // 面板里的提示词库弹层会读 react-query 缓存，这里给一个不重试的独立 client。
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, enabled: false } } });
    return renderToStaticMarkup(
        <QueryClientProvider client={client}>
            <CanvasNodePromptPanel node={node} nodes={[node]} isRunning={false} onPromptChange={() => undefined} onConfigChange={() => undefined} onGenerate={() => undefined} onStop={() => undefined} {...extra} />
        </QueryClientProvider>,
    );
}

describe("文本节点的提示词助手入口", () => {
    it("falls back to the plain workflow picker when no assistant config is passed", () => {
        const html = render();
        expect(html).toContain(i18n.t("canvas.promptPanel.generate"));
        expect(html).not.toContain(i18n.t("canvas.promptAssistant.runSkill"));
    });

    it("keeps the channel workflow picker and hides the skill picker for the comfyui backend", () => {
        const html = render({
            promptAssistantConfig: { backend: "comfyui", skill: { kind: "builtin", id: "prompt-polish" } },
            onPromptAssistantChange: () => undefined,
            onOptimizePrompt: () => undefined,
        });
        // 技能下拉是唯一可清空的 Select（allowClear），ComfyUI 后端不该出现它
        expect(html).not.toContain("ant-select-allow-clear");
        expect(html).not.toContain(i18n.t("canvas.promptAssistant.runSkill"));
        // 回车仍然是原来的「生成」路径，不按技能执行
        expect(html).toContain(i18n.t("canvas.promptPanel.generate"));
    });

    it("renders the selected node skill and the run button for a nodes skill on the agent backend", () => {
        const html = render({
            promptAssistantConfig: { backend: "agent", skill: { kind: "builtin", id: "director-stage-scene" } },
            onPromptAssistantChange: () => undefined,
            onOptimizePrompt: () => undefined,
        });
        // 选中的技能名直接显示在下拉上，所以「预演搭建」必须在首屏 HTML 里
        expect(html).toContain(i18n.t("canvas.promptAssistant.skills.director-stage-scene"));
        expect(html).toContain(i18n.t("canvas.promptAssistant.runSkill"));
        expect(html).not.toContain(i18n.t("canvas.promptPanel.repeatGeneration"));
    });

    it("greys out the run button while a reason is supplied", () => {
        const html = render({
            promptAssistantConfig: { backend: "agent", skill: { kind: "builtin", id: "director-stage-scene" } },
            onPromptAssistantChange: () => undefined,
            onOptimizePrompt: () => undefined,
            promptAssistantDisabledReason: i18n.t("canvas.promptAssistant.disabledEmpty"),
        });
        // 原因挂在 Tooltip 上（弹层未展开时不进 HTML），按钮本身必须是禁用态
        expect(html).toMatch(new RegExp(`${i18n.t("canvas.promptAssistant.runSkill")}[^>]*disabled`));
    });

    it("turns the primary button into a stop control while optimizing", () => {
        const html = render({
            promptAssistantConfig: { backend: "agent", skill: { kind: "builtin", id: "prompt-polish" } },
            onPromptAssistantChange: () => undefined,
            onOptimizePrompt: () => undefined,
            isOptimizingPrompt: true,
            onCancelOptimizePrompt: () => undefined,
        });
        expect(html).toContain(i18n.t("canvas.promptAssistant.cancel"));
    });
});
