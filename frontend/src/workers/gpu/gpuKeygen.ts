/// <reference types="@webgpu/types" />
// ============================================================
// gpuKeygen.ts — WebGPU pipeline manager for Ed25519 vanity keygen
// Ported from meshcore-web-keygen/webgpu/gpu-keygen.js
// Adapted for Vite/TypeScript: inlined WGSL, TypeScript types
// ============================================================

import { ED25519_WGSL } from './ed25519WgslSrc';
import { getBaseTableBuffer } from './precompute';

const MAX_WORKGROUPS_PER_SUBMIT = 64;

export interface GpuMatch {
  seed: Uint8Array;   // 32 bytes
  pubkey: Uint8Array; // 32 bytes
}

export interface GpuBatchResult {
  matches: GpuMatch[];
  attempted: number;
}

export class GPUKeyGenerator {
  private device: GPUDevice | null = null;
  private pipeline: GPUComputePipeline | null = null;
  private bindGroup: GPUBindGroup | null = null;
  private bindGroup1: GPUBindGroup | null = null;
  private bindGroup2: GPUBindGroup | null = null;
  private bindGroup3: GPUBindGroup | null = null;
  private configBuffer: GPUBuffer | null = null;
  private configBuffer1: GPUBuffer | null = null;
  private configBuffer2: GPUBuffer | null = null;
  private configBuffer3: GPUBuffer | null = null;
  private baseTableBuffer: GPUBuffer | null = null;
  private matchBuffer: GPUBuffer | null = null;
  private matchCountBuffer: GPUBuffer | null = null;
  private readbackBuffer: GPUBuffer | null = null;
  private readbackCountBuffer: GPUBuffer | null = null;

  private dispatchId = 0;
  private workgroupSize = 64;
  private numWorkgroups = 64; // starts small; continuous tuner scales up toward _maxWorkgroups each batch
  private consecutiveZeroCompletions = 0;
  private consecutiveFullCompletions = 0;
  private _batchSizeTuned = false;
  isReady = false;
  turboMode = false;
  /** Target wall-clock time per GPU dispatch. Default (100ms) keeps the GPU at ~60% duty cycle
   *  like the cracker's standard mode. Turbo mode raises this to 1000ms for maximum throughput. */
  dispatchTargetMs = 100;

  private get _maxWorkgroups(): number {
    return this.turboMode ? 4096 : 1024;
  }

  /** Reset the time-based tuner. Call this after changing turboMode or dispatchTargetMs. */
  resetBatchTuning(): void {
    this._batchSizeTuned = false;
    this.numWorkgroups = 64;
    this.consecutiveZeroCompletions = 0;
    this.consecutiveFullCompletions = 0;
  }

  get threadsPerDispatch(): number {
    return this.workgroupSize * this.numWorkgroups;
  }

  static async isAvailable(): Promise<boolean> {
    if (!navigator.gpu) return false;
    try {
      const adapter = await navigator.gpu.requestAdapter();
      return adapter !== null;
    } catch {
      return false;
    }
  }

  async initialize(): Promise<void> {
    if (this.isReady) return;

    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) throw new Error('No WebGPU adapter found');

    this.device = await adapter.requestDevice({
      requiredLimits: {
        maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
        maxBufferSize: adapter.limits.maxBufferSize,
      },
    });

    this.device.lost.then((info) =>
      console.error('GPU device lost:', info.message, info.reason)
    );

    // Compile shader from inlined WGSL source
    const shaderModule = this.device.createShaderModule({ code: ED25519_WGSL });
    const info = await shaderModule.getCompilationInfo();
    for (const msg of info.messages) {
      if (msg.type === 'error') {
        throw new Error(`Shader compilation failed: ${msg.message} (line ${msg.lineNum})`);
      }
    }

