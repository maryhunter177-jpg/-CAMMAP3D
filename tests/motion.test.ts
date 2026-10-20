import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as T from 'three';
import { BodyRetargeter, motionPoint, visible, handPointVisible, frameRotation, armDirection, type Point3, type MotionFrame } from '../src/motion.ts';
import {assignHands,solveArm} from '../src/motion-quality.ts';

test('global hand assignment follows body anchors despite swapped labels and detection order',()=>{
  const wrists={left:{x:.3,y:.4},right:{x:.7,y:.4}},history=new Map();
  const a={point:{x:.31,y:.4},side:'right' as const,score:.99},b={point:{x:.69,y:.4},side:'left' as const,score:.99};
  assert.deepEqual(assignHands([a,b],wrists,history,1000),['left','right']);
  assert.deepEqual(assignHands([b,a],wrists,history,1000),['right','left']);
  history.set('left',{point:{x:.31,y:.4},time:1000});history.set('right',{point:{x:.69,y:.4},time:1000});
  assert.deepEqual(assignHands([a,b],{},history,1050),['left','right']);
});

test('duplicate same-side detections do not create a second hand from a single history anchor',()=>{
  const observations=[{point:{x:.2,y:.5},side:'right' as const,score:1},{point:{x:.7,y:.5},side:'right' as const,score:1}];
  assert.deepEqual(assignHands(observations,{},new Map([['right',{point:{x:.2,y:.5},time:1000}]]),1100),['right','right']);
});

