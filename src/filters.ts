export const clamp = (x: number, min = 0, max = 1) => Math.min(max, Math.max(min, Number.isFinite(x) ? x : 0));
/** Adaptive low-pass, sampled at inference timestamps rather than render rate. */
export class OneEuro {
  private time=-Infinity;
  private raw=0;
  private value=0;
  private velocity=0;
  private minCutoff:number;
  private beta:number;
  constructor(minCutoff=2.5,beta=3){this.minCutoff=minCutoff;this.beta=beta;}
  step(input:number,now:number){
    if(!Number.isFinite(input)||!Number.isFinite(now))return this.value;
    if(now<=this.time)return this.value;
    if(now-this.time>500){this.raw=this.value=input;this.velocity=0;this.time=now;return input;}
    const dt=(now-this.time)/1000;
    const alpha=(cutoff:number)=>1/(1+1/(2*Math.PI*cutoff*dt));
    this.velocity+=((input-this.raw)/dt-this.velocity)*alpha(1);
    this.value+=(input-this.value)*alpha(this.minCutoff+this.beta*Math.abs(this.velocity));
    this.raw=input;this.time=now;return this.value;
  }
}
type Kernel = { memory: WebAssembly.Memory; input_ptr(): number; output_ptr(): number; step(n: number, alpha: number): void; reset(): void };
/** One batch per frame, fixed buffers, no wasm-bindgen or per-channel WASM calls. */
export class FilterBank {
  private state = new Float32Array(128);
  private kernel?: Kernel;
  async init(): Promise<boolean> {
    try {
      const response = await fetch('/wasm/cammap_filters.wasm');
      if (!response.ok) return false;
      const { instance } = await WebAssembly.instantiate(await response.arrayBuffer());
      this.kernel = instance.exports as unknown as Kernel;
      this.kernel.reset();
      return true;
    } catch { return false; }
  }
  step(values: Float32Array, dt: number, smoothing: number): Float32Array {
    const alpha = 1 - Math.exp(-clamp(dt, 0, .1) / Math.max(.004, smoothing));
    if (this.kernel) {
      new Float32Array(this.kernel.memory.buffer, this.kernel.input_ptr(), values.length).set(values);
      this.kernel.step(values.length, alpha);
      this.state.set(new Float32Array(this.kernel.memory.buffer, this.kernel.output_ptr(), values.length));
    } else for (let i = 0; i < values.length; i++) this.state[i] += (values[i] - this.state[i]) * alpha;
    return this.state.subarray(0, values.length);
  }
}
export class Calibration {
  baseline = new Float32Array(58);
  private sum = new Float64Array(58);
  private count = 0;
  private start = 0;
  active = false;
  begin(now: number) { this.sum.fill(0); this.count = 0; this.start = now; this.active = true; }
  sample(values: Float32Array, now: number): boolean {
    if (!this.active) return false;
    this.count++;
    for (let i = 0; i < values.length; i++) this.sum[i] += values[i];
    if (now - this.start < 2000) return false;
    for (let i = 0; i < this.baseline.length; i++) this.baseline[i] = this.sum[i] / this.count;
    this.active = false;
    return true;
  }
  cancel() { this.active = false; }
}
