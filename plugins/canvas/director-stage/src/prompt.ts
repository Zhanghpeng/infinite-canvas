// 状态 → 运镜提示词的纯逻辑：把"谁在哪、和谁什么关系、镜头怎么走"翻成人话。
// 不依赖 three / React / SDK，可在 web 侧直接单测。
import { assetById, assetHeight } from "./library";
import { hasMovement, marksFor, motionTimeline, poseAtTime, trackTimeline, type StageMotion, type StagePose, type StageShot } from "./motion";
import { HUMAN_HEIGHT_M, PROP_SIZE_M, type StageCamera, type StageObject, type StageState } from "./stage-state";

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;

type Vec3 = { x: number; y: number; z: number };

export function eyePosition(camera: StageCamera): Vec3 {
    const az = camera.azimuthDeg * DEG;
    const el = camera.elevationDeg * DEG;
    const horizontal = Math.cos(el) * camera.distance;
    return { x: Math.sin(az) * horizontal, y: camera.targetY + Math.sin(el) * camera.distance, z: Math.cos(az) * horizontal };
}

/** 垂直视场角：按全画幅 24mm 传感器高换算，等效焦距越大人越"压缩"。 */
export function focalToFov(focalMm: number): number {
    return 2 * Math.atan(24 / (2 * Math.max(1, focalMm))) * RAD;
}

export type Placement = { side: "左" | "中" | "右"; depth: "前景" | "中景" | "远景"; facing: "面向镜头" | "侧对镜头" | "背对镜头"; distanceM: number; /** 横向偏移比（lateral / distance），负=画面左，正=画面右 */ lateralRatio: number };

/** 相对当前机位判断物体在画面里的位置、景深与朝向。 */
export function describePlacement(object: StageObject, camera: StageCamera): Placement {
    const eye = eyePosition(camera);
    const target: Vec3 = { x: 0, y: camera.targetY, z: 0 };
    const forward = normalize(sub(target, eye));
    // 相机的屏幕右方向 = normalize(cross(forward, up))；写成 (forward.z, 0, -forward.x) 得到的是"左",
    // 会让提示词里的「画面左/右」整体颠倒（这一版修掉）。
    const right = normalize({ x: -forward.z, y: 0, z: forward.x });
    const toObject: Vec3 = { x: object.x - eye.x, y: HUMAN_HEIGHT_M * 0.5 * object.scale - eye.y, z: object.z - eye.z };
    const distance = length({ x: toObject.x, y: 0, z: toObject.z });
    const lateral = dot({ x: toObject.x, y: 0, z: toObject.z }, right);
    const ratio = distance > 0 ? lateral / distance : 0;
    const side = ratio < -0.3 ? "左" : ratio > 0.3 ? "右" : "中";
    const depth = distance < 2.2 ? "前景" : distance < 4.5 ? "中景" : "远景";
    const face = { x: Math.sin(object.rotationYDeg * DEG), y: 0, z: Math.cos(object.rotationYDeg * DEG) };
    const toward = dot(face, { x: -forward.x, y: 0, z: -forward.z });
    const facing = toward > 0.5 ? "面向镜头" : toward < -0.5 ? "背对镜头" : "侧对镜头";
    return { side, depth, facing, distanceM: distance, lateralRatio: ratio };
}

/** 物体的近似高度（米）：内置素材按素材真实高度，占位人形/道具按约定尺寸。 */
export function objectHeight(object: StageObject): number {
    const asset = assetById(object.assetId);
    const base = asset ? assetHeight(asset) : object.kind === "prop" ? PROP_SIZE_M : HUMAN_HEIGHT_M;
    return base * (object.scale || 1);
}

const BEARINGS = ["正前", "左前", "正左", "左后", "正后", "右后", "正右", "右前"] as const;
const BEARINGS_EN = ["straight ahead", "front-left", "to the left", "back-left", "behind", "back-right", "to the right", "front-right"] as const;

export type Relation = {
    /** A 相对 B 的朝向关系 */
    facing: "面向" | "侧对" | "背对";
    /** B 在 A 的哪个方向（以 A 的朝向为基准） */
    bearing: (typeof BEARINGS)[number];
    /** 两者水平距离（米） */
    distanceM: number;
    /** A 是否大致挡住 B（近似：横向屏幕位置接近且 A 更靠近相机） */
    occludes: boolean;
};

