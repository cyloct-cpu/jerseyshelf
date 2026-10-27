"""Map non-product homepage images to editable local homepage blocks."""
from shoplazza import *
tree,_,_=parse_home()
file=OUT/'home-source.json';home=json.loads(file.read_text(encoding='utf-8'))
blocks=[]
for section in tree.all(lambda n:n.attrs.get('data-section-type') in {'split_slideshow','logo_list','images_text_cols'}):
    kind=section.attrs['data-section-type']
    for index,url in enumerate(images_of(section)):
        if kind=='logo_list':blocks.append({'kind':'brand','title':'','description':'','href':'','image':url})
        elif kind=='images_text_cols':blocks.append({'kind':'story','title':['足球史上的经典瞬间（一）','设计背后的故事','新品'][index] if index<3 else '', 'description':['','足球史上的经典时刻（二）','足球史上的经典时刻（三）'][index] if index<3 else '', 'href':'','image':url})
        else:blocks.append({'kind':'feature','title':'儿童尺码','description':'We know how important it is to have gear that does not let you down when you are pushing your limits.','href':'/collections/kids-size','image':url})
home['extraImages']=blocks;atomic_json(file,home)
print('Mapped homepage blocks:',len(blocks))
