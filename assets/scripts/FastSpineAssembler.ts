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

        const rd = comp.renderData;
        if (!rd) return;

        // Resize render buffers if sizes changed
        if (rd.vertexCount !== vc || rd.indexCount !== ic) {
            rd.resize(vc, ic);
            if (rd.chunk) {
                rd.chunk.setIndexBuffer(spineData.indices);
            }
        }

        const chunk = rd.chunk;
        if (!chunk) return;

        const vbuf = chunk.vb;
        const u32Buf = new Uint32Array(vbuf.buffer, vbuf.byteOffset, vbuf.length);

        // Get playback progress and frame indices
        const progress = comp.getPlaybackProgress();
        const f1 = progress.frame1;
        const f2 = progress.frame2;
        const alpha = comp.interpolateFrames ? progress.alpha : 0;

        const worldMat = comp.node.worldMatrix;
        const m00 = worldMat.m00; const m01 = worldMat.m01;
        const m04 = worldMat.m04; const m05 = worldMat.m05;
        const m12 = worldMat.m12; const m13 = worldMat.m13;

        const stride = rd.floatStride || 6; // 3 pos + 2 uv + 1 color
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
        const hasTint = tintR < 0.999 || tintG < 0.999 || tintB < 0.999 || nodeA < 0.999;

        let vOffset = 0;
        for (let i = 0; i < vc; i++) {
            const idx1 = (base1 + i) * 2;
            const idx2 = (base2 + i) * 2;

            // Interpolated local vertex
            let lx = allPos[idx1];
            let ly = allPos[idx1 + 1];
            if (alpha > 0.001) {
                lx += (allPos[idx2] - lx) * alpha;
                ly += (allPos[idx2 + 1] - ly) * alpha;
            }

            // World transform
            const wx = m00 * lx + m04 * ly + m12;
            const wy = m01 * lx + m05 * ly + m13;

            vOffset = i * stride;
            vbuf[vOffset + 0] = wx;
            vbuf[vOffset + 1] = wy;
            vbuf[vOffset + 2] = 0;

            // UVs
            vbuf[vOffset + 3] = allUVs[idx1];
            vbuf[vOffset + 4] = allUVs[idx1 + 1];

            // Color
            let col = allCols[base1 + i];
            if (hasTint) {
                const cr = (col & 0xff) * tintR;
                const cg = ((col >> 8) & 0xff) * tintG;
                const cb = ((col >> 16) & 0xff) * tintB;
                const ca = ((col >> 24) & 0xff) * nodeA;
                col = ((Math.round(cr) & 0xff) |
                      ((Math.round(cg) & 0xff) << 8) |
                      ((Math.round(cb) & 0xff) << 16) |
                      ((Math.round(ca) & 0xff) << 24)) >>> 0;
            }
            u32Buf[vOffset + 5] = col;
        }

        rd.vertDirty = false;
    }

    public fillBuffers(comp: FastSpine, renderer: any): void {
        // Handled automatically by Cocos 3.8 batcher through RenderData chunk
    }
}

export const fastSpineAssembler = new FastSpineAssembler();
