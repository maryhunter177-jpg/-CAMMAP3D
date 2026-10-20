import * as T from 'three';
import {clamp} from './filters.ts';
type Point={x:number;y:number};
export type Side='left'|'right';
type Observation={point:Point;side:Side;score:number};
type Anchor={point:Point;time:number};
/** Joint assignment prevents detection order from swapping crossed hands. */
export function assignHands(observations:Observation[],wrists:Partial<Record<Side,Point>>,history:Map<string,Anchor>,now:number):Side[]{
  const cost=(o:Observation,side:Side)=>{
    let value=o.side===side?0:.12*clamp(o.score);
    const wrist=wrists[side];if(wrist)value+=Math.hypot(wrist.x-o.point.x,wrist.y-o.point.y)*2.5;
    const previous=history.get(side);if(previous&&now-previous.time<450)value+=Math.min(.5,Math.hypot(previous.point.x-o.point.x,previous.point.y-o.point.y))*.9;
    return value;
  };
  if(observations.length!==2)return observations.map(o=>cost(o,'left')<cost(o,'right')?'left':'right');
  // Duplicate same-side detections without body/history evidence are not
  // proof of two anatomical hands (e.g. a photograph containing two rights).
  const bothAnchored=!!(wrists.left&&wrists.right)||(now-(history.get('left')?.time??-Infinity)<450&&now-(history.get('right')?.time??-Infinity)<450);
  if(observations[0].side===observations[1].side&&!bothAnchored)return observations.map(o=>o.side);
  return cost(observations[0],'left')+cost(observations[1],'right')<=cost(observations[0],'right')+cost(observations[1],'left')?['left','right']:['right','left'];
}
/** Reachable, fixed-length arm; bend hint is projected onto its pole plane. */
export function solveArm(reach:T.Vector3,a:number,b:number,hint:T.Vector3){
  if(!reach.toArray().every(Number.isFinite)||!Number.isFinite(a)||!Number.isFinite(b)||a<=1e-5||b<=1e-5||reach.lengthSq()<1e-10)return;
  const margin=Math.min(a,b)*.01;
  const distance=clamp(reach.length(),Math.abs(a-b)+margin,a+b-margin),axis=reach.clone().normalize();
  const along=clamp((a*a-b*b+distance*distance)/(2*distance),-a,a);
  const bend=hint.clone().addScaledVector(axis,-hint.dot(axis));
  if(bend.lengthSq()<1e-7){bend.set(0,0,1).addScaledVector(axis,-axis.z);if(bend.lengthSq()<1e-7)bend.set(0,-1,0).addScaledVector(axis,axis.y);}
  bend.normalize();const elbow=axis.clone().multiplyScalar(along).addScaledVector(bend,Math.sqrt(Math.max(0,a*a-along*along)));
  return {upper:elbow,lower:axis.multiplyScalar(distance).sub(elbow),bend};
}
