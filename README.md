# Robotbattle

Ett fightingspel i webbläsaren. Du styr en robot, slåss mot en AI-robot eller en vän online,
och samlar fler robotar genom att vinna matcher och öppna lådor.

## Köra spelet

**Bara mot AI, som gäst (ingen server behövs):**
Öppna `index.html` direkt i webbläsaren, eller:
```
python3 -m http.server 8000
```
och gå till http://localhost:8000. Samlingen sparas bara i den webbläsaren.

**Med konto och vänmatcher (kräver servern):**
```
npm install
npm start
```
Gå till http://localhost:3000. Registrera ett konto för att spara samlingen på servern
och spela vänmatcher (Vänmatch-knappen på väljarskärmen). Servern sparar allt i `data/db.json`.

## Filer

- `index.html`, `style.css` — sidan och utseendet.
- `game.js` — spellogik, rendering och all skärmhantering. Körs i webbläsaren.
- `shared.js` — robotdata och matchreglerna (lådoddsen, insatsmatch, vem som får möta vem).
  Delas mellan klienten och servern så att de aldrig kan komma i otakt.
- `backend.js` — sparar samlingen antingen lokalt i webbläsaren (gäst) eller mot servern
  (inloggad).
- `netplay.js` — synkroniserar en vänmatch mellan två spelare (lockstep: bara knapptryckningar
  skickas över nätet, båda sidor kör samma simulering).
- `server.js` — konton, sessioner, matchresultat och rum för vänmatcher (Node, inga externa
  beroenden utom `ws`).

## Miljövariabler (servern)

- `PORT` (standard 3000), `HOST` (standard 0.0.0.0)
- `DATA_DIR` — var databasfilen sparas (standard `./data`)
- `GAME_TZ` — tidszon för den dagliga lådan (standard `Europe/Stockholm`)
- `COOKIE_SECURE=1` — sätt om servern körs bakom https