test('two-bone solver preserves lengths at extreme targets and degenerate bend poles',()=>{
  for(const reach of [new T.Vector3(0,0,10),new T.Vector3(0,-.1,0),new T.Vector3(.3,.2,.4)]){
    const result=solveArm(reach,.3,.25,reach)!;assert.ok(result);
    assert.ok(Math.abs(result.upper.length()-.3)<1e-6);assert.ok(Math.abs(result.lower.length()-.25)<1e-6);
    assert.ok(result.upper.clone().add(result.lower).length()<=.55);
    assert.ok(result.bend.toArray().every(Number.isFinite));
  }
  assert.equal(solveArm(new T.Vector3(NaN,0,0),.3,.25,new T.Vector3(0,-1,0)),undefined);
});
test('screen correction preserves a raised arm despite reversed world elevation',()=>{
  const a={x:.4,y:.7,z:0},b={x:.6,y:.3,z:0};
  const world=new T.Vector3(.2,-.8,.3);
  const corrected=armDirection(a,b,world,false,.8,4/3);
  assert.ok(corrected.y>.6);assert.ok(corrected.x>0);assert.ok(Number.isFinite(corrected.z));
  const mirrored=armDirection(a,b,new T.Vector3(-.2,-.8,.3),true,.8,4/3);
  assert.ok(mirrored.x<0);assert.ok(mirrored.y>.6);
  assert.ok(armDirection(a,b,world,false,0,4/3).distanceTo(world.clone().normalize())<1e-6);
});
function rig() {
  const root=new T.Group(),bones=new Map<string,T.Bone>();
  const add=(name:string,parent:T.Object3D,x:number,y:number,z=0)=>{const bone=new T.Bone();bone.name='mixamorig:'+name;bone.position.set(x,y,z);parent.add(bone);bones.set(name,bone);return bone;};
  const hips=add('Hips',root,0,1),chest=add('Spine2',hips,0,.45);
  for(const [side,sign] of [['Left',1],['Right',-1]] as const) {
    const arm=add(side+'Arm',chest,sign*.2,0),forearm=add(side+'ForeArm',arm,sign*.3,0),hand=add(side+'Hand',forearm,sign*.25,0);
    for(const [finger,z] of [['Thumb',.08],['Index',.04],['Middle',0],['Ring',-.02],['Pinky',-.04]] as const){let parent:T.Object3D=hand;for(let i=1;i<=4;i++)parent=add(side+'Hand'+finger+i,parent,sign*(i===1?.05:.025),0,i===1?z:0);}
    const leg=add(side+'UpLeg',hips,sign*.1,0),knee=add(side+'Leg',leg,0,-.5),foot=add(side+'Foot',knee,0,-.5);add(side+'ToeBase',foot,0,0,.12);
  }
  root.updateMatrixWorld(true);return {root,bones,retarget:new BodyRetargeter(root)};
}
function pose():MotionFrame {
  const world=Array.from({length:33},()=>({x:0,y:0,z:0,visibility:0}));
  for(const [i,x,y,z] of [[11,.2,-.45,0],[12,-.2,-.45,0],[13,.5,-.45,0],[14,-.5,-.45,0],[15,.75,-.45,0],[16,-.75,-.45,0],[23,.1,0,0],[24,-.1,0,0],[25,.1,.5,0],[26,-.1,.5,0],[27,.1,1,0],[28,-.1,1,0],[31,.1,1,-.12],[32,-.1,1,-.12]])world[i]={x,y,z,visibility:1};
  const image=world.map(p=>({...p,x:.5+p.x*.2,y:.3+p.y*.3}));
  return {pose:{landmarks:[image],worldLandmarks:[world]},poseTime:1000,handTime:0};
}
const direction=(bones:Map<string,T.Bone>,name:string,child:string)=>bones.get(child)!.getWorldPosition(new T.Vector3()).sub(bones.get(name)!.getWorldPosition(new T.Vector3())).normalize();
test('camera coordinates, visibility and degenerate frames are handled',()=>{
  assert.deepEqual(motionPoint({x:1,y:2,z:3},false).toArray(),[1,-2,-3]);assert.deepEqual(motionPoint({x:1,y:2,z:3},true).toArray(),[-1,-2,-3]);
  assert.equal(visible({x:.5,y:.5,z:0,visibility:.2}),false);assert.equal(visible({x:1.2,y:.5,z:0}),false);assert.equal(visible({x:.5,y:.5,z:NaN}),false);
  assert.equal(frameRotation(new T.Vector3(),new T.Vector3(0,1,0)),undefined);
});
test('an asymmetric tracked arm moves its mirrored counterpart and preserves lengths',()=>{
  const {root,bones,retarget}=rig(),frame=pose();frame.pose!.worldLandmarks[0][13]={x:.2,y:-.85,z:0,visibility:1};frame.pose!.worldLandmarks[0][15]={x:.2,y:-1.2,z:0,visibility:1};
  for(let i=0;i<40;i++)retarget.apply(frame,1000,.016,true,true,false,.04);
  root.updateMatrixWorld(true);
  assert.ok(direction(bones,'RightArm','RightForeArm').y>.97);
  assert.ok(direction(bones,'LeftArm','LeftForeArm').x>.97);
  assert.ok(Math.abs(bones.get('RightForeArm')!.getWorldPosition(new T.Vector3()).distanceTo(bones.get('RightArm')!.getWorldPosition(new T.Vector3()))-.3)<1e-6);
  for(const bone of bones.values())assert.deepEqual(bone.scale.toArray(),[1,1,1]);
});
test('occluded arm is not driven by inferred points and tracking loss relaxes smoothly',()=>{
  const {bones,retarget}=rig(),frame=pose();
  for(let i=0;i<40;i++)retarget.apply(frame,1000,.016,false,true,false,.04);
  frame.pose!.landmarks[0][13].visibility=.1;frame.pose!.worldLandmarks[0][13].y=-1;
  const before=bones.get('LeftArm')!.quaternion.clone();retarget.apply(frame,1000,.016,false,true,false,.1);
  assert.ok(before.angleTo(bones.get('LeftArm')!.quaternion)<.5);
  for(let i=0;i<100;i++)retarget.apply(undefined,3000,.016,false,true,false,.06);
  assert.ok(direction(bones,'LeftArm','LeftForeArm').y<-.97);
  for(let i=0;i<100;i++)retarget.apply(undefined,3000,.016,false,false,false,.04);
  assert.ok(direction(bones,'LeftArm','LeftForeArm').x>.99);
});

test('a brief detection dropout holds the arm before a gradual return',()=>{
  const {bones,retarget}=rig(),frame=pose();
  for(let i=0;i<50;i++)retarget.apply(frame,1000,.016,false,true,false,.04);
  const before=bones.get('LeftArm')!.quaternion.clone();
  const empty:MotionFrame={poseTime:1050,handTime:1050,pose:{landmarks:[],worldLandmarks:[]}};
  retarget.apply(empty,1050,.016,false,true,false,.04);
  assert.ok(before.angleTo(bones.get('LeftArm')!.quaternion)<1e-5);
  retarget.apply(empty,1250,.016,false,true,false,.04);
  const turn=before.angleTo(bones.get('LeftArm')!.quaternion);assert.ok(turn>0&&turn<.3);
});

