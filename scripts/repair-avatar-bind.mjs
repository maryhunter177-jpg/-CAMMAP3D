import fs from 'node:fs';
import { Matrix4 } from 'three';
// Repair this Tripo export only: no joint TRS was exported, while inverse bind
// matrices remained in X-forward/Y-left/Z-up coordinates centered at ground+.5.
const source=process.argv[2] || 'public/models/avatar-rig-original.glb';
const destination=process.argv[3] || 'public/models/avatar-restored.glb';
const bytes=fs.readFileSync(source),jsonLength=bytes.readUInt32LE(12);
const doc=JSON.parse(bytes.subarray(20,20+jsonLength).toString());
const binary=Buffer.from(bytes.subarray(28+jsonLength));
if(doc.nodes.some(n=>n.matrix||n.translation||n.rotation||n.scale))throw new Error('This repair is only for the verified Tripo export with missing joint transforms.');
const basis=new Matrix4().set(0,1,0,0, 0,0,1,.5, 1,0,0,0, 0,0,0,1);
const basisInverse=basis.clone().invert(),worlds=new Map(),parents=new Map();
doc.nodes.forEach((n,i)=>n.children?.forEach(child=>parents.set(child,i)));
for(const skin of doc.skins??[]) {
  const accessor=doc.accessors[skin.inverseBindMatrices],view=doc.bufferViews[accessor.bufferView];
  if(accessor.componentType!==5126||accessor.type!=='MAT4')throw new Error('Unexpected inverse bind format');
  for(let i=0;i<skin.joints.length;i++) {
    const offset=(view.byteOffset||0)+(accessor.byteOffset||0)+i*(view.byteStride||64);
    const inverse=new Matrix4().fromArray(Array.from({length:16},(_,k)=>binary.readFloatLE(offset+4*k)));
    worlds.set(skin.joints[i],basis.clone().multiply(inverse.clone().invert()));
    inverse.multiply(basisInverse).toArray().forEach((value,k)=>binary.writeFloatLE(value,offset+4*k));
  }
}
for(const [index,world] of worlds) {
  const parentWorld=worlds.get(parents.get(index)) ?? new Matrix4();
  doc.nodes[index].matrix=parentWorld.clone().invert().multiply(world).toArray();
}
doc.asset.extras={...(doc.asset.extras||{}),cammapBindRepair:'Recovered missing bind transforms; corrected Tripo axes; source preserved.'};
const json=Buffer.from(JSON.stringify(doc));const padded=Buffer.alloc(Math.ceil(json.length/4)*4,32);json.copy(padded);
const output=Buffer.alloc(12+8+padded.length+8+binary.length);
output.writeUInt32LE(0x46546c67,0);output.writeUInt32LE(2,4);output.writeUInt32LE(output.length,8);
output.writeUInt32LE(padded.length,12);output.writeUInt32LE(0x4e4f534a,16);padded.copy(output,20);
output.writeUInt32LE(binary.length,20+padded.length);output.writeUInt32LE(0x004e4942,24+padded.length);binary.copy(output,28+padded.length);
fs.writeFileSync(destination,output);console.log(`Recovered ${worlds.size} joints: ${destination}`);
