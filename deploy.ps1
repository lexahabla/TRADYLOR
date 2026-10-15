Write-Host "🚀 Iniciando despliegue de Tradylor..." -ForegroundColor Cyan

# 1. Estado de los archivos
git status

# 2. Añadir todos los cambios
git add .

# 3. Pedir mensaje de commit
$commitMsg = Read-Host "Introduce el mensaje para el commit"
if ([string]::IsNullOrWhitespace($commitMsg)) {
    $commitMsg = "feat: actualizacion automatica de tradylor"
}

# 4. Commit y Push a GitHub
git commit -m $commitMsg
git push origin main

# 5. Compilación de producción
npm run build

Write-Host "✅ ¡Hecho! Todo el código se ha subido a Git y se ha compilado para producción." -ForegroundColor Green