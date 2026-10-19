// 场景里的「相机元素」：给每个关键帧机位画一台小相机（机身 + 镜头 + 取景锥 + 名字标签），
// 让人一眼看出镜头在哪、朝哪、视野多大 —— 只靠一个空白场景很容易把机位搞混。
//
// 约定：标记只出现在编辑视口里，导出（截图 / 逐帧视频）时会整体隐藏 ——
// 参考画面里飘着一个方块，模型会当成真实物体。
import { eyePosition, focalToFov } from "./prompt";
import type { StageCamera } from "./stage-state";

type ThreeModule = typeof import("three");
type Group = import("three").Group;

const DEG = Math.PI / 180;
/** 取景锥的基准：apex 在局部原点，底面在 z = -DEPTH，半高 BASE_HALF（再按焦距缩放 x/y）。 */
export const FRUSTUM_DEPTH = 1.8;
const BASE_HALF = 0.5;
/** 参考图是 16:9，取景锥也按 16:9 画。 */
const FRUSTUM_ASPECT = 16 / 9;

const LABEL_WIDTH = 256;
const LABEL_HEIGHT = 64;

/**
 * 取景锥的 x/y 缩放：把「深度 DEPTH 处的半高」缩到真实视场角对应的半高。
 * 纯计算，方便单测（焦距越短视野越大 → 缩放越大）。
 */
export function frustumScale(focalMm: number): number {
    const fovRad = focalToFov(focalMm) * DEG;
    return (FRUSTUM_DEPTH * Math.tan(fovRad / 2)) / BASE_HALF;
}

/**
 * 「看全场」用的俯视机位：把所有可见物体与所有关键帧机位都框进来。
 * 只用于预览渲染，不会写进节点的机位状态。
 */
export function overviewCamera(state: { objects: Array<{ x: number; z: number; visible: boolean }>; shots: Array<{ camera: StageCamera }> }): StageCamera {
    const points = [
        ...state.objects.filter((object) => object.visible).map((object) => ({ x: object.x, z: object.z })),
        ...state.shots.map((shot) => eyePosition(shot.camera)).map((eye) => ({ x: eye.x, z: eye.z })),
    ];
    const radius = points.length ? Math.max(3, ...points.map((point) => Math.hypot(point.x, point.z))) : 3;
    return { azimuthDeg: 35, elevationDeg: 40, distance: Math.max(6, radius * 2.8), targetY: 1.1, focalMm: 28 };
}

export type CameraMarker = { group: Group; frustum: Group; body: Group; setActive: (active: boolean) => void };

/** 让某个相机标记"看起来被选中"（机身换强调色 + 取景锥变亮）。 */
export function setMarkerActive(marker: CameraMarker, active: boolean) {
    marker.setActive(active);
}

/** 把机位摆到标记上：位置取世界坐标的眼睛位置，朝向指向视线目标。 */
export function applyCameraToMarker(marker: CameraMarker, camera: StageCamera) {
    const eye = eyePosition(camera);
    marker.group.position.set(eye.x, eye.y, eye.z);
    marker.group.lookAt(0, camera.targetY, 0);
    // Object3D.lookAt 对普通 Group 是让 +Z 指向目标，而标记（镜头/取景锥）按 three 的相机约定做在 -Z，
    // 所以这里绕自身 Y 轴再转 180°，否则整台相机会背对主体（取景锥也会朝反方向）。
    marker.group.rotateY(Math.PI);
    const scale = frustumScale(camera.focalMm);
    marker.frustum.scale.set(scale, scale, 1);
}

function createLabel(t: ThreeModule, text: string, color: number) {
    const canvas = document.createElement("canvas");
    canvas.width = LABEL_WIDTH;
    canvas.height = LABEL_HEIGHT;
    const ctx = canvas.getContext("2d");
    if (ctx) {
        const css = `#${color.toString(16).padStart(6, "0")}`;
        ctx.fillStyle = "rgba(12,16,22,.82)";
        ctx.strokeStyle = css;
        ctx.lineWidth = 3;
        const radius = 16;
        ctx.beginPath();
        ctx.moveTo(radius, 2);
        ctx.arcTo(LABEL_WIDTH - 2, 2, LABEL_WIDTH - 2, LABEL_HEIGHT - 2, radius);
        ctx.arcTo(LABEL_WIDTH - 2, LABEL_HEIGHT - 2, 2, LABEL_HEIGHT - 2, radius);
        ctx.arcTo(2, LABEL_HEIGHT - 2, 2, 2, radius);
        ctx.arcTo(2, 2, LABEL_WIDTH - 2, 2, radius);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = "#e8edf4";
        ctx.font = "600 30px system-ui, -apple-system, 'Segoe UI', sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(text, LABEL_WIDTH / 2, LABEL_HEIGHT / 2 + 1, LABEL_WIDTH - 24);
    }
    const texture = new t.CanvasTexture(canvas);
    texture.colorSpace = t.SRGBColorSpace;
    const sprite = new t.Sprite(new t.SpriteMaterial({ map: texture, transparent: true, depthTest: false }));
    sprite.scale.set(0.9, 0.9 * (LABEL_HEIGHT / LABEL_WIDTH), 1);
    sprite.position.set(0, 0.42, 0);
    return sprite;
}

