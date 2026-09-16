# Test script para verificar navegación del admin panel

function Test-Section {
    param([string]$Section)
    
    try {
        $response = Invoke-WebRequest -Uri "http://localhost:5000/admin?section=$Section" -UseBasicParsing
        $content = $response.Content
        
        # Verificar que la sección se incluye en el HTML
        if ($content -match "data-admin-view=`"$Section`"") {
            # Verificar que la sección tiene la clase is-visible
            if ($content -match "<section[^>]*data-admin-view=`"$Section`"[^>]*class=[`"'][^`"']*is-visible") {
                Write-Host "✓ Section '$Section' renderiza correctamente con is-visible" -ForegroundColor Green
                return $true
            } else {
                Write-Host "✗ Section '$Section' No tiene clase is-visible" -ForegroundColor Red
                return $false
            }
        } else {
            Write-Host "✗ Section '$Section' No se encontró en el HTML" -ForegroundColor Red
            return $false
        }
    } catch {
        Write-Host "✗ Error accediendo a section '$Section': $_" -ForegroundColor Red
        return $false
    }
}

# Test todas las secciones
$sections = @('products', 'affiliates', 'categories', 'analytics', 'marketing')
$results = @()

foreach ($section in $sections) {
    $results += Test-Section -Section $section
}

# Resumen
Write-Host ""
Write-Host "Resumen:" -ForegroundColor Cyan
Write-Host "Total: $($results.Count) secciones"
Write-Host "Exitosas: $($results | Where-Object { $_ } | Measure-Object | Select-Object -ExpandProperty Count)"
Write-Host "Fallidas: $($results | Where-Object { -not $_ } | Measure-Object | Select-Object -ExpandProperty Count)"