/**
 * A 看 B 的关系。
 * 朝向用 A 的前方向与 A→B 方向的点积；方位用 A 的「左」向量（+X 绕 Y 转 θ）与前方分量做八向分桶；
 * 遮挡是**近似**判断：两者在画面横向位置接近、且 A 明显更靠近相机。
 */
export function describeRelation(a: StageObject, b: StageObject, camera: StageCamera): Relation {
    const forward = { x: Math.sin(a.rotationYDeg * DEG), y: 0, z: Math.cos(a.rotationYDeg * DEG) };
    const left = { x: Math.cos(a.rotationYDeg * DEG), y: 0, z: -Math.sin(a.rotationYDeg * DEG) };
    const to = { x: b.x - a.x, y: 0, z: b.z - a.z };
    const distance = length(to);
    if (distance < 0.05) return { facing: "侧对", bearing: "正前", distanceM: 0, occludes: false };
    const unit = normalize(to);
    const ahead = dot(unit, forward);
    const lateral = dot(unit, left);
    const facing = ahead > 0.5 ? "面向" : ahead < -0.5 ? "背对" : "侧对";
    const degrees = (Math.atan2(lateral, ahead) * RAD + 360) % 360;
    const bearing = BEARINGS[Math.round(degrees / 45) % 8];

    // 近似遮挡：在画面里横向位置接近，且 A 明显更靠近相机
    const placementA = describePlacement(a, camera);
    const placementB = describePlacement(b, camera);
    const occludes =
        Math.abs(placementA.lateralRatio - placementB.lateralRatio) < 0.12 &&
        Math.abs(placementA.distanceM - placementB.distanceM) > 0.8 &&
        placementA.distanceM < placementB.distanceM;

    return { facing, bearing, distanceM: distance, occludes };
}

/** 物体在画面里占多高（垂直张角 / 垂直视场角），以及偏左居中偏右。 */
export function describeFraming(object: StageObject, camera: StageCamera): { heightRatio: number; side: "居中" | "偏左" | "偏右" } {
    const placement = describePlacement(object, camera);
    const distance = Math.max(0.4, placement.distanceM);
    const angular = 2 * Math.atan(objectHeight(object) / 2 / distance) * RAD;
    const heightRatio = angular / focalToFov(camera.focalMm);
    const ratio = placement.side === "左" ? -1 : placement.side === "右" ? 1 : 0;
    const side = ratio < 0 ? "偏左" : ratio > 0 ? "偏右" : "居中";
    return { heightRatio, side };
}

function ratioText(ratio: number, locale: "zh" | "en") {
    const clamped = Math.max(0.02, Math.min(1.5, ratio));
    const rounded = clamped >= 0.95 ? 1 : Math.max(0.1, Math.round(clamped * 10) / 10);
    if (rounded === 1) return locale === "zh" ? "占满画面高度" : "fills the frame height";
    const fractions: Record<string, string> = { "0.1": "1/10", "0.2": "1/5", "0.3": "1/3", "0.4": "2/5", "0.5": "1/2", "0.6": "3/5", "0.7": "2/3", "0.8": "4/5", "0.9": "9/10" };
    const label = fractions[rounded.toFixed(1)] || `${Math.round(rounded * 100)}%`;
    return locale === "zh" ? `约占画面高度 ${label}` : `about ${label} of the frame height`;
}

/** 主体（写关系与构图的"人"）：人物与导入的人物模型；道具与环境都不算。 */
const isSubject = (object: StageObject) => object.kind === "person" || object.kind === "model";

const MAX_RELATION_PAIRS = 6;
/** 道具只以「谁站在它旁边」的形式出现，超过这个距离就不写。 */
const PROP_NEARBY_M = 3;
const MAX_PROP_RELATIONS = 3;

/**
 * 关系段：以**人物之间**为主，再补最多 3 条「人物 ↔ 最近的道具」（≤3m）。
 * 道具之间、道具与环境之间不写 —— 真实数据跑出来「路灯 ↔ 路灯 2：双方均侧对对方」纯属噪音。
 */
