"""Procedural gaze morphs and two-part eyelids for this specific inspected face."""
import bpy,math,os,json
from mathutils import Vector
ROOT=os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
bpy.ops.wm.open_mainfile(filepath=os.path.join(ROOT,'public/models/avatar-face.blend'))
mesh=max((o for o in bpy.context.scene.objects if o.type=='MESH'),key=lambda o:len(o.data.vertices))
armature=next(o for o in bpy.context.scene.objects if o.type=='ARMATURE')
original_material=mesh.data.materials[0]
image=next(n.image for n in original_material.node_tree.nodes if n.type=='TEX_IMAGE' and n.image)
pixels=list(image.pixels);width,height=image.size
def hit(x,z):
    ok,location,normal,face=mesh.ray_cast(Vector((x,-1,z)),Vector((0,1,0)))
    return (location,face) if ok else (Vector((x,-.115,z)),-1)
def skin_color(x,z):
    loc,face=hit(x,z)
    if face<0:return (.65,.38,.20,1)
    polygon=mesh.data.polygons[face];uv=mesh.data.uv_layers.active.data[polygon.loop_indices[0]].uv
    offset=(int(uv.y*(height-1))*width+int(uv.x*(width-1)))*4
    # This loaded JPEG exposes sRGB pixel values; shader constants are linear.
    def linear(c):return c/12.92 if c<=.04045 else ((c+.055)/1.055)**2.4
    return tuple(linear(c) for c in pixels[offset:offset+3])+(1,)
def rig(obj):
    group=obj.vertex_groups.new(name='mixamorig:Head');group.add(list(range(len(obj.data.vertices))),1,'REPLACE')
    modifier=obj.modifiers.new('Armature','ARMATURE');modifier.object=armature
    obj.parent=armature;obj.matrix_parent_inverse=armature.matrix_world.inverted()
    obj['cammapEyePrototype']='Procedural gaze/eyelids; bounded to this model, not medical eye tracking.'
created=[];counts={}
for side,cx in [('Left',.0355),('Right',-.0345)]:
    cz=.8635;rx=.0255;rz=.0188
    # Small, bounded deformation of the iris region, tapering to zero at its rim.
    for name,dx,dz in [('Out',.004 if side=='Left' else -.004,0),('In',-.004 if side=='Left' else .004,0),('Up',0,.003),('Down',0,-.003)]:
        key=mesh.shape_key_add(name='eyeLook'+name+side);count=0
        for vertex in mesh.data.vertices:
            x,y,z=vertex.co;r2=((x-cx)/rx)**2+((z-cz)/rz)**2
            if r2>=1 or y>-.075:continue
            weight=(1-r2)**1.4
            key.data[vertex.index].co.x+=dx*weight;key.data[vertex.index].co.z+=dz*weight;count+=1
        counts[key.name]=count;created.append(key.name)
    material=bpy.data.materials.new('EyelidSkin'+side);material.use_nodes=True
    bsdf=material.node_tree.nodes.get('Principled BSDF');bsdf.inputs['Base Color'].default_value=skin_color(cx,cz-.028);bsdf.inputs['Roughness'].default_value=.65
    # Upper/lower eyelids meet at a curved lash line, covering the existing iris.
    for upper in [True,False]:
        vertices=[];closed=[];faces=[];columns=24;rows=5
        for i in range(columns+1):
            t=-1+2*i/columns;x=cx+rx*t;arc=math.sqrt(max(0,1-t*t));rim_z=cz+(1 if upper else -1)*rz*arc
            line_z=cz+.0015*(1-t*t)
            start,_=hit(x,rim_z);start.y-=.0012
            for row in range(rows+1):
                s=row/rows;z=rim_z+(line_z-rim_z)*s;end,_=hit(x,z);end.y-=.0017
                vertices.append(tuple(start));closed.append(tuple(end))
        for i in range(columns):
            for row in range(rows):
                a=i*(rows+1)+row;b=a+rows+1;faces.append((a,b,b+1,a+1))
        data=bpy.data.meshes.new('EyelidSurface'+side);data.from_pydata(vertices,[],faces);data.update();data.materials.append(material)
        obj=bpy.data.objects.new(('Upper' if upper else 'Lower')+'Eyelid'+side,data);bpy.context.collection.objects.link(obj);rig(obj)
        obj.shape_key_add(name='Basis');blink=obj.shape_key_add(name='eyeBlink'+side)
        for i,co in enumerate(closed):blink.data[i].co=co
        for poly in data.polygons:poly.use_smooth=True
    created.append('eyeBlink'+side)
    # A narrow upper lash follows the advancing lid and provides a closed-eye
    # seam instead of a featureless oval of skin.
    lash_vertices=[];lash_closed=[];lash_faces=[]
    for i in range(25):
        t=-1+2*i/24;x=cx+rx*t;arc=math.sqrt(max(0,1-t*t))
        for dz in [-.00035,.00035]:
            start,_=hit(x,cz+rz*arc+dz);start.y-=.0022
            end,_=hit(x,cz+.0015*(1-t*t)+dz);end.y-=.0024
            lash_vertices.append(tuple(start));lash_closed.append(tuple(end))
        if i:lash_faces.append((2*i-2,2*i,2*i+1,2*i-1))
    data=bpy.data.meshes.new('LashSurface'+side);data.from_pydata(lash_vertices,[],lash_faces);data.update()
    dark=bpy.data.materials.new('Lash'+side);dark.use_nodes=True;dark.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value=(.025,.008,.003,1);dark.node_tree.nodes['Principled BSDF'].inputs['Roughness'].default_value=.9;data.materials.append(dark)
    obj=bpy.data.objects.new('Lash'+side,data);bpy.context.collection.objects.link(obj);rig(obj);obj.shape_key_add(name='Basis');blink=obj.shape_key_add(name='eyeBlink'+side)
    for i,co in enumerate(lash_closed):blink.data[i].co=co
