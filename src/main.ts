import * as T from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { FaceLandmarker, PoseLandmarker, HandLandmarker } from '@mediapipe/tasks-vision';
import { visible, handPointVisible, type Point3 } from './motion';
import { Avatar } from './avatar';
import { Tracker, VoiceInput } from './tracker';
import { Calibration, FilterBank, clamp } from './filters';
import { ARKIT, AVATAR_URL, BLOCKED_CAPTURE_LABEL } from './config';
import { mountUI, createUI, settings } from './ui';
import './style.css';
mountUI();
const element = <E extends HTMLElement>(id:string) => document.getElementById(id) as E;
const notice = (text:string) => { element('notice').textContent=text; };
const status = (text:string) => { element('status').textContent=text; };
const stage = element('stage');
const renderer = new T.WebGLRenderer({alpha:true,antialias:true,powerPreference:'high-performance'});
renderer.setPixelRatio(Math.min(devicePixelRatio,2)); renderer.outputColorSpace=T.SRGBColorSpace; renderer.setClearColor(settings.background,1); stage.prepend(renderer.domElement);
const scene = new T.Scene();
const camera = new T.PerspectiveCamera(35,1,.01,100); camera.position.set(0,.25,5.7);
const orbit = new OrbitControls(camera,renderer.domElement); orbit.target.set(0,0,0); orbit.enabled=false; orbit.update();
orbit.enableZoom=false;
const framing={x:0,y:0};
function updateFraming(){
  const w=stage.clientWidth,h=stage.clientHeight;
  if(w && h)camera.setViewOffset(w,h,-framing.x*w,-framing.y*h,w,h);
}
const canvas=renderer.domElement;
canvas.classList.add('avatar-draggable');
canvas.title='Arraste para posicionar o avatar. Use a roda do mouse para dar zoom.';
let drag:{id:number;x:number;y:number}|undefined;
canvas.addEventListener('pointerdown',event=>{
  if(orbit.enabled || event.button!==0 || drag)return;
  drag={id:event.pointerId,x:event.clientX,y:event.clientY};
  canvas.setPointerCapture(event.pointerId);canvas.classList.add('dragging');event.preventDefault();
});
canvas.addEventListener('pointermove',event=>{
  if(!drag || drag.id!==event.pointerId)return;
  framing.x=T.MathUtils.clamp(framing.x+(event.clientX-drag.x)/Math.max(1,stage.clientWidth),-1,1);
  framing.y=T.MathUtils.clamp(framing.y+(event.clientY-drag.y)/Math.max(1,stage.clientHeight),-1,1);
  drag.x=event.clientX;drag.y=event.clientY;updateFraming();
});
const endDrag=(event:PointerEvent)=>{if(drag?.id!==event.pointerId)return;drag=undefined;canvas.classList.remove('dragging');if(canvas.hasPointerCapture(event.pointerId))canvas.releasePointerCapture(event.pointerId);};
canvas.addEventListener('pointerup',endDrag);canvas.addEventListener('pointercancel',endDrag);canvas.addEventListener('lostpointercapture',endDrag);
const framingHint=document.createElement('span');framingHint.className='framing-hint';framingHint.textContent='Arraste para posicionar · role para zoom';stage.append(framingHint);
const zoomBar=document.createElement('div');zoomBar.className='avatar-zoom';zoomBar.setAttribute('role','group');zoomBar.setAttribute('aria-label','Zoom do avatar');
zoomBar.innerHTML='<button id="zoom-out" aria-label="Diminuir zoom">−</button><output id="zoom-value" aria-label="Zoom atual">100%</output><button id="zoom-in" aria-label="Aumentar zoom">+</button><button id="zoom-reset" aria-label="Redefinir zoom">Redefinir</button>';
stage.append(zoomBar);
function setZoom(value:number){
  camera.zoom=T.MathUtils.clamp(value,.5,3);camera.updateProjectionMatrix();
  element('zoom-value').textContent=`${Math.round(camera.zoom*100)}%`;
  element<HTMLButtonElement>('zoom-out').disabled=camera.zoom<=.5;
  element<HTMLButtonElement>('zoom-in').disabled=camera.zoom>=3;
}
element('zoom-out').onclick=()=>setZoom(camera.zoom/1.2);
element('zoom-in').onclick=()=>setZoom(camera.zoom*1.2);
element('zoom-reset').setAttribute('aria-label','Redefinir zoom e posição');
element('zoom-reset').onclick=()=>{framing.x=0;framing.y=0;updateFraming();setZoom(1);};
renderer.domElement.addEventListener('wheel',event=>{
  event.preventDefault();
  const pixels=event.deltaY*(event.deltaMode===1?16:event.deltaMode===2?stage.clientHeight:1);
  setZoom(camera.zoom*Math.exp(-T.MathUtils.clamp(pixels,-300,300)*.0015));
},{passive:false});
scene.add(new T.HemisphereLight(0xe4fff6,0x304352,2.4));
const light = new T.DirectionalLight(0xffe7d0,3); light.position.set(2,3,4); scene.add(light);
const rim = new T.DirectionalLight(0x77c9ff,2); rim.position.set(-3,1,-2); scene.add(rim);
const avatar = new Avatar(notice); scene.add(avatar.root);
void avatar.load(AVATAR_URL).catch(error=>{console.warn('Modelo padrão indisponível',error); avatar.showDemo();});
const resize = new ResizeObserver(()=>{const w=stage.clientWidth,h=stage.clientHeight; renderer.setSize(w,h);camera.aspect=w/h;if(!orbit.enabled){camera.position.set(0,.25,Math.max(5.7,1.65/(Math.tan(T.MathUtils.degToRad(camera.fov/2))*camera.aspect)));orbit.update();}updateFraming();camera.updateProjectionMatrix();}); resize.observe(stage);
const tracker = new Tracker(), voice = new VoiceInput(), filters = new FilterBank(), calibration = new Calibration();
const cameraButton=element<HTMLButtonElement>('camera');
const cameraPicker=document.createElement('select');cameraPicker.id='camera-device';cameraPicker.setAttribute('aria-label','Escolher webcam');
let selectedCamera='';
try {selectedCamera=localStorage.getItem('cammap.camera')??'';} catch {}
cameraPicker.add(new Option('Rise Mode · automática',''));
const pickerLabel=document.createElement('label');pickerLabel.htmlFor='camera-device';pickerLabel.textContent='Câmera de captura';
const deviceInfo=document.createElement('p');deviceInfo.className='camera-info';deviceInfo.textContent='Inicie a câmera para listar os dispositivos disponíveis.';
cameraButton.before(pickerLabel,cameraPicker,deviceInfo);
async function updateCameras() {
  try {
    const cameras=await tracker.cameras();
    if(cameras.some(d=>d.deviceId===selectedCamera && BLOCKED_CAPTURE_LABEL.test(d.label))) {
      selectedCamera='';
      try{localStorage.removeItem('cammap.camera');}catch{}
    }
    // Device enumeration may finish during a switch. Never replace user intent
    // with settings from the previous stream or an older enumeration request.
    cameraPicker.replaceChildren(new Option('Rise Mode · automática',''));
    for(const [i,device] of cameras.entries())cameraPicker.add(new Option(device.label || `Câmera ${i+1}`,device.deviceId));
    if(selectedCamera && !cameras.some(d=>d.deviceId===selectedCamera))cameraPicker.add(new Option('Câmera escolhida indisponível · selecione outra',selectedCamera));
    cameraPicker.value=selectedCamera;
    if(tracker.cameraLabel)deviceInfo.textContent=`Em uso: ${tracker.cameraLabel}. A seleção manual não será trocada automaticamente.`;
  } catch {deviceInfo.textContent='Autorize o acesso à câmera para listar os dispositivos.';}
}
cameraPicker.onchange=async()=>{
  selectedCamera=cameraPicker.value;
  try{localStorage.setItem('cammap.camera',selectedCamera);}catch{}
  if(!running || busy)return;
  const requestedCamera=selectedCamera;
  busy=true;cameraPicker.disabled=true;cameraButton.disabled=true;running=false;hasFace=false;calibration.cancel();poseOrigin=undefined;raw.fill(0);ctx.clearRect(0,0,640,480);status('Trocando câmera…');
  try{await tracker.openCamera(requestedCamera || undefined);running=true;await updateCameras();status(`Câmera ativa · ${tracker.cameraLabel}`);}
  catch(error){tracker.stop();cameraButton.textContent='Iniciar câmera ↗';deviceInfo.textContent=`A câmera escolhida não abriu. Nenhum outro dispositivo foi ativado. ${String(error)}. Se estiver ocupada, libere-a no OBS ou em outro aplicativo.`;status('Falha ao trocar câmera · escolha preservada');}
  finally{busy=false;cameraPicker.disabled=false;cameraButton.disabled=false;}
};
void updateCameras();navigator.mediaDevices?.addEventListener('devicechange',()=>void updateCameras());
void filters.init().then(rust=>element('engine').textContent=rust?'RUST / WASM ATIVO':'FILTROS TYPESCRIPT');
const raw = new Float32Array(58), target = new Float32Array(58);
let running=false,busy=false,hasFace=false,lastFace=0,lastFrame=performance.now(),frames=0,lastFps=performance.now();
let poseOrigin:T.Vector3|undefined;
const matrix = new T.Matrix4(), position=new T.Vector3(), quaternion=new T.Quaternion(), scale=new T.Vector3(), euler=new T.Euler(0,0,0,'YXZ');
const preview = element<HTMLCanvasElement>('preview'), ctx=preview.getContext('2d')!;
const calibrate = () => {if(!running || !hasFace) {status('Posicione o rosto na câmera antes de calibrar.');return;} calibration.begin(performance.now());status('Calibrando por 2s… mantenha expressão neutra.');};
const calibrateHands=()=>{if(!running||!settings.hands){status('Inicie a câmera e ative o rastreamento de mãos.');return;}avatar.calibrateHands(performance.now());element('hand-status').textContent='Calibrando por 2s: mostre uma ou duas palmas, com os dedos abertos e esticados.';};
const handButton=document.createElement('button');handButton.id='calibrate-hands';handButton.className='secondary';handButton.textContent='✋ Calibrar mãos abertas (2s)';handButton.onclick=calibrateHands;element('calibrate').after(handButton);
createUI({calibrate,calibrateHands,resetHands:()=>avatar.resetHands(),motion:()=>{tracker.poseQuality=settings.poseQuality;void tracker.configureMotion(settings.body,settings.hands);},voice:async enabled=>{if(enabled) {try{await voice.start();}catch(error){settings.voice=false;notice(`Microfone indisponível: ${String(error)}`);}}else voice.stop();},background:()=>{renderer.setClearColor(settings.background,settings.transparent?0:1);document.body.classList.toggle('transparent',settings.transparent);},orbit:enabled=>orbit.enabled=enabled});
element('calibrate').onclick=calibrate;
element('camera').onclick=async()=>{
  if(busy)return;
  if(running) {tracker.stop();voice.stop();settings.voice=false;running=false;hasFace=false;raw.fill(0);poseOrigin=undefined;calibration.cancel();ctx.clearRect(0,0,640,480);status('Câmera desligada');element('camera').textContent='Iniciar câmera ↗';return;}
  busy=true; cameraPicker.disabled=true;element<HTMLButtonElement>('camera').disabled=true;status('Abrindo câmera e carregando MediaPipe…');
  try{tracker.poseQuality=settings.poseQuality;tracker.bodyEnabled=settings.body;tracker.handsEnabled=settings.hands;await tracker.start(selectedCamera || undefined);running=true;await updateCameras();status(`Câmera ativa · ${tracker.delegate}`);element('camera').textContent='Parar câmera ■';}
  catch(error){status(`Não foi possível iniciar: ${String(error)}. Verifique a permissão e a conexão.`);}
  finally{busy=false;cameraPicker.disabled=false;element<HTMLButtonElement>('camera').disabled=false;}
};
async function loadFile(file:File) {
  if(!/\.(glb|vrm)$/i.test(file.name)){notice('Escolha um arquivo .glb ou .vrm.');return;}
  const url=URL.createObjectURL(file);notice(`Carregando ${file.name}…`);
  try{await avatar.load(url);element('avatar-name').textContent=file.name;element('avatar-name').title=file.name;poseOrigin=undefined;}catch(error){notice(`Falha ao abrir ${file.name}: ${String(error)}`);}finally{URL.revokeObjectURL(url);}
}
element('upload').textContent='Trocar avatar ↗';
const avatarName=document.createElement('span');avatarName.id='avatar-name';avatarName.textContent=AVATAR_URL.split('/').pop()??'Avatar';element('upload').before(avatarName);
element('upload').onclick=()=>element<HTMLInputElement>('file').click();
element<HTMLInputElement>('file').onchange=event=>{const input=event.target as HTMLInputElement;if(input.files?.[0])void loadFile(input.files[0]);input.value='';};
window.addEventListener('dragover',event=>event.preventDefault());
window.addEventListener('drop',event=>{event.preventDefault();const file=event.dataTransfer?.files[0];if(file)void loadFile(file);});
function frame(now:number) {
  requestAnimationFrame(frame);
  const dt=Math.min(.1,(now-lastFrame)/1000);lastFrame=now;
  if(running) {
    tracker.motionHz=settings.motionHz;tracker.handPriority=settings.handPriority;
    try {
      const start=performance.now(), result=tracker.detect(now);
      if(result) {
        settings.inference=Number((performance.now()-start).toFixed(1));
        hasFace=!!result.faceLandmarks.length;raw.fill(0);
        ctx.clearRect(0,0,640,480);ctx.save();if(settings.mirror){ctx.translate(640,0);ctx.scale(-1,1);}ctx.drawImage(tracker.video,0,0,640,480);
        if(hasFace) {
          lastFace=now;
          for(const category of result.faceBlendshapes[0]?.categories??[]) {const i=ARKIT.indexOf(category.categoryName as typeof ARKIT[number]);if(i>=0)raw[i]=clamp(category.score);}
          const transform=result.facialTransformationMatrixes[0];
          if(transform) {
            matrix.fromArray(transform.data);matrix.decompose(position,quaternion,scale);euler.setFromQuaternion(quaternion,'YXZ');
            raw[52]=euler.x;raw[53]=euler.y;raw[54]=euler.z;
            poseOrigin??=position.clone();raw[55]=(position.x-poseOrigin.x)*.01;raw[56]=(position.y-poseOrigin.y)*.01;raw[57]=(position.z-poseOrigin.z)*.01;
          }
          if(calibration.sample(raw,now)){avatar.calibrateBody();status('Calibração concluída · pose neutra definida');}
          else if(!calibration.active)status(`Rosto detectado · ${tracker.delegate}`);
          if(settings.landmarks) {
            const points=result.faceLandmarks[0];ctx.strokeStyle='#7fffd366';ctx.lineWidth=.6;ctx.beginPath();
            for(const edge of FaceLandmarker.FACE_LANDMARKS_TESSELATION){const a=points[edge.start],b=points[edge.end];ctx.moveTo(a.x*640,a.y*480);ctx.lineTo(b.x*640,b.y*480);}ctx.stroke();
          }
        } else {if(calibration.active){calibration.cancel();status('Calibração cancelada: rosto fora do quadro.');}else status('Rosto fora do quadro · retornando ao neutro');}
        if(settings.landmarks) {
          const draw=(points:Point3[],connections:{start:number;end:number}[],color:string,isHand=false)=>{
            const valid=isHand?handPointVisible:visible;
            ctx.strokeStyle=color;ctx.lineWidth=2;ctx.beginPath();
            for(const edge of connections){const a=points[edge.start],b=points[edge.end];if(!valid(a)||!valid(b))continue;ctx.moveTo(a.x*640,a.y*480);ctx.lineTo(b.x*640,b.y*480);}ctx.stroke();
            if(isHand){ctx.fillStyle=color;for(const p of points)if(valid(p)){ctx.beginPath();ctx.arc(p.x*640,p.y*480,2.2,0,Math.PI*2);ctx.fill();}}
          };
          if(settings.body&&now-tracker.motion.poseTime<350)for(const points of tracker.motion.pose?.landmarks??[])draw(points,PoseLandmarker.POSE_CONNECTIONS,'#79d5ff');
          if(settings.hands&&now-tracker.motion.handTime<350)for(const points of tracker.motion.hands?.landmarks??[])draw(points,HandLandmarker.HAND_CONNECTIONS,'#ffc977',true);
        }
        ctx.restore();
      }
    }catch(error){console.error(error);tracker.stop();running=false;hasFace=false;status('Rastreamento interrompido. Reinicie a câmera.');element('camera').textContent='Iniciar câmera ↗';}
  }
  const tracked=running&&hasFace&&now-lastFace<300;
  if(!tracked)hasFace=false;
  for(let i=0;i<58;i++) {
    if(!tracked)target[i]=0;
    else if(i<52)target[i]=clamp((raw[i]-calibration.baseline[i])*settings.sensitivity*settings.gains[ARKIT[i]]);
    else target[i]=raw[i]-calibration.baseline[i];
  }
  if(!tracked&&settings.voice)target[ARKIT.indexOf('jawOpen')]=voice.volume();
  else if(!running)target[ARKIT.indexOf('jawOpen')]=settings.mouthTest;
  if(!running) {
    for(const side of ['Left','Right']) {
      target[ARKIT.indexOf(('eyeBlink'+side) as typeof ARKIT[number])]=settings.blinkTest;
      target[ARKIT.indexOf(('eyeLook'+(side==='Left'?'Out':'In')+side) as typeof ARKIT[number])]=Math.max(0,settings.gazeTest);
      target[ARKIT.indexOf(('eyeLook'+(side==='Left'?'In':'Out')+side) as typeof ARKIT[number])]=Math.max(0,-settings.gazeTest);
    }
  }
  const values=filters.step(target,dt,tracked?settings.smoothing:Math.max(.15,settings.smoothing));
  avatar.applyMotion(running?tracker.motion:undefined,now,dt,settings.mirror,settings.body,settings.hands,settings.bodySmoothing,settings.bodyPosition,{...settings,videoAspect:tracker.video.videoWidth/Math.max(1,tracker.video.videoHeight)});
  avatar.apply(values,settings.mirror,dt,settings.wholeModelMotion,tracked);
  renderer.render(scene,camera);
  frames++;if(now-lastFps>=500){settings.fps=Math.round(frames*1000/(now-lastFps));frames=0;lastFps=now;element('metrics').textContent=`${settings.fps} FPS · ${settings.inference} ms / inferência`;const poses=now-tracker.motion.poseTime<350?tracker.motion.pose?.landmarks.length??0:0;const hands=now-tracker.motion.handTime<350?tracker.motion.hands?.landmarks.length??0:0;element('motion-status').textContent=`${tracker.motionStatus} · ${poses} corpo / ${hands} mãos · ${tracker.poseHz} / ${tracker.handHz} Hz`;element('hand-status').textContent=avatar.handStatus;}
}
requestAnimationFrame(frame);
window.addEventListener('pagehide',()=>{tracker.stop();voice.stop();});
