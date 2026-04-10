# 🎵 Discord Music Bot v2

Bot con **búsqueda Spotify**, audio desde **SoundCloud**, panel interactivo, grabación en MP3 y auto-join.

---

## 📋 Comandos

| Comando | Descripción |
|---|---|
| `-play <nombre o artista>` | Busca en Spotify y reproduce desde SoundCloud |
| `-play <link spotify.com/track/...>` | Reproduce un track de Spotify |
| `-play <link spotify.com/playlist/...>` | Añade una playlist de Spotify |
| `-play <link spotify.com/album/...>` | Añade un álbum de Spotify |
| `-play <link youtube.com>` | Reproduce URL de YouTube directamente |
| `-pause` | Pausa |
| `-resume` | Reanuda |
| `-skip` | Salta canción |
| `-stop` | Detiene y desconecta |
| `-list` / `-queue` | Ver cola |
| `-mov <nombre o ID>` | Mueve el bot a otro canal |
| `-help` | Ayuda |

---

## 🚀 Setup en 3 pasos

### Paso 1 — Token de Discord
1. [discord.com/developers/applications](https://discord.com/developers/applications)
2. New Application → Bot → copia el Token

### Paso 2 — Credenciales de Spotify (GRATIS)
1. [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard)
2. **Create App** → nombre cualquiera → Redirect URI: `http://localhost`
3. Settings → copia **Client ID** y **Client Secret**

### Paso 3 — Configura y ejecuta
```bash
cp .env.example .env
# Llena DISCORD_TOKEN, SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET
npm install
npm start
```

---

## 🎵 Cómo funciona la búsqueda

1. **Spotify** — obtiene los metadatos exactos: nombre oficial, artista, álbum, duración, portada
2. **SoundCloud** — busca el audio usando esos datos y verifica la duración (±15s) para asegurar la versión correcta
3. **YouTube** — solo se usa si el usuario manda un link de YouTube directamente

No se necesitan cookies ni API keys adicionales para SoundCloud.

---

## 🚂 Railway — Deploy

1. Sube el código a GitHub
2. Railway → New Project → Deploy from GitHub
3. **Variables**: `DISCORD_TOKEN`, `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`
4. Opcional — para grabaciones permanentes: `RECORDINGS_DIR=/data/recordings`
5. Opcional — para grabaciones permanentes: **Settings → Volumes** → Add Volume → Mount Path: `/data`

---

## 📁 Grabaciones

Cada vez que alguien habla en el canal de voz, el bot graba y convierte automáticamente a **MP3**:

```
recordings/
  2025-01-15T10-30-00_GUILD_ID/
    session_info.json
    USERID_2025-01-15T10-30-00.mp3
    USERID_2025-01-15T10-30-05.mp3
```

Sin Volume en Railway, las grabaciones se pierden al reiniciar. Con Volume, son permanentes.

---

## 🤖 Comportamiento automático

- El bot se une automáticamente al canal de voz cuando un usuario entra
- Si el canal queda vacío, el bot espera 10 segundos y se desconecta
- Usa `-mov` para moverlo a otro canal manualmente
