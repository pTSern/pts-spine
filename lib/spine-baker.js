'use strict';

const { SpineParser } = require('./spine-parser');
const { FastSpineBinary } = require('./fastspine-binary');

const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;

function clamp(v, min, max) {
    return v < min ? min : (v > max ? max : v);
}

function parseHexColor(hex) {
    if (!hex) return { r: 1, g: 1, b: 1, a: 1 };
    if (hex.startsWith('#')) hex = hex.substring(1);
    if (hex.length === 6) hex += 'ff';
    const num = parseInt(hex, 16);
    return {
        r: ((num >> 24) & 0xff) / 255,
        g: ((num >> 16) & 0xff) / 255,
        b: ((num >> 8) & 0xff) / 255,
        a: (num & 0xff) / 255,
    };
}

function packColorRGBA8(r, g, b, a) {
    const ir = Math.round(clamp(r, 0, 1) * 255);
    const ig = Math.round(clamp(g, 0, 1) * 255);
    const ib = Math.round(clamp(b, 0, 1) * 255);
    const ia = Math.round(clamp(a, 0, 1) * 255);
    return ((ir & 0xff) | ((ig & 0xff) << 8) | ((ib & 0xff) << 16) | ((ia & 0xff) << 24)) >>> 0;
}

// Cubic bezier evaluator
function solveBezier(cx1, cy1, cx2, cy2, t) {
    // Binary search for x = t
    let low = 0;
    let high = 1;
    let sampleT = t;
    for (let i = 0; i < 8; i++) {
        const u = 1 - sampleT;
        const currentX = 3 * u * u * sampleT * cx1 + 3 * u * sampleT * sampleT * cx2 + sampleT * sampleT * sampleT;
        if (Math.abs(currentX - t) < 0.001) break;
        if (currentX < t) low = sampleT;
        else high = sampleT;
        sampleT = (low + high) * 0.5;
    }
    const u = 1 - sampleT;
    return 3 * u * u * sampleT * cy1 + 3 * u * sampleT * sampleT * cy2 + sampleT * sampleT * sampleT;
}

function evaluateTimelineAlpha(kf1, kf2, t) {
    if (!kf2 || t <= kf1.time) return 0;
    if (t >= kf2.time) return 1;
    const duration = kf2.time - kf1.time;
    if (duration <= 0) return 0;
    const progress = (t - kf1.time) / duration;
    const curve = kf1.curve;
    if (curve === 'stepped') return 0;
    if (Array.isArray(curve) && curve.length >= 4) {
        return solveBezier(curve[0], curve[1], curve[2], curve[3], progress);
    }
    return progress;
}

class BoneState {
    constructor(def, index) {
        this.def = def;
        this.name = def.name;
        this.index = index;
        this.parentIndex = -1;
        this.setupX = def.x || 0;
        this.setupY = def.y || 0;
        this.setupRotation = def.rotation || 0;
        this.setupScaleX = def.scaleX !== undefined ? def.scaleX : 1;
        this.setupScaleY = def.scaleY !== undefined ? def.scaleY : 1;
        this.setupShearX = def.shearX || 0;
        this.setupShearY = def.shearY || 0;

        // Current pose
        this.x = this.setupX;
        this.y = this.setupY;
        this.rotation = this.setupRotation;
        this.scaleX = this.setupScaleX;
        this.scaleY = this.setupScaleY;
        this.shearX = this.setupShearX;
        this.shearY = this.setupShearY;

        // World matrix: [a, b, c, d, tx, ty]
        this.a = 1; this.b = 0;
        this.c = 0; this.d = 1;
        this.tx = 0; this.ty = 0;
    }

    reset() {
        this.x = this.setupX;
        this.y = this.setupY;
        this.rotation = this.setupRotation;
        this.scaleX = this.setupScaleX;
        this.scaleY = this.setupScaleY;
        this.shearX = this.setupShearX;
        this.shearY = this.setupShearY;
    }

    updateWorldTransform(parent) {
        const rotRad = this.rotation * DEG_TO_RAD;
        const shearXRad = this.shearX * DEG_TO_RAD;
        const shearYRad = this.shearY * DEG_TO_RAD;

        const la = Math.cos(rotRad + shearYRad) * this.scaleX;
        const lb = Math.sin(rotRad + shearYRad) * this.scaleX;
        const lc = -Math.sin(rotRad + shearXRad) * this.scaleY;
        const ld = Math.cos(rotRad + shearXRad) * this.scaleY;
        const ltx = this.x;
        const lty = this.y;

        if (parent) {
            this.a = parent.a * la + parent.c * lb;
            this.b = parent.b * la + parent.d * lb;
            this.c = parent.a * lc + parent.c * ld;
            this.d = parent.b * lc + parent.d * ld;
            this.tx = parent.a * ltx + parent.c * lty + parent.tx;
            this.ty = parent.b * ltx + parent.d * lty + parent.ty;
        } else {
            this.a = la; this.b = lb;
            this.c = lc; this.d = ld;
            this.tx = ltx; this.ty = lty;
        }
    }

