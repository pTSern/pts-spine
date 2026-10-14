import { IAssembler } from 'cc';
import { RenderData } from 'cc';
import { Vec3, Color } from 'cc';
import type { FastSpine } from './FastSpine';
import type { FastSpinePlaybackProgress } from './FastSpineData';

const _tempVecPos = new Vec3();

export class FastSpineAssembler implements IAssembler {
    public createData(comp: FastSpine): RenderData {
        let renderData = comp.renderData;
        if (!renderData) {
            renderData = comp.requestRenderData();
        }
        return renderData;
    }

    public updateRenderData(comp: FastSpine): void {
        const spineData = comp.data;
        if (!spineData || !spineData.isValid || !comp.node.active) return;

        const vc = spineData.vertexCountPerFrame;
        const ic = spineData.indexCount;
        if (vc <= 0 || ic <= 0) return;

        let rd = comp.renderData;
        if (!rd) {
            rd = this.createData(comp);
        }
        if (!rd) return;

        const progress = comp.getPlaybackProgress();
        const curFrame = (progress.isMixing && progress.mixAlpha < 0.5)
            ? ((comp.interpolateFrames && progress.fromAlpha >= 0.5) ? progress.fromFrame2 : progress.fromFrame1)
            : ((comp.interpolateFrames && progress.alpha >= 0.5) ? progress.frame2 : progress.frame1);
        const curOrderId = (progress.isMixing && progress.mixAlpha < 0.5)
            ? progress.fromOrderId
            : progress.toOrderId;
        const activeIndices = spineData.getIndices(curFrame);

        // Resize render buffers if sizes changed
        if (rd.vertexCount !== vc || rd.indexCount !== ic || !rd.chunk) {
            rd.resize(vc, ic);
            if (rd.chunk) {
                rd.chunk.setIndexBuffer(activeIndices);
                (comp as any)._curDrawOrderId = curOrderId;
            }
        } else if ((comp as any)._curDrawOrderId !== curOrderId) {
            (comp as any)._curDrawOrderId = curOrderId;
            if (rd.chunk) {
                rd.chunk.setIndexBuffer(activeIndices);
            }
        }

        const chunk = rd.chunk;
        if (!chunk) return;

        this._updateVertices(comp, rd, chunk, progress);

        // Bind texture and material to RenderData draw info
        const curMat = comp.getRenderMaterial(0);
        if (curMat && rd.material !== curMat) {
            rd.material = curMat;
            rd.passDirty = true;
        }
        if (comp.texture) {
            rd.updateRenderData(comp, comp.texture);
        }

        rd.vertDirty = false;
    }