report={'gazeMorphs':counts,'newChannels':created,'limitations':['First-pass gaze deformation, not separate spherical eyeballs','Procedural eyelid skin may differ slightly from original texture','No smile, teeth or tongue']}
with open(os.path.join(ROOT,'artifacts/eyes-preparation.json'),'w') as f:json.dump(report,f,indent=2)
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(ROOT,'public/models/avatar-full.blend'))
bpy.ops.export_scene.gltf(filepath=os.path.join(ROOT,'public/models/avatar-full.glb'),export_format='GLB',export_animations=False,export_skins=True,export_morph=True,export_morph_normal=True,export_extras=True)
scene=bpy.context.scene;scene.render.engine='CYCLES';scene.cycles.samples=12
scene.world=bpy.data.worlds.new('Studio');scene.world.use_nodes=True;scene.world.node_tree.nodes['Background'].inputs['Color'].default_value=(.4,.4,.4,1)
def aim(obj,target):obj.rotation_euler=(Vector(target)-obj.location).to_track_quat('-Z','Y').to_euler()
bpy.ops.object.camera_add(location=(0,-2,.855));camera=bpy.context.object;aim(camera,(0,0,.855));camera.data.type='ORTHO';camera.data.ortho_scale=.30;scene.camera=camera
for pos,power in [((-.5,-1,1.4),35),((.7,-.7,.8),20)]:
    bpy.ops.object.light_add(type='AREA',location=pos);light=bpy.context.object;light.data.energy=power;light.data.size=1;aim(light,(0,0,.85))
scene.render.resolution_x=640;scene.render.resolution_y=640;scene.render.resolution_percentage=100
for label,values in [('eyes-open',{}),('eyes-glance',{'eyeLookOutLeft':1,'eyeLookInRight':1}),('eyes-blink',{'eyeBlinkLeft':1,'eyeBlinkRight':1})]:
    for obj in bpy.context.scene.objects:
        if obj.type=='MESH' and obj.data.shape_keys:
            for key in obj.data.shape_keys.key_blocks:key.value=values.get(key.name,0)
    scene.render.filepath=os.path.join(ROOT,'artifacts/'+label+'.png');bpy.ops.render.render(write_still=True)
print('EYES_REPORT',json.dumps(report))
