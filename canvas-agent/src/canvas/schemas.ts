import { z } from "zod";

const recordSchema = z.record(z.unknown());
/** 机位：方位角/仰角/距离/视线高度/等效焦距（与插件 StageCamera 一致）。 */
const stageCameraSchema = z.object({
    azimuthDeg: z.number().optional(),
    elevationDeg: z.number().optional(),
    distance: z.number().optional(),
    targetY: z.number().optional(),
    focalMm: z.number().optional(),
});
const positionSchema = z.object({ x: z.number(), y: z.number() });
const viewportSchema = z.object({ x: z.number(), y: z.number(), k: z.number() });
const nodeTypeSchema = z.enum(["image", "text", "config", "video", "audio"]);
const generationModeSchema = z.enum(["text", "image", "video"]);

/** Canvas Agent 对外提供的工具名称。 */
export const toolNames = [
    "site_navigate",
    "canvas_open",
    "canvas_list_projects",
    "canvas_get_state",
    "canvas_get_selection",
    "canvas_export_snapshot",
    "canvas_apply_ops",
    "canvas_create_node",
    "canvas_create_attachment_nodes",
    "canvas_create_text_node",
    "canvas_create_text_nodes",
    "canvas_create_config_node",
    "canvas_create_image_prompt_flow",
    "canvas_create_generation_flow",
    "canvas_generate_text",
    "canvas_generate_image",
    "canvas_generate_video",
    "canvas_generate_audio",
    "canvas_update_node",
    "canvas_update_node_text",
    "canvas_move_nodes",
    "canvas_resize_node",
    "canvas_delete_nodes",
    "canvas_connect_nodes",
    "canvas_select_nodes",
    "canvas_set_viewport",
    "canvas_run_generation",
    "canvas_director_stage",
    "generation_get_status",
    "workbench_image_get_config",
    "workbench_image_generate",
    "workbench_video_get_config",
    "workbench_video_generate",
    "prompts_search",
    "assets_list",
    "assets_add",
] as const;
export type ToolName = (typeof toolNames)[number];

export const canvasOpSchema = z.discriminatedUnion("type", [
    z.object({ type: z.literal("add_node"), nodeType: nodeTypeSchema.optional(), id: z.string().optional(), title: z.string().optional(), x: z.number().optional(), y: z.number().optional(), width: z.number().optional(), height: z.number().optional(), position: positionSchema.optional(), metadata: recordSchema.optional() }).passthrough(),
    z.object({ type: z.literal("update_node"), id: z.string(), patch: recordSchema.optional(), metadata: recordSchema.optional() }).passthrough(),
    z.object({ type: z.literal("delete_node"), id: z.string().optional(), ids: z.array(z.string()).optional() }).passthrough(),
    z.object({ type: z.literal("delete_connections"), id: z.string().optional(), ids: z.array(z.string()).optional(), all: z.boolean().optional() }).passthrough(),
    z.object({ type: z.literal("connect_nodes"), id: z.string().optional(), fromNodeId: z.string(), toNodeId: z.string() }).passthrough(),
    z.object({ type: z.literal("set_viewport"), viewport: viewportSchema }).passthrough(),
    z.object({ type: z.literal("select_nodes"), ids: z.array(z.string()) }).passthrough(),
    z.object({ type: z.literal("run_generation"), nodeId: z.string(), mode: generationModeSchema.optional(), prompt: z.string().optional() }).passthrough(),
]);

const textNodeSchema = z.object({
    text: z.string(),
    title: z.string().optional(),
    x: z.number().optional(),
    y: z.number().optional(),
    width: z.number().optional(),
    height: z.number().optional(),
});

const generationOptionsSchema = z.object({
    model: z.string().optional(),
    size: z.string().optional(),
    quality: z.string().optional(),
    count: z.number().optional(),
    seconds: z.string().optional(),
    vquality: z.string().optional(),
    generateAudio: z.string().optional(),
    watermark: z.string().optional(),
    audioVoice: z.string().optional(),
    audioFormat: z.string().optional(),
    audioSpeed: z.string().optional(),
    audioInstructions: z.string().optional(),
});

