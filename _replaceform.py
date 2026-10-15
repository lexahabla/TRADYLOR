p_cur="D:/AXEL/WEBS/TRADYLOR/tradylor_web/src/pages/admin.astro"
cur=open(p_cur,encoding='utf-8').read()
import subprocess
old=subprocess.check_output(["git","show","de5b6e5:src/pages/admin.astro"], cwd="D:/AXEL/WEBS/TRADYLOR/tradylor_web", text=True, encoding='utf-8', errors='replace').splitlines()
fi=next(i for i,l in enumerate(old) if "<form id=\"productForm\"" in l)
fe=next(i for i,l in enumerate(old, fi+1) if "</form>" in l)
form=old[fi:fe+1]
pcs=next(i for i,l in enumerate(form) if "form-preview-col" in l)
tcs=next(i for i,l in enumerate(form) if i>pcs and "<div class=\"form-row two-cols\">" in l and "prodPrice" not in l or "<div class=\"form-row two-cols\">" in l and "Precio" not in l)
# choose first two-cols after preview
for i,l in enumerate(form):
    if i>pcs and "<div class=\"form-row two-cols\">" in l:
        tcs=i; break
newlines=[] 
for i,l in enumerate(form):
    if i==0:
        newlines.append('        <form id="productForm" class="product-edit-form form-toggle-body">')
    elif pcs <= i < tcs:
        continue
    else:
        newlines.append(l)
newtext="\n".join(newlines)
# replace current form
import re
cur_start=cur.index("        <form id=\"productForm\"")
cur_end=cur.index("        </form>", cur_start)
cur=cur[:cur_start]+newtext+cur[cur_end+len("        </form>"):]
open(p_cur,"w",encoding='utf-8').write(cur)
print("done")
PY