    worldToLocal(x, y) {
        const det = this.a * this.d - this.b * this.c;
        if (Math.abs(det) < 0.00001) return { x: 0, y: 0 };
        const dx = x - this.tx;
        const dy = y - this.ty;
        return {
            x: (dx * this.d - dy * this.c) / det,
            y: (dy * this.a - dx * this.b) / det,
        };
    }
}

class SlotState {
    constructor(def, index, boneIndex) {
        this.def = def;
        this.name = def.name;
        this.index = index;
        this.boneIndex = boneIndex;
        this.setupAttachment = def.attachment || null;
        this.setupColor = parseHexColor(def.color);
        this.attachment = this.setupAttachment;
        this.color = { ...this.setupColor };
    }

    reset() {
        this.attachment = this.setupAttachment;
        this.color = { ...this.setupColor };
    }
}

class SpineBaker {
    constructor(skeletonData, atlas, options = {}) {
        this.skeleton = skeletonData;
        this.atlas = atlas;
        this.fps = options.fps || 30;
        this.skinName = options.skin || 'default';
        this.bakeAllSkins = options.bakeAllSkins || false;
        this.initSkeleton();
    }

    initSkeleton() {
        // Initialize bones
        this.bones = [];
        this.boneMap = new Map();
        for (let i = 0; i < this.skeleton.bones.length; i++) {
            const def = this.skeleton.bones[i];
            const bone = new BoneState(def, i);
            this.bones.push(bone);
            this.boneMap.set(def.name, bone);
        }
        for (let i = 0; i < this.bones.length; i++) {
            const bone = this.bones[i];
            if (bone.def.parent && this.boneMap.has(bone.def.parent)) {
                bone.parentIndex = this.boneMap.get(bone.def.parent).index;
            }
        }

        // Initialize slots
        this.slots = [];
        this.slotMap = new Map();
        for (let i = 0; i < (this.skeleton.slots || []).length; i++) {
            const def = this.skeleton.slots[i];
            const boneIdx = this.boneMap.has(def.bone) ? this.boneMap.get(def.bone).index : 0;
            const slot = new SlotState(def, i, boneIdx);
            this.slots.push(slot);
            this.slotMap.set(def.name, slot);
        }

        // Initialize skins
        this.skins = new Map();
        if (Array.isArray(this.skeleton.skins)) {
            for (const skin of this.skeleton.skins) {
                this.skins.set(skin.name, skin.attachments || {});
            }
        } else if (this.skeleton.skins) {
            for (const [name, atts] of Object.entries(this.skeleton.skins)) {
                this.skins.set(name, atts);
            }
        }
    }

    getAttachment(slotName, attachmentName, skinName = this.skinName) {
        if (!attachmentName) return null;
        // Check active skin first
        const activeSkin = this.skins.get(skinName);
        if (activeSkin && activeSkin[slotName] && activeSkin[slotName][attachmentName]) {
            return activeSkin[slotName][attachmentName];
        }
        // Fallback to default skin
        const defSkin = this.skins.get('default');
        if (defSkin && defSkin[slotName] && defSkin[slotName][attachmentName]) {
            return defSkin[slotName][attachmentName];
        }
        return null;
    }

    getAnimationDuration(animDef) {
        let maxTime = 0;
        if (!animDef) return 0;
        const checkTimelines = (obj) => {
            if (!obj) return;
            for (const key of Object.keys(obj)) {
                const item = obj[key];
                if (Array.isArray(item)) {
                    for (const kf of item) {
                        if (kf.time && kf.time > maxTime) maxTime = kf.time;
                    }
                } else if (typeof item === 'object') {
                    checkTimelines(item);
                }
            }
        };
        checkTimelines(animDef);
        return maxTime;
    }