export function describeRelations(state: StageState, locale: "zh" | "en" = "zh"): string | null {
    const visible = state.objects.filter((object) => object.visible && object.kind !== "env");
    if (visible.length < 2) return null;
    const people = visible.filter(isSubject);
    const props = visible.filter((object) => !isSubject(object));
    const pairs: Array<[StageObject, StageObject]> = [];
    for (let i = 0; i < people.length; i += 1) {
        for (let j = i + 1; j < people.length; j += 1) pairs.push([people[i], people[j]]);
    }
    // 每个道具挂到离它最近的那个人身上（近的优先，最多 3 条）
    props
        .map((prop) => {
            const nearest = people.reduce<{ person: StageObject; distance: number } | null>((best, person) => {
                const distance = Math.hypot(person.x - prop.x, person.z - prop.z);
                return !best || distance < best.distance ? { person, distance } : best;
            }, null);
            return nearest && nearest.distance <= PROP_NEARBY_M ? { person: nearest.person, prop, distance: nearest.distance } : null;
        })
        .filter((item): item is { person: StageObject; prop: StageObject; distance: number } => Boolean(item))
        .sort((a, b) => a.distance - b.distance)
        .slice(0, MAX_PROP_RELATIONS)
        .forEach((item) => pairs.push([item.person, item.prop]));
    if (!pairs.length) return null;
    pairs.length = Math.min(pairs.length, MAX_RELATION_PAIRS);

    const facingEn = (facing: Relation["facing"]) => (facing === "面向" ? "facing" : facing === "背对" ? "facing away from" : "side-on to");
    const lines = pairs.map(([a, b]) => {
        const forward = describeRelation(a, b, state.camera);
        const backward = describeRelation(b, a, state.camera);
        // 一方是道具时只给方位与距离：道具没有"朝向"可言（朝向字段是随便填的）
        const bothSubjects = isSubject(a) && isSubject(b);
        if (locale === "en") {
            const bearing = BEARINGS_EN[BEARINGS.indexOf(forward.bearing)];
            const facing = !bothSubjects
                ? ""
                : forward.facing === backward.facing
                  ? `, both ${facingEn(forward.facing)} each other`
                  : `, ${a.name} ${facingEn(forward.facing)} ${b.name} and ${b.name} ${facingEn(backward.facing)} ${a.name}`;
            return `- ${a.name} ↔ ${b.name}: ${forward.distanceM.toFixed(1)}m apart, ${b.name} ${bearing} of ${a.name}${facing}`;
        }
        const facing = !bothSubjects
            ? ""
            : forward.facing === backward.facing
              ? `，双方均${forward.facing}对方`
              : `，${a.name}${forward.facing}对方、${b.name}${backward.facing}对方`;
        return `- ${a.name} ↔ ${b.name}：相距 ${forward.distanceM.toFixed(1)}m，${b.name}在${a.name}${forward.bearing}方${facing}`;
    });

    // 遮挡只可能一个方向成立（近的挡远的），两个方向都查一遍再报真正的那个
    const occlusion = pairs
        .map(([a, b]) => {
            if (describeRelation(a, b, state.camera).occludes) return [a, b] as const;
            if (describeRelation(b, a, state.camera).occludes) return [b, a] as const;
            return null;
        })
        .filter((pair): pair is readonly [StageObject, StageObject] => Boolean(pair))
        .map(([blocker, blocked]) => (locale === "en" ? `${blocker.name} roughly blocks ${blocked.name}` : `${blocker.name}大致挡住${blocked.name}`));
    const all = [...lines, ...(occlusion.length ? [locale === "zh" ? `- 遮挡（大致）：${occlusion.join("；")}` : `- Occlusion (approximate): ${occlusion.join("; ")}`] : [])];
    return (locale === "zh" ? "关系：\n" : "Relations:\n") + all.join("\n");
}

/** 构图段：只算主体（人物/模型）占画面高度与左右位置 —— 道具的"占画面高度"是噪音。 */
export function describeFramingBlock(state: StageState, locale: "zh" | "en" = "zh"): string | null {
    const visible = state.objects.filter((object) => object.visible && isSubject(object)).slice(0, 4);
    if (!visible.length) return null;
    const lines = visible.map((object) => {
        const framing = describeFraming(object, state.camera);
        if (locale === "en") {
            const side = framing.side === "居中" ? "centred" : framing.side === "偏左" ? "left of centre" : "right of centre";
            return `- ${object.name}: ${ratioText(framing.heightRatio, "en")}, ${side}`;
        }
        return `- ${object.name}：${ratioText(framing.heightRatio, "zh")}，${framing.side}`;
    });
    return (locale === "zh" ? "构图：\n" : "Framing:\n") + lines.join("\n");
}

