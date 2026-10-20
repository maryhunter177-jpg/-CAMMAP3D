import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { FilterBank, Calibration, clamp, OneEuro } from '../src/filters.ts';

test('adaptive filtering ignores repeated timestamps, attenuates jitter and resets after a gap',()=>{
  const filter=new OneEuro();let inputEnergy=0,outputEnergy=0;
  for(let i=0;i<90;i++){const input=Math.sin(i*2)*.01,output=filter.step(input,1000+i*1000/30);if(i>10){inputEnergy+=input*input;outputEnergy+=output*output;}}
  assert.ok(outputEnergy<inputEnergy*.4);
  const held=filter.step(0,4000);assert.equal(filter.step(100,4000),held);
  const fast=filter.step(1,4033);assert.ok(fast>.65,'real motion should pass with little delay');
  assert.equal(filter.step(.3,5000),.3);assert.equal(filter.step(NaN,5033),.3);
});
test('clamp handles invalid numbers and out-of-range coefficients',()=>{assert.equal(clamp(NaN),0);assert.equal(clamp(4),1);assert.equal(clamp(-2),0);});
test('smoothing is stable across render rates and returns to neutral',()=>{
  const a=new FilterBank(),b=new FilterBank();
  for(let i=0;i<60;i++)a.step(new Float32Array([1]),1/60,.055);
  for(let i=0;i<30;i++)b.step(new Float32Array([1]),1/30,.055);
  assert.ok(Math.abs(a.step(new Float32Array([1]),0,.055)[0]-b.step(new Float32Array([1]),0,.055)[0])<1e-5);
  let neutral=1;for(let i=0;i<120;i++)neutral=a.step(new Float32Array([0]),1/60,.15)[0];assert.ok(neutral<.00001);
});
test('calibration commits only after two seconds and preserves previous base on cancel',()=>{
  const c=new Calibration();const values=new Float32Array(58).fill(.2);c.begin(100);
  assert.equal(c.sample(values,1100),false);assert.equal(c.baseline[0],0);
  assert.equal(c.sample(values,2100),true);assert.ok(Math.abs(c.baseline[0]-.2)<1e-6);
  c.begin(2200);c.sample(new Float32Array(58),2300);c.cancel();assert.ok(Math.abs(c.baseline[0]-.2)<1e-6);
});
test('compiled Rust batch agrees with TypeScript recurrence',async t=>{
  let bytes:Buffer;try{bytes=await readFile('public/wasm/cammap_filters.wasm');}catch{t.skip('Compile Rust with npm run build:rust first');return;}
  const {instance}=await WebAssembly.instantiate(bytes);
  const k=instance.exports as unknown as {memory:WebAssembly.Memory;input_ptr():number;output_ptr():number;reset():void;step(n:number,a:number):void};
  k.reset();const input=new Float32Array(k.memory.buffer,k.input_ptr(),58),out=new Float32Array(k.memory.buffer,k.output_ptr(),58);
  const expected=new Float32Array(58);
  for(let frame=0;frame<100;frame++){for(let i=0;i<58;i++){input[i]=Math.sin(i+frame);expected[i]+=(input[i]-expected[i])*.2;}k.step(58,.2);for(let i=0;i<58;i++)assert.ok(Math.abs(out[i]-expected[i])<1e-6);}
});
