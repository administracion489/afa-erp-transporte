git push
if ($LASTEXITCODE -eq 0) {
    Invoke-WebRequest -Method POST -Uri "https://api.vercel.com/v1/integrations/deploy/prj_9EMH0FUhgorhcgxJlxCT82jjxmQy/fOnFH0vvif" -UseBasicParsing | Out-Null
    Write-Host "Vercel deploy triggered." -ForegroundColor Green
}