test('Pose wrist recovers the arm when the palm and elbow are not detected',()=>{
  const {root,bones,retarget}=rig(),frame=pose();const image=frame.pose!.landmarks[0];
  image[13].visibility=0;image[15]={x:image[11].x,y:image[11].y-.12,z:0,visibility:1};
  frame.pose!.worldLandmarks[0][15]={x:.2,y:-.8,z:-.1,visibility:1};
  for(let i=0;i<100;i++)retarget.apply(frame,1000,.016,false,true,true,.04);
  root.updateMatrixWorld(true);assert.equal(retarget.activeHands,0);
  assert.ok(bones.get('LeftHand')!.getWorldPosition(new T.Vector3()).y>bones.get('LeftArm')!.getWorldPosition(new T.Vector3()).y+.1);
  assert.match(retarget.handStatus,/cotovelo estimado/);
});
test('hand landmarks articulate fingers and stale hand data returns to neutral',()=>{
  const {bones,retarget}=rig();const points:Point3[]=Array.from({length:21},()=>({x:0,y:0,z:0}));
  for(const [base,z] of [[1,.08],[5,.04],[9,0],[13,-.02],[17,-.04]])for(let i=0;i<4;i++)points[base+i]={x:.05+i*.025,y:i===0?0:i*.025,z:-z};
  const image=points.map(p=>({x:.5+p.x,y:.5+p.y,z:p.z}));
  const frame:MotionFrame={poseTime:0,handTime:1000,hands:{landmarks:[image],worldLandmarks:[points],handedness:[[{categoryName:'Left',score:1}]]}};
  for(let i=0;i<40;i++)retarget.apply(frame,1000,.016,false,false,true,.04);
  assert.ok(bones.get('LeftHandIndex1')!.quaternion.angleTo(new T.Quaternion())>.1);
  assert.ok(bones.get('RightHandIndex1')!.quaternion.angleTo(new T.Quaternion())<1e-5);
  for(let i=0;i<100;i++)retarget.apply(frame,2000,.016,false,false,true,.04);
  assert.ok(bones.get('LeftHandIndex1')!.quaternion.angleTo(new T.Quaternion())<.001);
});
test('relative screen displacement is mirrored, bounded and recalibratable',()=>{
  const {retarget}=rig(),frame=pose();
  retarget.apply(frame,1000,.016,true,true,false,.04,true);
  for(const point of frame.pose!.landmarks[0])point.x+=.15;
  for(let i=0;i<50;i++)retarget.apply(frame,1000,.016,true,true,false,.04,true);
  assert.ok(retarget.offset.x<-.35 && retarget.offset.x>=-.6);
  retarget.calibratePosition();
  for(let i=0;i<80;i++)retarget.apply(frame,1000,.016,true,true,false,.04,true);
  assert.ok(retarget.offset.length()<1e-5);
});
function handFrame(bones:Map<string,T.Bone>,roll=0,side='Left'):MotionFrame {
  const wrist=bones.get(side+'Hand')!.getWorldPosition(new T.Vector3());
  const points:Point3[]=[{x:0,y:0,z:0,visibility:0}];
  const rotation=new T.Quaternion().setFromAxisAngle(new T.Vector3(1,0,0),roll);
  for(const finger of ['Thumb','Index','Middle','Ring','Pinky'])for(let segment=1;segment<=4;segment++) {
    const p=bones.get(side+'Hand'+finger+segment)!.getWorldPosition(new T.Vector3()).sub(wrist).applyQuaternion(rotation);
    points.push({x:p.x,y:-p.y,z:-p.z,visibility:0});
  }
  return {poseTime:0,handTime:1000,hands:{worldLandmarks:[points],landmarks:[points.map(p=>({...p,x:.5+p.x,y:.5+p.y}))],handedness:[[{categoryName:side,score:1}]]}};
}

