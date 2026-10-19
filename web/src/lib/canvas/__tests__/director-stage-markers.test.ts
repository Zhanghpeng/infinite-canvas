// 场景相机元素里唯一「算数」的部分：取景锥的缩放要跟着焦距走（焦距越短视野越大）。
// 造标记本身要 WebGL/three 实例，这里只钉住这条不变量。
import { describe, expect, it } from "vitest";

import { applyCameraToMarker, frustumScale, overviewCamera } from "../../../../../plugins/canvas/director-stage/src/markers";
import { eyePosition, focalToFov } from "../../../../../plugins/canvas/director-stage/src/prompt";
import { DEFAULT_CAMERA } from "../../../../../plugins/canvas/director-stage/src/stage-state";

const DEG = Math.PI / 180;
const DEPTH = 1.8;
const BASE_HALF = 0.5;

describe("相机元素的取景锥", () => {
    it("缩放 = 深度 × tan(视场角/2) / 基准半高", () => {
        const expected = (DEPTH * Math.tan((focalToFov(35) * DEG) / 2)) / BASE_HALF;
        expect(frustumScale(35)).toBeCloseTo(expected, 10);
    });

    it("焦距越短视野越大：24mm > 35mm > 85mm", () => {
        expect(frustumScale(24)).toBeGreaterThan(frustumScale(35));
        expect(frustumScale(35)).toBeGreaterThan(frustumScale(85));
        // 14~135mm 都在合理区间内，不会出现零或爆掉的锥体
        expect(frustumScale(14)).toBeGreaterThan(1);
        expect(frustumScale(135)).toBeLessThan(1);
        expect(frustumScale(135)).toBeGreaterThan(0);
    });
});

describe("「看全场」机位", () => {
    const person = (x: number, z: number) => ({ id: `p-${x}-${z}`, name: "人", kind: "person" as const, visible: true, x, z, rotationYDeg: 0, scale: 1 });

    it("把最远的物体与机位都框进来：距离随场景半径增长", () => {
        const near = overviewCamera({ objects: [person(0, 0)], shots: [] });
        const far = overviewCamera({ objects: [person(9, 9)], shots: [] });
        expect(far.distance).toBeGreaterThan(near.distance);
        expect(near.distance).toBeGreaterThanOrEqual(6);
        // 俯视 + 广角，方便一眼看全
        expect(far.elevationDeg).toBeGreaterThan(20);
        expect(far.focalMm).toBeLessThanOrEqual(35);
    });

    it("关键帧机位也算进包围范围（机位跑得远也要看得见）", () => {
        const shots = [{ id: "s1", name: "机位 1", holdMs: 0, camera: { azimuthDeg: 0, elevationDeg: 10, distance: 12, targetY: 1, focalMm: 35 } }];
        const withShot = overviewCamera({ objects: [person(0, 0)], shots });
        const withoutShot = overviewCamera({ objects: [person(0, 0)], shots: [] });
        expect(withShot.distance).toBeGreaterThan(withoutShot.distance);
    });

    it("隐藏的物体不算数", () => {
        const hidden = { ...person(9, 9), visible: false };
        // 与场景里什么都没有一致（隐藏物体不参与包围）
        expect(overviewCamera({ objects: [hidden], shots: [] }).distance).toBe(overviewCamera({ objects: [], shots: [] }).distance);
    });
});

describe("相机标记的摆放与朝向", () => {
    const fakeMarker = () => {
        const calls: Array<[string, number[]]> = [];
        const marker = {
            group: {
                position: { set: (...args: number[]) => calls.push(["position", args]) },
                lookAt: (...args: number[]) => calls.push(["lookAt", args]),
                rotateY: (...args: number[]) => calls.push(["rotateY", args]),
            },
            frustum: { scale: { set: (...args: number[]) => calls.push(["frustumScale", args]) } },
        };
        return { marker, calls };
    };

    it("站在眼睛位置、看向视线目标，并补一次 180° 转向（否则相机会背对主体）", () => {
        const { marker, calls } = fakeMarker();
        applyCameraToMarker(marker as never, DEFAULT_CAMERA);

        const eye = eyePosition(DEFAULT_CAMERA);
        const position = calls.find(([name]) => name === "position")![1];
        expect(position[0]).toBeCloseTo(eye.x, 6);
        expect(position[1]).toBeCloseTo(eye.y, 6);
        expect(position[2]).toBeCloseTo(eye.z, 6);

        expect(calls.find(([name]) => name === "lookAt")![1]).toEqual([0, DEFAULT_CAMERA.targetY, 0]);
        // lookAt 之后必须补 180°：Group 的 +Z 朝目标，而镜头/取景锥做在 -Z
        const order = calls.map(([name]) => name);
        expect(order).toEqual(["position", "lookAt", "rotateY", "frustumScale"]);
        expect(calls.find(([name]) => name === "rotateY")![1][0]).toBeCloseTo(Math.PI, 10);
    });

    it("取景锥的缩放跟着这台机位的焦距走", () => {
        const { marker, calls } = fakeMarker();
        applyCameraToMarker(marker as never, { ...DEFAULT_CAMERA, focalMm: 85 });
        const scale = calls.find(([name]) => name === "frustumScale")![1];
        expect(scale[0]).toBeCloseTo(frustumScale(85), 10);
        expect(scale[1]).toBeCloseTo(frustumScale(85), 10);
        expect(scale[2]).toBe(1);
    });
});