const generationFlowSchema = z.object({
    prompt: z.string(),
    title: z.string().optional(),
    x: z.number().optional(),
    y: z.number().optional(),
    referenceNodeIds: z.array(z.string()).optional(),
});

export const toolInputSchemas = {
    site_navigate: z.object({ path: z.string().default("/") }),
    canvas_open: z.object({ mode: z.enum(["new", "recent", "choose"]).optional().default("new"), url: z.string().optional() }),
    canvas_list_projects: z.object({ keyword: z.string().optional(), page: z.number().optional(), pageSize: z.number().optional() }),
    canvas_get_state: z.object({}).passthrough(),
    canvas_get_selection: z.object({}).passthrough(),
    canvas_export_snapshot: z.object({}).passthrough(),
    canvas_apply_ops: z.object({ ops: z.array(canvasOpSchema) }),
    canvas_create_node: z.object({ nodeType: nodeTypeSchema, title: z.string().optional(), x: z.number().optional(), y: z.number().optional(), width: z.number().optional(), height: z.number().optional(), metadata: recordSchema.optional() }),
    canvas_create_attachment_nodes: z.object({ attachmentIds: z.array(z.string()).min(1), x: z.number().optional(), y: z.number().optional(), gap: z.number().optional(), direction: z.enum(["row", "column"]).optional() }),
    canvas_create_text_node: z.object({ text: z.string().optional(), x: z.number().optional(), y: z.number().optional(), title: z.string().optional(), width: z.number().optional(), height: z.number().optional() }),
    canvas_create_text_nodes: z.object({ items: z.array(textNodeSchema).min(1), x: z.number().optional(), y: z.number().optional(), gap: z.number().optional(), direction: z.enum(["row", "column"]).optional() }),
    canvas_create_config_node: z.object({ prompt: z.string().optional(), mode: generationModeSchema.optional(), title: z.string().optional(), x: z.number().optional(), y: z.number().optional(), width: z.number().optional(), height: z.number().optional(), autoRun: z.boolean().optional() }).merge(generationOptionsSchema),
    canvas_create_image_prompt_flow: z.object({ prompt: z.string(), x: z.number().optional(), y: z.number().optional(), autoRun: z.boolean().optional() }).merge(generationOptionsSchema),
    canvas_create_generation_flow: generationFlowSchema.extend({ mode: generationModeSchema.optional(), autoRun: z.boolean().optional() }).merge(generationOptionsSchema),
    canvas_generate_text: generationFlowSchema.merge(generationOptionsSchema),
    canvas_generate_image: generationFlowSchema.merge(generationOptionsSchema),
    canvas_generate_video: generationFlowSchema.merge(generationOptionsSchema),
    canvas_generate_audio: generationFlowSchema.merge(generationOptionsSchema),
    canvas_update_node: z.object({ id: z.string(), patch: recordSchema.optional(), metadata: recordSchema.optional() }),
    canvas_update_node_text: z.object({ id: z.string(), text: z.string(), title: z.string().optional() }),
    canvas_move_nodes: z.object({ items: z.array(z.object({ id: z.string(), x: z.number().optional(), y: z.number().optional(), dx: z.number().optional(), dy: z.number().optional() })).min(1) }),
    canvas_resize_node: z.object({ id: z.string(), width: z.number(), height: z.number(), freeResize: z.boolean().optional() }),
    canvas_delete_nodes: z.object({ ids: z.array(z.string()).min(1) }),
    canvas_connect_nodes: z.object({ connections: z.array(z.object({ fromNodeId: z.string(), toNodeId: z.string() })).min(1) }),
    canvas_select_nodes: z.object({ ids: z.array(z.string()) }),
    canvas_set_viewport: z.object({ viewport: viewportSchema }),
    canvas_run_generation: z.object({ nodeId: z.string(), mode: generationModeSchema.optional(), prompt: z.string().optional() }),
    // 3D 导演台（本地画布插件 director-stage）：摆位/机位/运镜参数，服务端会归一化后再落到节点 metadata.stageState
    canvas_director_stage: z.object({
        nodeId: z.string().optional(),
        title: z.string().optional(),
        x: z.number().optional(),
        y: z.number().optional(),
        width: z.number().optional(),
        height: z.number().optional(),
        objects: z
            .array(
                z.object({
                    id: z.string().optional(),
                    name: z.string().optional(),
                    kind: z.enum(["person", "prop", "model", "env"]).optional(),
                    assetId: z.string().optional(),
                    // 走位点（blocking）：≥2 个点就按时间轴动起来，与相机关键帧共用同一条时间轴
                    track: z
                        .array(z.object({ x: z.number(), z: z.number(), rotationYDeg: z.number().optional(), holdMs: z.number().optional() }))
                        .optional(),
                    x: z.number().optional(),
                    z: z.number().optional(),
                    rotationYDeg: z.number().optional(),
                    scale: z.number().optional(),
                    visible: z.boolean().optional(),
                }),
            )
            .optional(),
        camera: stageCameraSchema.optional(),
        shots: z.array(z.object({ id: z.string().optional(), name: z.string().optional(), camera: stageCameraSchema.optional(), holdMs: z.number().optional() })).optional(),
        motion: z.object({ durationMs: z.number().optional(), fps: z.number().optional(), easing: z.enum(["linear", "easeInOut"]).optional() }).optional(),
        lighting: z.enum(["day", "night", "indoor", "backlit"]).optional(),
        // 三个"指令型"参数：真正的展开/导出/自检都由插件执行（模板数据只在插件里）
        sceneId: z.string().optional(),
        exportMode: z.enum(["prompt", "current", "firstLast", "multiView", "video"]).optional(),
        check: z.boolean().optional(),
        backdropNodeId: z.string().optional(),
        backdropHideEnvironment: z.boolean().optional(),
        exportFormat: z.enum(["jpeg", "png"]).optional(),
        exportHeight: z.union([z.literal(720), z.literal(1080)]).optional(),
        promptLocale: z.enum(["zh", "en"]).optional(),
    }),
    generation_get_status: z.object({ scope: z.enum(["all", "canvas", "image", "video"]).optional(), taskId: z.string().optional(), nodeIds: z.array(z.string()).optional(), limit: z.number().optional() }),
    workbench_image_get_config: z.object({}).passthrough(),
    workbench_image_generate: z.object({ prompt: z.string(), model: z.string().optional(), quality: z.string().optional(), size: z.string().optional(), count: z.number().optional(), run: z.boolean().optional() }),
    workbench_video_get_config: z.object({}).passthrough(),
    workbench_video_generate: z.object({ prompt: z.string(), model: z.string().optional(), size: z.string().optional(), seconds: z.string().optional(), resolution: z.string().optional(), generateAudio: z.boolean().optional(), watermark: z.boolean().optional(), run: z.boolean().optional() }),
    prompts_search: z.object({ keyword: z.string().optional(), category: z.string().optional(), tags: z.array(z.string()).optional(), page: z.number().optional(), pageSize: z.number().optional() }),
    assets_list: z.object({ kind: z.enum(["all", "text", "image", "video"]).optional(), keyword: z.string().optional(), page: z.number().optional(), pageSize: z.number().optional() }),
    assets_add: z.object({ kind: z.enum(["text", "image"]), title: z.string(), content: z.string().optional(), imageUrl: z.string().optional(), tags: z.array(z.string()).optional(), source: z.string().optional(), note: z.string().optional() }),
} satisfies Record<ToolName, z.AnyZodObject>;

