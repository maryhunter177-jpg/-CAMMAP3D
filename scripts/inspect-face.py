import bpy, math, json, os
from mathutils import Vector
ROOT=os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=os.path.join(ROOT,'public/models/avatar-restored.glb'))
mesh=next(o for o in bpy.context.scene.objects if o.type=='MESH')
print('MESH',mesh.name,len(mesh.data.vertices),len(mesh.data.polygons))
print('BOUNDS',[(min((mesh.matrix_world@v.co)[i] for v in mesh.data.vertices),max((mesh.matrix_world@v.co)[i] for v in mesh.data.vertices)) for i in range(3)])
print('BONES',[(b.name,list(b.head_local),list(b.tail_local)) for a in bpy.context.scene.objects if a.type=='ARMATURE' for b in a.data.bones if 'Head' in b.name or 'Neck' in b.name])
scene=bpy.context.scene;scene.render.engine='CYCLES';scene.cycles.samples=16
scene.world=bpy.data.worlds.new('Studio');scene.world.use_nodes=True;scene.world.node_tree.nodes['Background'].inputs['Color'].default_value=(.4,.4,.4,1)
def aim(obj,target):obj.rotation_euler=(Vector(target)-obj.location).to_track_quat('-Z','Y').to_euler()
bpy.ops.object.camera_add(location=(0,-2,.865));camera=bpy.context.object;aim(camera,(0,0,.865));camera.data.type='ORTHO';camera.data.ortho_scale=.34;scene.camera=camera
for pos,power,size in [((-.5,-1,1.4),35,1),((.7,-.7,.8),20,.8)]:
    bpy.ops.object.light_add(type='AREA',location=pos);light=bpy.context.object;light.data.energy=power;light.data.shape='DISK';light.data.size=size;aim(light,(0,0,.85))
scene.render.resolution_x=768;scene.render.resolution_y=768;scene.render.resolution_percentage=100
scene.render.filepath=os.path.join(ROOT,'artifacts/face-neutral.png');bpy.ops.render.render(write_still=True)
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(ROOT,'artifacts/avatar-inspect.blend'))