    // Create buffers
    const configSize = 36; // 9 × u32
    const makeConfig = () =>
      this.device!.createBuffer({
        size: configSize,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
    this.configBuffer  = makeConfig();
    this.configBuffer1 = makeConfig();
    this.configBuffer2 = makeConfig();
    this.configBuffer3 = makeConfig();

    const tableData = getBaseTableBuffer();
    this.baseTableBuffer = this.device.createBuffer({
      size: tableData.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(this.baseTableBuffer, 0, tableData.buffer as ArrayBuffer, tableData.byteOffset, tableData.byteLength);

    const matchBufferSize = 64 * 16 * 4; // 64 matches × 16 u32 × 4 bytes
    this.matchBuffer = this.device.createBuffer({
      size: matchBufferSize,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });
    this.matchCountBuffer = this.device.createBuffer({
      size: 8,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
    });
    this.readbackBuffer = this.device.createBuffer({
      size: matchBufferSize,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });
    this.readbackCountBuffer = this.device.createBuffer({
      size: 8,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });

    const bindGroupLayout = this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      ],
    });

    this.pipeline = this.device.createComputePipeline({
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] }),
      compute: { module: shaderModule, entryPoint: 'main' },
    });

    const makeBindGroup = (cfg: GPUBuffer) =>
      this.device!.createBindGroup({
        layout: bindGroupLayout,
        entries: [
          { binding: 0, resource: { buffer: cfg } },
          { binding: 1, resource: { buffer: this.baseTableBuffer! } },
          { binding: 2, resource: { buffer: this.matchBuffer! } },
          { binding: 3, resource: { buffer: this.matchCountBuffer! } },
        ],
      });

    this.bindGroup  = makeBindGroup(this.configBuffer);
    this.bindGroup1 = makeBindGroup(this.configBuffer1);
    this.bindGroup2 = makeBindGroup(this.configBuffer2);
    this.bindGroup3 = makeBindGroup(this.configBuffer3);

    this.isReady = true;
  }

  private _encodePrefix(targetPrefix: string): { prefix0: number; prefix1: number; nibbles: number } {
    const nibbles = targetPrefix.length;
    const bytes = new Uint8Array(8);
    for (let i = 0; i < nibbles; i++) {
      const nibble = parseInt(targetPrefix[i], 16);
      if (i & 1) {
        bytes[i >>> 1] |= nibble;
      } else {
        bytes[i >>> 1] = nibble << 4;
      }
    }
    const view = new DataView(bytes.buffer);
    return {
      prefix0: view.getUint32(0, true),
      prefix1: view.getUint32(4, true),
      nibbles,
    };
  }

  async dispatchBatch(targetPrefix: string, options: { allowWorkgroupReduce?: boolean } = {}): Promise<GpuBatchResult> {
    if (!this.isReady) throw new Error('GPU not initialized');

    // Single submit: dispatch all numWorkgroups in one command buffer, one mapAsync wait.
    // _dispatchOnce with workgroupsOverride=null issues dispatchWorkgroups(numWorkgroups) directly,
    // eliminating the previous 4-round-trip approach that was the main performance bottleneck.
    const allowReduce = options.allowWorkgroupReduce !== false;
    const result = await this._dispatchOnce(targetPrefix, allowReduce, null);
    return { matches: result.matches.slice(0, 64), attempted: result.attempted };
  }

  private async _dispatchOnce(
    targetPrefix: string,
    allowWorkgroupReduce: boolean,
    workgroupsOverride: number | null,
    dispatchesPerSubmit = 1,
  ): Promise<GpuBatchResult> {
    const prefixConfig = this._encodePrefix(targetPrefix);
    const workgroupsToUse = workgroupsOverride !== null ? workgroupsOverride : this.numWorkgroups;
    const seed = crypto.getRandomValues(new Uint32Array(4));

    const writeConfig = (buffer: GPUBuffer, baseThreadId: number) => {
      const configData = new Uint32Array(9);
      configData[0] = prefixConfig.prefix0;
      configData[1] = prefixConfig.prefix1;
      configData[2] = prefixConfig.nibbles;
      configData[3] = seed[0];
      configData[4] = seed[1];
      configData[5] = seed[2];
      configData[6] = seed[3];
      configData[7] = this.dispatchId;
      configData[8] = baseThreadId;
      this.device!.queue.writeBuffer(buffer, 0, configData);
    };

    this.dispatchId += dispatchesPerSubmit;
    this.device!.queue.writeBuffer(this.matchCountBuffer!, 0, new Uint32Array([0, 0]));

    this.device!.pushErrorScope('validation');
    this.device!.pushErrorScope('out-of-memory');

    const commandEncoder = this.device!.createCommandEncoder();
    const passEncoder = commandEncoder.beginComputePass();
    passEncoder.setPipeline(this.pipeline!);

    const multiDispatch =
      dispatchesPerSubmit > 1 && workgroupsToUse === MAX_WORKGROUPS_PER_SUBMIT;

    if (multiDispatch) {
      const configBuffers = [
        this.configBuffer!, this.configBuffer1!, this.configBuffer2!, this.configBuffer3!,
      ];
      const bindGroups = [
        this.bindGroup!, this.bindGroup1!, this.bindGroup2!, this.bindGroup3!,
      ];
      for (let i = 0; i < dispatchesPerSubmit; i++) {
        writeConfig(configBuffers[i], i * MAX_WORKGROUPS_PER_SUBMIT * this.workgroupSize);
      }
      for (let i = 0; i < dispatchesPerSubmit; i++) {
        passEncoder.setBindGroup(0, bindGroups[i]);
        passEncoder.dispatchWorkgroups(MAX_WORKGROUPS_PER_SUBMIT);
      }
    } else {
      writeConfig(this.configBuffer!, 0);
      passEncoder.setBindGroup(0, this.bindGroup!);
      passEncoder.dispatchWorkgroups(workgroupsToUse);
    }

    passEncoder.end();
    commandEncoder.copyBufferToBuffer(this.matchCountBuffer!, 0, this.readbackCountBuffer!, 0, 8);
    commandEncoder.copyBufferToBuffer(
      this.matchBuffer!, 0, this.readbackBuffer!, 0, this.readbackBuffer!.size
    );

    const submitStart = performance.now();
    this.device!.queue.submit([commandEncoder.finish()]);
    await this.device!.popErrorScope();
    await this.device!.popErrorScope();

    await this.readbackCountBuffer!.mapAsync(GPUMapMode.READ);
    const countData = new Uint32Array(this.readbackCountBuffer!.getMappedRange());
    const rawMatchCount = countData[0];
    const matchCount = Math.min(rawMatchCount, 64);
    const completedCount = countData[1];
    this.readbackCountBuffer!.unmap();
    const dispatchElapsedMs = performance.now() - submitStart;

    const matches: GpuMatch[] = [];
    if (matchCount > 0) {
      await this.readbackBuffer!.mapAsync(GPUMapMode.READ);
      const matchData = new Uint32Array(this.readbackBuffer!.getMappedRange());
      for (let i = 0; i < matchCount; i++) {
        const offset = i * 16; // 16 u32 per match
        const seedWords = new Uint32Array(8);
        const pubkeyWords = new Uint32Array(8);
        for (let j = 0; j < 8; j++) {
          seedWords[j]   = matchData[offset + j];
          pubkeyWords[j] = matchData[offset + 8 + j];
        }
        matches.push({
          seed:   new Uint8Array(seedWords.buffer.slice(0)),
          pubkey: new Uint8Array(pubkeyWords.buffer.slice(0)),
        });
      }
      this.readbackBuffer!.unmap();
    }

    // Continuous upward time-based scaling:
    // Ed25519 is too heavy for a one-shot tune from a small starting batch to be accurate —
    // the GPU may be underutilised at low workgroup counts, giving a misleading fast reading.
    // Instead, keep scaling up every batch while batches complete under the target.
    // Once a batch finally meets or exceeds the target (or the cap is reached) we lock in.
    if (allowWorkgroupReduce && workgroupsOverride === null && completedCount > 0 && dispatchElapsedMs > 5) {
      if (dispatchElapsedMs < this.dispatchTargetMs && this.numWorkgroups < this._maxWorkgroups) {
        // Batch finished faster than target: scale up (cap growth at 4× per step to avoid overshoot)
        const scaleFactor = Math.min(this.dispatchTargetMs / dispatchElapsedMs, 4.0);
        const tuned = Math.round(this.numWorkgroups * scaleFactor);
        this.numWorkgroups = Math.min(this._maxWorkgroups, tuned);
        this.consecutiveZeroCompletions = 0;
        this.consecutiveFullCompletions = 0;
      } else if (!this._batchSizeTuned) {
        // First batch that meets or exceeds the target: apply a one-shot scale-down if needed, then lock in
        if (dispatchElapsedMs > this.dispatchTargetMs) {
          const tuned = Math.max(4, Math.round(this.numWorkgroups * this.dispatchTargetMs / dispatchElapsedMs));
          this.numWorkgroups = Math.min(this._maxWorkgroups, tuned);
        }
        this._batchSizeTuned = true;
        this.consecutiveZeroCompletions = 0;
        this.consecutiveFullCompletions = 0;
      }
    }

    // Adaptive workgroup scaling
    if (allowWorkgroupReduce && workgroupsOverride === null) {
      const expected = this.workgroupSize * this.numWorkgroups;
      if (completedCount === 0) {
        this.consecutiveZeroCompletions++;
        this.consecutiveFullCompletions = 0;
        if (this.consecutiveZeroCompletions >= 2 && this.numWorkgroups > 4) {
          this.numWorkgroups = Math.max(4, Math.floor(this.numWorkgroups * 0.8));
          this.consecutiveZeroCompletions = 0;
        }
      } else {
        this.consecutiveZeroCompletions = 0;
        if (expected > 0 && completedCount >= Math.floor(0.95 * expected)) {
          this.consecutiveFullCompletions++;
          if (this.consecutiveFullCompletions >= 5 && this.numWorkgroups < this._maxWorkgroups) {
            const next = Math.min(this._maxWorkgroups, Math.ceil(this.numWorkgroups * 1.1));
            if (next > this.numWorkgroups) {
              this.numWorkgroups = next;
              this.consecutiveFullCompletions = 0;
            }
          }
        } else {
          this.consecutiveFullCompletions = 0;
        }
      }
    }

    return { matches, attempted: completedCount };
  }

  destroy(): void {
    this.configBuffer?.destroy();
    this.configBuffer1?.destroy();
    this.configBuffer2?.destroy();
    this.configBuffer3?.destroy();
    this.baseTableBuffer?.destroy();
    this.matchBuffer?.destroy();
    this.matchCountBuffer?.destroy();
    this.readbackBuffer?.destroy();
    this.readbackCountBuffer?.destroy();
    this.device?.destroy();
    this.device = null;
    this.isReady = false;
  }
}