    applyAnimationAtTime(animDef, t) {
        if (!animDef) return;

        // 1. Bones timelines
        if (animDef.bones) {
            for (const [boneName, timelines] of Object.entries(animDef.bones)) {
                const bone = this.boneMap.get(boneName);
                if (!bone) continue;

                // Rotate
                if (timelines.rotate && timelines.rotate.length > 0) {
                    bone.rotation = this._interpolateRotate(timelines.rotate, t, bone.setupRotation);
                }
                // Translate
                if (timelines.translate && timelines.translate.length > 0) {
                    const pos = this._interpolateVec2(timelines.translate, t, bone.setupX, bone.setupY);
                    bone.x = pos.x;
                    bone.y = pos.y;
                }
                // Scale
                if (timelines.scale && timelines.scale.length > 0) {
                    const sc = this._interpolateVec2(timelines.scale, t, bone.setupScaleX, bone.setupScaleY);
                    bone.scaleX = sc.x;
                    bone.scaleY = sc.y;
                }
                // Shear
                if (timelines.shear && timelines.shear.length > 0) {
                    const sh = this._interpolateVec2(timelines.shear, t, bone.setupShearX, bone.setupShearY);
                    bone.shearX = sh.x;
                    bone.shearY = sh.y;
                }
            }
        }

        // 2. Slots timelines
        if (animDef.slots) {
            for (const [slotName, timelines] of Object.entries(animDef.slots)) {
                const slot = this.slotMap.get(slotName);
                if (!slot) continue;

                // Attachment
                if (timelines.attachment && timelines.attachment.length > 0) {
                    let attName = slot.setupAttachment;
                    for (const kf of timelines.attachment) {
                        if (kf.time <= t) {
                            attName = kf.name !== undefined ? kf.name : null;
                        } else break;
                    }
                    slot.attachment = attName;
                }
                // Color
                if (timelines.color && timelines.color.length > 0) {
                    slot.color = this._interpolateColor(timelines.color, t, slot.setupColor);
                }
            }
        }
    }

    _interpolateRotate(frames, t, defaultValue) {
        if (frames.length === 0) return defaultValue;
        if (t <= frames[0].time) return defaultValue + (frames[0].angle || 0);
        const last = frames[frames.length - 1];
        if (t >= last.time) return defaultValue + (last.angle || 0);

        for (let i = 0; i < frames.length - 1; i++) {
            const kf1 = frames[i];
            const kf2 = frames[i + 1];
            if (t >= kf1.time && t <= kf2.time) {
                const alpha = evaluateTimelineAlpha(kf1, kf2, t);
                const a1 = kf1.angle || 0;
                let a2 = kf2.angle || 0;
                let diff = a2 - a1;
                while (diff > 180) diff -= 360;
                while (diff < -180) diff += 360;
                return defaultValue + a1 + diff * alpha;
            }
        }
        return defaultValue + (last.angle || 0);
    }

    _interpolateVec2(frames, t, defaultX, defaultY) {
        if (frames.length === 0) return { x: defaultX, y: defaultY };
        if (t <= frames[0].time) return { x: defaultX + (frames[0].x || 0), y: defaultY + (frames[0].y || 0) };
        const last = frames[frames.length - 1];
        if (t >= last.time) return { x: defaultX + (last.x || 0), y: defaultY + (last.y || 0) };

        for (let i = 0; i < frames.length - 1; i++) {
            const kf1 = frames[i];
            const kf2 = frames[i + 1];
            if (t >= kf1.time && t <= kf2.time) {
                const alpha = evaluateTimelineAlpha(kf1, kf2, t);
                const x1 = kf1.x || 0; const y1 = kf1.y || 0;
                const x2 = kf2.x || 0; const y2 = kf2.y || 0;
                return {
                    x: defaultX + x1 + (x2 - x1) * alpha,
                    y: defaultY + y1 + (y2 - y1) * alpha,
                };
            }
        }
        return { x: defaultX + (last.x || 0), y: defaultY + (last.y || 0) };
    }

    _interpolateColor(frames, t, defaultColor) {
        if (frames.length === 0) return { ...defaultColor };
        if (t <= frames[0].time) return parseHexColor(frames[0].color);
        const last = frames[frames.length - 1];
        if (t >= last.time) return parseHexColor(last.color);

        for (let i = 0; i < frames.length - 1; i++) {
            const kf1 = frames[i];
            const kf2 = frames[i + 1];
            if (t >= kf1.time && t <= kf2.time) {
                const alpha = evaluateTimelineAlpha(kf1, kf2, t);
                const c1 = parseHexColor(kf1.color);
                const c2 = parseHexColor(kf2.color);
                return {
                    r: c1.r + (c2.r - c1.r) * alpha,
                    g: c1.g + (c2.g - c1.g) * alpha,
                    b: c1.b + (c2.b - c1.b) * alpha,
                    a: c1.a + (c2.a - c1.a) * alpha,
                };
            }
        }
        return parseHexColor(last.color);
    }

