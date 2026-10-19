// three.js 运行时：场景、相机、物体、指针交互与导出渲染。
// 约定（与仓库既有 3D 插件一致）：three 从 CDN 动态加载、不打进 bundle；
// 视口静止不跑渲染循环；容器的 data-canvas-no-zoom / 阻止冒泡由外层负责。
import { assetById, assetRadius, buildAssetGroup } from "./library";
import { lightingPresetById, lightPosition } from "./lighting";
import { eyePosition } from "./prompt";
import { applyCameraToMarker, createCameraMarker, createTrackPath, disposeCameraMarker, setMarkerActive, type CameraMarker } from "./markers";
import { DEFAULT_CAMERA, HUMAN_HEIGHT_M, PROP_SIZE_M, PERSON_RADIUS_M, createStageObject, type StageCamera, type StageObject, type StageObjectKind, type StageState } from "./stage-state";
import { cameraAtTime, cameraFromEyeXZ, poseAtTime } from "./motion";

type ThreeModule = typeof import("three");
type WebGLRenderer = import("three").WebGLRenderer;
type Scene = import("three").Scene;
type PerspectiveCamera = import("three").PerspectiveCamera;
type GridHelper = import("three").GridHelper;
type Texture = import("three").Texture;
type Group = import("three").Group;
type Mesh = import("three").Mesh;
type Object3D = import("three").Object3D;
type BoxHelper = import("three").BoxHelper;

let threePromise: Promise<ThreeModule> | undefined;
function loadThree(): Promise<ThreeModule> {
    if (!threePromise) threePromise = import("three");
    return threePromise;
}

export type CameraPreset = "overShoulder" | "frontal" | "top" | "wide";

const PRESETS: Record<CameraPreset, { elevationDeg: number; distance: number; focalMm: number; azimuthOffsetDeg: number }> = {
    overShoulder: { elevationDeg: 10, distance: 3.4, focalMm: 50, azimuthOffsetDeg: 38 },
    frontal: { elevationDeg: 8, distance: 3.6, focalMm: 35, azimuthOffsetDeg: 0 },
    top: { elevationDeg: 55, distance: 7, focalMm: 24, azimuthOffsetDeg: 0 },
    wide: { elevationDeg: 18, distance: 9, focalMm: 24, azimuthOffsetDeg: 20 },
};

/** 视口加载状态：three 是随插件打包的本地模块，加载失败要给用户一个能看懂的原因，而不是一块黑屏。 */
export type StageStatus = { phase: "loading" } | { phase: "ready" } | { phase: "error"; message: string };

export type StageHandle = {
    setState: (next: StageState, options?: { commit?: boolean }) => void;
    /** 只推相机（运镜预演逐帧调用）：不重建物体、不写回状态，成本最低。 */
    setCamera: (camera: StageCamera) => void;
    /** 预览视角：从外部看场景（不写入保存的机位）；传 null 回到当前机位视角。 */
    setPreviewCamera: (camera: StageCamera | null) => void;
    /** 背景板：传 null 清除（回到灯光背景色）。同一个 nodeId|url 不会重复加载。 */
    setBackdrop: (source: { nodeId: string; url: string } | null) => void;
    /** 播放/导出时传 false，把编辑辅助（选中高亮 + 相机元素）藏起来。 */
    setEditingAidsVisible: (visible: boolean) => void;
    /** 交互/播放中传 true 降一档渲染质量（Retina / 弱 GPU 上明显更顺），结束传 false 恢复。 */
    setRenderQuality: (low: boolean) => void;
    /** 标出"当前选中的机位"（相机元素换强调色），传 null 取消。 */
    setSelectedShot: (shotId: string | null) => void;
    /**
     * 走时间轴：一次应用「相机 = cameraAtTime + 每个物体 = poseAtTime」。
     * 传 null 回到编辑态（相机回到保存的机位、物体回到各自记录的 x/z）。
     */
    setPlayhead: (elapsedMs: number | null) => void;
    /**
     * 逐帧导出用：把指定机位渲染到指定分辨率，**留下该尺寸**（不还原、不转 dataURL），
     * 返回 canvas 本身供编码器直接读像素（比 capture() 省掉每帧一次 JPEG 编码）。
     */
    renderFrame: (options: { height: number; camera: StageCamera; elapsedMs?: number }) => HTMLCanvasElement | null;
    getState: () => StageState;
    setInteractive: (interactive: boolean) => void;
    setSelected: (id: string | null) => void;
    applyPreset: (preset: CameraPreset) => void;
    frameAll: () => void;
    /**
     * 导入模型：给了 objectId 就挂到已有物体上（刷新后重建），否则新建一个物体。
     * 给了 cacheKey（素材库 id）就复用同一份解析结果 —— 同一个素材摆多个物体只解析/上传一次。
     */
    loadModel: (source: { name: string; arrayBuffer: () => Promise<ArrayBuffer> }, options?: { objectId?: string; cacheKey?: string }) => Promise<StageObject>;
    capture: (options: { format: "jpeg" | "png"; height: number; camera?: StageCamera; elapsedMs?: number }) => { dataUrl: string; width: number; height: number } | null;
    dispose: () => void;
};

