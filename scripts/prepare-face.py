"""First-pass lip seam and jawOpen for the inspected Tripo avatar, not a generic facial autorigger."""
import bpy, bmesh, math, os, json
from mathutils import Vector
ROOT=os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=os.path.join(ROOT,'public/models/avatar-restored.glb'))
mesh=next(o for o in bpy.context.scene.objects if o.type=='MESH')
armature=next(o for o in bpy.context.scene.objects if o.type=='ARMATURE')
# Work in scene coordinates (Blender X horizontal, -Y front, Z up), retaining
# world placement and vertex groups when applying the object's static matrix.
bpy.context.view_layer.objects.active=mesh;mesh.select_set(True)
bpy.ops.object.transform_apply(location=True,rotation=True,scale=True)
seam_z=.8035
bm=bmesh.new();bm.from_mesh(mesh.data)
region=[f for f in bm.faces if abs(f.calc_center_median().x)<.043 and .784<f.calc_center_median().z<.827 and f.calc_center_median().y<-.075]
geometry=set(region)
for f in region:geometry.update(f.edges);geometry.update(f.verts)
result=bmesh.ops.bisect_plane(bm,geom=list(geometry),dist=1e-7,plane_co=(0,0,seam_z),plane_no=(0,0,1))
seam=[e for e in bm.edges if all(abs(v.co.z-seam_z)<1e-6 for v in e.verts) and abs(sum(v.co.x for v in e.verts)/2)<.0225 and max(v.co.y for v in e.verts)<-.075]
if not seam:raise RuntimeError('Mouth seam was not found; source left untouched.')
seam_coords=[(e.verts[0].co.copy(),e.verts[1].co.copy()) for e in seam]
bmesh.ops.split_edges(bm,edges=seam)
bm.verts.ensure_lookup_table();bm.verts.index_update()
lower_seam={v.index for v in bm.verts if abs(v.co.z-seam_z)<1e-6 and v.co.y<-.075 and abs(v.co.x)<.035 and all(f.calc_center_median().z<seam_z+1e-6 for f in v.link_faces)}
bm.to_mesh(mesh.data);bm.free();mesh.data.update()
def smooth(a,b,x):
    t=max(0,min(1,(x-a)/(b-a)));return t*t*(3-2*t)
def jaw_delta(co,lower=True):
    x,y,z=co
    if not lower or z>seam_z+1e-6:return Vector((0,0,0))
    broad=math.exp(-((x/.038)**4))
    lip=max(0,1-(x/.024)**2)**.7
    near_lip=smooth(seam_z-.024,seam_z-.004,z)
    horizontal=broad*.55*(1-near_lip)+lip*near_lip
    depth=1-smooth(-.085,-.055,y)
    chin=smooth(.750,.790,z)
    drop=.018*horizontal*depth*chin
    return Vector((0,.0025*horizontal*depth*chin,-drop))
mesh.shape_key_add(name='Basis');jaw=mesh.shape_key_add(name='jawOpen')
affected=0
for v in mesh.data.vertices:
    delta=jaw_delta(v.co,v.co.z<seam_z-1e-6 or v.index in lower_seam)
    jaw.data[v.index].co+=delta
    if delta.length>1e-6:affected+=1
if affected<15:raise RuntimeError('Too few affected mouth vertices; refusing to export.')
# Oral surface is recessed behind the split lips. Its neutral shape is collapsed
# so it does not draw an artificial open mouth over the original closed texture.
coords=[];faces=[];opening=[]
for a,b in seam_coords:
    base=len(coords)
    for p in [a,b,b,a]:coords.append((p.x,p.y+.0015,p.z))
    opening.extend([Vector((0,0,0)),Vector((0,0,0)),jaw_delta(b),jaw_delta(a)])
    faces.append((base,base+1,base+2,base+3))
oral_mesh=bpy.data.meshes.new('OralSurface');oral_mesh.from_pydata(coords,[],faces);oral_mesh.update()
oral=bpy.data.objects.new('MouthInterior',oral_mesh);bpy.context.collection.objects.link(oral)
material=bpy.data.materials.new('MouthInterior');material.diffuse_color=(.035,.003,.006,1);material.use_nodes=True
bsdf=material.node_tree.nodes.get('Principled BSDF');bsdf.inputs['Base Color'].default_value=(.035,.003,.006,1);bsdf.inputs['Roughness'].default_value=.9
oral_mesh.materials.append(material)
group=oral.vertex_groups.new(name='mixamorig:Head');group.add(list(range(len(coords))),1,'REPLACE')
modifier=oral.modifiers.new('Armature','ARMATURE');modifier.object=armature
oral.parent=armature;oral.matrix_parent_inverse=armature.matrix_world.inverted()
oral.shape_key_add(name='Basis');oral_jaw=oral.shape_key_add(name='jawOpen')
for i,delta in enumerate(opening):oral_jaw.data[i].co+=delta
for obj in [mesh,oral]:obj['cammapFacialPrototype']='jawOpen v1, procedural lip seam, manually bounded to inspected model; no blink or smile supplied.'
report={'source':'avatar-rig-original.glb','output':'avatar-face.glb','shapeKeys':['jawOpen'],'mouthSeamEdges':len(seam_coords),'affectedVertices':affected,'limitations':['First-pass procedural lip seam, not a full ARKit rig','No tongue, teeth, smile or blink expressions','Facial topology requires visual review']}
with open(os.path.join(ROOT,'artifacts/face-preparation.json'),'w',encoding='utf8') as f:json.dump(report,f,indent=2)
# Save an editable authoring file, then export the actual morph targets and skin.
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(ROOT,'public/models/avatar-face.blend'))
bpy.ops.export_scene.gltf(filepath=os.path.join(ROOT,'public/models/avatar-face.glb'),export_format='GLB',export_animations=False,export_skins=True,export_morph=True,export_morph_normal=True)
# Inspection renders show closed/half/open independently of live tracking.
scene=bpy.context.scene;scene.render.engine='CYCLES';scene.cycles.samples=16
scene.world=bpy.data.worlds.new('Studio');scene.world.use_nodes=True;scene.world.node_tree.nodes['Background'].inputs['Color'].default_value=(.4,.4,.4,1)
def aim(obj,target):obj.rotation_euler=(Vector(target)-obj.location).to_track_quat('-Z','Y').to_euler()
bpy.ops.object.camera_add(location=(0,-2,.855));camera=bpy.context.object;aim(camera,(0,0,.855));camera.data.type='ORTHO';camera.data.ortho_scale=.30;scene.camera=camera
for pos,power,size in [((-.5,-1,1.4),35,1),((.7,-.7,.8),20,.8)]:
    bpy.ops.object.light_add(type='AREA',location=pos);light=bpy.context.object;light.data.energy=power;light.data.size=size;aim(light,(0,0,.85))
scene.render.resolution_x=640;scene.render.resolution_y=640;scene.render.resolution_percentage=100
for value,label in [(0,'closed'),(.5,'half'),(1,'open')]:
    jaw.value=value;oral_jaw.value=value;scene.render.filepath=os.path.join(ROOT,'artifacts/face-'+label+'.png');bpy.ops.render.render(write_still=True)
print('FACE_REPORT',json.dumps(report))