    updateWorldTransforms() {
        for (let i = 0; i < this.bones.length; i++) {
            const bone = this.bones[i];
            const parent = bone.parentIndex >= 0 ? this.bones[bone.parentIndex] : null;
            bone.updateWorldTransform(parent);
        }
        this.applyIKConstraints();
    }

    applyIKConstraints() {
        if (!this.skeleton.ik) return;
        for (const ikDef of this.skeleton.ik) {
            const targetBone = this.boneMap.get(ikDef.target);
            if (!targetBone) continue;
            const targetX = targetBone.tx;
            const targetY = targetBone.ty;
            const mix = ikDef.mix !== undefined ? ikDef.mix : 1;
            if (mix <= 0) continue;

            const boneNames = ikDef.bones || [];
            if (boneNames.length === 1) {
                const bone = this.boneMap.get(boneNames[0]);
                if (!bone) continue;
                const parent = bone.parentIndex >= 0 ? this.bones[bone.parentIndex] : null;
                const localTarget = parent ? parent.worldToLocal(targetX, targetY) : { x: targetX, y: targetY };
                const targetAngle = Math.atan2(localTarget.y - bone.y, localTarget.x - bone.x) * RAD_TO_DEG;
                const diff = (targetAngle - bone.rotation + 540) % 360 - 180;
                bone.rotation += diff * mix;
                bone.updateWorldTransform(parent);
            } else if (boneNames.length === 2) {
                const parentBone = this.boneMap.get(boneNames[0]);
                const childBone = this.boneMap.get(boneNames[1]);
                if (!parentBone || !childBone) continue;
                this._apply2BoneIK(parentBone, childBone, targetX, targetY, ikDef.bendPositive !== false, mix);
            }
        }
    }

    _apply2BoneIK(parent, child, targetX, targetY, bendPositive, alpha) {
        const l1 = parent.def.length || 0;
        const l2 = child.def.length || 0;
        if (l1 <= 0 || l2 <= 0) return;

        const rootParent = parent.parentIndex >= 0 ? this.bones[parent.parentIndex] : null;
        const tx = rootParent ? rootParent.worldToLocal(targetX, targetY).x : targetX;
        const ty = rootParent ? rootParent.worldToLocal(targetX, targetY).y : targetY;

        const dx = tx - parent.x;
        const dy = ty - parent.y;
        const d = Math.sqrt(dx * dx + dy * dy);

        // Law of cosines
        let c2 = (d * d - l1 * l1 - l2 * l2) / (2 * l1 * l2);
        c2 = clamp(c2, -1, 1);
        let a2 = Math.acos(c2);
        if (!bendPositive) a2 = -a2;

        const c1 = (l1 * l1 + d * d - l2 * l2) / (2 * l1 * d);
        let a1 = Math.atan2(dy, dx) - Math.acos(clamp(c1, -1, 1));
        if (!bendPositive) a1 = Math.atan2(dy, dx) + Math.acos(clamp(c1, -1, 1));

        const rot1 = a1 * RAD_TO_DEG;
        const rot2 = a2 * RAD_TO_DEG;

        parent.rotation += ((rot1 - parent.rotation + 540) % 360 - 180) * alpha;
        parent.updateWorldTransform(rootParent);

        child.rotation += ((rot2 - child.rotation + 540) % 360 - 180) * alpha;
        child.updateWorldTransform(parent);
    }