    private _updateVertices(comp: FastSpine, rd: RenderData, chunk: any, progress: FastSpinePlaybackProgress): void {
        const spineData = comp.data;
        const vc = spineData.vertexCountPerFrame;
        const vbuf = chunk.vb;
        if (!vbuf || vbuf.length === 0) return;

        const worldMat = comp.node.worldMatrix;
        const m00 = worldMat.m00; const m01 = worldMat.m01;
        const m04 = worldMat.m04; const m05 = worldMat.m05;
        const m12 = worldMat.m12; const m13 = worldMat.m13;

        const stride = rd.floatStride || 9;
        const allPos = spineData.allPositions;
        const allUVs = spineData.allUVs;
        const allCols = spineData.allColors;

        const nodeColor = comp.color;
        const nodeA = comp.node._uiProps ? comp.node._uiProps.opacity : 1;
        const tintR = nodeColor.r / 255;
        const tintG = nodeColor.g / 255;
        const tintB = nodeColor.b / 255;
        const tintA = (nodeColor.a / 255) * nodeA;
        const pma = comp.premultipliedAlpha ? tintA : 1;

        if (!progress.isMixing) {
            // ==================== FAST SINGLE-POSE BRANCH ====================
            const f1 = progress.frame1;
            const f2 = progress.frame2;
            const alpha = comp.interpolateFrames ? progress.alpha : 0;
            const base1 = f1 * vc;
            const base2 = f2 * vc;

            if (stride >= 9) {
                // Cocos Creator standard vfmtPosUvColor:
                // 3 floats pos (x, y, z) + 2 floats UV (u, v) + 4 floats color (r, g, b, a in [0..1])
                for (let i = 0; i < vc; i++) {
                    const idx1 = (base1 + i) * 2;
                    const idx2 = (base2 + i) * 2;

                    const col1 = allCols[base1 + i];
                    const col2 = allCols[base2 + i];
                    const a1 = (col1 >>> 24);
                    const a2 = (col2 >>> 24);

                    let lx = allPos[idx1];
                    let ly = allPos[idx1 + 1];
                    if (alpha > 0.001) {
                        if (a1 === 0) {
                            lx = allPos[idx2];
                            ly = allPos[idx2 + 1];
                        } else if (a2 === 0) {
                            lx = allPos[idx1];
                            ly = allPos[idx1 + 1];
                        } else {
                            lx += (allPos[idx2] - lx) * alpha;
                            ly += (allPos[idx2 + 1] - ly) * alpha;
                        }
                    }

                    const wx = m00 * lx + m04 * ly + m12;
                    const wy = m01 * lx + m05 * ly + m13;

                    const vOffset = i * stride;
                    vbuf[vOffset + 0] = wx;
                    vbuf[vOffset + 1] = wy;
                    vbuf[vOffset + 2] = 0;

                    const uvIdx = alpha >= 0.5 ? idx2 : idx1;
                    vbuf[vOffset + 3] = allUVs[uvIdx];
                    vbuf[vOffset + 4] = allUVs[uvIdx + 1];

                    const col = alpha >= 0.5 ? col2 : col1;
                    const cr = ((col & 0xff) / 255) * tintR * pma;
                    const cg = (((col >> 8) & 0xff) / 255) * tintG * pma;
                    const cb = (((col >> 16) & 0xff) / 255) * tintB * pma;
                    const ca = (((col >> 24) & 0xff) / 255) * tintA;

                    vbuf[vOffset + 5] = cr;
                    vbuf[vOffset + 6] = cg;
                    vbuf[vOffset + 7] = cb;
                    vbuf[vOffset + 8] = ca;
                }
            } else {
                // Packed 4-byte color format (vfmtPosUvColor4B)
                const u32Buf = new Uint32Array(vbuf.buffer, vbuf.byteOffset, vbuf.length);
                for (let i = 0; i < vc; i++) {
                    const idx1 = (base1 + i) * 2;
                    const idx2 = (base2 + i) * 2;

                    const col1 = allCols[base1 + i];
                    const col2 = allCols[base2 + i];
                    const a1 = (col1 >>> 24);
                    const a2 = (col2 >>> 24);

                    let lx = allPos[idx1];
                    let ly = allPos[idx1 + 1];
                    if (alpha > 0.001) {
                        if (a1 === 0) {
                            lx = allPos[idx2];
                            ly = allPos[idx2 + 1];
                        } else if (a2 === 0) {
                            lx = allPos[idx1];
                            ly = allPos[idx1 + 1];
                        } else {
                            lx += (allPos[idx2] - lx) * alpha;
                            ly += (allPos[idx2 + 1] - ly) * alpha;
                        }
                    }

                    const wx = m00 * lx + m04 * ly + m12;
                    const wy = m01 * lx + m05 * ly + m13;

                    const vOffset = i * stride;
                    vbuf[vOffset + 0] = wx;
                    vbuf[vOffset + 1] = wy;
                    vbuf[vOffset + 2] = 0;

                    const uvIdx = alpha >= 0.5 ? idx2 : idx1;
                    vbuf[vOffset + 3] = allUVs[uvIdx];
                    vbuf[vOffset + 4] = allUVs[uvIdx + 1];

                    const col = alpha >= 0.5 ? col2 : col1;
                    const cr = Math.round((col & 0xff) * tintR * pma);
                    const cg = Math.round(((col >> 8) & 0xff) * tintG * pma);
                    const cb = Math.round(((col >> 16) & 0xff) * tintB * pma);
                    const ca = Math.round(((col >> 24) & 0xff) * tintA);
                    const packedCol = ((cr & 0xff) | ((cg & 0xff) << 8) | ((cb & 0xff) << 16) | ((ca & 0xff) << 24)) >>> 0;
                    u32Buf[vOffset + 5] = packedCol;
                }
            }
        } else {
            // ==================== DUAL-POSE MIXING BRANCH ====================
            const mixAlpha = progress.mixAlpha;
            const invMixAlpha = 1 - mixAlpha;

            // Pose A (from)
            const fA1 = progress.fromFrame1;
            const fA2 = progress.fromFrame2;
            const alphaA = comp.interpolateFrames ? progress.fromAlpha : 0;
            const baseA1 = fA1 * vc;
            const baseA2 = fA2 * vc;

            // Pose B (to)
            const fB1 = progress.frame1;
            const fB2 = progress.frame2;
            const alphaB = comp.interpolateFrames ? progress.alpha : 0;
            const baseB1 = fB1 * vc;
            const baseB2 = fB2 * vc;

            const isPma = comp.premultipliedAlpha;

            if (stride >= 9) {
                for (let i = 0; i < vc; i++) {
                    const idxA1 = (baseA1 + i) * 2;
                    const idxA2 = (baseA2 + i) * 2;
                    const colA1 = allCols[baseA1 + i];
                    const colA2 = allCols[baseA2 + i];
                    const aA1 = (colA1 >>> 24);
                    const aA2 = (colA2 >>> 24);

                    let lxA = allPos[idxA1];
                    let lyA = allPos[idxA1 + 1];
                    if (alphaA > 0.001) {
                        if (aA1 === 0) {
                            lxA = allPos[idxA2]; lyA = allPos[idxA2 + 1];
                        } else if (aA2 === 0) {
                            lxA = allPos[idxA1]; lyA = allPos[idxA1 + 1];
                        } else {
                            lxA += (allPos[idxA2] - lxA) * alphaA;
                            lyA += (allPos[idxA2 + 1] - lyA) * alphaA;
                        }
                    }
                    const colA = alphaA >= 0.5 ? colA2 : colA1;
                    const aA = (colA >>> 24);
                    const uvIdxA = alphaA >= 0.5 ? idxA2 : idxA1;

                    // Sample Pose B
                    const idxB1 = (baseB1 + i) * 2;
                    const idxB2 = (baseB2 + i) * 2;
                    const colB1 = allCols[baseB1 + i];
                    const colB2 = allCols[baseB2 + i];
                    const aB1 = (colB1 >>> 24);
                    const aB2 = (colB2 >>> 24);

                    let lxB = allPos[idxB1];
                    let lyB = allPos[idxB1 + 1];
                    if (alphaB > 0.001) {
                        if (aB1 === 0) {
                            lxB = allPos[idxB2]; lyB = allPos[idxB2 + 1];
                        } else if (aB2 === 0) {
                            lxB = allPos[idxB1]; lyB = allPos[idxB1 + 1];
                        } else {
                            lxB += (allPos[idxB2] - lxB) * alphaB;
                            lyB += (allPos[idxB2 + 1] - lyB) * alphaB;
                        }
                    }
                    const colB = alphaB >= 0.5 ? colB2 : colB1;
                    const aB = (colB >>> 24);
                    const uvIdxB = alphaB >= 0.5 ? idxB2 : idxB1;

                    // Blend Position, Color, UV
                    let lx: number, ly: number;
                    let cr: number, cg: number, cb: number, ca: number;
                    let uvIdx: number;

                    const rA = (colA & 0xff); const gA = ((colA >> 8) & 0xff); const bA = ((colA >> 16) & 0xff);
                    const rB = (colB & 0xff); const gB = ((colB >> 8) & 0xff); const bB = ((colB >> 16) & 0xff);

                    if (aA > 0 && aB > 0) {
                        lx = lxA + (lxB - lxA) * mixAlpha;
                        ly = lyA + (lyB - lyA) * mixAlpha;
                        cr = rA + (rB - rA) * mixAlpha;
                        cg = gA + (gB - gA) * mixAlpha;
                        cb = bA + (bB - bA) * mixAlpha;
                        ca = aA + (aB - aA) * mixAlpha;
                        uvIdx = mixAlpha < 0.5 ? uvIdxA : uvIdxB;
                    } else if (aA > 0) {
                        lx = lxA; ly = lyA;
                        if (isPma) {
                            cr = rA * invMixAlpha; cg = gA * invMixAlpha; cb = bA * invMixAlpha;
                        } else {
                            cr = rA; cg = gA; cb = bA;
                        }
                        ca = aA * invMixAlpha;
                        uvIdx = uvIdxA;
                    } else if (aB > 0) {
                        lx = lxB; ly = lyB;
                        if (isPma) {
                            cr = rB * mixAlpha; cg = gB * mixAlpha; cb = bB * mixAlpha;
                        } else {
                            cr = rB; cg = gB; cb = bB;
                        }
                        ca = aB * mixAlpha;
                        uvIdx = uvIdxB;
                    } else {
                        lx = lxA; ly = lyA;
                        cr = 0; cg = 0; cb = 0; ca = 0;
                        uvIdx = uvIdxA;
                    }

                    const wx = m00 * lx + m04 * ly + m12;
                    const wy = m01 * lx + m05 * ly + m13;

                    const vOffset = i * stride;
                    vbuf[vOffset + 0] = wx;
                    vbuf[vOffset + 1] = wy;
                    vbuf[vOffset + 2] = 0;

                    vbuf[vOffset + 3] = allUVs[uvIdx];
                    vbuf[vOffset + 4] = allUVs[uvIdx + 1];

                    vbuf[vOffset + 5] = (cr / 255) * tintR * pma;
                    vbuf[vOffset + 6] = (cg / 255) * tintG * pma;
                    vbuf[vOffset + 7] = (cb / 255) * tintB * pma;
                    vbuf[vOffset + 8] = (ca / 255) * tintA;
                }
            } else {
                const u32Buf = new Uint32Array(vbuf.buffer, vbuf.byteOffset, vbuf.length);
                for (let i = 0; i < vc; i++) {
                    const idxA1 = (baseA1 + i) * 2;
                    const idxA2 = (baseA2 + i) * 2;
                    const colA1 = allCols[baseA1 + i];
                    const colA2 = allCols[baseA2 + i];
                    const aA1 = (colA1 >>> 24);
                    const aA2 = (colA2 >>> 24);

                    let lxA = allPos[idxA1];
                    let lyA = allPos[idxA1 + 1];
                    if (alphaA > 0.001) {
                        if (aA1 === 0) {
                            lxA = allPos[idxA2]; lyA = allPos[idxA2 + 1];
                        } else if (aA2 === 0) {
                            lxA = allPos[idxA1]; lyA = allPos[idxA1 + 1];
                        } else {
                            lxA += (allPos[idxA2] - lxA) * alphaA;
                            lyA += (allPos[idxA2 + 1] - lyA) * alphaA;
                        }
                    }
                    const colA = alphaA >= 0.5 ? colA2 : colA1;
                    const aA = (colA >>> 24);
                    const uvIdxA = alphaA >= 0.5 ? idxA2 : idxA1;

                    // Sample Pose B
                    const idxB1 = (baseB1 + i) * 2;
                    const idxB2 = (baseB2 + i) * 2;
                    const colB1 = allCols[baseB1 + i];
                    const colB2 = allCols[baseB2 + i];
                    const aB1 = (colB1 >>> 24);
                    const aB2 = (colB2 >>> 24);

                    let lxB = allPos[idxB1];
                    let lyB = allPos[idxB1 + 1];
                    if (alphaB > 0.001) {
                        if (aB1 === 0) {
                            lxB = allPos[idxB2]; lyB = allPos[idxB2 + 1];
                        } else if (aB2 === 0) {
                            lxB = allPos[idxB1]; lyB = allPos[idxB1 + 1];
                        } else {
                            lxB += (allPos[idxB2] - lxB) * alphaB;
                            lyB += (allPos[idxB2 + 1] - lyB) * alphaB;
                        }
                    }
                    const colB = alphaB >= 0.5 ? colB2 : colB1;
                    const aB = (colB >>> 24);
                    const uvIdxB = alphaB >= 0.5 ? idxB2 : idxB1;

                    // Blend Position, Color, UV
                    let lx: number, ly: number;
                    let cr: number, cg: number, cb: number, ca: number;
                    let uvIdx: number;

                    const rA = (colA & 0xff); const gA = ((colA >> 8) & 0xff); const bA = ((colA >> 16) & 0xff);
                    const rB = (colB & 0xff); const gB = ((colB >> 8) & 0xff); const bB = ((colB >> 16) & 0xff);

                    if (aA > 0 && aB > 0) {
                        lx = lxA + (lxB - lxA) * mixAlpha;
                        ly = lyA + (lyB - lyA) * mixAlpha;
                        cr = rA + (rB - rA) * mixAlpha;
                        cg = gA + (gB - gA) * mixAlpha;
                        cb = bA + (bB - bA) * mixAlpha;
                        ca = aA + (aB - aA) * mixAlpha;
                        uvIdx = mixAlpha < 0.5 ? uvIdxA : uvIdxB;
                    } else if (aA > 0) {
                        lx = lxA; ly = lyA;
                        if (isPma) {
                            cr = rA * invMixAlpha; cg = gA * invMixAlpha; cb = bA * invMixAlpha;
                        } else {
                            cr = rA; cg = gA; cb = bA;
                        }
                        ca = aA * invMixAlpha;
                        uvIdx = uvIdxA;
                    } else if (aB > 0) {
                        lx = lxB; ly = lyB;
                        if (isPma) {
                            cr = rB * mixAlpha; cg = gB * mixAlpha; cb = bB * mixAlpha;
                        } else {
                            cr = rB; cg = gB; cb = bB;
                        }
                        ca = aB * mixAlpha;
                        uvIdx = uvIdxB;
                    } else {
                        lx = lxA; ly = lyA;
                        cr = 0; cg = 0; cb = 0; ca = 0;
                        uvIdx = uvIdxA;
                    }

                    const wx = m00 * lx + m04 * ly + m12;
                    const wy = m01 * lx + m05 * ly + m13;

                    const vOffset = i * stride;
                    vbuf[vOffset + 0] = wx;
                    vbuf[vOffset + 1] = wy;
                    vbuf[vOffset + 2] = 0;

                    vbuf[vOffset + 3] = allUVs[uvIdx];
                    vbuf[vOffset + 4] = allUVs[uvIdx + 1];

                    const fCr = Math.round(cr * tintR * pma);
                    const fCg = Math.round(cg * tintG * pma);
                    const fCb = Math.round(cb * tintB * pma);
                    const fCa = Math.round(ca * tintA);
                    const packedCol = ((fCr & 0xff) | ((fCg & 0xff) << 8) | ((fCb & 0xff) << 16) | ((fCa & 0xff) << 24)) >>> 0;
                    u32Buf[vOffset + 5] = packedCol;
                }
            }
        }
    }