export function describeScene(state: StageState, locale: "zh" | "en" = "zh"): string {
    const visible = state.objects.filter((object) => object.visible);
    if (!visible.length) return locale === "zh" ? "场景：暂无人物或道具。" : "Scene: no subject placed yet.";
    // 环境（房间/街道/远景/地形）不是主体：只报一行"这是什么环境"，
    // 不然会写出"房间在画面中央、面向镜头"这种噪音，还会污染关系与构图段。
    const environment = visible.filter((object) => object.kind === "env");
    const subjects = visible.filter((object) => object.kind !== "env");
    if (!subjects.length) {
        const names = environment.map((object) => object.name).join(locale === "zh" ? "、" : ", ");
        return locale === "zh" ? `场景：只有环境（${names}），还没有人物或道具。` : `Scene: only environment (${names}); no subject placed yet.`;
    }
    const lines = subjects.map((object) => {
        const placement = describePlacement(object, state.camera);
        const kind = object.kind === "person" ? (locale === "zh" ? "人物" : "person") : object.kind === "prop" ? (locale === "zh" ? "道具" : "prop") : object.kind === "env" ? (locale === "zh" ? "环境" : "environment") : locale === "zh" ? "模型" : "model";
        const sideZh = placement.side === "左" ? "左侧" : placement.side === "右" ? "右侧" : "中央";
        const hasFacing = object.kind === "person" || object.kind === "model";
        const facingZh = hasFacing ? `，${placement.facing}` : "";
        const facingEn = hasFacing ? `, ${placement.facing === "面向镜头" ? "facing camera" : placement.facing === "背对镜头" ? "back to camera" : "three-quarter to camera"}` : "";
        return locale === "zh"
            ? `- ${object.name}（${kind}）：画面${sideZh}·${placement.depth}，约 ${placement.distanceM.toFixed(1)}m${facingZh}`
            : `- ${object.name} (${kind}): ${placement.side === "左" ? "left" : placement.side === "右" ? "right" : "centre"} ${placement.depth === "前景" ? "foreground" : placement.depth === "中景" ? "midground" : "background"}, ~${placement.distanceM.toFixed(1)}m away${facingEn}`;
    });
    const blocks = [(locale === "zh" ? "场景关系：\n" : "Scene layout:\n") + lines.join("\n")];
    if (environment.length) {
        const names = environment.map((object) => object.name).join(locale === "zh" ? "、" : ", ");
        blocks.push(locale === "zh" ? `环境：${names}` : `Environment: ${names}`);
    }
    const relations = describeRelations(state, locale);
    if (relations) blocks.push(relations);
    const framing = describeFramingBlock(state, locale);
    if (framing) blocks.push(framing);
    return blocks.join("\n");
}

export function describeCamera(camera: StageCamera, locale: "zh" | "en" = "zh"): string {
    const fov = focalToFov(camera.focalMm);
    const shot = camera.distance < 2.4 ? "近景" : camera.distance < 4.5 ? "中景" : "全景";
    const angle = camera.elevationDeg > 35 ? "俯拍" : camera.elevationDeg < -8 ? "仰拍" : "平视";
    return locale === "zh"
        ? `机位：${shot}，${angle}（仰角 ${camera.elevationDeg.toFixed(0)}°），距主体约 ${camera.distance.toFixed(1)}m，等效 ${camera.focalMm.toFixed(0)}mm（垂直视场角 ${fov.toFixed(0)}°），视线高度 ${camera.targetY.toFixed(2)}m。`
        : `Camera: ${camera.distance < 2.4 ? "close shot" : camera.distance < 4.5 ? "medium shot" : "wide shot"}, ${camera.elevationDeg > 35 ? "high angle" : camera.elevationDeg < -8 ? "low angle" : "eye level"} (elevation ${camera.elevationDeg.toFixed(0)}°), ~${camera.distance.toFixed(1)}m from the subject, ${camera.focalMm.toFixed(0)}mm equivalent (vertical FOV ${fov.toFixed(0)}°), eye height ${camera.targetY.toFixed(2)}m.`;
}

const LOCKED_OFF: Record<"zh" | "en", string> = {
    zh: "运镜：固定机位，画面内只有人物动作。",
    en: "Camera motion: locked-off shot; only the subjects move.",
};
const NO_MOVE: Record<"zh" | "en", string> = {
    zh: "运镜：机位基本不动，轻微手持呼吸感。",
    en: "Camera motion: nearly locked-off with a subtle handheld breathing.",
};