    /**
     * Compute geometry (vertices, uvs, colors, indices) for current frame pose
     * @returns {{ positions: Float32Array, uvs: Float32Array, colors: Uint32Array, indices: Uint16Array }}
     */
    extractFrameGeometry() {
        const positions = [];
        const uvs = [];
        const colors = [];
        const indices = [];

        let vertexOffset = 0;

        for (let i = 0; i < this.slots.length; i++) {
            const slot = this.slots[i];
            if (!slot.attachment) continue;
            const bone = this.bones[slot.boneIndex];
            const att = this.getAttachment(slot.name, slot.attachment);
            if (!att) continue;

            const attType = att.type || 'region';
            const attColor = parseHexColor(att.color);
            const finalColor = {
                r: slot.color.r * attColor.r,
                g: slot.color.g * attColor.g,
                b: slot.color.b * attColor.b,
                a: slot.color.a * attColor.a,
            };
            const packedColor = packColorRGBA8(finalColor.r, finalColor.g, finalColor.b, finalColor.a);

            // Lookup region in texture atlas
            const regionName = att.path || att.name || slot.attachment;
            const region = this.atlas ? this.atlas.findRegion(regionName) : null;

            if (attType === 'region') {
                const w = (att.width || (region ? region.width : 50)) * 0.5 * (att.scaleX !== undefined ? att.scaleX : 1);
                const h = (att.height || (region ? region.height : 50)) * 0.5 * (att.scaleY !== undefined ? att.scaleY : 1);
                const attRot = (att.rotation || 0) * DEG_TO_RAD;
                const cos = Math.cos(attRot);
                const sin = Math.sin(attRot);
                const attX = att.x || 0;
                const attY = att.y || 0;

                // 4 local corners: BL, BR, TR, TL
                const localCorners = [
                    { x: -w * cos - -h * sin + attX, y: -w * sin + -h * cos + attY },
                    { x:  w * cos - -h * sin + attX, y:  w * sin + -h * cos + attY },
                    { x:  w * cos -  h * sin + attX, y:  w * sin +  h * cos + attY },
                    { x: -w * cos -  h * sin + attX, y: -w * sin +  h * cos + attY },
                ];

                // UVs
                const ru = region ? region.u : 0;
                const rv = region ? region.v : 0;
                const ru2 = region ? region.u2 : 1;
                const rv2 = region ? region.v2 : 1;

                const quadUVs = region && region.rotate ? [
                    ru2, rv,
                    ru2, rv2,
                    ru, rv2,
                    ru, rv,
                ] : [
                    ru, rv2,
                    ru2, rv2,
                    ru2, rv,
                    ru, rv,
                ];

                for (let c = 0; c < 4; c++) {
                    const lc = localCorners[c];
                    const wx = bone.a * lc.x + bone.c * lc.y + bone.tx;
                    const wy = bone.b * lc.x + bone.d * lc.y + bone.ty;
                    positions.push(wx, wy);
                    uvs.push(quadUVs[c * 2], quadUVs[c * 2 + 1]);
                    colors.push(packedColor);
                }

                // Indices: 2 triangles [0, 1, 2, 2, 3, 0]
                indices.push(
                    vertexOffset + 0, vertexOffset + 1, vertexOffset + 2,
                    vertexOffset + 2, vertexOffset + 3, vertexOffset + 0
                );
                vertexOffset += 4;

            } else if (attType === 'mesh' || attType === 'linkedmesh') {
                const meshUvs = att.uvs || [];
                const meshTriangles = att.triangles || [];
                const meshVertices = att.vertices || [];
                const vertCount = meshUvs.length / 2;

                const ru = region ? region.u : 0;
                const rv = region ? region.v : 0;
                const ru2 = region ? region.u2 : 1;
                const rv2 = region ? region.v2 : 1;
                const rw = ru2 - ru;
                const rh = rv2 - rv;

                let vIdx = 0;
                const isWeighted = meshVertices.length > meshUvs.length;

                for (let v = 0; v < vertCount; v++) {
                    let wx = 0;
                    let wy = 0;

                    if (!isWeighted) {
                        const px = meshVertices[v * 2] || 0;
                        const py = meshVertices[v * 2 + 1] || 0;
                        wx = bone.a * px + bone.c * py + bone.tx;
                        wy = bone.b * px + bone.d * py + bone.ty;
                    } else {
                        const boneCount = meshVertices[vIdx++];
                        for (let b = 0; b < boneCount; b++) {
                            const bIdx = meshVertices[vIdx++];
                            const px = meshVertices[vIdx++];
                            const py = meshVertices[vIdx++];
                            const weight = meshVertices[vIdx++];
                            const wb = this.bones[bIdx];
                            if (wb) {
                                wx += (wb.a * px + wb.c * py + wb.tx) * weight;
                                wy += (wb.b * px + wb.d * py + wb.ty) * weight;
                            }
                        }
                    }

                    positions.push(wx, wy);

                    // UV mapping
                    const mu = meshUvs[v * 2];
                    const mv = meshUvs[v * 2 + 1];
                    let finalU = ru + mu * rw;
                    let finalV = rv + mv * rh;
                    if (region && region.rotate) {
                        finalU = ru + mv * rw;
                        finalV = rv2 - mu * rh;
                    }
                    uvs.push(finalU, finalV);
                    colors.push(packedColor);
                }

                for (let t = 0; t < meshTriangles.length; t++) {
                    indices.push(vertexOffset + meshTriangles[t]);
                }
                vertexOffset += vertCount;
            }
        }

        return {
            positions: new Float32Array(positions),
            uvs: new Float32Array(uvs),
            colors: new Uint32Array(colors),
            indices: new Uint16Array(indices),
            vertexCount: vertexOffset,
        };
    }

