'use strict';

const fs = require('fs');
const path = require('path');
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

function solveBezier(cx1, cy1, cx2, cy2, t) {
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

function resolveSpineWasmDir() {
    if (typeof Editor !== 'undefined' && Editor.App && Editor.App.path) {
        const p1 = path.join(Editor.App.path, 'resources/3d/engine/native/external/emscripten/spine/3.8');
        if (fs.existsSync(path.join(p1, 'spine.wasm'))) return p1;
        const p2 = path.join(Editor.App.path, 'resources/resources/3d/engine/native/external/emscripten/spine/3.8');
        if (fs.existsSync(path.join(p2, 'spine.wasm'))) return p2;
    }
    const cfgPath = 'E:/.cocos/.reverse/EDITOR/config.json';
    if (fs.existsSync(cfgPath)) {
        try {
            const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8').replace(/^\uFEFF/, ''));
            if (cfg.creatorRoot) {
                const p = path.join(cfg.creatorRoot, 'resources/resources/3d/engine/native/external/emscripten/spine/3.8');
                if (fs.existsSync(path.join(p, 'spine.wasm'))) return p;
                const pAlt = path.join(cfg.creatorRoot, 'resources/3d/engine/native/external/emscripten/spine/3.8');
                if (fs.existsSync(path.join(pAlt, 'spine.wasm'))) return pAlt;
            }
        } catch (e) {}
    }
    const fallback = 'E:/Editor/Creator/3.8.8/resources/resources/3d/engine/native/external/emscripten/spine/3.8';
    if (fs.existsSync(path.join(fallback, 'spine.wasm'))) return fallback;
    return null;
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

        this.x = this.setupX;
        this.y = this.setupY;
        this.rotation = this.setupRotation;
        this.scaleX = this.setupScaleX;
        this.scaleY = this.setupScaleY;
        this.shearX = this.setupShearX;
        this.shearY = this.setupShearY;

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
        const rotationY = this.rotation + 90 + this.shearY;
        const rotYRad = rotationY * DEG_TO_RAD;
        const rotXRad = (this.rotation + this.shearX) * DEG_TO_RAD;

        const la = Math.cos(rotXRad) * this.scaleX;
        const lb = Math.cos(rotYRad) * this.scaleY;
        const lc = Math.sin(rotXRad) * this.scaleX;
        const ld = Math.sin(rotYRad) * this.scaleY;
        const ltx = this.x;
        const lty = this.y;

        if (parent) {
            const pa = parent.a, pb = parent.b, pc = parent.c, pd = parent.d;
            this.a = pa * la + pb * lc;
            this.b = pa * lb + pb * ld;
            this.c = pc * la + pd * lc;
            this.d = pc * lb + pd * ld;
            this.tx = pa * ltx + pb * lty + parent.tx;
            this.ty = pc * ltx + pd * lty + parent.ty;
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
            x: (dx * this.d - dy * this.b) / det,
            y: (dy * this.a - dx * this.c) / det,
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
        this.spineJsonPath = options.spineJsonPath;
        this.atlasPath = options.atlasPath;
        this.initSkeleton();
        this.initTopology();
    }

    initSkeleton() {
        this.bones = [];
        this.boneMap = new Map();
        for (let i = 0; i < (this.skeleton.bones || []).length; i++) {
            const def = this.skeleton.bones[i];
            const bone = new BoneState(def, i);
            this.bones.push(bone);
            this.boneMap.set(def.name, bone);
        }
        for (let i = 0; i < this.bones.length; i++) {
            const bone = this.bones[i];
            bone.children = [];
            if (bone.def.parent && this.boneMap.has(bone.def.parent)) {
                bone.parentIndex = this.boneMap.get(bone.def.parent).index;
            }
        }
        for (let i = 0; i < this.bones.length; i++) {
            const bone = this.bones[i];
            if (bone.parentIndex >= 0) {
                this.bones[bone.parentIndex].children.push(bone);
            }
        }

        this.slots = [];
        this.slotMap = new Map();
        for (let i = 0; i < (this.skeleton.slots || []).length; i++) {
            const def = this.skeleton.slots[i];
            const boneIdx = this.boneMap.has(def.bone) ? this.boneMap.get(def.bone).index : 0;
            const slot = new SlotState(def, i, boneIdx);
            this.slots.push(slot);
            this.slotMap.set(def.name, slot);
        }

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

        this.constraints = [];
        if (this.skeleton.ik) {
            for (const ik of this.skeleton.ik) {
                this.constraints.push({ type: 'ik', order: ik.order !== undefined ? ik.order : 0, data: ik });
            }
        }
        if (this.skeleton.transform) {
            for (const tc of this.skeleton.transform) {
                this.constraints.push({ type: 'transform', order: tc.order !== undefined ? tc.order : 0, data: tc });
            }
        }
        this.constraints.sort((a, b) => a.order - b.order);
    }

    /**
     * Dedicated Attachment Topology
     * Gives every slot attachment its own dedicated vertex and triangle range
     * to eliminate stretched triangle artifacts when slots switch attachments.
     */
    initTopology() {
        this.attGeometries = [];
        this.allIndices = [];
        let totalVerts = 0;

        // Iterate slots in draw order
        for (let sIdx = 0; sIdx < this.slots.length; sIdx++) {
            const slot = this.slots[sIdx];
            const slotName = slot.name;

            // Collect all unique attachments used by this slot
            const attDefs = new Map();

            // From all skins
            for (const [skinName, skinAtts] of this.skins.entries()) {
                if (skinAtts[slotName]) {
                    for (const [attName, attDef] of Object.entries(skinAtts[slotName])) {
                        if (!attDefs.has(attName)) {
                            attDefs.set(attName, attDef);
                        }
                    }
                }
            }

            for (const [attName, attDef] of attDefs.entries()) {
                let vc = 4;
                let tris = [0, 1, 2, 2, 3, 0];
                if (attDef.type === 'mesh' || attDef.type === 'linkedmesh') {
                    vc = (attDef.uvs || []).length / 2;
                    tris = attDef.triangles || [];
                }

                const startVert = totalVerts;
                for (let t = 0; t < tris.length; t++) {
                    this.allIndices.push(startVert + tris[t]);
                }

                this.attGeometries.push({
                    slotName,
                    slotIndex: sIdx,
                    boneIndex: slot.boneIndex,
                    attName,
                    attDef,
                    type: attDef.type || 'region',
                    startVert,
                    vertCount: vc,
                    triangles: tris,
                });

                totalVerts += vc;
            }
        }

        this.totalVerts = totalVerts;
        this.sharedIndices = new Uint16Array(this.allIndices);
    }

    getAttachment(slotName, attachmentName, skinName = this.skinName) {
        if (!attachmentName) return null;
        const activeSkin = this.skins.get(skinName);
        if (activeSkin && activeSkin[slotName] && activeSkin[slotName][attachmentName]) {
            return activeSkin[slotName][attachmentName];
        }
        const defSkin = this.skins.get('default');
        if (defSkin && defSkin[slotName] && defSkin[slotName][attachmentName]) {
            return defSkin[slotName][attachmentName];
        }
        return null;
    }

    async bake() {
        const wasmDir = resolveSpineWasmDir();
        if (wasmDir && this.spineJsonPath) {
            try {
                return await this.bakeWithWasm(wasmDir);
            } catch (err) {
                console.warn('[SpineBaker] WASM baking failed, falling back to pure JS engine:', err.message);
            }
        }
        return this.bakeWithJs();
    }

    /**
     * Primary High-Precision Engine: Cocos Creator's official Spine 3.8 C++ WebAssembly runtime
     */
    async bakeWithWasm(wasmDir) {
        const wasmBinaryPath = path.join(wasmDir, 'spine.wasm');
        const wasmJsPath = path.join(wasmDir, 'spine.wasm.js');
        const wasmBinary = fs.readFileSync(wasmBinaryPath);
        const factory = require(wasmJsPath).default;

        const spine = await factory({ wasmBinary });
        spine.SpineWasmUtil.spineWasmInit();

        const jsonStr = fs.readFileSync(this.spineJsonPath, 'utf8');
        let atlasStr = '';
        if (this.atlasPath && fs.existsSync(this.atlasPath)) {
            atlasStr = fs.readFileSync(this.atlasPath, 'utf8');
        } else if (this.atlas && this.atlas.rawText) {
            atlasStr = this.atlas.rawText;
        }

        const atlasPageNames = [];
        if (this.atlas && this.atlas.pages) {
            for (const page of this.atlas.pages) atlasPageNames.push(page.name);
        }
        if (atlasPageNames.length === 0) atlasPageNames.push('Main.png');

        const skelData = spine.SpineWasmUtil.createSpineSkeletonDataWithJson(jsonStr, atlasStr, atlasPageNames, atlasPageNames);
        const instance = new spine.SkeletonInstance();
        instance.isCache = true;
        const skeleton = instance.initSkeleton(skelData);

        const animList = [];
        const eventList = [];
        const frames = [];
        let globalFrameOffset = 0;

        const regVec = new spine.SPVectorFloat();
        regVec.resize(8, 0);
        const meshVecMap = new Map();

        const animationNames = Object.keys(this.skeleton.animations || {});
        for (const animName of animationNames) {
            const animDef = this.skeleton.animations[animName];
            const wasmAnim = skelData.findAnimation(animName);
            const duration = wasmAnim ? wasmAnim.duration : (this.getAnimationDuration(animDef));
            const frameCount = Math.max(1, Math.round(duration * this.fps)) + (duration > 0 ? 1 : 0);
            const dt = frameCount > 1 ? duration / (frameCount - 1) : 0;
            const animStartFrame = globalFrameOffset;

            // Events
            if (animDef && animDef.events) {
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

            instance.setAnimation(0, animName, false);

            for (let f = 0; f < frameCount; f++) {
                if (f > 0) instance.updateAnimation(dt);
                else instance.updateAnimation(0);
                skeleton.updateWorldTransform();

                const pos = new Float32Array(this.totalVerts * 2);
                const uvs = new Float32Array(this.totalVerts * 2);
                const cols = new Uint32Array(this.totalVerts);

                for (const geo of this.attGeometries) {
                    const slot = skeleton.findSlot(geo.slotName);
                    const activeAtt = slot ? slot.getAttachment() : null;
                    const isActive = activeAtt && activeAtt.name === geo.attName;

                    if (isActive) {
                        const sr = slot.color.r, sg = slot.color.g, sb = slot.color.b, sa = slot.color.a;
                        const ar = activeAtt.color.r, ag = activeAtt.color.g, ab = activeAtt.color.b, aa = activeAtt.color.a;
                        const cr = Math.round(clamp(sr * ar, 0, 1) * 255);
                        const cg = Math.round(clamp(sg * ag, 0, 1) * 255);
                        const cb = Math.round(clamp(sb * ab, 0, 1) * 255);
                        const ca = Math.round(clamp(sa * aa, 0, 1) * 255);
                        const packedCol = ((cr & 0xff) | ((cg & 0xff) << 8) | ((cb & 0xff) << 16) | ((ca & 0xff) << 24)) >>> 0;

                        const attUVs = activeAtt.getUVs();

                        if (activeAtt.worldVerticesLength) {
                            let mVec = meshVecMap.get(activeAtt.worldVerticesLength);
                            if (!mVec) {
                                mVec = new spine.SPVectorFloat();
                                mVec.resize(activeAtt.worldVerticesLength, 0);
                                meshVecMap.set(activeAtt.worldVerticesLength, mVec);
                            }
                            activeAtt.computeWorldVertices(slot, 0, activeAtt.worldVerticesLength, mVec, 0, 2);
                            for (let v = 0; v < geo.vertCount; v++) {
                                const dst = (geo.startVert + v) * 2;
                                pos[dst] = mVec.get(v * 2);
                                pos[dst + 1] = mVec.get(v * 2 + 1);
                                uvs[dst] = attUVs.get(v * 2);
                                uvs[dst + 1] = attUVs.get(v * 2 + 1);
                                cols[geo.startVert + v] = packedCol;
                            }
                        } else {
                            activeAtt.computeWorldVertices(slot.bone, regVec, 0, 2);
                            for (let v = 0; v < 4; v++) {
                                const dst = (geo.startVert + v) * 2;
                                pos[dst] = regVec.get(v * 2);
                                pos[dst + 1] = regVec.get(v * 2 + 1);
                                uvs[dst] = attUVs.get(v * 2);
                                uvs[dst + 1] = attUVs.get(v * 2 + 1);
                                cols[geo.startVert + v] = packedCol;
                            }
                        }
                    } else {
                        const bx = slot ? slot.bone.worldX : 0;
                        const by = slot ? slot.bone.worldY : 0;
                        for (let v = 0; v < geo.vertCount; v++) {
                            const dst = (geo.startVert + v) * 2;
                            pos[dst] = bx;
                            pos[dst + 1] = by;
                            uvs[dst] = 0;
                            uvs[dst + 1] = 0;
                            cols[geo.startVert + v] = 0;
                        }
                    }
                }

                frames.push({ positions: pos, uvs, colors: cols });
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

        const encoded = FastSpineBinary.encode({
            fps: this.fps,
            vertexCountPerFrame: this.totalVerts,
            indices: this.sharedIndices,
            frames,
            animations: animList,
            events: eventList,
            flags: 0,
        });

        const metadata = {
            fps: this.fps,
            totalFrames: frames.length,
            vertexCountPerFrame: this.totalVerts,
            indexCount: this.sharedIndices.length,
            animations: animList,
            events: eventList,
            skins: Array.from(this.skins.keys()),
            binarySize: encoded.length,
            bonesCount: this.bones.length,
            slotsCount: this.slots.length,
            engine: 'SpineWasm 3.8',
        };

        return {
            buffer: encoded,
            metadata,
        };
    }

    /**
     * Fallback Pure JS Engine with corrected matrix math
     */
    bakeWithJs() {
        const animList = [];
        const eventList = [];
        const frames = [];
        let globalFrameOffset = 0;

        const animationNames = Object.keys(this.skeleton.animations || {});
        for (const animName of animationNames) {
            const animDef = this.skeleton.animations[animName];
            const duration = this.getAnimationDuration(animDef);
            const frameCount = Math.max(1, Math.round(duration * this.fps)) + (duration > 0 ? 1 : 0);
            const dt = frameCount > 1 ? duration / (frameCount - 1) : 0;
            const animStartFrame = globalFrameOffset;

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

                const pos = new Float32Array(this.totalVerts * 2);
                const uvs = new Float32Array(this.totalVerts * 2);
                const cols = new Uint32Array(this.totalVerts);

                for (const geo of this.attGeometries) {
                    const slot = this.slots[geo.slotIndex];
                    const bone = this.bones[slot.boneIndex];
                    const isActive = slot.attachment === geo.attName;

                    if (isActive) {
                        const att = geo.attDef;
                        const attColor = parseHexColor(att.color);
                        const finalColor = {
                            r: slot.color.r * attColor.r,
                            g: slot.color.g * attColor.g,
                            b: slot.color.b * attColor.b,
                            a: slot.color.a * attColor.a,
                        };
                        const packedColor = packColorRGBA8(finalColor.r, finalColor.g, finalColor.b, finalColor.a);
                        const regionName = att.path || att.name || geo.attName;
                        const region = this.atlas ? this.atlas.findRegion(regionName) : null;

                        if (geo.type === 'region') {
                            const w = (att.width || (region ? region.width : 50)) * 0.5 * (att.scaleX !== undefined ? att.scaleX : 1);
                            const h = (att.height || (region ? region.height : 50)) * 0.5 * (att.scaleY !== undefined ? att.scaleY : 1);
                            const attRot = (att.rotation || 0) * DEG_TO_RAD;
                            const cos = Math.cos(attRot);
                            const sin = Math.sin(attRot);
                            const attX = att.x || 0;
                            const attY = att.y || 0;

                            const localCorners = [
                                { x: -w * cos - -h * sin + attX, y: -w * sin + -h * cos + attY },
                                { x:  w * cos - -h * sin + attX, y:  w * sin + -h * cos + attY },
                                { x:  w * cos -  h * sin + attX, y:  w * sin +  h * cos + attY },
                                { x: -w * cos -  h * sin + attX, y: -w * sin +  h * cos + attY },
                            ];

                            const ru = region ? region.u : 0;
                            const rv = region ? region.v : 0;
                            const ru2 = region ? region.u2 : 1;
                            const rv2 = region ? region.v2 : 1;
                            const quadUVs = region && region.rotate ? [
                                ru2, rv, ru2, rv2, ru, rv2, ru, rv,
                            ] : [
                                ru, rv2, ru2, rv2, ru2, rv, ru, rv,
                            ];

                            for (let c = 0; c < 4; c++) {
                                const lc = localCorners[c];
                                const wx = lc.x * bone.a + lc.y * bone.b + bone.tx;
                                const wy = lc.x * bone.c + lc.y * bone.d + bone.ty;
                                const dst = (geo.startVert + c) * 2;
                                pos[dst] = wx;
                                pos[dst + 1] = wy;
                                uvs[dst] = quadUVs[c * 2];
                                uvs[dst + 1] = quadUVs[c * 2 + 1];
                                cols[geo.startVert + c] = packedColor;
                            }
                        } else {
                            // Mesh
                            const meshUvs = att.uvs || [];
                            const meshVertices = att.vertices || [];
                            const vertCount = geo.vertCount;
                            const ru = region ? region.u : 0;
                            const rv = region ? region.v : 0;
                            const ru2 = region ? region.u2 : 1;
                            const rv2 = region ? region.v2 : 1;
                            const rw = ru2 - ru;
                            const rh = rv2 - rv;
                            const isWeighted = meshVertices.length > meshUvs.length;

                            let vIdx = 0;
                            for (let v = 0; v < vertCount; v++) {
                                let wx = 0;
                                let wy = 0;
                                if (!isWeighted) {
                                    const px = meshVertices[v * 2] || 0;
                                    const py = meshVertices[v * 2 + 1] || 0;
                                    wx = px * bone.a + py * bone.b + bone.tx;
                                    wy = px * bone.c + py * bone.d + bone.ty;
                                } else {
                                    const boneCount = meshVertices[vIdx++];
                                    for (let b = 0; b < boneCount; b++) {
                                        const bIdx = meshVertices[vIdx++];
                                        const px = meshVertices[vIdx++];
                                        const py = meshVertices[vIdx++];
                                        const weight = meshVertices[vIdx++];
                                        const wb = this.bones[bIdx];
                                        if (wb) {
                                            wx += (px * wb.a + py * wb.b + wb.tx) * weight;
                                            wy += (px * wb.c + py * wb.d + wb.ty) * weight;
                                        }
                                    }
                                }
                                const dst = (geo.startVert + v) * 2;
                                pos[dst] = wx;
                                pos[dst + 1] = wy;
                                const mu = meshUvs[v * 2];
                                const mv = meshUvs[v * 2 + 1];
                                let fu = ru + mu * rw;
                                let fv = rv + mv * rh;
                                if (region && region.rotate) {
                                    fu = ru + mv * rw;
                                    fv = rv2 - mu * rh;
                                }
                                uvs[dst] = fu;
                                uvs[dst + 1] = fv;
                                cols[geo.startVert + v] = packedColor;
                            }
                        }
                    } else {
                        for (let v = 0; v < geo.vertCount; v++) {
                            const dst = (geo.startVert + v) * 2;
                            pos[dst] = bone.tx;
                            pos[dst + 1] = bone.ty;
                            uvs[dst] = 0;
                            uvs[dst + 1] = 0;
                            cols[geo.startVert + v] = 0;
                        }
                    }
                }

                frames.push({ positions: pos, uvs, colors: cols });
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

        const encoded = FastSpineBinary.encode({
            fps: this.fps,
            vertexCountPerFrame: this.totalVerts,
            indices: this.sharedIndices,
            frames,
            animations: animList,
            events: eventList,
            flags: 0,
        });

        const metadata = {
            fps: this.fps,
            totalFrames: frames.length,
            vertexCountPerFrame: this.totalVerts,
            indexCount: this.sharedIndices.length,
            animations: animList,
            events: eventList,
            skins: Array.from(this.skins.keys()),
            binarySize: encoded.length,
            bonesCount: this.bones.length,
            slotsCount: this.slots.length,
            engine: 'PureJS (Corrected Math)',
        };

        return {
            buffer: encoded,
            metadata,
        };
    }

    getAnimationDuration(animDef) {
        let maxTime = 0;
        if (animDef.bones) {
            for (const boneAnims of Object.values(animDef.bones)) {
                for (const timeline of Object.values(boneAnims)) {
                    if (Array.isArray(timeline)) {
                        for (const kf of timeline) {
                            if (kf.time && kf.time > maxTime) maxTime = kf.time;
                        }
                    }
                }
            }
        }
        if (animDef.slots) {
            for (const slotAnims of Object.values(animDef.slots)) {
                for (const timeline of Object.values(slotAnims)) {
                    if (Array.isArray(timeline)) {
                        for (const kf of timeline) {
                            if (kf.time && kf.time > maxTime) maxTime = kf.time;
                        }
                    }
                }
            }
        }
        return maxTime;
    }

    resetPose() {
        for (let i = 0; i < this.bones.length; i++) {
            this.bones[i].reset();
        }
        for (let i = 0; i < this.slots.length; i++) {
            this.slots[i].reset();
        }
    }

    applyAnimationAtTime(animDef, t) {
        if (!animDef) return;
        if (animDef.bones) {
            for (const [boneName, timelines] of Object.entries(animDef.bones)) {
                const bone = this.boneMap.get(boneName);
                if (!bone) continue;

                if (timelines.rotate) {
                    bone.rotation = this.interpolateTimelineScalar(timelines.rotate, t, bone.setupRotation, 'angle');
                }
                if (timelines.translate) {
                    const pos = this.interpolateTimelineVec2(timelines.translate, t, bone.setupX, bone.setupY);
                    bone.x = pos.x;
                    bone.y = pos.y;
                }
                if (timelines.scale) {
                    const sc = this.interpolateTimelineVec2(timelines.scale, t, bone.setupScaleX, bone.setupScaleY, 'x', 'y', 1, 1);
                    bone.scaleX = sc.x;
                    bone.scaleY = sc.y;
                }
                if (timelines.shear) {
                    const sh = this.interpolateTimelineVec2(timelines.shear, t, bone.setupShearX, bone.setupShearY);
                    bone.shearX = sh.x;
                    bone.shearY = sh.y;
                }
            }
        }

        if (animDef.slots) {
            for (const [slotName, timelines] of Object.entries(animDef.slots)) {
                const slot = this.slotMap.get(slotName);
                if (!slot) continue;

                if (timelines.attachment) {
                    slot.attachment = this.evaluateAttachmentTimeline(timelines.attachment, t, slot.setupAttachment);
                }
                if (timelines.color) {
                    slot.color = this.interpolateColorTimeline(timelines.color, t, slot.setupColor);
                }
            }
        }
    }

    interpolateTimelineScalar(keyframes, t, setupVal, prop = 'value') {
        if (!keyframes || keyframes.length === 0) return setupVal;
        if (t <= keyframes[0].time) return keyframes[0][prop] !== undefined ? keyframes[0][prop] : setupVal;
        if (t >= keyframes[keyframes.length - 1].time) {
            const last = keyframes[keyframes.length - 1];
            return last[prop] !== undefined ? last[prop] : setupVal;
        }

        for (let i = 0; i < keyframes.length - 1; i++) {
            const kf1 = keyframes[i];
            const kf2 = keyframes[i + 1];
            if (t >= kf1.time && t <= kf2.time) {
                const alpha = evaluateTimelineAlpha(kf1, kf2, t);
                const v1 = kf1[prop] !== undefined ? kf1[prop] : setupVal;
                const v2 = kf2[prop] !== undefined ? kf2[prop] : setupVal;
                return v1 + (v2 - v1) * alpha;
            }
        }
        return setupVal;
    }

    interpolateTimelineVec2(keyframes, t, setupX, setupY, propX = 'x', propY = 'y', defX = 0, defY = 0) {
        if (!keyframes || keyframes.length === 0) return { x: setupX, y: setupY };
        if (t <= keyframes[0].time) {
            return {
                x: keyframes[0][propX] !== undefined ? keyframes[0][propX] : setupX,
                y: keyframes[0][propY] !== undefined ? keyframes[0][propY] : setupY,
            };
        }
        if (t >= keyframes[keyframes.length - 1].time) {
            const last = keyframes[keyframes.length - 1];
            return {
                x: last[propX] !== undefined ? last[propX] : setupX,
                y: last[propY] !== undefined ? last[propY] : setupY,
            };
        }

        for (let i = 0; i < keyframes.length - 1; i++) {
            const kf1 = keyframes[i];
            const kf2 = keyframes[i + 1];
            if (t >= kf1.time && t <= kf2.time) {
                const alpha = evaluateTimelineAlpha(kf1, kf2, t);
                const x1 = kf1[propX] !== undefined ? kf1[propX] : (propX === 'x' ? defX : setupX);
                const y1 = kf1[propY] !== undefined ? kf1[propY] : (propY === 'y' ? defY : setupY);
                const x2 = kf2[propX] !== undefined ? kf2[propX] : (propX === 'x' ? defX : setupX);
                const y2 = kf2[propY] !== undefined ? kf2[propY] : (propY === 'y' ? defY : setupY);
                return {
                    x: x1 + (x2 - x1) * alpha,
                    y: y1 + (y2 - y1) * alpha,
                };
            }
        }
        return { x: setupX, y: setupY };
    }

    evaluateAttachmentTimeline(keyframes, t, setupAttachment) {
        if (!keyframes || keyframes.length === 0) return setupAttachment;
        if (t < keyframes[0].time) return setupAttachment;
        let activeName = setupAttachment;
        for (let i = 0; i < keyframes.length; i++) {
            if (t >= keyframes[i].time) {
                activeName = keyframes[i].name !== undefined ? keyframes[i].name : null;
            } else {
                break;
            }
        }
        return activeName;
    }

    interpolateColorTimeline(keyframes, t, setupColor) {
        if (!keyframes || keyframes.length === 0) return { ...setupColor };
        if (t <= keyframes[0].time) return parseHexColor(keyframes[0].color);
        if (t >= keyframes[keyframes.length - 1].time) {
            return parseHexColor(keyframes[keyframes.length - 1].color);
        }

        for (let i = 0; i < keyframes.length - 1; i++) {
            const kf1 = keyframes[i];
            const kf2 = keyframes[i + 1];
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
        return { ...setupColor };
    }

    updateWorldTransforms() {
        for (let i = 0; i < this.bones.length; i++) {
            const bone = this.bones[i];
            const parent = bone.parentIndex >= 0 ? this.bones[bone.parentIndex] : null;
            bone.updateWorldTransform(parent);
        }

        if (this.constraints) {
            for (const c of this.constraints) {
                if (c.type === 'ik') {
                    this.applyIKConstraintSingle(c.data);
                } else if (c.type === 'transform') {
                    this.applyTransformConstraint(c.data);
                }
            }
        }
    }

    updateBoneWorldTransformsRecursive(bone) {
        if (!bone.children) return;
        for (const child of bone.children) {
            child.updateWorldTransform(bone);
            this.updateBoneWorldTransformsRecursive(child);
        }
    }

    applyIKConstraintSingle(ikDef) {
        const targetBone = this.boneMap.get(ikDef.target);
        if (!targetBone) return;
        const targetX = targetBone.tx;
        const targetY = targetBone.ty;
        const mix = ikDef.mix !== undefined ? ikDef.mix : 1;
        if (mix <= 0) return;

        const boneNames = ikDef.bones || [];
        if (boneNames.length === 1) {
            const bone = this.boneMap.get(boneNames[0]);
            if (!bone) return;
            const parent = bone.parentIndex >= 0 ? this.bones[bone.parentIndex] : null;
            const localTarget = parent ? parent.worldToLocal(targetX, targetY) : { x: targetX, y: targetY };
            const targetAngle = Math.atan2(localTarget.y - bone.y, localTarget.x - bone.x) * RAD_TO_DEG;
            const diff = (targetAngle - bone.rotation + 540) % 360 - 180;
            bone.rotation += diff * mix;
            bone.updateWorldTransform(parent);
            this.updateBoneWorldTransformsRecursive(bone);
        } else if (boneNames.length === 2) {
            const parentBone = this.boneMap.get(boneNames[0]);
            const childBone = this.boneMap.get(boneNames[1]);
            if (!parentBone || !childBone) return;
            this._apply2BoneIK(parentBone, childBone, targetX, targetY, ikDef.bendPositive !== false, mix);
            this.updateBoneWorldTransformsRecursive(childBone);
        }
    }

    applyTransformConstraint(tcDef) {
        const target = this.boneMap.get(tcDef.target);
        if (!target) return;

        const rotateMix = tcDef.rotateMix !== undefined ? tcDef.rotateMix : 1;
        const translateMix = tcDef.translateMix !== undefined ? tcDef.translateMix : 1;
        const scaleMix = tcDef.scaleMix !== undefined ? tcDef.scaleMix : 1;
        const shearMix = tcDef.shearMix !== undefined ? tcDef.shearMix : 1;

        const ta = target.a, tb = target.b, tc = target.c, td = target.d;
        const degRadReflect = (ta * td - tb * tc > 0) ? DEG_TO_RAD : -DEG_TO_RAD;
        const offsetRotation = (tcDef.rotation || 0) * degRadReflect;
        const offsetShearY = (tcDef.shearY || 0) * degRadReflect;
        const offsetX = tcDef.x || 0;
        const offsetY = tcDef.y || 0;
        const offsetScaleX = tcDef.scaleX || 0;
        const offsetScaleY = tcDef.scaleY || 0;

        const boneNames = tcDef.bones || [];
        for (const boneName of boneNames) {
            const bone = this.boneMap.get(boneName);
            if (!bone) continue;

            let modified = false;

            if (rotateMix !== 0) {
                const a = bone.a, b = bone.b, c = bone.c, d = bone.d;
                let r = Math.atan2(tc, ta) - Math.atan2(c, a) + offsetRotation;
                if (r > Math.PI) r -= Math.PI * 2;
                else if (r < -Math.PI) r += Math.PI * 2;

                r *= rotateMix;
                const cos = Math.cos(r), sin = Math.sin(r);
                bone.a = cos * a - sin * c;
                bone.b = cos * b - sin * d;
                bone.c = sin * a + cos * c;
                bone.d = sin * b + cos * d;
                modified = true;
            }

            if (translateMix !== 0) {
                const tx = ta * offsetX + tb * offsetY + target.tx;
                const ty = tc * offsetX + td * offsetY + target.ty;
                bone.tx += (tx - bone.tx) * translateMix;
                bone.ty += (ty - bone.ty) * translateMix;
                modified = true;
            }

            if (scaleMix !== 0) {
                let s = Math.sqrt(bone.a * bone.a + bone.c * bone.c);
                if (s > 0.00001) {
                    s = (s + (Math.sqrt(ta * ta + tc * tc) - s + offsetScaleX) * scaleMix) / s;
                    bone.a *= s;
                    bone.c *= s;
                }
                s = Math.sqrt(bone.b * bone.b + bone.d * bone.d);
                if (s > 0.00001) {
                    s = (s + (Math.sqrt(tb * tb + td * td) - s + offsetScaleY) * scaleMix) / s;
                    bone.b *= s;
                    bone.d *= s;
                }
                modified = true;
            }

            if (shearMix !== 0) {
                const b = bone.b, d = bone.d;
                const by = Math.atan2(d, b);
                let r = Math.atan2(td, tb) - Math.atan2(tc, ta) - (by - Math.atan2(bone.c, bone.a));
                if (r > Math.PI) r -= Math.PI * 2;
                else if (r < -Math.PI) r += Math.PI * 2;

                r = by + (r + offsetShearY) * shearMix;
                const s = Math.sqrt(b * b + d * d);
                bone.b = Math.cos(r) * s;
                bone.d = Math.sin(r) * s;
                modified = true;
            }

            if (modified) {
                this.updateBoneWorldTransformsRecursive(bone);
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
}

module.exports = {
    SpineBaker,
    BoneState,
    SlotState,
};
