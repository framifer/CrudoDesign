# CrudoDesign

App di disegno e animazione **frame-by-frame**, pensata per dito e pennino attivo.
Funziona come **PWA offline**: dopo il primo caricamento si usa senza internet.

## Funzionalità

- ✏️ Pennelli: tondo, calligrafico, pennarello, matita, aerografo, **pittura ad olio**, **carboncino**
- 🧽 Gomma, 🪣 riempimento (secchiello), 💧 contagocce
- 🎨 Colori, campioni predefiniti e **tavolozza per mescolare**
- 🗂️ **Layer** (aggiungi, nascondi, elimina)
- 🎞️ **Animazione** frame-by-frame con **onion skin** (frame precedente/successivo in trasparenza)
- 🎬 Export **video** (WebM) dell'animazione e ⬇️ export **PNG** del frame
- 📷 **Camera di riferimento** semitrasparente per ricalcare dal vivo
- 💾 **Salvataggio progetti** in locale (IndexedDB) + export/import file `.crudo`
- 📱 **PWA installabile** e **offline**

## Come si usa in locale

Serve un semplice server statico (i moduli JS e il service worker non funzionano aprendo il file direttamente):

```bash
# con Python
python3 -m http.server 3000
# oppure
npx serve .
```

Poi apri `http://localhost:3000`.

## Pubblicazione su GitHub Pages (hosting gratuito HTTPS)

La PWA richiede **HTTPS**: GitHub Pages lo fornisce gratis.

1. Crea un repository su GitHub (es. `crudodesign`) e caricaci **tutti** i file di questa cartella:
   ```bash
   git init
   git add .
   git commit -m "CrudoDesign PWA"
   git branch -M main
   git remote add origin https://github.com/<TUO_UTENTE>/crudodesign.git
   git push -u origin main
   ```
2. Su GitHub: **Settings → Pages**.
3. In *Build and deployment* scegli **Deploy from a branch**, branch **main**, cartella **/(root)**, poi **Save**.
4. Dopo qualche minuto l'app sarà su:
   `https://<TUO_UTENTE>.github.io/crudodesign/`
5. Aprila sul telefono: dal menu del browser scegli **"Aggiungi a schermata Home"** / **"Installa app"**.
   Al primo caricamento vengono messi in cache tutti i file → **da lì funziona offline**.

## Creare un .apk con PWABuilder (opzionale)

1. Vai su [https://www.pwabuilder.com](https://www.pwabuilder.com).
2. Incolla l'URL della tua PWA (quello di GitHub Pages).
3. Verifica il punteggio (manifest + service worker devono essere OK).
4. Sezione **Android** → **Generate Package** → scarica `.apk`/`.aab`.
5. Installa l'`.apk` sul telefono (abilita "origini sconosciute") o pubblica sul Play Store con l'`.aab`.

## Aggiornare l'app dopo un deploy

Il service worker mette in cache i file. Quando modifichi qualcosa, **incrementa la versione della cache**
in `sw.js`:

```js
const CACHE = 'crudodesign-v2'; // era v1
```

Così i dispositivi scaricano la nuova versione al successivo avvio.

## Struttura del progetto

```
crudodesign/
├── index.html          # UI e registrazione service worker
├── manifest.json       # manifest PWA
├── sw.js               # service worker (cache offline)
├── styles.css
├── js/
│   ├── main.js         # logica principale (input, UI, animazione)
│   ├── doc.js          # modello documento: frame + layer
│   ├── brush.js        # motore dei pennelli
│   ├── fill.js         # secchiello (flood fill)
│   ├── color.js        # utility colore
│   └── storage.js      # salvataggio progetti (IndexedDB + .crudo)
├── icons/              # icone PWA (pixel art)
├── gen-icons.cjs       # (dev) rigenera le icone dalla SVG
├── package.json        # (dev) solo per lo strumento icone
└── .gitignore
```

> `gen-icons.cjs`, `package.json` e `node_modules/` servono **solo** per rigenerare le icone
> (`npm install && npm run icons`) e non sono necessari al funzionamento dell'app.

## Note tecniche

- Solo HTML/CSS/JavaScript (moduli ES), **nessuna dipendenza a runtime**.
- Camera e service worker funzionano solo su **HTTPS** o `localhost`.
- Testato su browser moderni (Chrome, Edge, Safari, Firefox).

## Licenza

MIT