/** 创建一个导演台视口；onCommit 只在"用户操作结束/状态真正改变"时回调，避免拖拽时刷爆 React。 */
export type StageHandlers = {
    /** 点了场景里的相机元素（关键帧机位）时回调，参数是机位 id。 */
    onPickShot?: (shotId: string) => void;
    /** 按住某个相机元素时回调（用于"选中"反馈）。 */
    onShotPressed?: (shotId: string) => void;
    /** 拖动相机元素调机位：给出新的方位角/距离（其余参数不变）。 */
    onMoveShot?: (shotId: string, camera: StageCamera) => void;
    /** 背景板加载失败（图片读不到）时回调，用于把原因写到状态行 —— 不静默。 */
    onBackdropError?: (message: string) => void;
};

export function createStage(container: HTMLElement, initial: StageState, onCommit: (state: StageState) => void, onStatus?: (status: StageStatus) => void, handlers: StageHandlers = {}): StageHandle {
    let state: StageState = initial;
    let selectedId: string | null = state.objects[0]?.id ?? null;
    let interactive = false;
    let disposed = false;
    let renderer: WebGLRenderer | null = null;
    let scene: Scene | null = null;
    let camera: PerspectiveCamera | null = null;
    let grid: GridHelper | null = null;
    // 背景板贴图（见 backdrop.ts）：有它时 scene.background 用它、不用灯光背景色
    let backdropTexture: Texture | null = null;
    let backdropKey = "";
    let objectsGroup: Group | null = null;
    let groundPlane: Mesh | null = null;
    let frame = 0;
    // 场景构建在 initPromise 里用带类型的局部 THREE;这里的闭包引用保持宽松,
    // 避免每处使用都得先判空。
    onStatus?.({ phase: "loading" });
    // 闭包引用也用真类型：three 的 API 用错（例如给 getSize 传普通对象）在 tsc 阶段就能发现。
    // 使用处一律先 `const t = three; if (!t) return;` 收窄。
    let three: ThreeModule | null = null;
    /** 预览相机：从外部看场景时用它渲染，不写入保存的机位（null = 从当前机位看）。 */
    let previewCamera: StageCamera | null = null;
    /** 播放用相机：走时间轴时临时覆盖，绝不动 state（state 与编辑器共享同一个对象）。 */
    let playbackCamera: StageCamera | null = null;
    /** 播放/导出时把编辑辅助（选中高亮 + 相机元素）藏起来。 */
    let aidsVisible = true;
    let ambientLight: import("three").HemisphereLight | null = null;
    let keyLight: import("three").DirectionalLight | null = null;
    let fillLight: import("three").DirectionalLight | null = null;
    let markersGroup: Group | null = null;
    let shotMarkers: CameraMarker[] = [];
    let shotMarkerSignature = "";
    let currentMarker: CameraMarker | null = null;
    let trackPaths: Group | null = null;
    let trackPathSignature = "";
    const meshes = new Map<string, Group>();
    const models = new Map<string, Object3D>();
    // 按素材库 id 缓存"已解析并归一化"的模型原型（多物体 clone 复用，见 loadModel）
    const modelCache = new Map<string, Object3D>();
    const highlight: { box: BoxHelper | null; target: string | null } = { box: null, target: null };
    // 拖拽状态：拖空场景=环绕，拖到物体上=在地面移动
    let drag: { mode: "orbit" | "move"; x: number; y: number; objectId?: string; offsetX?: number; offsetZ?: number } | null = null;
    /** 按下时命中的相机标记：抬手没怎么动就当成"点这台相机"。 */
    let pendingShotPick: string | null = null;
    /** 正在拖动某个机位的相机元素：按地面位移换算方位角与距离。 */
    let draggingShot: { id: string; ground: { x: number; z: number } | null; eye: { x: number; z: number }; x: number; y: number } | null = null;

    const BASE_PIXEL_RATIO = 1.5;
    const basePixelRatio = () => Math.min(window.devicePixelRatio || 1, BASE_PIXEL_RATIO);

    /** 交互（拖拽 / 播放）时降分辨率换流畅；结束回到基准。导出会另外强制 1:1。 */
    const setInteractiveQuality = (low: boolean) => {
        if (!renderer) return;
        const target = low ? 1 : basePixelRatio();
        if (Math.abs((renderer.getPixelRatio?.() ?? 1) - target) < 0.01) return;
        renderer.setPixelRatio(target);
        requestRender();
    };

    const requestRender = () => {
        if (disposed || frame) return;
        frame = window.requestAnimationFrame(() => {
            frame = 0;
            renderScene();
        });
    };

    const commit = () => {
        // 预览视角 / 播放中的转视角只是"看"，不该覆盖用户保存的机位
        if (previewCamera || playbackCamera) return;
        onCommit({ ...state, objects: state.objects.map((object) => ({ ...object })), camera: { ...state.camera } });
    };

    /**
     * 把物体摆到某时刻的走位（elapsedMs 为 null = 回到编辑态的位置）。
     * 只改 transform、不做 traverse，逐帧调用也很便宜。
     */
    const applyPoses = (elapsedMs: number | null) => {
        for (const object of state.objects) {
            const group = meshes.get(object.id);
            if (!group) continue;
            const pose = elapsedMs === null || !object.track ? null : poseAtTime(object.track, state.motion, elapsedMs);
            group.position.set(pose ? pose.x : object.x, 0, pose ? pose.z : object.z);
            group.rotation.y = ((pose ? pose.rotationYDeg : object.rotationYDeg) * Math.PI) / 180;
        }
    };

    /** 按当前灯光预设摆灯 + 定背景色（导出的是同一场景，所以参考图也吃这套灯）。 */
    const applyLighting = () => {
        const preset = lightingPresetById(state.lighting);
        if (keyLight && fillLight && ambientLight) {
            keyLight.position.set(...lightPosition(preset.key));
            keyLight.intensity = preset.key.intensity;
            keyLight.color.set(preset.key.color);
            fillLight.position.set(...lightPosition(preset.fill));
            fillLight.intensity = preset.fill.intensity;
            fillLight.color.set(preset.fill.color);
            ambientLight.intensity = preset.ambient.intensity;
            ambientLight.color.set(preset.ambient.sky);
            ambientLight.groundColor.set(preset.ambient.ground);
        }
        // 背景板优先于灯光背景色：有背景板时它就是"环境"
        if (scene && three) scene.background = backdropTexture ?? new three.Color(preset.background);
    };

    // --- 相机 ---
    const applyCameraValues = (cam: StageCamera) => {
        if (!camera) return;
        const { azimuthDeg, elevationDeg, distance, targetY, focalMm } = cam;
        const az = (azimuthDeg * Math.PI) / 180;
        const el = (elevationDeg * Math.PI) / 180;
        const horizontal = Math.cos(el) * distance;
        camera.position.set(Math.sin(az) * horizontal, targetY + Math.sin(el) * distance, Math.cos(az) * horizontal);
        camera.lookAt(0, targetY, 0);
        camera.fov = (2 * Math.atan(24 / (2 * Math.max(1, focalMm))) * 180) / Math.PI;
        camera.updateProjectionMatrix();
    };
    /** 视口当前用哪台相机渲染：预览视角优先，否则就是保存的当前机位。 */
    const activeCamera = (): StageCamera => playbackCamera || previewCamera || state.camera;
    const applyCamera = () => applyCameraValues(activeCamera());

    // --- 物体 ---
    const buildObjectMesh = (t: ThreeModule, object: StageObject) => {
        // 内置素材：直接按素材目录拼（人物/道具/环境），不再走占位体
        const asset = assetById(object.assetId);
        if (asset && object.kind !== "model") {
            const group = buildAssetGroup(t, asset);
            addContactShadow(t, group, assetRadius(asset), asset.shadow !== "none");
            return group;
        }
        const material = new t.MeshStandardMaterial({ color: object.kind === "person" ? 0xb9c2cf : object.kind === "prop" ? 0xcfa98a : 0xa8b6a1, roughness: 0.85, metalness: 0.05 });
        const group = new t.Group();
        if (object.kind === "model" && models.has(object.id)) {
            const model = models.get(object.id);
            if (model) group.add(model);
        } else if (object.kind === "prop") {
            const cube = new t.Mesh(new t.BoxGeometry(PROP_SIZE_M, PROP_SIZE_M, PROP_SIZE_M), material);
            cube.position.y = PROP_SIZE_M / 2;
            group.add(cube);
        } else {
            // 占位人形：胶囊身体 + 头球 + 朝向指示的小鼻子，便于判断"面向谁"
            const body = new t.Mesh(new t.CapsuleGeometry(PERSON_RADIUS_M, HUMAN_HEIGHT_M - PERSON_RADIUS_M * 2 - 0.34, 6, 12), material);
            body.position.y = HUMAN_HEIGHT_M / 2 - 0.05;
            const head = new t.Mesh(new t.SphereGeometry(0.17, 16, 12), material);
            head.position.y = HUMAN_HEIGHT_M - 0.17;
            const nose = new t.Mesh(new t.SphereGeometry(0.05, 8, 6), new t.MeshStandardMaterial({ color: 0xef6b6b }));
            nose.position.set(0, HUMAN_HEIGHT_M - 0.17, 0.17);
            group.add(body, head, nose);
        }
        // 接地阴影：只用一个半透明圆片，成本低但空间关系清楚很多
        addContactShadow(t, group, object.kind === "prop" ? PROP_SIZE_M * 0.75 : PERSON_RADIUS_M * 1.5);
        group.traverse((child: any) => {
            if (child.isMesh) child.userData.objectId = object.id;
        });
        return group;
    };

    /** 只更新一个物体的变换（拖拽时用；比整体 syncObjects 便宜，且顺带把高亮框跟上）。 */
    const applyObjectTransform = (object: StageObject) => {
        const group = meshes.get(object.id);
        if (!group) return;
        group.position.set(object.x, 0, object.z);
        group.rotation.y = (object.rotationYDeg * Math.PI) / 180;
        group.scale.setScalar(object.scale);
        if (highlight.box && highlight.target === object.id) highlight.box.setFromObject(group);
    };

    /** 接地阴影圆片：半径按素材/占位体给，环境类（房间/路面）通常不需要。 */
    const addContactShadow = (t: ThreeModule, group: Group, radius: number, enabled = true) => {
        if (!enabled) return;
        const shadow = new t.Mesh(new t.CircleGeometry(Math.max(0.2, radius), 22), new t.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.22 }));
        shadow.rotation.x = -Math.PI / 2;
        shadow.position.y = 0.004;
        group.add(shadow);
    };

    const syncObjects = () => {
        const t = three;
        if (!t || !objectsGroup) return;
        for (const object of state.objects) {
            let group = meshes.get(object.id);
            if (!group) {
                group = buildObjectMesh(t, object);
                objectsGroup.add(group);
                meshes.set(object.id, group);
            }
            // 背景板打开时环境类素材不渲染（真环境就是那张图）；只影响渲染与导出，不动 state.visible
            const hiddenByBackdrop = Boolean(state.backdrop?.nodeId) && state.backdrop?.hideEnvironment !== false && object.kind === "env";
            group.visible = object.visible && !hiddenByBackdrop;
            group.position.set(object.x, 0, object.z);
            group.rotation.y = (object.rotationYDeg * Math.PI) / 180;
            group.scale.setScalar(object.scale);
            group.traverse((child: any) => {
                if (child.isMesh) child.userData.objectId = object.id;
            });
        }
        for (const [id, group] of meshes) {
            if (!state.objects.some((object) => object.id === id)) {
                objectsGroup.remove(group);
                meshes.delete(id);
            }
        }
        syncHighlight();
        requestRender();
    };

    const syncHighlight = () => {
        const t = three;
        if (!t || !objectsGroup || !scene) return;
        const target = selectedId && state.objects.some((object) => object.id === selectedId) ? meshes.get(selectedId) : null;
        if (!target) {
            if (highlight.box) {
                highlight.box.visible = false;
            }
            return;
        }
        if (!highlight.box) {
            highlight.box = new t.BoxHelper(target, 0x2f80ff);
            highlight.box.material.depthTest = false;
            highlight.box.material.transparent = true;
            highlight.box.material.opacity = 0.9;
            scene.add(highlight.box);
        }
        highlight.box.setFromObject(target);
        highlight.box.visible = true;
    };

    /**
     * 场景里的相机元素：每个关键帧机位一台（灰色 + 编号名），当前机位单独一台（蓝色）。
     * 机位没变就只更新当前机位那一台，避免每帧重建几何。
     */
    const syncCameraMarkers = () => {
        const t = three;
        if (!t || !scene) return;
        if (!markersGroup) {
            markersGroup = new t.Group();
            scene.add(markersGroup);
        }
        // 只看"有哪些机位、叫什么"，不看机位参数：拖动相机元素时靠下面的 applyCameraToMarker 更新变换，
        // 否则每拖一下都会重建几何 + 重画标签贴图（明显掉帧）。
        const signature = state.shots.map((shot) => `${shot.id}:${shot.name}`).join("|");
        if (signature !== shotMarkerSignature) {
            shotMarkerSignature = signature;
            for (const marker of shotMarkers) {
                markersGroup.remove(marker.group);
                disposeCameraMarker(marker);
            }
            shotMarkers = state.shots.map((shot, index) => {
                const marker = createCameraMarker(t, { camera: shot.camera, color: 0xd7dee8, label: `${index + 1} ${shot.name}`.slice(0, 14), shotId: shot.id });
                markersGroup!.add(marker.group);
                applyCameraToMarker(marker, shot.camera);
                return marker;
            });
        } else {
            // 数量没变就只更新变换（拖动/滑块调机位时走这里）
            state.shots.forEach((shot, index) => {
                const marker = shotMarkers[index];
                if (marker) applyCameraToMarker(marker, shot.camera);
            });
        }
        if (!currentMarker) {
            currentMarker = createCameraMarker(t, { camera: state.camera, color: 0x2f80ff, label: "当前机位" });
            markersGroup.add(currentMarker.group);
        }
        applyCameraToMarker(currentMarker, state.camera);
        syncTrackPaths();
    };

    /**
     * 走位路径：每个有走位的物体画一条地面折线（带落点与朝向箭头），选中那条用强调色。
     * 只在走位或选中项变化时重建。
     */
    const syncTrackPaths = () => {
        const t = three;
        if (!t || !scene || !markersGroup) return;
        const movers = state.objects.filter((object) => (object.track || []).length >= 2);
        const signature = `${selectedId}|${movers.map((object) => `${object.id}:${(object.track || []).map((pose) => `${pose.x},${pose.z},${pose.rotationYDeg}`).join("/")}`).join("|")}`;
        if (signature === trackPathSignature) return;
        trackPathSignature = signature;

        if (trackPaths) {
            markersGroup.remove(trackPaths);
            trackPaths.traverse((child: unknown) => {
                const node = child as { geometry?: { dispose?: () => void }; material?: { dispose?: () => void } };
                node.geometry?.dispose?.();
                node.material?.dispose?.();
            });
            trackPaths = null;
        }
        if (!movers.length) return;
        trackPaths = new t.Group();
        for (const object of movers) {
            trackPaths.add(createTrackPath(t, object.track || [], object.id === selectedId ? 0x2f80ff : 0x9aa4b2));
        }
        markersGroup.add(trackPaths);
    };

    /**
     * 截图/逐帧导出时临时隐藏编辑辅助（选中高亮 + 相机元素）。
     * 那个蓝色 BoxHelper 是编辑辅助，混进参考图/参考视频里就是一个框框跟着人物跑；
     * 它只在同一帧的渲染前后生效，编辑态的显示不受影响。
     */
    const renderScene = (options: { hideAids?: boolean } = {}) => {
        if (!renderer || !scene || !camera) return;
        const box = highlight.box;
        const hide = options.hideAids || !aidsVisible;
        // 站在当前机位上看时，自己那台相机标记正好在镜头里（镜头圆筒和标签会糊在画面上），从内部看时藏掉它；
        // 切到自由视角（外部）时再显示，此时它才是"我在哪"的参照物。
        const hideSelfMarker = !previewCamera && currentMarker;
        const restore: Array<() => void> = [];
        const hideFor = (object: { visible: boolean } | null | undefined) => {
            if (!object) return;
            const was = object.visible;
            object.visible = false;
            restore.push(() => {
                object.visible = was;
            });
        };
        if (hide) {
            hideFor(box);
            hideFor(markersGroup);
        } else {
            hideFor(hideSelfMarker ? currentMarker!.group : null);
        }
        try {
            renderer.render(scene, camera);
        } finally {
            for (const fn of restore) fn();
        }
    };

    /** 导出（截图 / 逐帧）用：一定不带编辑辅助。 */
    const renderWithoutHighlight = () => renderScene({ hideAids: true });

    // --- 指针交互 ---
    const pointerToGround = (event: PointerEvent) => {
        const t = three;
        if (!t || !renderer || !camera || !objectsGroup || !groundPlane) return null;
        const rect = renderer.domElement.getBoundingClientRect();
        const pointer = new t.Vector2(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
        const raycaster = new t.Raycaster();
        raycaster.setFromCamera(pointer, camera);
        const hits = raycaster.intersectObjects(objectsGroup.children, true).filter((hit: any) => hit.object.visible);
        const ground = raycaster.intersectObject(groundPlane, false)[0];
        const markerHit = markersGroup ? raycaster.intersectObjects(markersGroup.children, true).find((hit: any) => hit.object.visible) : undefined;
        const shotId = markerHit ? (markerHit.object.userData?.shotId as string | undefined) : undefined;
        return { hits, ground, shotId };
    };

    const onPointerDown = (event: PointerEvent) => {
        if (!interactive || event.button !== 0 || !renderer) return;
        event.preventDefault();
        event.stopPropagation();
        renderer.domElement.setPointerCapture?.(event.pointerId);
        const picked = pointerToGround(event);
        if (!picked) return;
        const { hits, ground, shotId } = picked;
        if (shotId) {
            // 点在相机元素上：先记为"待定"，抬手时若没怎么动 = 切到那台机位，动了 = 拖动调整该机位
            pendingShotPick = shotId;
            handlers.onShotPressed?.(shotId);
            if (renderer) renderer.domElement.style.cursor = "grabbing";
            if (handlers.onMoveShot) {
                const shot = state.shots.find((item) => item.id === shotId);
                if (shot) {
                    const eye = eyePosition(shot.camera);
                    draggingShot = { id: shotId, ground: ground?.point ?? null, eye: { x: eye.x, z: eye.z }, x: event.clientX, y: event.clientY };
                    setInteractiveQuality(true);
                }
            }
            return;
        }
        pendingShotPick = null;
        const hitObjectId = hits.find((hit: any) => hit.object.userData.objectId)?.object.userData.objectId as string | undefined;
        if (hitObjectId) {
            // 拖到物体上就直接在地面移动它（未选中时先选中），不用"先点一下再拖"两步。
            if (hitObjectId !== selectedId) {
                selectedId = hitObjectId;
                syncHighlight();
                requestRender();
            }
            const object = state.objects.find((item) => item.id === hitObjectId);
            if (ground) {
                drag = { mode: "move", x: event.clientX, y: event.clientY, objectId: hitObjectId, offsetX: ground.point.x - (object?.x ?? 0), offsetZ: ground.point.z - (object?.z ?? 0) };
                return;
            }
            // 射线擦到物体却没落到地面（极端视角）：保留选中，退化成环绕，不要反手清空选择。
            drag = { mode: "orbit", x: event.clientX, y: event.clientY };
            return;
        }
        selectedId = null;
        syncHighlight();
        drag = { mode: "orbit", x: event.clientX, y: event.clientY };
        requestRender();
    };

    const onPointerMove = (event: PointerEvent) => {
        if (!drag && !draggingShot && interactive && renderer) {
            // 悬停在相机元素上时换成"手型"（否则看不出这里可以点/拖），离开再换回去
            const wantCursor = pointerToGround(event)?.shotId ? "pointer" : "grab";
            if (renderer.domElement.style.cursor !== wantCursor) renderer.domElement.style.cursor = wantCursor;
        }
        if (draggingShot) {
            event.preventDefault();
            event.stopPropagation();
            if (!draggingShot.ground) return;
            const ground = pointerToGround(event)?.ground;
            if (!ground) return;
            const shot = state.shots.find((item) => item.id === draggingShot!.id);
            if (!shot) return;
            // 眼睛跟着"光标在地面上的位移"走，再换算回方位角 + 距离（高度角/焦距/视线高度不变）
            const deltaX = ground.point.x - draggingShot.ground.x;
            const deltaZ = ground.point.z - draggingShot.ground.z;
            handlers.onMoveShot?.(draggingShot.id, cameraFromEyeXZ(draggingShot.eye.x + deltaX, draggingShot.eye.z + deltaZ, shot.camera));
            return;
        }
        if (!drag) return;
        event.preventDefault();
        event.stopPropagation();
        const dx = event.clientX - drag.x;
        const dy = event.clientY - drag.y;
        drag.x = event.clientX;
        drag.y = event.clientY;
        if (drag.mode === "orbit") {
            const view = activeCamera();
            view.azimuthDeg = view.azimuthDeg - dx * 0.4;
            view.elevationDeg = Math.max(-20, Math.min(80, view.elevationDeg + dy * 0.3));
            applyCamera();
        } else if (drag.objectId) {
            const ground = pointerToGround(event)?.ground;
            if (ground) {
                const object = state.objects.find((item) => item.id === drag?.objectId);
                if (object) {
                    object.x = Math.max(-12, Math.min(12, ground.point.x - (drag.offsetX ?? 0)));
                    object.z = Math.max(-12, Math.min(12, ground.point.z - (drag.offsetZ ?? 0)));
                    // 拖拽期间只动这一个物体（原来每帧整体 syncObjects，物体多时明显掉帧）
                    applyObjectTransform(object);
                }
            }
        }
        requestRender();
    };

    const endDrag = (event: PointerEvent) => {
        if (draggingShot) {
            const moved = Math.hypot(event.clientX - draggingShot.x, event.clientY - draggingShot.y);
            const shotId = draggingShot.id;
            draggingShot = null;
            pendingShotPick = null;
            setInteractiveQuality(false);
            if (renderer) renderer.domElement.style.cursor = "grab";
            commit();
            // 没怎么动 = 点选（切到那台机位）；动了 = 刚才是拖动调整
            if (moved < 4) handlers.onPickShot?.(shotId);
            return;
        }
        if (pendingShotPick) {
            const shotId = pendingShotPick;
            pendingShotPick = null;
            handlers.onPickShot?.(shotId);
            return;
        }
        if (!drag || !renderer) return;
        event.stopPropagation();
        renderer.domElement.releasePointerCapture?.(event.pointerId);
        drag = null;
        commit();
    };

    let wheelTimer = 0;
    const onWheel = (event: WheelEvent) => {
        if (!interactive) return;
        event.preventDefault();
        event.stopPropagation();
        const view = activeCamera();
        view.focalMm = Math.max(14, Math.min(135, view.focalMm + (event.deltaY > 0 ? -2 : 2)));
        applyCamera();
        requestRender();
        window.clearTimeout(wheelTimer);
        wheelTimer = window.setTimeout(commit, 300);
    };

    let resizeObserver: ResizeObserver | null = null;

    loadThree()
        .then((THREE) => {
            if (disposed) return;
            three = THREE;
            scene = new THREE.Scene();
            camera = new THREE.PerspectiveCamera(35, 1, 0.1, 400);
            // 不指定 powerPreference：GPU 不稳的环境里争抢独显反而容易创建上下文失败，用默认即可。
            renderer = new THREE.WebGLRenderer({ antialias: true });
            // 像素比基准封顶 1.5（Retina 上 2x 会让交互明显变重）；交互/播放中再降到 1，松手恢复
            renderer.setPixelRatio(basePixelRatio());
            renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
            renderer.domElement.style.width = "100%";
            renderer.domElement.style.height = "100%";
            renderer.domElement.style.display = "block";
            renderer.domElement.style.cursor = "grab";
            renderer.domElement.style.touchAction = "none";
            container.appendChild(renderer.domElement);

            ambientLight = new THREE.HemisphereLight(0xffffff, 0x333844, 1.1);
            keyLight = new THREE.DirectionalLight(0xffffff, 1.3);
            fillLight = new THREE.DirectionalLight(0xa9c1ff, 0.35);
            scene.add(ambientLight, keyLight, fillLight);
            applyLighting();

            grid = new THREE.GridHelper(24, 24, 0x4b5563, 0x2f3542);
            scene.add(grid);
            groundPlane = new THREE.Mesh(new THREE.PlaneGeometry(48, 48), new THREE.MeshBasicMaterial({ visible: false }));
            groundPlane.rotation.x = -Math.PI / 2;
            scene.add(groundPlane);
            objectsGroup = new THREE.Group();
            scene.add(objectsGroup);

            applyCamera();
            syncObjects();
            syncCameraMarkers();

            const canvas = renderer.domElement;
            canvas.addEventListener("pointerdown", onPointerDown);
            canvas.addEventListener("pointermove", onPointerMove);
            canvas.addEventListener("pointerup", endDrag);
            canvas.addEventListener("pointercancel", endDrag);
            canvas.addEventListener("wheel", onWheel, { passive: false });

            resizeObserver = new ResizeObserver(() => {
                const target = renderer;
                const view = camera;
                if (!target || !view) return;
                const width = Math.max(1, container.clientWidth);
                const height = Math.max(1, container.clientHeight);
                target.setSize(width, height, false);
                view.aspect = width / height;
                view.updateProjectionMatrix();
                requestRender();
            });
            resizeObserver.observe(container);
            requestRender();
            onStatus?.({ phase: "ready" });
        })
        .catch((error: unknown) => {
            if (disposed) return;
            onStatus?.({ phase: "error", message: error instanceof Error ? error.message : String(error) });
        });

    return {
        getState: () => state,
        setState: (next, options) => {
            state = next;
            if (three) {
                applyLighting();
                applyCamera();
                syncObjects();
                syncCameraMarkers();
            }
            if (options?.commit !== false) commit();
        },
        setCamera: (next) => {
            if (previewCamera) previewCamera = { ...next };
            else state.camera = { ...next };
            applyCamera();
            syncCameraMarkers();
            requestRender();
        },
        setBackdrop: (source) => {
            const key = source ? `${source.nodeId}|${source.url}` : "";
            if (key === backdropKey) return;
            backdropKey = key;
            backdropTexture?.dispose?.();
            backdropTexture = null;
            if (!source) {
                applyLighting();
                syncObjects();
                return;
            }
            const image = new Image();
            // 同源（data:/blob:）不需要 CORS；跨域图必须带这个属性才能当 WebGL 贴图
            image.crossOrigin = "anonymous";
            image.onload = () => {
                const t = three;
                if (!t || disposed || backdropKey !== key) return;
                const texture = new t.Texture(image);
                texture.colorSpace = (t as unknown as { SRGBColorSpace?: string }).SRGBColorSpace ?? texture.colorSpace;
                texture.needsUpdate = true;
                backdropTexture = texture;
                applyLighting();
                syncObjects();
                requestRender();
            };
            image.onerror = () => {
                if (disposed || backdropKey !== key) return;
                backdropKey = "";
                handlers?.onBackdropError?.(`背景板加载失败：${source.url.startsWith("blob:") ? "这张图在本地存储里已经找不到了（可能被清理过）" : "读不到这个图片地址（可能是跨域）"}，已退回灯光背景色`);
            };
            image.src = source.url;
        },
        setPreviewCamera: (next) => {
            previewCamera = next ? { ...next } : null;
            applyCamera();
            syncCameraMarkers();
            requestRender();
        },
        setEditingAidsVisible: (next) => {
            aidsVisible = next;
            requestRender();
        },
        setRenderQuality: (low) => setInteractiveQuality(low),
        setPlayhead: (elapsedMs) => {
            if (elapsedMs === null) {
                playbackCamera = null;
                applyPoses(null);
            } else {
                // 预览视角（从外面看）时不覆盖相机，只让人物动 —— 这样能在外面看走位
                if (!previewCamera) {
                    const camera = cameraAtTime(state.shots, state.motion, elapsedMs);
                    playbackCamera = camera ? { ...camera } : null;
                }
                applyPoses(elapsedMs);
            }
            applyCamera();
            syncCameraMarkers();
            requestRender();
        },
        renderFrame: ({ height, camera: frameCamera, elapsedMs }) => {
            if (!renderer || !camera || !scene) return null;
            const width = Math.round((height * 16) / 9);
            // 同上：视频帧尺寸必须等于编码配置里的宽高，否则 WebCodecs 会直接拒绝
            renderer.setPixelRatio?.(1);
            renderer.setSize(width, height, false);
            camera.aspect = width / height;
            applyCameraValues(frameCamera);
            // 逐帧导出：人物也要在动，所以按帧时间摆一次走位
            if (elapsedMs !== undefined) applyPoses(elapsedMs);
            renderWithoutHighlight();
            return renderer.domElement;
        },
        setInteractive: (next) => {
            interactive = next;
            if (renderer) renderer.domElement.style.cursor = next ? "grab" : "default";
        },
        setSelected: (id) => {
            selectedId = id;
            syncHighlight();
            syncTrackPaths();
            requestRender();
        },
        setSelectedShot: (shotId) => {
            shotMarkers.forEach((marker, index) => setMarkerActive(marker, state.shots[index]?.id === shotId));
            requestRender();
        },
        applyPreset: (preset) => {
            const config = PRESETS[preset];
            const anchor = state.objects.find((object) => object.visible && object.kind === "person") || state.objects[0];
            const facing = anchor ? anchor.rotationYDeg : 0;
            state.camera = {
                ...state.camera,
                elevationDeg: config.elevationDeg,
                distance: config.distance,
                focalMm: config.focalMm,
                azimuthDeg: preset === "overShoulder" || preset === "frontal" ? facing + config.azimuthOffsetDeg : state.camera.azimuthDeg,
            };
            if (anchor) {
                state.camera.targetY = Math.min(1.5, HUMAN_HEIGHT_M * 0.55 * anchor.scale);
            }
            applyCamera();
            requestRender();
            commit();
        },
        frameAll: () => {
            const visible = state.objects.filter((object) => object.visible);
            if (!visible.length) return;
            const radius = visible.reduce((max, object) => Math.max(max, Math.hypot(object.x, object.z) + 0.6), 1);
            state.camera.distance = Math.max(3, radius * 2.4);
            state.camera.elevationDeg = 16;
            state.camera.targetY = 0.95;
            applyCamera();
            requestRender();
            commit();
        },
        loadModel: async (source, options) => {
            // 同一个素材（cacheKey = 素材库 id）只解析/上传一次：第二个物体起用 clone 复用
            const cacheKey = options?.cacheKey;
            const cached = cacheKey ? modelCache.get(cacheKey) : undefined;
            let model: any;
            if (cached) {
                // SkeletonUtils.clone 对静态网格等价于 clone(true)，但将来接带动画的 glb 时也是对的
                const { clone } = await import("three/examples/jsm/utils/SkeletonUtils.js");
                model = clone(cached);
            } else {
                const THREE = await loadThree();
                const { GLTFLoader } = await import("three/examples/jsm/loaders/GLTFLoader.js");
                const buffer = await source.arrayBuffer();
                const loader = new GLTFLoader();
                const gltf: any = await new Promise((resolve, reject) => loader.parse(buffer, "", resolve, reject));
                model = gltf.scene as any;
                const box = new THREE.Box3().setFromObject(model);
                const size = new THREE.Vector3();
                box.getSize(size);
                const height = size.y || 1;
                const scale = Math.min(3, 1.8 / height);
                model.scale.setScalar(scale);
                const box2 = new THREE.Box3().setFromObject(model);
                model.position.y -= box2.min.y;
                if (cacheKey) modelCache.set(cacheKey, model);
            }
            const objectId = options?.objectId;
            if (objectId) {
                // 刷新后重建：挂到已有物体上，不改动物体列表。
                // 初始 syncObjects 因为没有模型而先画了占位人形，这里必须把旧 mesh 丢掉让 syncObjects 重建。
                const placeholder = meshes.get(objectId);
                if (placeholder) {
                    objectsGroup?.remove(placeholder);
                    meshes.delete(objectId);
                }
                models.set(objectId, model);
                syncObjects();
                return state.objects.find((item) => item.id === objectId) as StageObject;
            }
            const object = { ...createStageObject("model", source.name.replace(/\.[^.]+$/, ""), 0, 1.2), scale: 1, sourceName: source.name };
            models.set(object.id, model);
            state.objects = [...state.objects, object];
            selectedId = object.id;
            syncObjects();
            commit();
            return object;
        },
        capture: ({ format, height, camera: override, elapsedMs }) => {
            const t = three;
            if (!t || !renderer || !camera || !scene) return null;
            // 导出必须 1:1：pixelRatio 不为 1 时帧缓冲会比目标尺寸大（Retina 上直接翻倍）
            const previousRatio = renderer.getPixelRatio?.() ?? 1;
            renderer.setPixelRatio?.(1);
            if (elapsedMs !== undefined) applyPoses(elapsedMs);
            applyCameraValues(override || activeCamera());
            const width = Math.round((height * 16) / 9);
            // 必须是 three 的 Vector2：renderer.getSize(target) 内部会调 target.set()，
            // 传普通对象会直接抛 "target.set is not a function"。
            const previousSize = new t.Vector2();
            renderer.getSize(previousSize);
            const aspect = camera.aspect;
            renderer.setSize(width, height, false);
            camera.aspect = width / height;
            camera.updateProjectionMatrix();
            renderWithoutHighlight();
            const dataUrl = format === "png" ? renderer.domElement.toDataURL("image/png") : renderer.domElement.toDataURL("image/jpeg", 0.92);
            renderer.setSize(previousSize.x || 640, previousSize.y || 360, false);
            renderer.setPixelRatio?.(previousRatio);
            camera.aspect = aspect;
            camera.updateProjectionMatrix();
            // 取完这一帧把人物摆回编辑态（capture 之后视口还要继续用）
            if (elapsedMs !== undefined) applyPoses(null);
            applyCamera();
            requestRender();
            return { dataUrl, width, height };
        },
        dispose: () => {
            disposed = true;
            window.clearTimeout(wheelTimer);
            if (frame) window.cancelAnimationFrame(frame);
            resizeObserver?.disconnect();
            const canvas = renderer?.domElement;
            if (canvas) {
                canvas.removeEventListener("pointerdown", onPointerDown);
                canvas.removeEventListener("pointermove", onPointerMove);
                canvas.removeEventListener("pointerup", endDrag);
                canvas.removeEventListener("pointercancel", endDrag);
                canvas.removeEventListener("wheel", onWheel);
            }
            for (const marker of shotMarkers) disposeCameraMarker(marker);
            shotMarkers = [];
            if (currentMarker) disposeCameraMarker(currentMarker);
            currentMarker = null;
            markersGroup = null;
            highlight.box?.geometry?.dispose?.();
            meshes.forEach((group) => group.traverse?.((child: any) => (child.geometry?.dispose?.(), child.material?.dispose?.())));
            meshes.clear();
            models.clear();
            modelCache.clear();
            backdropTexture?.dispose?.();
            backdropTexture = null;
            backdropKey = "";
            renderer?.dispose?.();
            // 主动丢掉 WebGL 上下文：画布上多个导演台节点时，浏览器上下文数量是有上限的。
            renderer?.forceContextLoss?.();
            renderer?.domElement?.remove?.();
        },
    };
}

export type { StageCamera, StageObject, StageObjectKind, StageState };