    /**
     * Bake all animations into a unified FastSpine buffer
     * @returns {{ buffer: Buffer, metadata: Object }}
     */
    bake() {
        const animList = [];
        const eventList = [];
        const frames = [];
        let sharedIndices = new Uint16Array(0);
        let maxVertexCount = 0;

        const animationNames = Object.keys(this.skeleton.animations || {});
        if (animationNames.length === 0) {
            // Bake single frame setup pose
            this.resetPose();
            this.updateWorldTransforms();
            const geom = this.extractFrameGeometry();
            frames.push(geom);
            sharedIndices = geom.indices;
            maxVertexCount = geom.vertexCount;
            animList.push({
                name: 'setup',
                startFrame: 0,
                frameCount: 1,
                duration: 0.033,
                fps: this.fps,
                loop: true,
            });
        }

        let globalFrameOffset = 0;

        for (const animName of animationNames) {
            const animDef = this.skeleton.animations[animName];
            const duration = this.getAnimationDuration(animDef);
            const frameCount = Math.max(1, Math.round(duration * this.fps)) + (duration > 0 ? 1 : 0);
            const dt = frameCount > 1 ? duration / (frameCount - 1) : 0;

            const animStartFrame = globalFrameOffset;

            // Collect animation events
            if (animDef.events) {
                for (const ev of animDef.events) {
                    const evFrame = Math.round((ev.time || 0) * this.fps);
                    eventList.push({
                        name: ev.name,
                        frame: animStartFrame + evFrame,
                        time: ev.time || 0,
                        intValue: ev.int || 0,
                        floatValue: ev.float || 0,
                        stringValue: ev.string || '',
                    });
                }
            }

            for (let f = 0; f < frameCount; f++) {
                const t = f * dt;
                this.resetPose();
                this.applyAnimationAtTime(animDef, t);
                this.updateWorldTransforms();
                const geom = this.extractFrameGeometry();
                frames.push(geom);
                if (geom.vertexCount > maxVertexCount) {
                    maxVertexCount = geom.vertexCount;
                }
                if (sharedIndices.length === 0 && geom.indices.length > 0) {
                    sharedIndices = geom.indices;
                }
            }

            animList.push({
                name: animName,
                startFrame: animStartFrame,
                frameCount,
                duration: duration > 0 ? duration : 1 / this.fps,
                fps: this.fps,
                loop: true,
            });

            globalFrameOffset += frameCount;
        }

        // Align all frames to maxVertexCount
        for (let i = 0; i < frames.length; i++) {
            const f = frames[i];
            if (f.vertexCount < maxVertexCount) {
                const paddedPos = new Float32Array(maxVertexCount * 2);
                paddedPos.set(f.positions, 0);
                const paddedUv = new Float32Array(maxVertexCount * 2);
                paddedUv.set(f.uvs, 0);
                const paddedCol = new Uint32Array(maxVertexCount);
                paddedCol.set(f.colors, 0);
                frames[i] = {
                    positions: paddedPos,
                    uvs: paddedUv,
                    colors: paddedCol,
                };
            }
        }

        const encoded = FastSpineBinary.encode({
            fps: this.fps,
            vertexCountPerFrame: maxVertexCount,
            indices: sharedIndices,
            frames,
            animations: animList,
            events: eventList,
            flags: 0,
        });

        const metadata = {
            fps: this.fps,
            totalFrames: frames.length,
            vertexCountPerFrame: maxVertexCount,
            indexCount: sharedIndices.length,
            animations: animList,
            events: eventList,
            skins: Array.from(this.skins.keys()),
            binarySize: encoded.length,
            bonesCount: this.bones.length,
            slotsCount: this.slots.length,
        };

        return {
            buffer: encoded,
            metadata,
        };
    }

    resetPose() {
        for (let i = 0; i < this.bones.length; i++) {
            this.bones[i].reset();
        }
        for (let i = 0; i < this.slots.length; i++) {
            this.slots[i].reset();
        }
    }
}

module.exports = {
    SpineBaker,
    BoneState,
    SlotState,
};
