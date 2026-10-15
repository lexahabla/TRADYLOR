import subprocess
p="src/pages/admin.astro"
out=subprocess.check_output(["git","show","de5b6e5:"+p], cwd="D:/AXEL/WEBS/TRADYLOR/tradylor_web", text=True, encoding='utf-8', errors='replace')
lines=out.splitlines()
print("form start", next(i for i,l in enumerate(lines) if "<form id=\"productForm\"" in l))
print("form end", [i for i,l in enumerate(lines) if "</form>" in l])
with open("D:/AXEL/WEBS/TRADYLOR/tradylor_web/_oldform.txt","w",encoding='utf-8') as f:
    for i,l in enumerate(lines,1):
        if "Formulario Editable del Producto" in l:
            s=i-1
        if "<!-- Barra de Scraping" in l:
           ? 
print("done")