/** 两台机位之间的差异拆成镜头运动（推/拉/摇/升降/变焦），供单段与多段运镜复用。 */
export function motionParts(from: StageCamera, to: StageCamera): Array<{ zh: string; en: string }> {
    const parts: Array<{ zh: string; en: string }> = [];
    const dolly = to.distance - from.distance;
    if (dolly < -0.35) parts.push({ zh: "推近（dolly-in）", en: "dolly in" });
    else if (dolly > 0.35) parts.push({ zh: "拉远（dolly-out）", en: "dolly out" });
    const azimuth = normalizeAngle(to.azimuthDeg - from.azimuthDeg);
    if (Math.abs(azimuth) > 6) parts.push(azimuth > 0 ? { zh: "向右环绕（orbit right）", en: "orbit right" } : { zh: "向左环绕（orbit left）", en: "orbit left" });
    const elevation = to.elevationDeg - from.elevationDeg;
    if (Math.abs(elevation) > 6) parts.push(elevation > 0 ? { zh: "镜头抬高（crane up）", en: "crane up" } : { zh: "镜头压低（crane down）", en: "crane down" });
    const focal = to.focalMm - from.focalMm;
    if (Math.abs(focal) > 4) parts.push(focal > 0 ? { zh: "焦距变长（推镜压缩空间）", en: "zoom in / longer lens" } : { zh: "焦距变短（拉镜展开空间）", en: "zoom out / wider lens" });
    return parts;
}

