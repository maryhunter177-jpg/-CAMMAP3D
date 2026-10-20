// Optional browser smoke test using installed Chrome, synthetic camera and CDP.
// Run with the dev server already started: node scripts/smoke.mjs
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
const browser = spawn(process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe',[
  '--headless=new','--remote-debugging-port=9338',`--user-data-dir=${resolve('.browser-test')}`,
  '--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream','--no-first-run','about:blank'
],{windowsHide:true,stdio:'ignore'});
const delay=ms=>new Promise(r=>setTimeout(r,ms));
let ws;const pending=new Map();let id=0;const exceptions=[];
try {
  let pages;
  for(let n=0;n<40;n++){try{pages=await(await fetch('http://127.0.0.1:9338/json')).json();break;}catch{await delay(250);}}
  if(!pages)throw new Error('Chrome CDP indisponível');
  ws=new WebSocket(pages.find(p=>p.type==='page').webSocketDebuggerUrl);
  await new Promise((res,rej)=>{ws.onopen=res;ws.onerror=rej;});
  ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id){pending.get(m.id)?.(m);pending.delete(m.id);}else if(m.method==='Runtime.exceptionThrown')exceptions.push(m.params.exceptionDetails);};
  const send=(method,params={})=>new Promise((res,rej)=>{const n=++id;pending.set(n,m=>m.error?rej(new Error(JSON.stringify(m.error))):res(m.result));ws.send(JSON.stringify({id:n,method,params}));});
  const evaluate=async expression=>{const value=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(value.exceptionDetails)throw new Error(value.exceptionDetails.exception?.description||value.exceptionDetails.text);return value.result.value;};
  await send('Runtime.enable');await send('Page.enable');await send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
  await send('Page.navigate',{url:'http://127.0.0.1:5173/'});
  let loaded=false;
  for(let n=0;n<80;n++){await delay(250);loaded=await evaluate(`document.querySelector('#notice')?.textContent.includes('/52 ARKit')`);if(loaded)break;}
  if(!loaded)throw new Error('Avatar não terminou de carregar');
  await evaluate(`(() => {
    const value=()=>document.querySelector('#zoom-value').textContent;
    document.querySelector('#zoom-in').click();
    if(value()!=='120%')throw new Error('Zoom + falhou');
    document.querySelector('#zoom-out').click();
    if(value()!=='100%')throw new Error('Zoom - falhou');
    document.querySelector('#stage canvas').dispatchEvent(new WheelEvent('wheel',{deltaY:-200,cancelable:true}));
    if(parseInt(value())<=100)throw new Error('Zoom pela roda falhou');
    document.querySelector('#zoom-reset').click();
    if(value()!=='100%')throw new Error('Redefinir zoom falhou');
    if(!document.querySelector('#upload').textContent.includes('Trocar avatar'))throw new Error('Troca de avatar indisponível');
  })()`);
  const captureAvatar=()=>evaluate(`new Promise(resolve=>requestAnimationFrame(()=>resolve(document.querySelector('#stage canvas').toDataURL())))`);
  const beforeDrag=await captureAvatar();
  const dragPoint=await evaluate(`(() => {const r=document.querySelector('#stage canvas').getBoundingClientRect();return {x:r.x+r.width*.65,y:r.y+r.height*.5}})()`);
  await send('Input.dispatchMouseEvent',{type:'mousePressed',...dragPoint,button:'left',clickCount:1});
  await send('Input.dispatchMouseEvent',{type:'mouseMoved',x:dragPoint.x+40,y:dragPoint.y+90,buttons:1});
  await send('Input.dispatchMouseEvent',{type:'mouseReleased',x:dragPoint.x+40,y:dragPoint.y+90,button:'left',clickCount:1});
  await delay(80);
  const afterDrag=await captureAvatar();
  if(afterDrag===beforeDrag)throw new Error('Arrastar não alterou o enquadramento');
  await evaluate(`document.querySelector('#zoom-reset').click()`);await delay(80);
  if(await captureAvatar()===afterDrag)throw new Error('Redefinir não alterou o enquadramento');
  const initial=await evaluate(`({engine:document.querySelector('#engine').textContent,avatar:document.querySelector('#notice').textContent,canvas:!!document.querySelector('#stage canvas')})`);
  const layout=await evaluate(`(() => {const box=id=>{const r=document.querySelector(id).getBoundingClientRect();return {left:r.left,right:r.right,width:r.width}};return {controls:box('#session-panel'),avatar:box('#stage'),camera:box('#camera-panel'),preview:box('#preview')};})()`);
  if(layout.controls.right>layout.avatar.left+1 || layout.avatar.right>layout.camera.left+1 || layout.preview.width<300)throw new Error('Capture layout regressed: '+JSON.stringify(layout));
  const facial=await evaluate(`(async()=>{
    const {Avatar}=await import('/src/avatar.ts');const {ARKIT}=await import('/src/config.ts');
    const avatar=new Avatar(()=>{});await avatar.load('/models/avatar-full.glb');
    const meshes=[];avatar.root.traverse(o=>{if(o.isSkinnedMesh)meshes.push(o)});
    const update=()=>{avatar.root.updateMatrixWorld(true);for(const m of meshes)m.skeleton.update()};
    const sample=()=>meshes.map(m=>Array.from({length:m.geometry.attributes.position.count},(_,i)=>m.getVertexPosition(i,m.position.clone()).applyMatrix4(m.matrixWorld)));
    const input=new Float32Array(58);update();const loaded=sample();avatar.apply(input,true,1/60);update();const neutral=sample();
    let restError=0,minY=Infinity,maxY=-Infinity,maxX=0;
    for(let m=0;m<neutral.length;m++)for(let i=0;i<neutral[m].length;i++){const p=neutral[m][i];restError=Math.max(restError,p.distanceTo(loaded[m][i]));minY=Math.min(minY,p.y);maxY=Math.max(maxY,p.y);maxX=Math.max(maxX,Math.abs(p.x));}
    input[ARKIT.indexOf('jawOpen')]=1;avatar.apply(input,true,1/60);update();const open=sample();let mouthTravel=0;
    for(let m=0;m<open.length;m++)for(let i=0;i<open[m].length;i++)mouthTravel=Math.max(mouthTravel,open[m][i].distanceTo(neutral[m][i]));
    input[ARKIT.indexOf('jawOpen')]=0;input[52]=.15;input[53]=.3;avatar.apply(input,true,1/60);update();const turned=sample();let bodyTravel=0,headTravel=0;
    for(let m=0;m<turned.length;m++)for(let i=0;i<turned[m].length;i++){const d=turned[m][i].distanceTo(neutral[m][i]);if(neutral[m][i].y<-.5)bodyTravel=Math.max(bodyTravel,d);if(neutral[m][i].y>.9)headTravel=Math.max(headTravel,d);}
    input.fill(0);input[ARKIT.indexOf('eyeLookOutLeft')]=1;avatar.apply(input,false,1/60);update();const glance=sample();let gazeTravel=0;
    for(let m=0;m<glance.length;m++)for(let i=0;i<glance[m].length;i++)gazeTravel=Math.max(gazeTravel,glance[m][i].distanceTo(neutral[m][i]));
    input.fill(0);input[ARKIT.indexOf('eyeBlinkLeft')]=1;avatar.apply(input,false,1/60);update();const blink=sample();let blinkTravel=0;
    for(let m=0;m<blink.length;m++)for(let i=0;i<blink[m].length;i++)blinkTravel=Math.max(blinkTravel,blink[m][i].distanceTo(neutral[m][i]));
    const world=Array.from({length:33},()=>({x:0,y:0,z:0,visibility:0}));
    for(const [i,x,y,z] of [[11,.2,-.45,0],[12,-.2,-.45,0],[13,.2,-.85,0],[14,-.2,-.1,0],[15,.2,-1.2,0],[16,-.2,.2,0],[23,.1,0,0],[24,-.1,0,0],[25,.1,.5,0],[26,-.1,.5,0],[27,.1,1,0],[28,-.1,1,0],[31,.1,1,-.12],[32,-.1,1,-.12]])world[i]={x,y,z,visibility:1};
    const image=world.map(p=>({...p,x:.5+p.x*.2,y:.4+p.y*.2}));
    const motion={pose:{landmarks:[image],worldLandmarks:[world]},poseTime:1000,handTime:0};
    for(let i=0;i<80;i++)avatar.applyMotion(motion,1000,1/60,true,true,false,.04);
    avatar.root.updateMatrixWorld(true);let rightArm,leftArm,rightElbow,leftElbow;
    avatar.root.traverse(b=>{const n=b.name.toLowerCase().replace(/[^a-z0-9]/g,'').replace(/^mixamorig/,'');if(n==='rightarm')rightArm=b;if(n==='leftarm')leftArm=b;if(n==='rightforearm')rightElbow=b;if(n==='leftforearm')leftElbow=b;});
    const armY=(a,b)=>{const vector=b.getWorldPosition(b.position.clone()).sub(a.getWorldPosition(a.position.clone())).normalize();return vector.y};
    const mirroredRightArmY=armY(rightArm,rightElbow),mirroredLeftArmY=armY(leftArm,leftElbow);
    avatar['clear']();
    return {meshes:meshes.length,restError,height:maxY-minY,maxX,mouthTravel,bodyTravel,headTravel,gazeTravel,blinkTravel,mirroredRightArmY,mirroredLeftArmY};
  })()`);
  if(facial.restError>1e-4||facial.height<2.5||facial.height>3.1||facial.maxX>1.7||facial.mouthTravel<.02||facial.mouthTravel>.15||facial.bodyTravel>1e-4||facial.headTravel<.01||facial.gazeTravel<.001||facial.blinkTravel<.01||facial.mirroredRightArmY<.9||facial.mirroredLeftArmY>-.9)throw new Error('Facial/body rig regression: '+JSON.stringify(facial));
  // Expose the synthetic camera as the configured Rise Mode webcam; never use
  // a real camera in this test. The original device ID remains unchanged.
  await evaluate(`(() => {
    const media=navigator.mediaDevices, enumerate=media.enumerateDevices.bind(media);
    media.enumerateDevices=async()=> (await enumerate()).map(d=>d.kind==='videoinput'?{kind:d.kind,deviceId:d.deviceId,groupId:d.groupId,label:'Rise Mode sintética'}:d);
    media.dispatchEvent(new Event('devicechange'));
  })()`);
  await evaluate(`document.querySelector('#camera').click()`);
  let capture;
  for(let n=0;n<100;n++){await delay(300);capture=await evaluate(`({status:document.querySelector('#status').textContent,button:document.querySelector('#camera').textContent,disabled:document.querySelector('#camera').disabled})`);if(!capture.disabled)break;}
  let motionModels='';
  for(let n=0;n<100;n++){await delay(300);motionModels=await evaluate(`document.querySelector('#motion-status').textContent`);if(/Corpo: (GPU|CPU)/.test(motionModels)&&/Mãos: (GPU|CPU)/.test(motionModels))break;if(/falhou|erro/.test(motionModels))throw new Error(motionModels);}
  if(!/Corpo: (GPU|CPU)/.test(motionModels)||!/Mãos: (GPU|CPU)/.test(motionModels))throw new Error('Motion models did not initialize: '+motionModels);
  const profiles=await evaluate(`(async()=>{
    const {Tracker}=await import('/src/tracker.ts'),{FilesetResolver}=await import('/node_modules/.vite/deps/@mediapipe_tasks-vision.js'),config=await import('/src/config.ts');
    const tracker=new Tracker();tracker['files']=await FilesetResolver.forVisionTasks(config.VISION_WASM_URL);
    tracker.poseQuality='lite';await tracker.configureMotion(true,false);const first=tracker['pose'];
    if(!first||tracker['loadedPoseQuality']!=='lite')throw new Error('Lite profile failed');
    tracker.poseQuality='full';await tracker.configureMotion(true,false);
    if(!tracker['pose']||tracker['pose']===first||tracker['loadedPoseQuality']!=='full')throw new Error('Live profile switch failed');
    tracker.stop();tracker.video.remove();return ['lite','full'];
  })()`);
  let realHand={skipped:true};
  if(existsSync('artifacts/hand-reference-plain.jpg')) {
    realHand=await evaluate(`(async()=>{
      const {HandLandmarker,FilesetResolver}=await import('/node_modules/.vite/deps/@mediapipe_tasks-vision.js');
      const {HAND_MODEL_URL,VISION_WASM_URL}=await import('/src/config.ts');const {Avatar}=await import('/src/avatar.ts');
      const image=new Image();image.src='/artifacts/hand-reference-plain.jpg';await image.decode();
      const files=await FilesetResolver.forVisionTasks(VISION_WASM_URL);
      const task=await HandLandmarker.createFromOptions(files,{baseOptions:{modelAssetPath:HAND_MODEL_URL,delegate:'GPU'},runningMode:'IMAGE',numHands:2});
      const result=task.detect(image);task.close();if(!result.landmarks.length)throw new Error('No hand in official test image');
      const avatar=new Avatar(()=>{});await avatar.load('/models/avatar-full.glb');const rest=new Map();
      avatar.root.traverse(b=>{if(b.isBone)rest.set(b,b.quaternion.clone())});
      const frame={poseTime:0,handTime:1000,hands:result};
      for(let n=0;n<100;n++)avatar.applyMotion(frame,1000,1/60,false,false,true,.05);
      let fingersMoved=0;avatar.root.traverse(b=>{if(b.isBone&&/hand(index|middle|ring|pinky|thumb)[123]$/i.test(b.name.replace(/[^a-z0-9]/gi,''))&&b.quaternion.angleTo(rest.get(b))>.1)fingersMoved++});
      const report={detected:result.landmarks.length,visibility:result.landmarks[0][0].visibility,status:avatar.handStatus,fingersMoved};avatar['clear']();return report;
    })()`);
    if(realHand.fingersMoved<5||!/[12] mãos? aplicadas?/.test(realHand.status))throw new Error('Real hand integration failed: '+JSON.stringify(realHand));
  }
  // Two synthetic devices reproduce devicechange firing while getUserMedia is pending.
  await evaluate(`(() => {
    const media=navigator.mediaDevices, original=media.getUserMedia.bind(media);
    window.__cameraRequests=[];
    media.enumerateDevices=async()=>['physical','virtual'].map(id=>({kind:'videoinput',deviceId:id,label:id==='physical'?'Webcam física de teste':'OBS Virtual de teste'}));
    media.getUserMedia=async constraints=>{
      const id=constraints.video.deviceId?.exact || 'virtual';window.__cameraRequests.push(id);
      media.dispatchEvent(new Event('devicechange'));
      await new Promise(r=>setTimeout(r,100));
      if(window.__failCamera)throw new DOMException('Dispositivo ocupado','NotReadableError');
      const stream=await original({video:true,audio:false}),track=stream.getVideoTracks()[0],settings=track.getSettings.bind(track);
      track.getSettings=()=>({...settings(),deviceId:id});
      Object.defineProperty(track,'label',{get:()=>id==='physical'?'Webcam física de teste':'OBS Virtual de teste'});
      return stream;
    };
    media.dispatchEvent(new Event('devicechange'));
  })()`);
  await delay(200);
  await evaluate(`document.querySelector('#camera-device').value='physical';document.querySelector('#camera-device').dispatchEvent(new Event('change'))`);
  for(let n=0;n<40;n++){await delay(100);if(!await evaluate(`document.querySelector('#camera-device').disabled`))break;}
  const switched=await evaluate(`({selected:document.querySelector('#camera-device').value,active:document.querySelector('.camera-info').textContent,requests:[...window.__cameraRequests]})`);
  if(switched.selected!=='physical'||!switched.active.includes('Webcam física'))throw new Error('Camera selection regressed: '+JSON.stringify(switched));
  await evaluate(`window.__failCamera=true;document.querySelector('#camera-device').value='virtual';document.querySelector('#camera-device').dispatchEvent(new Event('change'))`);
  for(let n=0;n<40;n++){await delay(100);if(!await evaluate(`document.querySelector('#camera-device').disabled`))break;}
  const failedSwitch=await evaluate(`({selected:document.querySelector('#camera-device').value,info:document.querySelector('.camera-info').textContent,requests:window.__cameraRequests})`);
  if(failedSwitch.selected!=='virtual'||failedSwitch.requests.join(',')!=='physical,virtual'||!failedSwitch.info.includes('Nenhum outro dispositivo'))throw new Error('Camera fallback regressed: '+JSON.stringify(failedSwitch));
  await evaluate(`window.__failCamera=false;localStorage.removeItem('cammap.camera')`);
  await mkdir('artifacts',{recursive:true});
  const shot=await send('Page.captureScreenshot',{format:'png'});await writeFile('artifacts/studio.png',Buffer.from(shot.data,'base64'));
  await send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});await delay(150);
  const mobile=await evaluate(`({width:innerWidth,documentWidth:document.documentElement.scrollWidth})`);
  if(mobile.documentWidth>mobile.width+1)throw new Error('Mobile horizontal overflow: '+JSON.stringify(mobile));
  const mobileShot=await send('Page.captureScreenshot',{format:'png'});await writeFile('artifacts/studio-mobile.png',Buffer.from(mobileShot.data,'base64'));
  console.log(JSON.stringify({initial,facial,motionModels,profiles,realHand,layout,mobile,capture,switched,failedSwitch,exceptions},null,2));
  if(!initial.canvas||!initial.engine.includes('WASM')||!capture.button.includes('Parar')||exceptions.length)process.exitCode=1;
  // Chrome can close its socket before acknowledging Browser.close.
  ws.send(JSON.stringify({id:++id,method:'Browser.close'}));
} catch(error){console.error(error);process.exitCode=1;}finally{ws?.close();browser.kill();}
