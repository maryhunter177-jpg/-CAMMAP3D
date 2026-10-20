import * as T from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils, type VRM, type VRMHumanBoneName } from '@pixiv/three-vrm';
import { ARKIT } from './config';
import { clamp } from './filters';
import { BodyRetargeter, type MotionFrame, type HandTuning } from './motion';
type Binding = { mesh:T.Mesh; index:number };
const key = (s:string) => s.toLowerCase().replace(/[^a-z0-9]/g,'');
export class Avatar {
  readonly root = new T.Group();
  private content?: T.Object3D;
  private vrm?: VRM;
  private morphs = new Map<string, Binding[]>();
  private bones: Partial<Record<'head'|'neck'|'jaw'|'leftEye'|'rightEye',T.Object3D>> = {};
  private rest = new Map<T.Object3D,T.Quaternion>();
  private axes = new Map<T.Object3D,T.Quaternion>();
  private headPosition = new T.Vector3();
  private demo = false;
  private demoMouth?: T.Mesh;
  private demoEyes: T.Mesh[] = [];
  private generation = 0;
  private bodyMotion?:BodyRetargeter;
  constructor(private report:(text:string)=>void) {}
  async load(url:string) {
    const ticket = ++this.generation;
    const loader = new GLTFLoader(); loader.register(parser => new VRMLoaderPlugin(parser));
    const gltf = await loader.loadAsync(url);
    if (ticket !== this.generation) { this.disposeObject(gltf.scene); return; }
    this.clear(); this.vrm = gltf.userData.vrm as VRM | undefined;
    if (this.vrm) VRMUtils.rotateVRM0(this.vrm);
    this.content = gltf.scene; this.root.add(this.content);
    const found = new Set<string>();
    const aliases: Record<string,string[]> = {head:['head'],neck:['neck'],jaw:['jaw','mandible'],leftEye:['lefteye','eyeleft'],rightEye:['righteye','eyeright']};
    this.content.traverse(object => {
      const mesh = object as T.Mesh;
      if (mesh.morphTargetDictionary && mesh.morphTargetInfluences) {
        console.group(`Morph targets: ${mesh.name || mesh.uuid}`); console.table(mesh.morphTargetDictionary); console.groupEnd();
        for (const [name,index] of Object.entries(mesh.morphTargetDictionary)) {
          const canonical = ARKIT.find(n => key(n) === key(name));
          if (!canonical) continue;
          found.add(canonical);
          const bindings = this.morphs.get(canonical) ?? []; bindings.push({mesh,index}); this.morphs.set(canonical,bindings);
        }
      }
      if ((object as T.Bone).isBone) for (const [role,names] of Object.entries(aliases)) {
        const normalized = key(object.name).replace(/^mixamorig/,'');
        if (names.includes(normalized)) this.bones[role as keyof typeof this.bones] = object;
      }
    });
    if (this.vrm) for (const role of ['head','neck','jaw','leftEye','rightEye'] as const) {
      const bone = this.vrm.humanoid.getRawBoneNode(role); if (bone) this.bones[role] = bone;
    }
    this.content.updateMatrixWorld(true);
    for (const bone of Object.values(this.bones)) if (bone) {this.rest.set(bone,bone.quaternion.clone());this.axes.set(bone,bone.getWorldQuaternion(new T.Quaternion()));}
    this.headPosition.copy(this.bones.head?.position ?? new T.Vector3());
    console.info('ARKit encontrados', [...found]); console.info('ARKit ausentes', ARKIT.filter(n=>!found.has(n)));
    console.info('MediaPipe não fornece tongueOut; permanece neutro. O canal _neutral não é ARKit.');
    console.info('Expressões VRM',this.vrm?.expressionManager?.expressions.map(e=>e.expressionName) ?? []);
    const box = new T.Box3().setFromObject(this.content); const size = box.getSize(new T.Vector3()); const center = box.getCenter(new T.Vector3());
    if (size.y > 0) { const scale = 2.8 / size.y; this.content.scale.multiplyScalar(scale); this.content.position.sub(center.multiplyScalar(scale)); }
    const bodyAliases:Record<string,T.Object3D|null>={};
    if(this.vrm) {
      const get=(name:string)=>this.vrm!.humanoid.getRawBoneNode(name as VRMHumanBoneName);
      for(const role of ['hips','spine','head','neck','leftEye','rightEye'])bodyAliases[role.toLowerCase()]=get(role);
      bodyAliases.spine2=get('upperChest')??get('chest');
      for(const side of ['left','right']) {
        for(const [name,role] of [['arm','UpperArm'],['forearm','LowerArm'],['hand','Hand'],['upleg','UpperLeg'],['leg','LowerLeg'],['foot','Foot'],['toebase','Toes']])bodyAliases[side+name]=get(side+role);
        for(const finger of ['Thumb','Index','Middle','Ring','Little']) {
          const parts=finger==='Thumb'?['Metacarpal','Proximal','Distal']:['Proximal','Intermediate','Distal'];
          parts.forEach((part,index)=>bodyAliases[side+'hand'+(finger==='Little'?'pinky':finger.toLowerCase())+(index+1)]=get(side+finger+part));
        }
      }
    }
    this.bodyMotion=new BodyRetargeter(this.root,bodyAliases);
    const hasMouth = [...found].some(n=>n.startsWith('mouth') || n==='jawOpen');
    const hasVowels = ['aa','ih','ou','ee','oh'].some(n=>this.vrm?.expressionManager?.getExpression(n));
    const prototype=!!this.content.getObjectByName('MouthInterior') && found.has('jawOpen');
    this.report(`${found.size}/52 ARKit · ${this.vrm?'VRM':'GLB'}${prototype?(found.has('eyeBlinkLeft')?' · boca e olhos experimentais ativos; sorriso indisponível.':' · boca experimental ativa; sorriso e piscadas ainda indisponíveis.'):''}${!hasMouth && !hasVowels ? (this.bones.jaw?' · boca via osso jaw':' · sem controles faciais: boca indisponível'):''}${!this.bones.head && !this.bones.neck?' · sem rig de cabeça: movimento indisponível. Exporte com esqueleto e blendshapes faciais.':''}`);
  }
  showDemo() {
    this.clear(); this.demo = true;
    const head = new T.Group(); this.content = head; this.root.add(head);
    const shell = new T.Mesh(new T.SphereGeometry(.7,48,32),new T.MeshStandardMaterial({color:0xa2e8cf,roughness:.36,metalness:.12})); shell.scale.set(1,1.13,.85); head.add(shell);
    for (const x of [-.25,.25]) {
      const eye = new T.Mesh(new T.SphereGeometry(.09,24,16),new T.MeshStandardMaterial({color:0x102c2e})); eye.position.set(x,.13,.55); head.add(eye); this.demoEyes.push(eye);
    }
    this.demoMouth = new T.Mesh(new T.SphereGeometry(1,24,16),new T.MeshStandardMaterial({color:0x173f3d})); this.demoMouth.position.set(0,-.25,.56); this.demoMouth.scale.set(.19,.025,.03); head.add(this.demoMouth);
    const body = new T.Mesh(new T.CapsuleGeometry(.48,.35,8,24),new T.MeshStandardMaterial({color:0x214b49,roughness:.7})); body.position.y=-1.24; this.root.add(body);
    this.report('Avatar de demonstração · coloque seu GLB em public/models/avatar.glb ou arraste aqui.');
  }
  calibrateBody(){this.bodyMotion?.calibratePosition();}
  calibrateHands(now:number){this.bodyMotion?.calibrateHands(now);}
  resetHands(){this.bodyMotion?.resetHands();}
  get handStatus(){return this.bodyMotion?.handStatus??'Este modelo não tem rig de mãos mapeado';}
  applyMotion(frame:MotionFrame|undefined,now:number,dt:number,mirrored:boolean,body:boolean,hands:boolean,smoothing:number,position=false,handOptions:Partial<HandTuning>&{armScreenWeight?:number;videoAspect?:number;depthGain?:number}={}) {
    this.bodyMotion?.apply(frame,now,dt,mirrored,body,hands,smoothing,position,handOptions);
  }
  apply(values:Float32Array, mirrored:boolean, dt:number, wholeModelMotion=false,faceTracked=true) {
    const v = (name:string) => values[ARKIT.indexOf(name as typeof ARKIT[number])] || 0;
    for (const [name,bindings] of this.morphs) {
      const source = mirrored ? name.replace(/Left$|Right$/,s=>s==='Left'?'Right':'Left') : name;
      for (const {mesh,index} of bindings) mesh.morphTargetInfluences![index] = clamp(v(source));
    }
    const manager = this.vrm?.expressionManager;
    if (manager) {
      const smile = (v('mouthSmileLeft')+v('mouthSmileRight'))*.5;
      const expressions:Record<string,number> = {aa:v('jawOpen')*(1-v('mouthClose')),ih:v('mouthStretchLeft')*.5+v('mouthStretchRight')*.5,ou:v('mouthPucker'),ee:smile,oh:v('mouthFunnel'),happy:smile,angry:(v('browDownLeft')+v('browDownRight'))*.5,sad:(v('mouthFrownLeft')+v('mouthFrownRight'))*.5,surprised:v('browInnerUp')};
      if (!this.bones.leftEye && !this.bones.rightEye) {
        expressions.lookUp=(v('eyeLookUpLeft')+v('eyeLookUpRight'))*.5;
        expressions.lookDown=(v('eyeLookDownLeft')+v('eyeLookDownRight'))*.5;
        const left=(v('eyeLookOutLeft')+v('eyeLookInRight'))*.5;
        const right=(v('eyeLookOutRight')+v('eyeLookInLeft'))*.5;
        expressions.lookLeft=mirrored?right:left; expressions.lookRight=mirrored?left:right;
      }
      const l=v(mirrored?'eyeBlinkRight':'eyeBlinkLeft'), r=v(mirrored?'eyeBlinkLeft':'eyeBlinkRight');
      if (manager.getExpression('blinkLeft') && manager.getExpression('blinkRight')) { expressions.blinkLeft=l; expressions.blinkRight=r; expressions.blink=0; } else expressions.blink=(l+r)*.5;
      const sum = expressions.aa+expressions.ih+expressions.ou+expressions.ee+expressions.oh;
      for (const [name,value] of Object.entries(expressions)) manager.setValue(name,clamp(['aa','ih','ou','ee','oh'].includes(name)?value/Math.max(1,sum):value));
    }
    const sign = mirrored?-1:1;
    const rotation = new T.Euler(clamp(values[52],-.70,.70),clamp(values[53]*sign,-1.047,1.047),clamp(values[54]*sign,-.6,.6),'YXZ');
    const q = new T.Quaternion().setFromEuler(rotation);
    const pose = (bone:T.Object3D|undefined, delta:T.Quaternion, local=false, absolute=false) => {
      if (!bone) return;
      // Tracking axes are scene axes; imported bones may have arbitrary rest axes.
      const basis=this.axes.get(bone)!;
      if(absolute&&bone.parent) {
        bone.parent.updateWorldMatrix(true,false);
        bone.quaternion.copy(bone.parent.getWorldQuaternion(new T.Quaternion()).invert().multiply(delta).multiply(basis));
      } else {
        const rotation=local?delta:basis.clone().invert().multiply(delta).multiply(basis);
        bone.quaternion.copy(this.rest.get(bone)!).multiply(rotation);
      }
      bone.updateWorldMatrix(false,true);
    };
    if (this.bones.head || this.bones.neck) {
      pose(this.bones.neck,new T.Quaternion().slerp(q,this.bones.head ? .4 : 1),false,faceTracked);
      pose(this.bones.head,new T.Quaternion().slerp(q,faceTracked?1:(this.bones.neck ? .6 : 1)),false,faceTracked);
      if (this.bones.head) this.bones.head.position.copy(this.headPosition);
      // Translation is applied in normalized scene units, independent of skeleton scale.
      this.root.position.set(clamp(values[55]*sign,-.2,.2),clamp(values[56],-.15,.15),clamp(values[57],-.2,.2));
    } else if(wholeModelMotion) { this.root.quaternion.copy(q); this.root.position.set(clamp(values[55]*sign,-.2,.2),clamp(values[56],-.15,.15),clamp(values[57],-.2,.2)); }
    else {this.root.quaternion.identity();this.root.position.set(0,0,0);}
    if(this.bodyMotion)this.root.position.add(this.bodyMotion.offset);
    if (!this.morphs.has('jawOpen') && !manager?.getExpression('aa')) pose(this.bones.jaw,new T.Quaternion().setFromAxisAngle(new T.Vector3(1,0,0),v('jawOpen')*.45),true);
    for (const side of ['Left','Right'] as const) {
      const source = mirrored?(side==='Left'?'Right':'Left'):side;
      const eye = this.bones[side==='Left'?'leftEye':'rightEye'];
      const yaw = (v(`eyeLookOut${source}`)-v(`eyeLookIn${source}`))*(side==='Left'?1:-1)*.4;
      const pitch = (v(`eyeLookDown${source}`)-v(`eyeLookUp${source}`))*.3;
      if (!this.morphs.has(`eyeLookUp${side}`)) pose(eye,new T.Quaternion().setFromEuler(new T.Euler(pitch,yaw,0)));
    }
    if (this.demo) {
      this.content?.quaternion.copy(q);
      this.demoMouth?.scale.set(.19+v('mouthSmileLeft')*.08,.025+v('jawOpen')*.2,.03);
      this.demoEyes.forEach((eye,i)=>eye.scale.y=Math.max(.04,1-v(i?'eyeBlinkRight':'eyeBlinkLeft')));
    }
    // Raw bones are driven above; don't let normalized humanoid overwrite them.
    if (this.vrm) { this.vrm.expressionManager?.update(); this.vrm.springBoneManager?.update(dt); this.vrm.nodeConstraintManager?.update(); }
  }
  private disposeObject(object:T.Object3D) {
    const textures = new Set<T.Texture>();
    object.traverse(o=>{const m=o as T.Mesh; m.geometry?.dispose(); if(m.material) for(const mat of Array.isArray(m.material)?m.material:[m.material]) {for(const value of Object.values(mat)) if(value instanceof T.Texture) textures.add(value); mat.dispose();}});
    textures.forEach(t=>t.dispose());
  }
  private clear() { this.bodyMotion=undefined;this.root.children.forEach(c=>this.disposeObject(c)); this.root.clear(); this.root.position.set(0,0,0); this.root.quaternion.identity(); this.morphs.clear(); this.rest.clear(); this.axes.clear(); this.bones={}; this.vrm=undefined; this.demo=false; this.demoEyes=[]; this.demoMouth=undefined; }
}