/** 机位 A → B 的差异翻译成镜头运动；没有 B 就退化成静态机位描述。 */
export function describeMotion(from: StageCamera | undefined, to: StageCamera | undefined, locale: "zh" | "en" = "zh"): string {
    if (!from || !to) return LOCKED_OFF[locale];
    const parts = motionParts(from, to);
    if (!parts.length) return NO_MOVE[locale];
    return locale === "zh"
        ? `运镜：从机位 A 到机位 B，${parts.map((part) => part.zh).join(" + ")}，速度缓慢均匀。`
        : `Camera motion: ${parts.map((part) => part.en).join(" + ")} from position A to B, slow and even.`;
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

/** 按时间刻度把"停留 + 运动"拼成带时间段的句子（相机与人物走位共用）。 */
function timedClauses(
    holds: number[],
    movements: string[],
    timeline: ReturnType<typeof trackTimeline>,
    locale: "zh" | "en",
): string[] {
    const arrivals = marksFor(holds, timeline);
    const clauses: string[] = [];
    for (let index = 0; index < holds.length; index += 1) {
        if (holds[index] >= 500 && index < holds.length - 1) {
            clauses.push(
                locale === "en"
                    ? `${seconds(arrivals[index])}→${seconds(arrivals[index] + holds[index])} hold`
                    : `${seconds(arrivals[index])}→${seconds(arrivals[index] + holds[index])} 停留`,
            );
        }
        const movement = movements[index];
        if (movement) {
            const depart = arrivals[index] + holds[index];
            const arrive = arrivals[index + 1] ?? depart;
            clauses.push(`${seconds(depart)}→${seconds(arrive)} ${movement}`);
        }
    }
    return clauses;
}

/**
 * 多关键帧运镜描述：逐段带时间段（「0.0→2.1s 推近（dolly-in）」）——
 * 视频模型对时间轴的指令比纯状态描述听话得多。少于 2 个机位时退化成固定机位。
 */
export function describeShotSequence(shots: StageShot[], motion: StageMotion, locale: "zh" | "en" = "zh"): string {
    if (shots.length < 2) return LOCKED_OFF[locale];
    const clauses: string[][] = [];
    for (let index = 0; index < shots.length - 1; index += 1) {
        const parts = motionParts(shots[index].camera, shots[index + 1].camera);
        if (parts.length) clauses.push(parts.map((part) => (locale === "zh" ? part.zh : part.en)));
    }
    if (!clauses.length) return NO_MOVE[locale];

    const timeline = motionTimeline(shots, motion);
    const movements = shots.slice(0, -1).map((_, index) => (clauses[index] ? clauses[index].join(" + ") : ""));
    const text = timedClauses(shots.map((shot) => shot.holdMs), movements, timeline, locale).join(locale === "zh" ? "，" : ", ");

    if (locale === "en") return `Camera motion: ${text}. About ${(timeline.totalMs / 1000).toFixed(1)}s total, slow and even.`;
    return `运镜：${text}。全程约 ${(timeline.totalMs / 1000).toFixed(1)}s，节奏缓慢均匀。`;
}

/**
 * 主体是否还在画面里（近似：用它的正前方深度 + 横向/纵向偏移与视场角比）。
 * 用来给走位做"出画预警"，不是精确裁切 —— 但足够抓住"人走出画面了"这种问题。
 */
export function frameFit(object: StageObject, camera: StageCamera): { inFrame: boolean; reason?: "不在镜头前方" | "横向出画" | "纵向出画" } {
    const eye = eyePosition(camera);
    const target: Vec3 = { x: 0, y: camera.targetY, z: 0 };
    const forward = normalize(sub(target, eye));
    const right = normalize({ x: -forward.z, y: 0, z: forward.x });
    const to = sub({ x: object.x, y: objectHeight(object) * 0.5, z: object.z }, eye);
    const depth = dot(to, forward);
    if (depth <= 0.3) return { inFrame: false, reason: "不在镜头前方" };

    const fov = focalToFov(camera.focalMm) * DEG;
    const halfVertical = Math.tan(fov / 2);
    const halfHorizontal = halfVertical * (16 / 9);
    // 纵向要用相机自己的上方向（相机可能是俯仰的），直接拿世界 Y 会在俯拍时误判。
    // 做法是把世界 Y 对 forward 正交化 —— 必须真正垂直于 forward，否则长焦/大俯仰时会假报"纵向出画"。
    const up = normalize({ x: -forward.y * forward.x, y: 1 - forward.y * forward.y, z: -forward.y * forward.z });
    if (Math.abs(dot(to, right)) / depth > halfHorizontal * 0.98) return { inFrame: false, reason: "横向出画" };
    if (Math.abs(dot(to, up)) / depth > halfVertical * 0.98) return { inFrame: false, reason: "纵向出画" };
    return { inFrame: true };
}

/**
 * 沿时间轴采样，找出"谁在什么时候出画"（只查有走位的物体）。
 * 返回按时间排序的提示语，供编辑器在运镜预演区提示。
 */
export function frameWarnings(state: StageState, sampleCount = 24): string[] {
    const movers = state.objects.filter((object) => object.visible && object.kind !== "env" && hasMovement(object.track));
    if (!movers.length) return [];
    const totalMs = Math.max(state.motion.durationMs, ...movers.map((object) => trackTimeline(object.track!, state.motion).totalMs));
    const warnings: string[] = [];
    for (const object of movers) {
        for (let index = 0; index <= sampleCount; index += 1) {
            const at = (totalMs * index) / sampleCount;
            const pose = poseAtTime(object.track!, state.motion, at);
            if (!pose) continue;
            const fit = frameFit({ ...object, x: pose.x, z: pose.z, rotationYDeg: pose.rotationYDeg }, state.camera);
            if (!fit.inFrame) {
                warnings.push(`${(at / 1000).toFixed(1)}s 起「${object.name}」${fit.reason}`);
                break;
            }
        }
    }
    return warnings;
}

/** 用走位点上的位置/朝向临时造一个物体，复用 describePlacement 的"画面左中右 + 景别"措辞。 */
function poseAsObject(object: StageObject, pose: StagePose): StageObject {
    return { ...object, x: pose.x, z: pose.z, rotationYDeg: pose.rotationYDeg };
}

/**
 * 「表演」段：逐物体、按时间段说清"谁在什么时候走到哪、转向谁"。
 * 这正是视频模型最吃得进的形式（时间轴 + 位移 + 朝向变化），也是走位相对于"只是摆着"的核心价值。
 */
export function describePerformance(state: StageState, locale: "zh" | "en" = "zh"): string | null {
    const movers = state.objects.filter((object) => object.visible && object.kind !== "env" && hasMovement(object.track)).slice(0, 4);
    if (!movers.length) return null;

    const sideZh = (placement: Placement) => `画面${placement.side === "左" ? "左侧" : placement.side === "右" ? "右侧" : "中央"}·${placement.depth}`;
    const sideEn = (placement: Placement) =>
        `${placement.side === "左" ? "left" : placement.side === "右" ? "right" : "centre"} ${placement.depth === "前景" ? "foreground" : placement.depth === "中景" ? "midground" : "background"}`;

    const lines = movers.map((object) => {
        const track = object.track!;
        const timeline = trackTimeline(track, state.motion);
        const arrivals = marksFor(track.map((pose) => pose.holdMs), timeline);
        const items: string[] = [];

        for (let index = 0; index < track.length - 1; index += 1) {
            const from = poseAsObject(object, track[index]);
            const to = poseAsObject(object, track[index + 1]);
            const fromPlacement = describePlacement(from, state.camera);
            const toPlacement = describePlacement(to, state.camera);
            const distance = Math.hypot(track[index + 1].x - track[index].x, track[index + 1].z - track[index].z);
            const moved = distance > 0.15;
            const turn = Math.abs(track[index + 1].rotationYDeg - track[index].rotationYDeg) > 15;
            const depart = arrivals[index] + track[index].holdMs;
            const arrive = arrivals[index + 1];
            const facingZh = toPlacement.facing === "面向镜头" ? "面向镜头" : toPlacement.facing === "背对镜头" ? "背对镜头" : "侧对镜头";
            const facingEn = toPlacement.facing === "面向镜头" ? "facing camera" : toPlacement.facing === "背对镜头" ? "back to camera" : "three-quarter to camera";
            if (!moved && !turn) continue;
            if (locale === "en") {
                const text = moved ? `walk from ${sideEn(fromPlacement)} to ${sideEn(toPlacement)} (~${distance.toFixed(1)}m)` : "turn in place";
                items.push(`${seconds(depart)}→${seconds(arrive)} ${text}${turn ? `, now ${facingEn}` : ""}`);
            } else {
                const text = moved ? `从${sideZh(fromPlacement)}走到${sideZh(toPlacement)}（约 ${distance.toFixed(1)}m）` : "原地转身";
                items.push(`${seconds(depart)}→${seconds(arrive)} ${text}${turn ? `，转向${facingZh}` : ""}`);
            }
            if (track[index + 1].holdMs >= 500 && index + 1 < track.length - 1) {
                items.push(locale === "en" ? `${seconds(arrive)}→${seconds(arrive + track[index + 1].holdMs)} hold` : `${seconds(arrive)}→${seconds(arrive + track[index + 1].holdMs)} 原地停留`);
            }
        }
        const tail = track[track.length - 1].holdMs;
        if (tail >= 500) items.push(locale === "en" ? `stays until ${seconds(arrivals[arrivals.length - 1] + tail)}` : `之后站在原地直到 ${seconds(arrivals[arrivals.length - 1] + tail)}`);
        return locale === "en" ? `- ${object.name}: ${items.join("; ")}` : `- ${object.name}：${items.join("；")}`;
    });

    const idle = state.objects.filter((object) => object.visible && (object.kind === "person" || object.kind === "model") && !hasMovement(object.track));
    const idleLine = idle.length ? [locale === "en" ? `- (others stay in place: ${idle.map((object) => object.name).join(", ")})` : `- （其余人物保持原位：${idle.map((object) => object.name).join("、")}）`] : [];
    return (locale === "zh" ? "表演：\n" : "Performance:\n") + [...lines, ...idleLine].join("\n");
}

export function buildDirectorPrompt(state: StageState, locale: "zh" | "en" = state.promptLocale): string {
    const parts = [describeScene(state, locale)];
    const performance = describePerformance(state, locale);
    if (performance) parts.push(performance);
    parts.push(describeCamera(state.camera, locale), describeShotSequence(state.shots, state.motion, locale));
    if (state.shots.length >= 2 && locale === "zh") parts.push("（首帧为第 1 个机位画面，尾帧为最后一个机位画面，请保持人物外观与场景一致。）");
    if (state.shots.length >= 2 && locale === "en") parts.push("(The first frame is the first camera position and the last frame is the final one; keep the subjects and scene consistent.)");
    return parts.join("\n");
}

function sub(a: Vec3, b: Vec3): Vec3 {
    return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}
function dot(a: Vec3, b: Vec3): number {
    return a.x * b.x + a.y * b.y + a.z * b.z;
}
function length(a: Vec3): number {
    return Math.sqrt(dot(a, a));
}
function normalize(a: Vec3): Vec3 {
    const len = length(a) || 1;
    return { x: a.x / len, y: a.y / len, z: a.z / len };
}
function normalizeAngle(value: number): number {
    let angle = value % 360;
    if (angle > 180) angle -= 360;
    if (angle < -180) angle += 360;
    return angle;
}
