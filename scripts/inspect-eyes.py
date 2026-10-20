import bpy,os,json
ROOT=os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
bpy.ops.wm.open_mainfile(filepath=os.path.join(ROOT,'public/models/avatar-face.blend'))
mesh=max((o for o in bpy.context.scene.objects if o.type=='MESH'),key=lambda o:len(o.data.vertices))
parents=list(range(len(mesh.data.vertices)))
def find(i):
    while parents[i]!=i:parents[i]=parents[parents[i]];i=parents[i]
    return i
for edge in mesh.data.edges:
    a,b=edge.vertices;parents[find(a)]=find(b)
groups={}
for v in mesh.data.vertices:groups.setdefault(find(v.index),[]).append(v)
data=[]
for vertices in groups.values():
    if len(vertices)<6:continue
    bounds=[(min(v.co[i] for v in vertices),max(v.co[i] for v in vertices)) for i in range(3)]
    data.append({'count':len(vertices),'bounds':bounds,'indices':[v.index for v in vertices[:8]]})
print('COMPONENTS',json.dumps(sorted(data,key=lambda c:c['count'],reverse=True)))
with open(os.path.join(ROOT,'artifacts/eye-components.json'),'w') as f:json.dump(data,f,indent=2)