export const toolDescriptions: Record<ToolName, string> = {
    site_navigate: "跳转网站页面。path 可为 / (首页)、/canvas (我的画布)、/canvas/:id (指定画布)、/image (生图工作台)、/video (视频创作台)、/prompts (提示词库)、/assets (我的素材)、/config (配置)。操作画布前若不在画布页，先用本工具打开画布。",
    canvas_open: "在系统默认浏览器中打开 Infinite Canvas 画布，并自动携带本地 Agent 连接凭据。mode 支持 new (新建画布)、recent (最近画布)、choose (项目选择)。若本地服务未启动，会自动唤醒启动本地服务。",
    canvas_list_projects: "列出用户全部画布（仅标题、创建/更新时间、节点数、连线数，不含完整数据），支持 keyword 搜索和 page/pageSize 分页。返回的 id 可配合 site_navigate 跳转到 /canvas/:id 打开对应画布。",
    canvas_get_state: "读取当前网页画布的节点、连线、选区和视口。",
    canvas_get_selection: "读取当前网页画布选中的节点。",
    canvas_export_snapshot: "导出当前画布快照，用于理解布局。",
    canvas_apply_ops: "批量操作当前网页画布。ops 支持 add_node、update_node、delete_node、delete_connections、connect_nodes、set_viewport、select_nodes、run_generation。",
    canvas_create_node: "创建任意类型节点：text、image、config、video、audio。适合创建占位图、媒体占位、配置节点或自定义 metadata 节点。",
    canvas_create_attachment_nodes: "把当前对话中用户上传的图片附件创建成真实画布图片节点。attachmentIds 使用本轮附件清单中的 ID；返回的节点 ID 可传给 canvas_create_generation_flow.referenceNodeIds 作为生成参考图。",
    canvas_create_text_node: "在当前画布创建单个文本节点。",
    canvas_create_text_nodes: "批量创建文本节点，适合生成标题、段落、脚本、说明等内容块。",
    canvas_create_config_node: "创建生成配置节点，可指定 text/image/video 模式和生成参数，可选择立即触发生成。",
    canvas_create_image_prompt_flow: "创建提示词文本节点和图片生成配置节点，并自动连线，可选择立即触发生图。",
    canvas_create_generation_flow: "创建通用生成流程：提示词文本节点、生成配置节点、参考节点连线，可用于文案、生图或视频。",
    canvas_generate_text: "创建通用文本生成流程并立即触发生成。",
    canvas_generate_image: "创建通用图片生成流程并立即触发生成。",
    canvas_generate_video: "创建通用视频生成流程并立即触发生成。",
    canvas_generate_audio: "当前项目尚未支持 ComfyUI 音频生成，调用会返回显式错误。",
    canvas_update_node: "更新节点基础字段或 metadata。",
    canvas_update_node_text: "更新文本节点内容和标题。",
    canvas_move_nodes: "移动一个或多个节点，支持绝对坐标或 dx/dy 偏移。",
    canvas_resize_node: "调整节点尺寸。",
    canvas_delete_nodes: "删除指定节点及相关连线。",
    canvas_connect_nodes: "批量连接节点。",
    canvas_select_nodes: "设置当前选中节点。",
    canvas_set_viewport: "调整画布视口。",
    canvas_director_stage: "创建或更新一个「3D 导演台」节点（本地画布插件 director-stage）：用 objects 摆人物/道具/环境（x/z 单位米，rotationYDeg 朝向，0=面向 +Z），camera 设当前机位，shots 记关键帧机位序列（可带 holdMs 停留），motion 设运镜时长/帧率/缓动。传 nodeId 则更新已有导演台节点（未给的字段保留原值）。两种用法：① 直接给 objects/camera/shots/motion 摆场景；② 传 sceneId 让插件**套用内置场景模板**（推荐先套模板再微调，比从零拼坐标稳得多），模板 id：dialogue-over-shoulder 过肩正反打 / dialogue-external-reverse 外反打 / solo-monologue-push-in 单人独白推近 / hero-low-angle-crane 英雄低角度上摇 / rooftop-lookout-crane 天台摇臂拉起 / tracking-street-walk 横移跟拍 / chase-low-night 雨夜对峙 / group-pan 群像横扫 / product-orbit 静物环绕 / seaside-lookout 海边缓推。sceneId 也可以是用户在导演台里存过的「我的模板」id（节点 metadata.stageTemplateIds 里能读到 id 与名字，套用后会带上用户自己的模型与人物走位）。摆好之后可以传 exportMode 让插件导出（prompt 运镜提示词文本节点 / current 当前机位参考图 / firstLast 首尾帧 / multiView 多视图 / video 运镜视频），导出是异步的，节点与连线会自动出现。objects[].track 可以给人物记走位点（x/z/rotationYDeg/holdMs，≥2 个点就按 motion 的时间轴移动，与相机关键帧同步）。推荐用内置素材（objects[].assetId）而不是裸占位体，素材 id：人物 person-man / person-woman / person-child / person-sitting；道具 prop-table / prop-chair / prop-sofa / prop-box / prop-pillar / prop-door / prop-tree / prop-streetlamp / prop-car；环境 env-room（6m 房间）/ env-street（10m 街道）/ env-terrain（12m 地形）/ env-skyline（远景楼群，放在原点即可 —— 楼群自身已在 z≈-9）。环境类 kind 用 env、放在原点让人物站进去。摆好之后可以再用 canvas_create_node 建参考图/视频节点并连线，或让用户在导演台大窗口里微调。backdropNodeId 可以把画布上某个图片节点（通常是刚生成的环境/空镜）设为导演台的**背景板** —— 导出时人物就合成在真画面里，那张图重新生成后背景板会自动更新；传空串清除。backdropHideEnvironment（默认 true）表示背景板打开时环境类素材不再渲染（真环境就是那张图）。搭完/改完之后可以传 check: true（需要 nodeId）让插件做一次**几何自检** —— 检查主体是否出画、占比是否过小过大、机位是否贴脸、两个物体是否重叠、走位过程是否出画；自检是纯计算，一两秒后用 canvas_get_state 读回该节点 metadata 的 directorStageCheck（含 ok / issues / text），按 text 里的 ✗ 提示调机位或位置后再 check 一次；交付前不要留 ✗ 级问题。",
    canvas_run_generation: "触发指定节点生成（mode 可选 text/image/video），通常用于配置节点或文本/图片/视频节点。",
    generation_get_status: "查询当前活动网页的生成任务状态。默认返回画布、生图工作台和视频工作台最近任务；可用 scope 过滤来源，用 taskId 查询工作台任务，用 nodeIds 查询画布节点。",
    workbench_image_get_config: "读取生图工作台的当前参数和可选项（可用模型、质量、尺寸/宽高比、张数范围），在调用 workbench_image_generate 前先了解可选值。",
    workbench_image_generate: "在生图工作台填入提示词并按需设置 model、quality、size（如 1:1 或 1024x1024）、count，run 默认 true 会自动点击生成按钮。会自动跳转到生图工作台。生成为异步过程，提交后返回 taskId，可用 generation_get_status 查询状态。",
    workbench_video_get_config: "读取视频创作台的当前参数和可选项（可用模型、尺寸/比例、时长、清晰度/分辨率、是否生成声音与水印）。",
    workbench_video_generate: "在视频创作台填入提示词并按需设置 model、size、seconds、resolution、generateAudio、watermark，run 默认 true 会自动点击生成按钮。会自动跳转到视频创作台。生成为异步过程，提交后返回 taskId，可用 generation_get_status 查询状态。",
    prompts_search: "搜索提示词库（第三方提示词合集），支持 keyword、category、tags 过滤和 page/pageSize 分页，返回标题、提示词、分类、标签、封面等。",
    assets_list: "列出用户「我的素材」，支持 kind（text/image/video）过滤、keyword 搜索和 page/pageSize 分页。为控制体积不返回图片/视频原始 data，仅返回封面与元信息。",
    assets_add: "向「我的素材」新增素材。kind=text 时用 content 传文本内容；kind=image 时用 imageUrl 传图片地址或 dataURL。可附带 title、tags、source、note。",
};
