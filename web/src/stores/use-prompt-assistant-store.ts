import { create } from "zustand";
import { persist } from "zustand/middleware";

import { DEFAULT_PROMPT_ASSISTANT_CONFIG, type PromptAssistantConfig } from "@/lib/canvas/canvas-prompt-assistant";

/** 提示词助手的全局默认配置；单个文本节点可以用 metadata.promptAssistant 覆盖它。 */
type PromptAssistantStore = {
    config: PromptAssistantConfig;
    setConfig: (patch: Partial<PromptAssistantConfig>) => void;
};

export const usePromptAssistantStore = create<PromptAssistantStore>()(
    persist(
        (set) => ({
            config: DEFAULT_PROMPT_ASSISTANT_CONFIG,
            setConfig: (patch) => set((state) => ({ config: { ...state.config, ...patch } })),
        }),
        {
            name: "canvas-prompt-assistant",
            partialize: (state) => ({ config: state.config }),
        },
    ),
);