/** 造一台小相机：机身方块 + 镜头圆筒 + 取景锥线框 + 名字标签（局部 -Z 为视线方向，与 three 一致）。 */
export function createCameraMarker(t: ThreeModule, options: { camera: StageCamera; color: number; label: string; shotId?: string }): CameraMarker {
    const group = new t.Group();
    const body = new t.Group();

    const shell = new t.Mesh(
        new t.BoxGeometry(0.36, 0.26, 0.5),
        new t.MeshStandardMaterial({ color: options.color, roughness: 0.45, metalness: 0.25 }),
    );
    const lens = new t.Mesh(
        new t.CylinderGeometry(0.1, 0.13, 0.24, 14),
        new t.MeshStandardMaterial({ color: 0x1b2028, roughness: 0.6 }),
    );
    lens.rotation.x = Math.PI / 2;
    lens.position.z = -0.34;
    const shoe = new t.Mesh(new t.BoxGeometry(0.16, 0.06, 0.16), new t.MeshStandardMaterial({ color: 0x1b2028 }));
    shoe.position.y = 0.16;
    body.add(shell, lens, shoe);
    body.add(createLabel(t, options.label, options.color));
    group.add(body);

    // 取景锥：apex 在镜头处，底面在 -Z 方向 —— 直观表示"这台相机拍到的范围"
    const frustum = new t.Group();
    const halfHeight = BASE_HALF;
    const halfWidth = BASE_HALF * FRUSTUM_ASPECT;
    const corners = [
        [-halfWidth, -halfHeight, -FRUSTUM_DEPTH],
        [halfWidth, -halfHeight, -FRUSTUM_DEPTH],
        [halfWidth, halfHeight, -FRUSTUM_DEPTH],
        [-halfWidth, halfHeight, -FRUSTUM_DEPTH],
    ] as Array<[number, number, number]>;
    const points: number[] = [];
    for (const corner of corners) points.push(0, 0, 0, ...corner);
    for (let index = 0; index < corners.length; index += 1) points.push(...corners[index], ...corners[(index + 1) % corners.length]);
    const geometry = new t.BufferGeometry();
    geometry.setAttribute("position", new t.Float32BufferAttribute(points, 3));
    const lines = new t.LineSegments(geometry, new t.LineBasicMaterial({ color: options.color, transparent: true, opacity: 0.55 }));
    frustum.add(lines);
    frustum.position.z = -0.34;
    group.add(frustum);

    // 看不见的命中体：机身只有 0.36×0.26m、取景锥是细线，直接用它们做点击目标太难中。
    // 用一个更大的透明盒当"点击区"（材质 visible=false 不渲染但可被射线命中，地面平面就是同一招）。
    const hitProxy = new t.Mesh(new t.BoxGeometry(1.5, 1.5, 1.5), new t.MeshBasicMaterial({ visible: false }));
    hitProxy.position.y = 0.1;
    group.add(hitProxy);

    if (options.shotId) {
        group.userData.shotId = options.shotId;
        group.traverse((child: unknown) => {
            (child as { userData?: Record<string, unknown> }).userData = { ...((child as { userData?: Record<string, unknown> }).userData || {}), shotId: options.shotId };
        });
    }

    const setActive = (active: boolean) => {
        (shell.material as { color?: { set?: (value: number) => void } }).color?.set?.(active ? 0x2f80ff : options.color);
        (lines.material as { opacity?: number; color?: { set?: (value: number) => void } }).color?.set?.(active ? 0x2f80ff : options.color);
        const lineMaterial = lines.material as { opacity?: number };
        lineMaterial.opacity = active ? 0.9 : 0.55;
    };

    return { group, frustum, body, setActive };
}

/**
 * 走位路径（blocking diagram）：地面折线 + 每个走位点的圆点 + 该点的朝向箭头。
 * 和相机元素一样只在编辑视口出现（调用方把它加进 markersGroup，导出时整体隐藏）。
 */
export function createTrackPath(t: ThreeModule, track: Array<{ x: number; z: number; rotationYDeg: number }>, color: number): Group {
    const group = new t.Group();
    if (track.length < 2) return group;

    const geometry = new t.BufferGeometry();
    const points: number[] = [];
    for (const pose of track) points.push(pose.x, 0.03, pose.z);
    geometry.setAttribute("position", new t.Float32BufferAttribute(points, 3));
    group.add(new t.Line(geometry, new t.LineBasicMaterial({ color, transparent: true, opacity: 0.85 })));

    const dotMaterial = new t.MeshBasicMaterial({ color, transparent: true, opacity: 0.9 });
    const arrowMaterial = new t.MeshBasicMaterial({ color, transparent: true, opacity: 0.55 });
    track.forEach((pose, index) => {
        const dot = new t.Mesh(new t.SphereGeometry(index === 0 || index === track.length - 1 ? 0.11 : 0.07, 12, 8), dotMaterial);
        dot.position.set(pose.x, 0.05, pose.z);
        group.add(dot);

        // 朝向箭头：从落脚点往前指，长度代表"这一刻面朝哪"
        const heading = (pose.rotationYDeg * Math.PI) / 180;
        const length = 0.62;
        const arrow = new t.Mesh(new t.ConeGeometry(0.075, 0.22, 10), arrowMaterial);
        arrow.position.set(pose.x + Math.sin(heading) * length, 0.05, pose.z + Math.cos(heading) * length);
        arrow.rotation.x = Math.PI / 2;
        arrow.rotation.z = -heading;
        group.add(arrow);
    });
    return group;
}

/** 释放标记占用的 GPU 资源（几何、材质、标签贴图）。 */
export function disposeCameraMarker(marker: CameraMarker) {
    marker.group.traverse((child: unknown) => {
        const node = child as { geometry?: { dispose?: () => void }; material?: { map?: { dispose?: () => void }; dispose?: () => void } };
        node.geometry?.dispose?.();
        node.material?.map?.dispose?.();
        node.material?.dispose?.();
    });
}
