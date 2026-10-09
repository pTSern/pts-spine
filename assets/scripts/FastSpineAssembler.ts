import { IAssembler } from 'cc';
import { RenderData } from 'cc';
import { Vec3, Color } from 'cc';
import type { FastSpine } from './FastSpine';

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

        // Resize render buffers if sizes changed
        if (rd.vertexCount !== vc || rd.indexCount !== ic || !rd.chunk) {
            rd.resize(vc, ic);
            if (rd.chunk) {
                rd.chunk.setIndexBuffer(spineData.indices);
            }
        }

        const chunk = rd.chunk;
        if (!chunk) return;

        this._updateVertices(comp, rd, chunk);

        // Bind texture and material to RenderData draw info
        if (!rd.material) {
            rd.material = comp.getRenderMaterial(0)!;
        }
        if (comp.texture) {
            rd.updateRenderData(comp, comp.texture);
        }

        rd.vertDirty = false;
    }

    private _updateVertices(comp: FastSpine, rd: RenderData, chunk: any): void {
        const spineData = comp.data;
        const vc = spineData.vertexCountPerFrame;
        const vbuf = chunk.vb;
        if (!vbuf || vbuf.length === 0) return;

        // Get playback progress and frame indices
        const progress = comp.getPlaybackProgress();
        const f1 = progress.frame1;
        const f2 = progress.frame2;
        const alpha = comp.interpolateFrames ? progress.alpha : 0;

        const worldMat = comp.node.worldMatrix;
        const m00 = worldMat.m00; const m01 = worldMat.m01;
        const m04 = worldMat.m04; const m05 = worldMat.m05;
        const m12 = worldMat.m12; const m13 = worldMat.m13;

        const stride = rd.floatStride || 9;
        const base1 = f1 * vc;
        const base2 = f2 * vc;

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

        const indices = comp.data.indices;
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
