// Local-only inspection of a user-selected recording. Never uploads the file.
import {spawn} from 'node:child_process';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
const path=process.argv[2];if(!path)throw new Error('Pass the recording path');
const browser=spawn('C:/Program Files/Google/Chrome/Application/chrome.exe',['--headless=new','--remote-debugging-port=9339',`--user-data-dir=${resolve('.browser-review')}`,'--no-first-run','about:blank'],{windowsHide:true,stdio:'ignore'});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));let ws;let id=0;const pending=new Map();
try{
 let pages;for(let i=0;i<40;i++){try{pages=await(await fetch('http://127.0.0.1:9339/json')).json();break;}catch{await sleep(250);}}
 ws=new WebSocket(pages.find(p=>p.type==='page').webSocketDebuggerUrl);await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j;});
 ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id){pending.get(m.id)?.(m);pending.delete(m.id);}};
 const send=(method,params={})=>new Promise((r,j)=>{const n=++id;pending.set(n,m=>m.error?j(new Error(JSON.stringify(m.error))):r(m.result));ws.send(JSON.stringify({id:n,method,params}));});
 const evaluate=async expression=>{const r=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw new Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value;};
 await send('Page.enable');await send('Page.navigate',{url:'http://127.0.0.1:5173/'});await sleep(1200);
 await evaluate(`(()=>{const input=document.createElement('input');input.type='file';input.id='review-video';document.body.append(input);})()`);
 const {root}=await send('DOM.getDocument');const {nodeId}=await send('DOM.querySelector',{nodeId:root.nodeId,selector:'#review-video'});
 await send('DOM.setFileInputFiles',{nodeId,files:[path]});
 const result=await evaluate(`(async()=>{
  const video=document.createElement('video');video.muted=true;video.src=URL.createObjectURL(document.querySelector('#review-video').files[0]);window.__reviewVideo=video;
  await new Promise((r,j)=>{video.onloadedmetadata=r;video.onerror=j;});
  const canvas=document.createElement('canvas');canvas.width=960;canvas.height=3*290;const c=canvas.getContext('2d');c.fillStyle='#111';c.fillRect(0,0,960,870);
  const times=Array.from({length:6},(_,i)=>Math.max(.05,video.duration*(i+.3)/6));
  for(let i=0;i<times.length;i++){video.currentTime=times[i];await new Promise(r=>video.onseeked=r);const x=i%2*480,y=Math.floor(i/2)*290;c.drawImage(video,x,y,480,270);c.fillStyle='white';c.font='14px sans-serif';c.fillText(times[i].toFixed(2)+'s',x+8,y+285);}
  const full=document.createElement('canvas');full.width=video.videoWidth;full.height=video.videoHeight;full.getContext('2d').drawImage(video,0,0);
  return {duration:video.duration,width:video.videoWidth,height:video.videoHeight,sheet:canvas.toDataURL('image/jpeg',.9),full:full.toDataURL('image/jpeg',.9)};
 })()`);
 await mkdir('artifacts',{recursive:true});await writeFile('artifacts/recording-review.jpg',Buffer.from(result.sheet.split(',')[1],'base64'));
 await writeFile('artifacts/recording-frame.jpg',Buffer.from(result.full.split(',')[1],'base64'));
 console.log(JSON.stringify({...result,sheet:'artifacts/recording-review.jpg',full:'artifacts/recording-frame.jpg'}));
 if(process.argv.includes('--publish-shots')){
  const shots=await evaluate(`(async()=>{
   const video=window.__reviewVideo,shots=[];
   for(const [name,time] of [['estudio',15.75],['rastreio-corpo',39.75],['maos-dedos',63.75]]){
    video.currentTime=time;await new Promise(r=>video.onseeked=r);
    const canvas=document.createElement('canvas');canvas.width=1440;canvas.height=710;
    canvas.getContext('2d').drawImage(video,45,108,1875,924,0,0,1440,710);
    shots.push({name,data:canvas.toDataURL('image/jpeg',.9)});
   }return shots;
  })()`);
  await mkdir('docs/images',{recursive:true});for(const shot of shots)await writeFile('docs/images/'+shot.name+'.jpg',Buffer.from(shot.data.split(',')[1],'base64'));
  console.log('README screenshots saved in docs/images');
 }
 if(process.argv.includes('--analyze')){
  const replay=await evaluate(`(async()=>{
   const {FilesetResolver,PoseLandmarker,HandLandmarker}=await import('/node_modules/.vite/deps/@mediapipe_tasks-vision.js');
   const config=await import('/src/config.ts');const files=await FilesetResolver.forVisionTasks(config.VISION_WASM_URL);
   const pose=await PoseLandmarker.createFromOptions(files,{baseOptions:{modelAssetPath:config.POSE_MODEL_URL,delegate:'GPU'},runningMode:'VIDEO',numPoses:1});
   const hand=await HandLandmarker.createFromOptions(files,{baseOptions:{modelAssetPath:config.HAND_MODEL_URL,delegate:'GPU'},runningMode:'VIDEO',numHands:2});
   const video=window.__reviewVideo,canvas=document.createElement('canvas');canvas.width=640;canvas.height=480;const c=canvas.getContext('2d');const frames=[];
   for(let t=.25;t<video.duration;t+=.25){video.currentTime=t;await new Promise(r=>video.onseeked=r);c.save();c.translate(640,0);c.scale(-1,1);c.drawImage(video,1282,338,592,444,0,0,640,480);c.restore();const now=1000+t*1000;const a=performance.now(),p=pose.detectForVideo(canvas,now),h=hand.detectForVideo(canvas,now);frames.push({time:now,pose:{landmarks:p.landmarks,worldLandmarks:p.worldLandmarks},hands:{landmarks:h.landmarks,worldLandmarks:h.worldLandmarks,handedness:h.handedness},ms:performance.now()-a});}
   pose.close();hand.close();return {note:'Derived from an already annotated screen recording; not independent ground truth.',frames};
  })()`);
  await writeFile('artifacts/recording-landmarks.json',JSON.stringify(replay));console.log(JSON.stringify({frames:replay.frames.length,landmarks:'artifacts/recording-landmarks.json'}));
 }
 if(process.argv.includes('--retarget')){
  const replay=JSON.parse(await readFile('artifacts/recording-landmarks.json','utf8'));
  await evaluate(`window.__replay=${JSON.stringify(replay.frames)}`);
  const preview=await evaluate(`(async()=>{
   const T=await import('/node_modules/.vite/deps/three.js'),{Avatar}=await import('/src/avatar.ts'),{AVATAR_URL}=await import('/src/config.ts');
   const avatar=new Avatar(()=>{});await avatar.load(AVATAR_URL);const scene=new T.Scene();scene.add(avatar.root);scene.add(new T.HemisphereLight(0xe4fff6,0x304352,2.4));const light=new T.DirectionalLight(0xffe7d0,3);light.position.set(2,3,4);scene.add(light);
   const render=new T.WebGLRenderer({antialias:true});render.setSize(180,270);render.setClearColor('#101f29');const camera=new T.PerspectiveCamera(35,180/270,.01,100);camera.position.set(0,.25,6.5);camera.lookAt(0,0,0);
   const sheet=document.createElement('canvas');sheet.width=960;sheet.height=900;const c=sheet.getContext('2d');c.fillStyle='#101f29';c.fillRect(0,0,960,900);
   let selected=0;const times=[3.6,15.6,27.6,39.7,51.7,63.7],video=window.__reviewVideo;let finite=true;
   for(const f of window.__replay){const frame={pose:f.pose,hands:f.hands,poseTime:f.time,handTime:f.time};for(let i=0;i<15;i++){avatar.applyMotion(frame,f.time+i*1000/60,1/60,true,true,true,.065,false,{armScreenWeight:.8,depthGain:1,videoAspect:4/3});avatar.apply(new Float32Array(58),true,1/60,false,false);}avatar.root.traverse(b=>{if(!b.position.toArray().every(Number.isFinite)||!b.quaternion.toArray().every(Number.isFinite))finite=false;});
    if(selected<times.length&&f.time>=1000+times[selected]*1000){const x=selected%2*480,y=Math.floor(selected/2)*300;video.currentTime=(f.time-1000)/1000;await new Promise(r=>video.onseeked=r);c.drawImage(video,1282,338,592,444,x,y+25,300,225);render.render(scene,camera);c.drawImage(render.domElement,x+300,y+20);c.fillStyle='white';c.font='13px sans-serif';c.fillText(((f.time-1000)/1000).toFixed(2)+'s · webcam gravada / rig atual',x+6,y+17);selected++;}
   }render.dispose();return {finite,frames:window.__replay.length,sheet:sheet.toDataURL('image/jpeg',.92)};
  })()`);
  await writeFile('artifacts/retarget-review.jpg',Buffer.from(preview.sheet.split(',')[1],'base64'));console.log(JSON.stringify({...preview,sheet:'artifacts/retarget-review.jpg'}));
 }
 ws.send(JSON.stringify({id:++id,method:'Browser.close'}));
}finally{ws?.close();browser.kill();}