    public fillBuffers(comp: FastSpine, renderer: any): void {
        const rd = comp.renderData;
        if (!rd || !comp.data || !comp.data.isValid) return;

        if (rd.vertDirty || !rd.chunk) {
            this.updateRenderData(comp);
        }

        const chunk = rd.chunk;
        if (!chunk) return;
        const meshBuffer = chunk.meshBuffer;
        if (!meshBuffer) return;

        const progress = comp.getPlaybackProgress();
        const curFrame = (progress.isMixing && progress.mixAlpha < 0.5)
            ? ((comp.interpolateFrames && progress.fromAlpha >= 0.5) ? progress.fromFrame2 : progress.fromFrame1)
            : ((comp.interpolateFrames && progress.alpha >= 0.5) ? progress.frame2 : progress.frame1);
        const indices = comp.data.getIndices(curFrame);
        const ic = indices.length;
        if (ic <= 0) return;

        let ib = meshBuffer.iData;
        const vid = chunk.vertexOffset;
        let indexOffset = meshBuffer.indexOffset;

        // Ensure index buffer capacity
        if (ib.length < indexOffset + ic) {
            const expansion = Math.max(Math.floor(ib.length * 1.5), indexOffset + ic + 256);
            const newIb = new Uint16Array(expansion);
            newIb.set(ib);
            meshBuffer.iData = newIb;
            ib = newIb;
        }

        for (let i = 0; i < ic; i++) {
            ib[indexOffset + i] = vid + indices[i];
        }
        meshBuffer.indexOffset += ic;
    }
}

export const fastSpineAssembler = new FastSpineAssembler();
