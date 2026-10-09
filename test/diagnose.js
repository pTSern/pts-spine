const { SpineParser } = require('../lib/spine-parser');
const { SpineBaker } = require('../lib/spine-baker');
const path = require('path');

const jsonPath = path.resolve(__dirname, '../../../assets/game/$shared/_$shared/spine/main/Main.json');
const { skeleton, atlas } = SpineParser.loadFromFile(jsonPath);

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

// Modify SpineBaker prototype to test the new methods
SpineBaker.prototype.initChildrenAndConstraints = function() {
    // 1. Children
    for (const b of this.bones) b.children = [];
    for (const b of this.bones) {
        if (b.parentIndex >= 0) {
            this.bones[b.parentIndex].children.push(b);
        }
    }

    // 2. Constraints sorted by order
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

    // 3. Fixed slot geometries
    this.slotGeometries = new Map();
    for (const s of this.skeleton.slots) {
        const usedAttNames = new Set();
        if (s.attachment) usedAttNames.add(s.attachment);

        for (const [animName, animDef] of Object.entries(this.skeleton.animations || {})) {
            if (animDef.slots && animDef.slots[s.name] && animDef.slots[s.name].attachment) {
                for (const kf of animDef.slots[s.name].attachment) {
                    if (kf.name) usedAttNames.add(kf.name);
                }
            }
        }

        if (usedAttNames.size === 0) {
            this.slotGeometries.set(s.name, { maxVerts: 0, maxIndices: 0, isMesh: false });
            continue;
        }

        let maxVerts = 0;
        let maxIndices = 0;
        let isMesh = false;
        let sampleMeshAtt = null;

        for (const attName of usedAttNames) {
            const att = this.getAttachment(s.name, attName);
            if (!att) continue;
            const type = att.type || 'region';
            if (type === 'mesh' || type === 'linkedmesh') {
                const vc = att.uvs.length / 2;
                const ic = att.triangles.length;
                if (vc > maxVerts) {
                    maxVerts = vc;
                    maxIndices = ic;
                    isMesh = true;
                    sampleMeshAtt = att;
                }
            } else {
                if (maxVerts < 4) {
                    maxVerts = 4;
                    maxIndices = 6;
                }
            }
        }

        const triangles = isMesh && sampleMeshAtt ? sampleMeshAtt.triangles : [0, 1, 2, 2, 3, 0];
        this.slotGeometries.set(s.name, {
            maxVerts,
            maxIndices,
            isMesh,
            triangles,
            meshAtt: sampleMeshAtt,
        });
    }
};

SpineBaker.prototype.updateBoneWorldTransformsRecursive = function(bone) {
    for (const child of bone.children) {
        child.updateWorldTransform(bone);
        this.updateBoneWorldTransformsRecursive(child);
    }
};

SpineBaker.prototype.applyTransformConstraint = function(tcDef) {
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
            const tx = ta * offsetX + tc * offsetY + target.tx;
            const ty = tb * offsetX + td * offsetY + target.ty;
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
};

SpineBaker.prototype.applyIKConstraintSingle = function(ikDef) {
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
};

SpineBaker.prototype.updateWorldTransforms = function() {
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
};

SpineBaker.prototype.extractFrameGeometry = function() {
    const positions = [];
    const uvs = [];
    const colors = [];
    const indices = [];

    let vertexOffset = 0;

    for (let i = 0; i < this.slots.length; i++) {
        const slot = this.slots[i];
        const geoInfo = this.slotGeometries ? this.slotGeometries.get(slot.name) : null;
        if (!geoInfo || geoInfo.maxVerts === 0) continue;

        const bone = this.bones[slot.boneIndex];
        const att = slot.attachment ? this.getAttachment(slot.name, slot.attachment) : null;

        if (!att) {
            // Null attachment: emit degenerate geometry
            for (let v = 0; v < geoInfo.maxVerts; v++) {
                positions.push(bone.tx, bone.ty);
                uvs.push(0, 0);
                colors.push(0);
            }
            for (let t = 0; t < geoInfo.triangles.length; t++) {
                indices.push(vertexOffset + geoInfo.triangles[t]);
            }
            vertexOffset += geoInfo.maxVerts;
            continue;
        }

        const attType = att.type || 'region';
        const attColor = parseHexColor(att.color);
        const finalColor = {
            r: slot.color.r * attColor.r,
            g: slot.color.g * attColor.g,
            b: slot.color.b * attColor.b,
            a: slot.color.a * attColor.a,
        };
        const packedColor = packColorRGBA8(finalColor.r, finalColor.g, finalColor.b, finalColor.a);

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

            // If geoInfo has more than 4 verts (mesh slot switching to region)
            for (let v = 4; v < geoInfo.maxVerts; v++) {
                positions.push(bone.tx, bone.ty);
                uvs.push(0, 0);
                colors.push(0);
            }

            for (let t = 0; t < geoInfo.triangles.length; t++) {
                indices.push(vertexOffset + geoInfo.triangles[t]);
            }
            vertexOffset += geoInfo.maxVerts;

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

            // Pad if fewer than maxVerts
            for (let v = vertCount; v < geoInfo.maxVerts; v++) {
                positions.push(bone.tx, bone.ty);
                uvs.push(0, 0);
                colors.push(0);
            }

            for (let t = 0; t < geoInfo.triangles.length; t++) {
                indices.push(vertexOffset + geoInfo.triangles[t]);
            }
            vertexOffset += geoInfo.maxVerts;
        }
    }

    return {
        positions: new Float32Array(positions),
        uvs: new Float32Array(uvs),
        colors: new Uint32Array(colors),
        indices: new Uint16Array(indices),
        vertexCount: vertexOffset,
    };
};

const bakerTest = new SpineBaker(skeleton, atlas);
bakerTest.initChildrenAndConstraints();

console.log('Testing prototype baking for all animations:');
for (const [animName, animDef] of Object.entries(skeleton.animations)) {
    const duration = bakerTest.getAnimationDuration(animDef);
    const count = Math.max(1, Math.round(duration * 30));
    const dt = count > 1 ? duration / (count - 1) : 0;
    const vcSet = new Set();
    const icSet = new Set();
    for (let f = 0; f < count; f++) {
        bakerTest.resetPose();
        bakerTest.applyAnimationAtTime(animDef, f * dt);
        bakerTest.updateWorldTransforms();
        const g = bakerTest.extractFrameGeometry();
        vcSet.add(g.vertexCount);
        icSet.add(g.indices.length);
    }
    console.log(`  ${animName}: frames=${count}, vertexCounts=[${Array.from(vcSet)}], indexCounts=[${Array.from(icSet)}]`);
}

// Check index equality across frames
const firstGeom = (() => {
    bakerTest.resetPose();
    bakerTest.applyAnimationAtTime(skeleton.animations['WinUI'], 0);
    bakerTest.updateWorldTransforms();
    return bakerTest.extractFrameGeometry();
})();

let mismatchCount = 0;
for (let t = 0; t <= 4; t += 0.1) {
    bakerTest.resetPose();
    bakerTest.applyAnimationAtTime(skeleton.animations['WinUI'], t);
    bakerTest.updateWorldTransforms();
    const g = bakerTest.extractFrameGeometry();
    for (let i = 0; i < firstGeom.indices.length; i++) {
        if (firstGeom.indices[i] !== g.indices[i]) {
            mismatchCount++;
            break;
        }
    }
}
console.log('Index mismatch across WinUI frames:', mismatchCount);