test('visible hand raises a cropped arm with fixed bone lengths in both mirror modes',()=>{
  for(const mirror of [false,true]) {
    const {bones,root,retarget}=rig(),frame=pose(),hand=handFrame(bones);
    frame.hands=hand.hands;frame.handTime=1000;
    frame.pose!.landmarks[0][13].visibility=0;frame.pose!.landmarks[0][15].visibility=0;
    const shoulder=frame.pose!.landmarks[0][11];
    const wrist=frame.hands!.landmarks[0][0];wrist.x=shoulder.x;wrist.y=shoulder.y-.12;
    const side=mirror?'Right':'Left';
    for(let i=0;i<100;i++)retarget.apply(frame,1000,.016,mirror,true,true,.04);
    root.updateMatrixWorld(true);
    const a=bones.get(side+'Arm')!.getWorldPosition(new T.Vector3()),b=bones.get(side+'ForeArm')!.getWorldPosition(new T.Vector3()),c=bones.get(side+'Hand')!.getWorldPosition(new T.Vector3());
    assert.ok(c.y>a.y+.15,'visible wrist should rise above shoulder');
    assert.ok(Math.abs(a.distanceTo(b)-.3)<1e-6);assert.ok(Math.abs(b.distanceTo(c)-.25)<1e-6);
    assert.match(retarget.handStatus,/cotovelo estimado: 1/);
    for(let i=0;i<100;i++)retarget.apply(frame,2000,.016,mirror,true,true,.04);
    assert.doesNotMatch(retarget.handStatus,/cotovelo estimado/);
    assert.ok(direction(bones,side+'Arm',side+'ForeArm').y<-.97);
  }
});

