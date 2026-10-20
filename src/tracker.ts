import { FaceLandmarker, FilesetResolver, PoseLandmarker, HandLandmarker, type FaceLandmarkerResult } from '@mediapipe/tasks-vision';
import { FACE_MODEL_URL, POSE_MODEL_URL, POSE_LITE_MODEL_URL, HAND_MODEL_URL, VISION_WASM_URL, PREFERRED_CAMERA_LABEL, BLOCKED_CAPTURE_LABEL } from './config';
import type { MotionFrame } from './motion';
export class Tracker {
  readonly video = document.createElement('video');
  private task?: FaceLandmarker;
  private stream?: MediaStream;
  private lastTime = -1;
  private files?:Awaited<ReturnType<typeof FilesetResolver.forVisionTasks>>;
  private pose?:PoseLandmarker;
  private hands?:HandLandmarker;
  private session=0;
  private motionQueue:Promise<void>=Promise.resolve();
  private motionSlot=0;
  private lastMotion=0;
  private rateStart=0;
  private poseCount=0;
  private handCount=0;
  poseHz=0;
  handHz=0;
  handPriority=true;
  bodyEnabled=true;
  handsEnabled=true;
  motionHz=24;
  poseQuality:'full'|'lite'='full';
  private loadedPoseQuality='';
  readonly motion:MotionFrame={poseTime:0,handTime:0};
  motionStatus='Corpo e mãos aguardando câmera';
  private poseBackend='';
  private handBackend='';
  delegate = 'GPU';
  constructor() { this.video.muted = true; this.video.playsInline = true; this.video.hidden = true; document.body.append(this.video); }
  get cameraId() { return this.stream?.getVideoTracks()[0]?.getSettings().deviceId ?? ''; }
  get cameraLabel() { return this.stream?.getVideoTracks()[0]?.label ?? ''; }
  async cameras() { return (await navigator.mediaDevices.enumerateDevices()).filter(d=>d.kind==='videoinput'); }
  async openCamera(deviceId?:string) {
    this.motion.pose=undefined;this.motion.hands=undefined;this.motion.poseTime=0;this.motion.handTime=0;this.lastMotion=0;this.motionSlot=0;this.rateStart=0;this.poseCount=0;this.handCount=0;this.poseHz=0;this.handHz=0;
    this.stream?.getTracks().forEach(t=>t.stop());
    this.stream=undefined;
    this.video.srcObject=null;
    const cameras=await this.cameras();
    const camera=deviceId ? cameras.find(d=>d.deviceId===deviceId) : cameras.find(d=>PREFERRED_CAMERA_LABEL.test(d.label));
    if(!camera)throw new Error(deviceId ? 'A webcam escolhida não está disponível. Nenhuma câmera alternativa foi aberta.' : 'Webcam Rise Mode não detectada. Conecte a webcam e autorize o acesso no Opera; a placa de captura não será usada.');
    if(BLOCKED_CAPTURE_LABEL.test(camera.label))throw new Error('Este dispositivo é a placa de captura USB Video (534d:2109). Ela continua disponível para outros aplicativos; selecione a webcam Rise Mode neste projeto.');
    deviceId=camera.deviceId;
    const stream=await navigator.mediaDevices.getUserMedia({video:{deviceId:{exact:deviceId},width:{ideal:640},height:{ideal:480},frameRate:{ideal:30}},audio:false});
    const actual=stream.getVideoTracks()[0]?.getSettings().deviceId;
    if(deviceId && actual && actual!==deviceId) {
      stream.getTracks().forEach(t=>t.stop());
      throw new Error('O navegador abriu uma câmera diferente da selecionada. Confira a permissão de câmera do Opera.');
    }
    this.stream=stream;
    this.video.srcObject=stream;
    try {await this.video.play();} catch(error) {stream.getTracks().forEach(t=>t.stop());this.stream=undefined;this.video.srcObject=null;throw error;}
    this.lastTime=-1;
  }
  async start(deviceId?:string) {
    try {
      if (!navigator.mediaDevices) throw new Error('Câmera requer HTTPS ou localhost.');
      await this.openCamera(deviceId);
      const files = await FilesetResolver.forVisionTasks(VISION_WASM_URL);
      this.files=files;
      const create = (delegate: 'GPU' | 'CPU') => FaceLandmarker.createFromOptions(files, {
        baseOptions:{modelAssetPath:FACE_MODEL_URL,delegate}, runningMode:'VIDEO', numFaces:1,
        outputFaceBlendshapes:true, outputFacialTransformationMatrixes:true,
        minFaceDetectionConfidence:.5, minFacePresenceConfidence:.5, minTrackingConfidence:.5
      });
      try { this.task = await create('GPU'); } catch (error) { console.warn('GPU indisponível; usando CPU', error); this.delegate = 'CPU'; this.task = await create('CPU'); }
      this.lastTime = -1;
      void this.configureMotion(this.bodyEnabled,this.handsEnabled);
    } catch (error) { this.stop(); throw error; }
  }
  detect(now: number): FaceLandmarkerResult | undefined {
    if (!this.task || this.video.readyState < 2 || this.video.currentTime === this.lastTime) return;
    this.lastTime = this.video.currentTime;
    const result=this.task.detectForVideo(this.video, now);
    // One extra model per slot. Preserve the deadline phase so camera jitter
    // does not halve the inference rate. Detailed mode gives hands 2/3 slots.
    if(now-this.lastMotion>=1000/Math.max(2,this.motionHz)) {
      const interval=1000/Math.max(2,this.motionHz);this.lastMotion=now-((now-this.lastMotion)%interval);
      const preferPose=this.handPriority?this.motionSlot%3===1:this.motionSlot%2===0;
      const usePose=!!(this.bodyEnabled&&this.pose&&(!this.handsEnabled||!this.hands||preferPose));
      try {
        if(usePose&&this.pose&&this.bodyEnabled){this.motion.pose=this.pose.detectForVideo(this.video,now);this.motion.poseTime=now;this.poseCount++;this.motionSlot++;}
        else if(this.hands&&this.handsEnabled){this.motion.hands=this.hands.detectForVideo(this.video,now);this.motion.handTime=now;this.handCount++;this.motionSlot++;}
      } catch(error) {
        console.warn('Rastreamento corporal interrompido',error);
        if(usePose){this.pose?.close();this.pose=undefined;this.poseBackend='erro';this.motion.pose=undefined;}
        else{this.hands?.close();this.hands=undefined;this.handBackend='erro';this.motion.hands=undefined;}
        this.describeMotion();
      }
    }
    if(!this.rateStart)this.rateStart=now;
    if(now-this.rateStart>=1000){const elapsed=(now-this.rateStart)/1000;this.poseHz=Math.round(this.poseCount/elapsed);this.handHz=Math.round(this.handCount/elapsed);this.poseCount=0;this.handCount=0;this.rateStart=now;}
    return result;
  }
  private describeMotion() {
    this.motionStatus=`Corpo: ${this.bodyEnabled?(this.poseBackend||'carregando'):'desligado'} · Mãos: ${this.handsEnabled?(this.handBackend||'carregando'):'desligado'}`;
  }
  configureMotion(body:boolean,hands:boolean):Promise<void> {
    this.bodyEnabled=body;this.handsEnabled=hands;this.describeMotion();
    const session=this.session,files=this.files;
    if(!files)return Promise.resolve();
    this.motionQueue=this.motionQueue.catch(()=>{}).then(async()=>{
      if(session!==this.session)return;
      if(this.bodyEnabled&&(!this.pose||this.loadedPoseQuality!==this.poseQuality)) {
        try {
          const quality=this.poseQuality;
          const create=(delegate:'GPU'|'CPU')=>PoseLandmarker.createFromOptions(files,{baseOptions:{modelAssetPath:quality==='full'?POSE_MODEL_URL:POSE_LITE_MODEL_URL,delegate},runningMode:'VIDEO',numPoses:1,outputSegmentationMasks:false,minPoseDetectionConfidence:.5,minPosePresenceConfidence:.5,minTrackingConfidence:.5});
          let task:PoseLandmarker;try{task=await create('GPU');this.poseBackend='GPU';}catch{task=await create('CPU');this.poseBackend='CPU';}
          if(session!==this.session){task.close();return;}this.pose?.close();this.pose=task;this.loadedPoseQuality=quality;this.motion.pose=undefined;this.motion.poseTime=0;
        }catch(error){this.poseBackend='falhou; rosto continua ativo';console.warn('Pose indisponível',error);}
        this.describeMotion();
      }
      if(session!==this.session)return;
      if(this.handsEnabled&&!this.hands) {
        try {
          const create=(delegate:'GPU'|'CPU')=>HandLandmarker.createFromOptions(files,{baseOptions:{modelAssetPath:HAND_MODEL_URL,delegate},runningMode:'VIDEO',numHands:2,minHandDetectionConfidence:.5,minHandPresenceConfidence:.5,minTrackingConfidence:.5});
          let task:HandLandmarker;try{task=await create('GPU');this.handBackend='GPU';}catch{task=await create('CPU');this.handBackend='CPU';}
          if(session!==this.session){task.close();return;}this.hands=task;
        }catch(error){this.handBackend='falhou; rosto continua ativo';console.warn('Mãos indisponíveis',error);}
        this.describeMotion();
      }
    });
    return this.motionQueue;
  }
  stop() {
    this.session++;this.task?.close();this.task=undefined;this.pose?.close();this.pose=undefined;this.hands?.close();this.hands=undefined;this.files=undefined;
    this.poseBackend='';this.handBackend='';this.motion.pose=undefined;this.motion.hands=undefined;this.motion.poseTime=0;this.motion.handTime=0;this.motionStatus='Corpo e mãos aguardando câmera';
    this.stream?.getTracks().forEach(t=>t.stop());this.stream=undefined;this.video.srcObject=null;
  }
}
export class VoiceInput {
  private stream?: MediaStream;
  private context?: AudioContext;
  private analyser?: AnalyserNode;
  private samples = new Float32Array(512);
  async start() {
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true},video:false});
      this.context = new AudioContext();
      await this.context.resume();
      this.analyser = this.context.createAnalyser(); this.analyser.fftSize = 512;
      this.context.createMediaStreamSource(this.stream).connect(this.analyser);
    } catch (error) { this.stop(); throw error; }
  }
  volume() {
    if (!this.analyser) return 0;
    this.analyser.getFloatTimeDomainData(this.samples);
    let energy = 0; for (const sample of this.samples) energy += sample * sample;
    return Math.min(1, Math.max(0, (Math.sqrt(energy / this.samples.length) - .015) * 9));
  }
  stop() { this.stream?.getTracks().forEach(t => t.stop()); void this.context?.close(); this.analyser = undefined; this.context = undefined; }
}
