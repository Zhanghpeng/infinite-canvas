import type {
    ComfyFlowEdgeData,
    ComfyFlowGraphLayout,
    ComfyFlowNodeData,
    ComfyNodePort,
    ComfySlotCategory,
} from "./comfy-flow-types";

// 常见 ComfyUI 节点类别的常见端口类型推导
const KNOWN_OUTPUT_TYPES: Record<string, string[]> = {
    KSampler: ["LATENT"],
    KSamplerAdvanced: ["LATENT"],
    SamplerCustomAdvanced: ["LATENT"],
    VAEDecode: ["IMAGE"],
    VAEEncode: ["LATENT"],
    VAEEncodeForInpaint: ["LATENT"],
    CLIPTextEncode: ["CONDITIONING"],
    CLIPTextEncodeSDXL: ["CONDITIONING"],
    CLIPLoader: ["CLIP"],
    UNETLoader: ["MODEL"],
    VAELoader: ["VAE"],
    CheckpointLoaderSimple: ["MODEL", "CLIP", "VAE"],
    LoadImage: ["IMAGE", "MASK"],
    EmptyLatentImage: ["LATENT"],
    EmptySD3LatentImage: ["LATENT"],
    ConditioningCombine: ["CONDITIONING"],
    FluxGuidance: ["CONDITIONING"],
    SaveImage: ["IMAGE"],
    PreviewImage: ["IMAGE"],
    VHS_VideoCombine: ["IMAGE"],
};

function inferDataType(classType: string, slotIndex: number, paramKey?: string): string {
    const key = (paramKey || "").toLowerCase();
    if (key.includes("image") || key.includes("frame")) return "IMAGE";
    if (key.includes("latent")) return "LATENT";
    if (key.includes("model") || key.includes("unet")) return "MODEL";
    if (key.includes("clip") || key.includes("conditioning") || key === "positive" || key === "negative") {
        return "CONDITIONING";
    }
    if (key.includes("vae")) return "VAE";
    if (key.includes("mask")) return "MASK";
    if (key.includes("audio")) return "AUDIO";
    if (key.includes("video")) return "VIDEO";
    if (key.includes("seed") || key.includes("steps") || key.includes("width") || key.includes("height")) {
        return "INT";
    }

    const outputs = KNOWN_OUTPUT_TYPES[classType];
    if (outputs && outputs[slotIndex]) {
        return outputs[slotIndex];
    }
    return "ANY";
}

function classifySlot(rawTitle?: string, classType?: string): { category: ComfySlotCategory; modelType?: string } {
    if (!rawTitle) {
        if (classType?.startsWith("Save") || classType === "VHS_VideoCombine" || classType === "SaveText") {
            return { category: "output" };
        }
        return { category: "general" };
    }

    const title = rawTitle.trim();
    if (title.startsWith("select_models_")) {
        return { category: "model", modelType: title.slice("select_models_".length).toLowerCase() };
    }
    if (title.startsWith("select_")) {
        return { category: "model", modelType: title.slice("select_".length).toLowerCase() };
    }
    if (title === "prompt") return { category: "prompt" };
    if (title === "seed") return { category: "seed" };
    if (title === "width" || title === "height" || title === "duration") return { category: "size" };
    if (
        title.startsWith("ref_image_") ||
        title.startsWith("ref_video_") ||
        title.startsWith("ref_audio_") ||
        title === "first_frame" ||
        title === "last_frame" ||
        title === "ref_mask"
    ) {
        return { category: "reference" };
    }
    if (title.startsWith("output_") || title === "output_image" || title === "output_video" || title === "output_text") {
        return { category: "output" };
    }
    if (classType?.startsWith("Save") || classType === "VHS_VideoCombine" || classType === "SaveText") {
        return { category: "output" };
    }
    return { category: "general" };
}

