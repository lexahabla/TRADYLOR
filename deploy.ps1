Write-Host "🚀 Iniciant desplegament de Tradylor..." -ForegroundColor Cyan

# 1. Estat dels fitxers
git status

# 2. Afegir tots els canvis
git add .

# 3. Demanar missatge de commit
$commitMsg = Read-Host "Introdueix el missatge per al commit"
if ([string]::IsNullOrWhitespace($commitMsg)) {
    $commitMsg = "feat: actualitzacio automatica de tradylor"
}

# 4. Commit i Push a GitHub
git commit -m $commitMsg
git push origin main

# 5. Compilació de producció
npm run build

Write-Host "✅ ¡Fet! Tot el codi s'ha pujat a Git i s'ha compilat per a producció." -ForegroundColor Green