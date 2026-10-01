import sys,re
for p in sys.argv[1:]:
    s=open(p,encoding='utf-8',newline='').read()
    s2=re.sub(r"<<<<<<< [^\n]*\n(.*?)=======\r?\n(.*?)>>>>>>> [^\n]*\n", lambda m: m.group(1)+m.group(2), s, flags=re.S)
    open(p,'w',encoding='utf-8',newline='').write(s2); print("kept both in", p)
