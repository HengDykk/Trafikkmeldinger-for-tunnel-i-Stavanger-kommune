# Tunneltrafikk Stavanger

Infoskjerm (1920x1080) som også brukes på mobil, med status for åtte tunneler.
Repo: HengDykk/Trafikkmeldinger-for-tunnel-i-Stavanger-kommune. Cloudflare Pages
deployer automatisk fra `main` til https://trafikkmeldinger.pages.dev.

## Oppbygging

- `index.html`, `app.js`, `styles.css`: frontend uten byggesteg
- `traffic-rules.js`: regler for stengt/delvis stengt, delt mellom frontend og backend
- `functions/api/combined.js`: henter Vegvesen (DATEX), TomTom og Politiloggen
- `functions/api/cam.js`: proxy for veikameraer
- `functions/api/tunnel-history.js`: historikk for tunnelene (cachet i Cloudflare)
- `workers/traffic-coordinator.js`: Durable Object som styrer TomTom-kvoten
- `tests/traffic.test.mjs`: kjøres med `node tests/traffic.test.mjs`

## Arbeidsmåte

- Start alltid fra siste `main` (`git pull`).
- Infoskjermen på 1920x1080 skal vise alt uten rulling og uten at kort kuttes.
  Sjekk også laptop og mobil (393 px) før du pusher.
- Kjør testene før commit. Commit-meldinger skrives på norsk.
- Du kan pushe rett til `main` når endringen er testet.
- Si fra før du gjør noe som endrer backend, kvoter eller miljøvariabler.
- Hemmeligheter (DATEX, TomTom) ligger i Cloudflare og skal aldri inn i koden.