export function parseWorkflowToGraph(workflow: Record<string, unknown>): ComfyFlowGraphLayout {
    if (!workflow || typeof workflow !== "object") {
        return {
            nodes: [],
            edges: [],
            bounds: { minX: 0, minY: 0, maxX: 800, maxY: 600, width: 800, height: 600 },
            stats: { totalNodes: 0, totalEdges: 0, detectedSlots: 0 },
        };
    }

    const rawEntries = Object.entries(workflow);
    const validNodesMap = new Map<string, { classType: string; inputs: Record<string, unknown>; title?: string }>();

    for (const [id, rawVal] of rawEntries) {
        if (!rawVal || typeof rawVal !== "object" || Array.isArray(rawVal)) continue;
        const rawNode = rawVal as {
            class_type?: string;
            inputs?: Record<string, unknown>;
            _meta?: { title?: unknown };
        };
        const classType = typeof rawNode.class_type === "string" ? rawNode.class_type : "Node";
        const inputs = rawNode.inputs && typeof rawNode.inputs === "object" ? rawNode.inputs : {};
        const title = typeof rawNode._meta?.title === "string" ? rawNode._meta.title.trim() : undefined;
        validNodesMap.set(id, { classType, inputs, title });
    }

    // 收集所有边和每个节点被使用的输出端口
    const edges: ComfyFlowEdgeData[] = [];
    const usedOutputSlots = new Map<string, Set<number>>();
    let detectedSlotsCount = 0;

    for (const [toId, nodeInfo] of validNodesMap.entries()) {
        const { inputs } = nodeInfo;
        for (const [paramKey, paramVal] of Object.entries(inputs)) {
            if (
                Array.isArray(paramVal) &&
                paramVal.length === 2 &&
                (typeof paramVal[0] === "string" || typeof paramVal[0] === "number") &&
                typeof paramVal[1] === "number"
            ) {
                const fromId = String(paramVal[0]);
                const fromSlot = paramVal[1];
                if (validNodesMap.has(fromId)) {
                    if (!usedOutputSlots.has(fromId)) {
                        usedOutputSlots.set(fromId, new Set());
                    }
                    usedOutputSlots.get(fromId)!.add(fromSlot);

                    const fromPortId = `${fromId}-out-${fromSlot}`;
                    const toPortId = `${toId}-in-${paramKey}`;
                    const dataType = inferDataType(
                        validNodesMap.get(fromId)?.classType || "",
                        fromSlot,
                        paramKey,
                    );

                    edges.push({
                        id: `${fromId}:${fromSlot}->${toId}:${paramKey}`,
                        fromNodeId: fromId,
                        fromSlot,
                        toNodeId: toId,
                        toInputKey: paramKey,
                        fromPortId,
                        toPortId,
                        dataType,
                    });
                }
            }
        }
    }

    // 构建邻接表用于计算 DAG 拓扑分层 (Kahn / Longest Path)
    const inDegree = new Map<string, number>();
    const outgoing = new Map<string, string[]>();

    for (const id of validNodesMap.keys()) {
        inDegree.set(id, 0);
        outgoing.set(id, []);
    }

    for (const edge of edges) {
        inDegree.set(edge.toNodeId, (inDegree.get(edge.toNodeId) || 0) + 1);
        outgoing.get(edge.fromNodeId)?.push(edge.toNodeId);
    }

    // 计算分层 (Layer)
    const layers = new Map<string, number>();
    const queue: string[] = [];

    for (const [id, deg] of inDegree.entries()) {
        if (deg === 0) {
            layers.set(id, 0);
            queue.push(id);
        }
    }

    // BFS / Relaxation 计算最长路径分层
    let maxLayer = 0;
    while (queue.length > 0) {
        const u = queue.shift()!;
        const currentLayer = layers.get(u) || 0;
        const neighbors = outgoing.get(u) || [];
        for (const v of neighbors) {
            const nextLayer = Math.max(layers.get(v) || 0, currentLayer + 1);
            layers.set(v, nextLayer);
            if (nextLayer > maxLayer) maxLayer = nextLayer;
            const remaining = (inDegree.get(v) || 1) - 1;
            inDegree.set(v, remaining);
            if (remaining === 0) {
                queue.push(v);
            }
        }
    }

    // 对于残留环形或未访问到的节点做兜底
    for (const id of validNodesMap.keys()) {
        if (!layers.has(id)) {
            layers.set(id, 0);
        }
    }

    // 构建完整节点结构
    const nodes: ComfyFlowNodeData[] = [];
    const layerBuckets = new Map<number, ComfyFlowNodeData[]>();

    const NODE_WIDTH = 250;
    const LAYER_GAP_X = 100;
    const NODE_GAP_Y = 32;

    for (const [id, nodeInfo] of validNodesMap.entries()) {
        const { classType, inputs, title } = nodeInfo;
        const { category, modelType } = classifySlot(title, classType);
        if (category !== "general") {
            detectedSlotsCount++;
        }

        let nodeLayer = layers.get(id) || 0;
        // 如果是最终输出节点，将其推至最右侧层级，使 SaveImage 等整齐排在最后
        if (category === "output" && (outgoing.get(id)?.length || 0) === 0) {
            nodeLayer = Math.max(nodeLayer, maxLayer + 1);
        }

        const connectedInputs: { key: string; fromNodeId: string; fromSlot: number }[] = [];
        const literalInputs: { key: string; value: unknown }[] = [];
        const inputPorts: ComfyNodePort[] = [];

        for (const [key, val] of Object.entries(inputs)) {
            if (
                Array.isArray(val) &&
                val.length === 2 &&
                (typeof val[0] === "string" || typeof val[0] === "number") &&
                typeof val[1] === "number" &&
                validNodesMap.has(String(val[0]))
            ) {
                connectedInputs.push({ key, fromNodeId: String(val[0]), fromSlot: val[1] });
                inputPorts.push({
                    id: `${id}-in-${key}`,
                    name: key,
                    type: inferDataType(classType, 0, key),
                    isConnected: true,
                });
            } else {
                literalInputs.push({ key, value: val });
                // 关键字面量也作为可选端口展现
                inputPorts.push({
                    id: `${id}-in-${key}`,
                    name: key,
                    type: inferDataType(classType, 0, key),
                    isConnected: false,
                });
            }
        }

        // 输出端口根据该节点被下游引用的 slotIndex 生成，至少保留 slot 0
        const outSlotsSet = usedOutputSlots.get(id) || new Set<number>();
        const maxOutSlot = outSlotsSet.size > 0 ? Math.max(...outSlotsSet) : 0;
        const outputPorts: ComfyNodePort[] = [];
        const knownTypes = KNOWN_OUTPUT_TYPES[classType] || [];

        // 只有非最终 Save 节点才强制有输出端口
        if (category !== "output" || outSlotsSet.size > 0) {
            for (let s = 0; s <= maxOutSlot; s++) {
                const portName = knownTypes[s] || (s === 0 ? "output" : `out_${s}`);
                outputPorts.push({
                    id: `${id}-out-${s}`,
                    name: portName,
                    type: knownTypes[s] || inferDataType(classType, s),
                    slotIndex: s,
                    isConnected: outSlotsSet.has(s),
                });
            }
        }

        // 计算节点自适应高度
        const portRowsCount = Math.max(inputPorts.length, outputPorts.length, 1);
        // 最多展示前 3 个常用字面量摘要
        const previewLiteralCount = Math.min(literalInputs.length, 3);
        const baseHeight = 56;
        const portHeight = portRowsCount * 22;
        const literalHeight = previewLiteralCount > 0 ? previewLiteralCount * 18 + 10 : 0;
        const calculatedHeight = Math.max(76, baseHeight + portHeight + literalHeight);

        const nodeData: ComfyFlowNodeData = {
            id,
            classType,
            title: title || classType,
            slotTitle: title,
            slotCategory: category,
            modelType,
            inputs,
            connectedInputs,
            literalInputs,
            inputPorts,
            outputPorts,
            x: 0,
            y: 0,
            width: NODE_WIDTH,
            height: calculatedHeight,
            layer: nodeLayer,
        };

        nodes.push(nodeData);

        if (!layerBuckets.has(nodeLayer)) {
            layerBuckets.set(nodeLayer, []);
        }
        layerBuckets.get(nodeLayer)!.push(nodeData);
    }

    // 计算 X 轴和 Y 轴坐标（层级对齐与垂直居中布局）
    let currentX = 60;
    const sortedLayers = Array.from(layerBuckets.keys()).sort((a, b) => a - b);

    // 计算最高层的总高度，使各列纵向垂直居中
    let maxColumnHeight = 0;
    for (const layer of sortedLayers) {
        const bucket = layerBuckets.get(layer)!;
        const colHeight = bucket.reduce((sum, n) => sum + n.height + NODE_GAP_Y, 0) - NODE_GAP_Y;
        if (colHeight > maxColumnHeight) maxColumnHeight = colHeight;
    }

    let minX = currentX;
    let minY = 60;
    let maxX = currentX;
    let maxY = 60;

    for (const layer of sortedLayers) {
        const bucket = layerBuckets.get(layer)!;
        const colHeight = bucket.reduce((sum, n) => sum + n.height + NODE_GAP_Y, 0) - NODE_GAP_Y;
        let startY = 60 + Math.max(0, (maxColumnHeight - colHeight) / 2);

        for (const node of bucket) {
            node.x = currentX;
            node.y = startY;

            // 计算该节点端口在世界坐标系下的位置
            const headerOffset = 48;
            const pinStep = 22;

            node.inputPorts.forEach((port, idx) => {
                port.x = node.x;
                port.y = node.y + headerOffset + idx * pinStep + 10;
            });

            node.outputPorts.forEach((port, idx) => {
                port.x = node.x + node.width;
                port.y = node.y + headerOffset + idx * pinStep + 10;
            });

            if (node.y + node.height > maxY) maxY = node.y + node.height;
            startY += node.height + NODE_GAP_Y;
        }

        if (currentX + NODE_WIDTH > maxX) maxX = currentX + NODE_WIDTH;
        currentX += NODE_WIDTH + LAYER_GAP_X;
    }

    return {
        nodes,
        edges,
        bounds: {
            minX,
            minY,
            maxX,
            maxY,
            width: Math.max(maxX - minX + 120, 800),
            height: Math.max(maxY - minY + 120, 600),
        },
        stats: {
            totalNodes: nodes.length,
            totalEdges: edges.length,
            detectedSlots: detectedSlotsCount,
        },
    };
}