test('a close palm reaches toward the camera instead of sideways in both mirror modes',()=>{
  for(const mirror of [false,true]) {
    const {root,bones,retarget}=rig(),frame=pose(),hand=handFrame(bones,Math.PI/2);
    frame.hands=hand.hands;frame.handTime=1000;
    const shoulder=frame.pose!.landmarks[0][11],wrist={x:shoulder.x+.025,y:shoulder.y+.02};
    const world=frame.hands!.worldLandmarks[0];
    frame.hands!.landmarks[0]=world.map(p=>({x:wrist.x+p.x*.6,y:wrist.y+p.y*.8,z:0}));
    for(let i=0;i<120;i++)retarget.apply(frame,1000,.016,mirror,true,true,.04,false,{armScreenWeight:.8});
    root.updateMatrixWorld(true);const side=mirror?'Right':'Left';
    const a=bones.get(side+'Arm')!.getWorldPosition(new T.Vector3()),c=bones.get(side+'Hand')!.getWorldPosition(new T.Vector3());
    assert.ok(c.z-a.z>.3,'close palm should extend toward the camera');
    assert.ok(Math.abs(c.x-a.x)<.2,'perspective displacement should not become a lateral reach');
  }
  const direction=armDirection({x:.4,y:.5,z:0},{x:.6,y:.5,z:0},new T.Vector3(.1,.05,.9),false,1,4/3);
  assert.ok(direction.z>.98,'screen correction must retain forward depth');
});
test('MediaPipe hand visibility zero is accepted while pose zero is rejected',()=>{
  const point={x:.5,y:.5,z:0,visibility:0};assert.equal(visible(point),false);assert.equal(handPointVisible(point),true);
  const {bones,retarget}=rig(),frame=handFrame(bones,Math.PI/2);
  for(let i=0;i<80;i++)retarget.apply(frame,1000,.016,false,false,true,.04,false,{forearmTwist:0});
  assert.equal(retarget.activeHands,1);assert.equal(retarget.activeFingerJoints,15);
  assert.ok(bones.get('LeftHand')!.quaternion.angleTo(new T.Quaternion())>1);
});
test('finger roll follows palm roll and forearm twist is shared without accumulating',()=>{
  const {bones,retarget}=rig(),neutral=handFrame(bones),rolled=handFrame(bones,Math.PI/2);
  for(let i=0;i<100;i++)retarget.apply(neutral,1000,.016,false,false,true,.04,false,{forearmTwist:.3});
  const handBefore=bones.get('LeftHand')!.getWorldQuaternion(new T.Quaternion()),fingerBefore=bones.get('LeftHandIndex1')!.getWorldQuaternion(new T.Quaternion());
  for(let i=0;i<150;i++)retarget.apply(rolled,1000,.016,false,false,true,.04,false,{forearmTwist:.3});
  const handDelta=bones.get('LeftHand')!.getWorldQuaternion(new T.Quaternion()).multiply(handBefore.invert());
  const fingerDelta=bones.get('LeftHandIndex1')!.getWorldQuaternion(new T.Quaternion()).multiply(fingerBefore.invert());
  assert.ok(handDelta.angleTo(fingerDelta)<.01);
  const forearm=bones.get('LeftForeArm')!.quaternion.angleTo(new T.Quaternion());assert.ok(forearm>.2&&forearm<.7);
  const steady=bones.get('LeftForeArm')!.quaternion.clone();
  for(let i=0;i<150;i++)retarget.apply(rolled,1000,.016,false,false,true,.04,false,{forearmTwist:.3});
  assert.ok(steady.angleTo(bones.get('LeftForeArm')!.quaternion)<.001);
});
test('individual finger joints bend independently instead of a single fist value',()=>{
  const {bones,retarget}=rig(),frame=handFrame(bones);const p=frame.hands!.worldLandmarks[0];
  p[7]={...p[7],x:p[6].x+.005,y:p[6].y+.025};p[8]={...p[8],x:p[7].x-.02,y:p[7].y+.01};
  for(let i=0;i<100;i++)retarget.apply(frame,1000,.016,false,false,true,.04,false,{forearmTwist:0});
  assert.ok(bones.get('LeftHandIndex1')!.quaternion.angleTo(new T.Quaternion())<.02);
  assert.ok(bones.get('LeftHandIndex2')!.quaternion.angleTo(new T.Quaternion())>.5);
  assert.ok(bones.get('LeftHandIndex3')!.quaternion.angleTo(new T.Quaternion())>.5);
  assert.ok(bones.get('LeftHandMiddle2')!.quaternion.angleTo(new T.Quaternion())<.02);
});
test('open-hand calibration collects distinct frames and preserves previous data on failure',()=>{
  const {bones,retarget}=rig(),frame=handFrame(bones);const p=frame.hands!.worldLandmarks[0];
  for(let i=1;i<4;i++)p[5+i]={...p[5+i],y:p[5+i].y+i*.012};
  retarget.calibrateHands(1000);
  for(let i=0;i<=25;i++){frame.handTime=1000+i*80;retarget.apply(frame,frame.handTime,.016,false,false,true,.04,false,{forearmTwist:0});}
  for(let i=0;i<100;i++)retarget.apply(frame,3100,.016,false,false,true,.04,false,{forearmTwist:0});
  assert.match(retarget.handStatus,/1 mão calibrada/);
  assert.ok(bones.get('LeftHandIndex1')!.quaternion.angleTo(new T.Quaternion())<.02);
  retarget.calibrateHands(4000);retarget.apply(undefined,6100,.016,false,false,true,.04);
  assert.match(retarget.handStatus,/não aplicada/);
  frame.handTime=6200;for(let i=0;i<100;i++)retarget.apply(frame,6200,.016,false,false,true,.04,false,{forearmTwist:0});
  assert.ok(bones.get('LeftHandIndex1')!.quaternion.angleTo(new T.Quaternion())<.02);
});
test('two anatomical hands drive thirty joints in mirrored mode',()=>{
  const {bones,retarget}=rig(),left=handFrame(bones,.7,'Left'),right=handFrame(bones,-.4,'Right');
  const frame:MotionFrame={poseTime:0,handTime:1000,hands:{landmarks:[...left.hands!.landmarks,...right.hands!.landmarks],worldLandmarks:[...left.hands!.worldLandmarks,...right.hands!.worldLandmarks],handedness:[...left.hands!.handedness,...right.hands!.handedness]}};
  for(let n=0;n<100;n++)retarget.apply(frame,1000,.016,true,false,true,.04,false,{forearmTwist:0});
  assert.equal(retarget.activeHands,2);assert.equal(retarget.activeFingerJoints,30);
  for(const bone of bones.values())assert.ok(bone.quaternion.toArray().every(Number.isFinite));
  // Left input controls the right displayed wrist in mirror mode.
  assert.ok(bones.get('RightHand')!.quaternion.angleTo(new T.Quaternion())>.4);
});
