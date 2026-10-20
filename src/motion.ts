import * as T from 'three';
import { clamp, OneEuro } from './filters.ts';
import {assignHands,solveArm,type Side} from './motion-quality.ts';
export type Point3 = { x:number; y:number; z:number; visibility?:number; presence?:number };
export type MotionFrame = {
  pose?: {landmarks:Point3[][];worldLandmarks:Point3[][]};
  hands?: {landmarks:Point3[][];worldLandmarks:Point3[][];handedness:{categoryName:string;score:number}[][]};
  poseTime:number; handTime:number;
};
export const motionPoint=(p:Point3,mirror:boolean)=>new T.Vector3(p.x*(mirror?-1:1),-p.y,-p.z);
/** Preserve the observed arm elevation when monocular depth bends the 3D estimate. */
export function armDirection(a:Point3,b:Point3,world:T.Vector3,mirror:boolean,weight:number,aspect:number){
  const projected=new T.Vector3((b.x-a.x)*aspect*(mirror?-1:1),a.y-b.y,0);
  const direction=world.clone().normalize();
  if(projected.lengthSq()<1e-8)return direction;
  const flat=new T.Vector3(direction.x,direction.y,0);
  if(flat.lengthSq()<1e-8)return direction;
  flat.normalize().lerp(projected.normalize(),clamp(weight)).normalize();
  // Correct only image-plane heading: retain the full estimated depth.
  flat.multiplyScalar(Math.sqrt(Math.max(0,1-direction.z*direction.z)));flat.z=direction.z;
  return flat.normalize();
}
export function palmApproach(points:Point3[],world:Point3[],shoulderImage:number,shoulderWorld:number,aspect:number){
  if(shoulderImage<.04||shoulderWorld<.05)return 0;
  const ratios=([[0,9],[5,17]] as const).map(([a,b])=>{
    const metric=Math.hypot(world[a].x-world[b].x,world[a].y-world[b].y,world[a].z-world[b].z);
    const image=Math.hypot((points[a].x-points[b].x)*aspect,points[a].y-points[b].y);
    return metric>.015?image/shoulderImage/(metric/shoulderWorld):0;
  });
  // Require both palm dimensions to agree; opening fingers alone is no cue.
  const ratio=Math.min(...ratios);
  return clamp((1-1/Math.max(1,ratio))/.65,0,1);
}
// HandLandmarker does not supply per-point visibility; the JS wrapper fills
// the absent protobuf field with zero. That zero is not a rejected hand.
export function handPointVisible(p:Point3|undefined) {
  return !!p&&[p.x,p.y,p.z].every(Number.isFinite)&&p.x>=0&&p.x<=1&&p.y>=0&&p.y<=1;
}
export type HandTuning={handSmoothing:number;fingerSmoothing:number;wristGain:number;fingerGain:number;spreadGain:number;forearmTwist:number;wristPitch:number;wristYaw:number;wristRoll:number;thumbGain:number;indexGain:number;middleGain:number;ringGain:number;pinkyGain:number};
export const HAND_DEFAULTS:HandTuning={handSmoothing:.045,fingerSmoothing:.035,wristGain:1,fingerGain:1,spreadGain:1,forearmTwist:.3,wristPitch:0,wristYaw:0,wristRoll:0,thumbGain:1,indexGain:1,middleGain:1,ringGain:1,pinkyGain:1};
const FINGERS=[['thumb',1],['index',5],['middle',9],['ring',13],['pinky',17]] as const;
type HandCalibration={start:number;lastSample:number;samples:Map<string,{count:number;directions:T.Vector3[]}>};
export function visible(p:Point3|undefined) {
  return !!p && [p.x,p.y,p.z].every(Number.isFinite) && (p.visibility??1)>.55 && (p.presence??1)>.5 && p.x>=0 && p.x<=1 && p.y>=0 && p.y<=1;
}
export function frameRotation(across:T.Vector3,up:T.Vector3):T.Quaternion|undefined {
  const y=up.clone().normalize(),z=across.clone().cross(y);
  if(y.lengthSq()<.5||z.lengthSq()<1e-6)return;
  z.normalize();const x=y.clone().cross(z).normalize();
  return new T.Quaternion().setFromRotationMatrix(new T.Matrix4().makeBasis(x,y,z));
}
type Joint={bone:T.Object3D;rest:T.Quaternion;world:T.Quaternion;position:T.Vector3;direction?:T.Vector3};
const normalized=(name:string)=>name.toLowerCase().replace(/[^a-z0-9]/g,'').replace(/^mixamorig/,'');
/** Direction-based retargeting. Retains bone lengths and never writes scale. */
export class BodyRetargeter {
  readonly offset=new T.Vector3();
  private hipOrigin?:T.Vector2;
  private root:T.Object3D;
  private joints=new Map<string,Joint>();
  private restHipFrame?:T.Quaternion;
  private restChestFrame?:T.Quaternion;
  private handFrames=new Map<string,T.Quaternion>();
  private neutralArms=new Map<string,T.Quaternion>();
  private openHandDirections=new Map<string,T.Vector3[]>();
  private handCalibration?:HandCalibration;
  private handHistory=new Map<string,{point:T.Vector2;time:number}>();
  private handCalibrationMessage='Mãos sem calibração personalizada';
  private inferredArms=0;
  private armFilters=new Map<string,[OneEuro,OneEuro,OneEuro]>();
  private elbowHints=new Map<string,T.Vector3>();
  private recentJoints=new Map<string,{time:number;rotation:T.Quaternion}>();
  private previousMirror?:boolean;
  activeHands=0;
  activeFingerJoints=0;
  get handStatus(){return `${this.handCalibrationMessage} · ${this.activeHands} mão${this.activeHands===1?'':'s'} aplicada${this.activeHands===1?'':'s'} / ${this.activeFingerJoints} articulações${this.inferredArms?' · cotovelo estimado: '+this.inferredArms:''}`;}
  constructor(root:T.Object3D,aliases:Record<string,T.Object3D|null>={}) {
    this.root=root;
    root.updateMatrixWorld(true);
    const register=(name:string,bone:T.Object3D)=>this.joints.set(name,{bone,rest:bone.quaternion.clone(),world:bone.getWorldQuaternion(new T.Quaternion()),position:bone.getWorldPosition(new T.Vector3())});
    root.traverse(bone=>{if((bone as T.Bone).isBone)register(normalized(bone.name),bone);});
    for(const [name,bone] of Object.entries(aliases))if(bone) {
      for(const [oldName,j] of this.joints)if(j.bone===bone)this.joints.delete(oldName);
      register(name,bone);
    }
    for(const [name,j] of this.joints) {
      const child=j.bone.children.find(c=>(c as T.Bone).isBone);
      if(child)j.direction=child.getWorldPosition(new T.Vector3()).sub(j.position).normalize();
      else if((j.bone.parent as T.Bone)?.isBone)j.direction=j.position.clone().sub(j.bone.parent!.getWorldPosition(new T.Vector3())).normalize();
    }
    const p=(n:string)=>this.joints.get(n)?.position;
    const shoulderL=p('leftarm'),shoulderR=p('rightarm'),hipL=p('leftupleg'),hipR=p('rightupleg');
    if(shoulderL&&shoulderR&&hipL&&hipR) {
      const up=shoulderL.clone().add(shoulderR).sub(hipL).sub(hipR);
      this.restHipFrame=frameRotation(hipL.clone().sub(hipR),up);
      this.restChestFrame=frameRotation(shoulderL.clone().sub(shoulderR),up);
    }
    for(const side of ['left','right']) {
      const wrist=p(side+'hand'),index=p(side+'handindex1'),pinky=p(side+'handpinky1'),middle=p(side+'handmiddle1');
      if(wrist&&index&&pinky&&middle) {const q=frameRotation(index.clone().sub(pinky),middle.clone().sub(wrist));if(q)this.handFrames.set(side,q);}
      const arm=this.joints.get(side+'arm');
      if(arm?.direction) {
        // A relaxed downwards arm is a clearer neutral than a permanent T-pose.
        const down=new T.Vector3(side==='left'?.12:-.12,-1,.05).normalize();
        const world=new T.Quaternion().setFromUnitVectors(arm.direction,down).multiply(arm.world);
        const parent=arm.bone.parent!.getWorldQuaternion(new T.Quaternion());
        this.neutralArms.set(side,parent.invert().multiply(world));
      }
    }
  }
  get available() {return this.joints.has('leftarm')&&this.joints.has('rightarm');}
  private setWorld(name:string,world:T.Quaternion,alpha:number) {
    const j=this.joints.get(name);if(!j||!j.bone.parent)return;
    j.bone.parent.updateWorldMatrix(true,false);
    const local=j.bone.parent.getWorldQuaternion(new T.Quaternion()).invert().multiply(world);
    j.bone.quaternion.slerp(local,alpha);j.bone.updateWorldMatrix(false,true);
  }
  private aim(name:string,direction:T.Vector3,alpha:number) {
    const j=this.joints.get(name);if(!j?.direction||direction.lengthSq()<1e-8)return;
    this.setWorld(name,new T.Quaternion().setFromUnitVectors(j.direction,direction.normalize()).multiply(j.world),alpha);
  }
  apply(frame:MotionFrame|undefined,now:number,dt:number,mirror:boolean,body:boolean,hands:boolean,smoothing:number,position=false,options:Partial<HandTuning>&{armScreenWeight?:number;videoAspect?:number;depthGain?:number}={}) {
    if(!frame||mirror!==this.previousMirror){this.armFilters.clear();this.elbowHints.clear();this.handHistory.clear();this.recentJoints.clear();this.previousMirror=mirror;}
    const alpha=1-Math.exp(-clamp(dt,0,.1)/Math.max(.025,smoothing));
    const tuning={...HAND_DEFAULTS,...options};
    const handAlpha=1-Math.exp(-clamp(dt,0,.1)/Math.max(.015,tuning.handSmoothing));
    const fingerAlpha=1-Math.exp(-clamp(dt,0,.1)/Math.max(.015,tuning.fingerSmoothing));
    this.activeHands=0;this.activeFingerJoints=0;this.inferredArms=0;
    const driven=new Set<string>();
    const armBefore=new Map<string,T.Quaternion>();
    for(const side of ['left','right'])for(const part of ['arm','forearm']){const bone=this.joints.get(side+part)?.bone;if(bone)armBefore.set(side+part,bone.quaternion.clone());}
    const pose=body&&frame&&now-frame.poseTime<350?frame.pose:undefined;
    const wp=pose?.worldLandmarks[0],np=pose?.landmarks[0];
    const desiredOffset=new T.Vector3();
    if(!frame)this.hipOrigin=undefined;
    if(position&&np&&visible(np[23])&&visible(np[24])) {
      const center=new T.Vector2((np[23].x+np[24].x)*.5,(np[23].y+np[24].y)*.5);
      this.hipOrigin??=center.clone();
      desiredOffset.set(clamp((center.x-this.hipOrigin.x)*(mirror?-1:1)*2.5,-.6,.6),clamp(-(center.y-this.hipOrigin.y)*2,-.35,.35),0);
    }
    this.offset.lerp(desiredOffset,alpha);
    const aim=(name:string,direction:T.Vector3)=>{this.aim(name,direction,alpha);driven.add(name);};
    if(wp&&np) {
      const vector=(i:number)=>motionPoint(wp[i],mirror);
      const valid=(...ids:number[])=>ids.every(i=>visible(np[i])&&wp[i]&&[wp[i].x,wp[i].y,wp[i].z].every(Number.isFinite));
      const source=(side:string,left:number,right:number)=>(side==='left')!==mirror?left:right;
      if(valid(11,12,23,24)) {
        const sl=source('left',11,12),sr=source('right',11,12),hl=source('left',23,24),hr=source('right',23,24);
        const up=vector(sl).add(vector(sr)).sub(vector(hl)).sub(vector(hr));
        for(const [name,a,b,rest] of [['hips',hl,hr,this.restHipFrame],['spine2',sl,sr,this.restChestFrame]] as const) {
          const q=frameRotation(vector(a).sub(vector(b)),up),j=this.joints.get(name);
          if(q&&rest&&j){this.setWorld(name,q.multiply(rest.clone().invert()).multiply(j.world),alpha);driven.add(name);}
        }
      }
      for(const side of ['left','right']) {
        for(const [name,l0,r0,l1,r1] of [['arm',11,12,13,14],['forearm',13,14,15,16],['upleg',23,24,25,26],['leg',25,26,27,28],['foot',27,28,31,32]] as const) {
          const a=source(side,l0,r0),b=source(side,l1,r1);
          if(valid(a,b)) {
            let direction=vector(b).sub(vector(a));
            if(name==='arm'||name==='forearm')direction=armDirection(np[a],np[b],direction,mirror,options.armScreenWeight??0,options.videoAspect??4/3);
            aim(side+name,direction);
          }
        }
      }
    }
    const hand=hands&&frame&&now-frame.handTime<350?frame.hands:undefined;
    const used=new Set<string>();
    const wrists:Partial<Record<Side,Point3>>={};
    if(np){if(visible(np[15]))wrists.left=np[15];if(visible(np[16]))wrists.right=np[16];}
    const handSides=assignHands((hand?.landmarks??[]).map((points,index)=>({point:points[0]??{x:-10,y:-10},side:hand!.handedness[index]?.[0]?.categoryName==='Left'?'left':'right',score:hand!.handedness[index]?.[0]?.score??0})),wrists,this.handHistory,now);
    hand?.worldLandmarks.forEach((world,index)=>{
      const points=hand.landmarks[index];if(world.length!==21||!world.every(p=>[p.x,p.y,p.z].every(Number.isFinite))||!points?.every(p=>Number.isFinite(p.x)&&Number.isFinite(p.y))||!handPointVisible(points[0]))return;
      const sourceSide=handSides[index];
      // Body wrists disambiguate hand classification in a non-mirrored video.
      const bodyPoints=frame?.pose?.landmarks[0];
      let associated=false;
      if(bodyPoints&&frame&&now-frame.poseTime<350) {
        const distance=(p:Point3)=>Math.hypot(p.x-points[0].x,p.y-points[0].y);
        const candidates=([['left',15],['right',16]] as const).filter(([,i])=>visible(bodyPoints[i])).map(([side,i])=>({side,distance:distance(bodyPoints[i])})).sort((a,b)=>a.distance-b.distance);
        if(candidates.some(c=>c.side===sourceSide&&c.distance<.22))associated=true;
      }
      const side=mirror?(sourceSide==='left'?'right':'left'):sourceSide;if(used.has(side))return;used.add(side);
      this.handHistory.set(sourceSide,{point:new T.Vector2(points[0].x,points[0].y),time:frame!.handTime});
      const v=(i:number)=>motionPoint(world[i],mirror);
      const target=frameRotation(v(5).sub(v(17)),v(9).sub(v(0))),rest=this.handFrames.get(side),j=this.joints.get(side+'hand');
      if(!target||!rest||!j)return;
      const aspect=options.videoAspect??4/3;
      const shoulderImage=np?Math.hypot((np[11].x-np[12].x)*aspect,np[11].y-np[12].y):0;
      const shoulderWorld=wp?motionPoint(wp[11],false).distanceTo(motionPoint(wp[12],false)):0;
      const approach=palmApproach(points,world,shoulderImage,shoulderWorld,aspect);
      // A cropped elbow must not leave a visible, articulated hand at the hip.
      // Estimate a reachable two-bone arm from shoulder/wrist image coordinates.
      if(body&&np&&visible(np[11])&&visible(np[12])&&(associated||(hand.handedness[index]?.[0]?.score??0)>=.8)) {
        const upper=this.joints.get(side+'arm'),lower=this.joints.get(side+'forearm');
        const left=this.joints.get('leftarm'),right=this.joints.get('rightarm');
        const shoulder=np[sourceSide==='left'?11:12],aspect=options.videoAspect??4/3;
        const imageWidth=Math.hypot((np[11].x-np[12].x)*aspect,np[11].y-np[12].y);
        if(upper&&lower&&left&&right&&imageWidth>.04) {
          const units=left.position.distanceTo(right.position)/imageWidth;
          const lengthA=upper.position.distanceTo(lower.position),lengthB=lower.position.distanceTo(j.position);
          const reach=new T.Vector3((points[0].x-shoulder.x)*aspect*(mirror?-1:1),shoulder.y-points[0].y,0).multiplyScalar(units);
          const shoulderId=sourceSide==='left'?11:12,wristId=sourceSide==='left'?15:16;
          const metricScale=shoulderWorld>.05?left.position.distanceTo(right.position)/shoulderWorld:0;
          const poseDepth=wp&&visible(np[wristId])?-(wp[wristId].z-wp[shoulderId].z)*metricScale:0;
          // Undo perspective around the image centre before subtracting the
          // shoulder, instead of shrinking the shoulder-to-hand vector.
          const depth=approach*clamp(options.depthGain??1,0,1.5);
          const perspective=1-depth*.55;
          reach.x=((points[0].x-.5)*perspective-(shoulder.x-.5))*aspect*(mirror?-1:1)*units;
          reach.y=((.5-points[0].y)*perspective-(.5-shoulder.y))*units;
          reach.z=Math.max(poseDepth,depth*(lengthA+lengthB)*.95,.04);
          let filter=this.armFilters.get(side);if(!filter){filter=[new OneEuro(),new OneEuro(),new OneEuro(1.8,4)];this.armFilters.set(side,filter);}
          reach.set(filter[0].step(reach.x,frame!.handTime),filter[1].step(reach.y,frame!.handTime),filter[2].step(reach.z,frame!.handTime));
          if(lengthA>1e-5&&lengthB>1e-5&&reach.lengthSq()>1e-8) {
            const elbowId=sourceSide==='left'?13:14;
            const measuredElbow=wp&&visible(np[elbowId])?motionPoint(wp[elbowId],mirror).sub(motionPoint(wp[shoulderId],mirror)):undefined;
            const hint=this.elbowHints.get(side)??new T.Vector3(side==='left'?.35:-.35,-1,0);
            if(measuredElbow&&measuredElbow.lengthSq()>1e-6)hint.lerp(measuredElbow.normalize(),alpha);
            const solution=solveArm(reach,lengthA,lengthB,hint);if(!solution)return;
            this.elbowHints.set(side,solution.bend.clone());
            // Resolve this frame once, rather than smoothing toward two
            // competing Pose and IK targets on every render frame.
            upper.bone.quaternion.copy(armBefore.get(side+'arm')!);lower.bone.quaternion.copy(armBefore.get(side+'forearm')!);
            upper.bone.updateWorldMatrix(true,true);
            aim(side+'arm',solution.upper);aim(side+'forearm',solution.lower);if(!measuredElbow)this.inferredArms++;
          }
        }
      }
      const targetInverse=target.clone().invert();
      const localDirections=FINGERS.flatMap(([,base])=>[0,1,2].map(segment=>v(base+segment+1).sub(v(base+segment)).normalize().applyQuaternion(targetInverse)));
      const calibration=this.handCalibration;
      if(calibration&&frame&&frame.handTime!==calibration.lastSample&&now-calibration.start<=2200) {
        const straight=FINGERS.slice(1).every(([,base])=>{
          const a=v(base+1).sub(v(base)).normalize(),b=v(base+2).sub(v(base+1)).normalize(),c=v(base+3).sub(v(base+2)).normalize();
          return a.dot(b)>.8&&b.dot(c)>.8;
        });
        if(straight) {
          const sample=calibration.samples.get(sourceSide)??{count:0,directions:localDirections.map(()=>new T.Vector3())};sample.count++;
          localDirections.forEach((direction,i)=>{const canonical=direction.clone();if(mirror)canonical.z*=-1;sample.directions[i].add(canonical);});
          calibration.samples.set(sourceSide,sample);
        }
      }
      const trim=new T.Quaternion().setFromEuler(new T.Euler(T.MathUtils.degToRad(tuning.wristPitch),T.MathUtils.degToRad(tuning.wristYaw),T.MathUtils.degToRad(tuning.wristRoll),'YXZ'));
      const desiredPalm=target.clone().multiply(trim);
      let desiredWrist=desiredPalm.clone().multiply(rest.clone().invert()).multiply(j.world);
      const forearm=this.joints.get(side+'forearm');
      if(forearm&&tuning.forearmTwist>0&&j.bone.parent===forearm.bone) {
        forearm.bone.updateWorldMatrix(true,false);
        const base=driven.has(side+'forearm')?forearm.bone.getWorldQuaternion(new T.Quaternion()):forearm.bone.parent!.getWorldQuaternion(new T.Quaternion()).multiply(forearm.rest);
        const relative=base.clone().invert().multiply(desiredWrist).multiply(j.rest.clone().invert());
        const axis=j.bone.position.clone().normalize();const projection=new T.Vector3(relative.x,relative.y,relative.z).dot(axis);
        const twist=new T.Quaternion(axis.x*projection,axis.y*projection,axis.z*projection,relative.w);
        if(twist.lengthSq()>1e-8) {
          twist.normalize();if(twist.w<0)twist.set(-twist.x,-twist.y,-twist.z,-twist.w);
          const share=new T.Quaternion().slerp(twist,clamp(tuning.forearmTwist,0,.65));
          this.setWorld(side+'forearm',base.multiply(share),handAlpha);driven.add(side+'forearm');
        }
      }
      j.bone.parent!.updateWorldMatrix(true,false);
      const parentWorld=j.bone.parent!.getWorldQuaternion(new T.Quaternion());
      const desiredLocal=parentWorld.clone().invert().multiply(desiredWrist);
      const relativeWrist=j.rest.clone().invert().multiply(desiredLocal);
      desiredWrist=parentWorld.multiply(j.rest).multiply(new T.Quaternion().slerp(relativeWrist,clamp(tuning.wristGain,0,1.5)));
      this.setWorld(side+'hand',desiredWrist,handAlpha);driven.add(side+'hand');this.activeHands++;
      // Digits inherit actual palm roll. Aligning every segment directly in
      // world space would counter-rotate them when the wrist twists.
      const actualPalm=j.bone.getWorldQuaternion(new T.Quaternion()).multiply(j.world.clone().invert()).multiply(rest);
      const restInverse=rest.clone().invert(),reference=this.openHandDirections.get(sourceSide);
      for(const [finger,base] of FINGERS) {
        for(let segment=0;segment<3;segment++) {
          const name=side+'hand'+finger+(segment+1),joint=this.joints.get(name),slot=FINGERS.findIndex(([n])=>n===finger)*3+segment;
          if(!joint?.direction||!handPointVisible(points[base+segment])||!handPointVisible(points[base+segment+1]))continue;
          const restDirection=joint.direction.clone().applyQuaternion(restInverse),observed=localDirections[slot];
          if(observed.lengthSq()<.5)continue;
          let desiredDirection=observed.clone();
          if(reference) {
            const neutral=reference[slot].clone();if(mirror)neutral.z*=-1;
            desiredDirection=restDirection.clone().applyQuaternion(new T.Quaternion().setFromUnitVectors(neutral,observed));
          }
          desiredDirection.x=restDirection.x+(desiredDirection.x-restDirection.x)*clamp(tuning.spreadGain,0,2);desiredDirection.normalize();
          const swing=new T.Quaternion().setFromUnitVectors(restDirection,desiredDirection);
          const gain=clamp(tuning.fingerGain*tuning[(finger+'Gain') as keyof HandTuning],0,2);
          const angle=new T.Quaternion().angleTo(swing),limit=T.MathUtils.degToRad(finger==='thumb'?110:segment===0?100:120);
          const tuned=new T.Quaternion().slerp(swing,Math.min(gain,angle>1e-6?limit/angle:gain));
          const worldRotation=actualPalm.clone().multiply(tuned).multiply(restInverse).multiply(joint.world);
          this.setWorld(name,worldRotation,fingerAlpha);driven.add(name);this.activeFingerJoints++;
        }
      }
    });
    // Pose can still locate a wrist when HandLandmarker loses a turned or
    // overlapping palm. Recover the cropped elbow without inventing fingers.
    if(np&&wp&&visible(np[11])&&visible(np[12]))for(const side of ['left','right']) {
      if(used.has(side)||(driven.has(side+'arm')&&driven.has(side+'forearm')))continue;
      const sourceSide=mirror?(side==='left'?'right':'left'):side,shoulderId=sourceSide==='left'?11:12,wristId=sourceSide==='left'?15:16;
      if(!visible(np[wristId]))continue;
      const upper=this.joints.get(side+'arm'),lower=this.joints.get(side+'forearm'),wrist=this.joints.get(side+'hand'),left=this.joints.get('leftarm'),right=this.joints.get('rightarm');
      if(!upper||!lower||!wrist||!left||!right)continue;
      const aspect=options.videoAspect??4/3,imageWidth=Math.hypot((np[11].x-np[12].x)*aspect,np[11].y-np[12].y),worldWidth=motionPoint(wp[11],false).distanceTo(motionPoint(wp[12],false));
      if(imageWidth<.04||worldWidth<.05)continue;
      const modelWidth=left.position.distanceTo(right.position),units=modelWidth/imageWidth;
      const reach=new T.Vector3((np[wristId].x-np[shoulderId].x)*aspect*(mirror?-1:1)*units,(np[shoulderId].y-np[wristId].y)*units,-(wp[wristId].z-wp[shoulderId].z)*modelWidth/worldWidth);
      const solution=solveArm(reach,upper.position.distanceTo(lower.position),lower.position.distanceTo(wrist.position),this.elbowHints.get(side)??new T.Vector3(side==='left'?.35:-.35,-1,0));
      if(!solution)continue;
      upper.bone.quaternion.copy(armBefore.get(side+'arm')!);lower.bone.quaternion.copy(armBefore.get(side+'forearm')!);upper.bone.updateWorldMatrix(true,true);
      aim(side+'arm',solution.upper);aim(side+'forearm',solution.lower);this.elbowHints.set(side,solution.bend);this.inferredArms++;
    }
    if(this.handCalibration&&frame?.handTime)this.handCalibration.lastSample=frame.handTime;
    if(this.handCalibration&&now-this.handCalibration.start>=2000) {
      let committed=0;
      for(const [side,sample] of this.handCalibration.samples)if(sample.count>=5&&sample.directions.every(v=>v.length()/sample.count>.92)){this.openHandDirections.set(side,sample.directions.map(v=>v.normalize()));committed++;}
      this.handCalibrationMessage=committed?`${committed} mão${committed===1?'':'s'} calibrada${committed===1?'':'s'} com dedos abertos`:'Calibração não aplicada: mantenha palmas e dedos abertos estáveis por 2s';this.handCalibration=undefined;
    }
    for(const [name,j] of this.joints) {
      if(driven.has(name)){this.recentJoints.set(name,{time:now,rotation:j.bone.quaternion.clone()});continue;}
      if(name==='head'||name==='neck'||name.includes('eye'))continue;
      const recent=this.recentJoints.get(name),enabled=name.includes('hand')?hands:body;
      if(frame&&enabled&&recent&&now-recent.time<140){j.bone.quaternion.copy(recent.rotation);continue;}
      const idle=(name==='leftarm'||name==='rightarm')&&body?this.neutralArms.get(name.startsWith('left')?'left':'right'):undefined;
      j.bone.quaternion.slerp(idle??j.rest,1-Math.exp(-clamp(dt,0,.1)/Math.max(.16,smoothing)));
    }
    this.root.updateMatrixWorld(true);
  }
  calibratePosition(){this.hipOrigin=undefined;}
  calibrateHands(now:number){this.handCalibration={start:now,lastSample:-1,samples:new Map()};this.handCalibrationMessage='Calibrando por 2s: palmas visíveis e dedos esticados';}
  resetHands(){this.handCalibration=undefined;this.openHandDirections.clear();this.handHistory.clear();this.handCalibrationMessage='Mãos sem calibração personalizada';}
}
