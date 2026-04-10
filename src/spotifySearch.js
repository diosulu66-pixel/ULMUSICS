const SpotifyWebApi = require('spotify-web-api-node');
const playdl = require('play-dl');

// ─────────────────────────────────────────────
//  Spotify client setup
// ─────────────────────────────────────────────

const spotify = new SpotifyWebApi({
  clientId:     process.env.SPOTIFY_CLIENT_ID,
  clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
});

let tokenExpiresAt = 0;

async function ensureSpotifyToken() {
  if (Date.now() < tokenExpiresAt - 60_000) return;
  try {
    const data = await spotify.clientCredentialsGrant();
    spotify.setAccessToken(data.body.access_token);
    tokenExpiresAt = Date.now() + data.body.expires_in * 1000;
    console.log('✅ Token de Spotify renovado');
  } catch (err) {
    console.error('❌ Error renovando token Spotify:', err.message);
    throw err;
  }
}

// ─────────────────────────────────────────────
//  Construir queries para SoundCloud
//  Varias variantes de más a menos específica
// ─────────────────────────────────────────────

function buildSoundCloudQueries(trackName, artists, albumName) {
  const mainArtist = artists[0];
  const allArtists = artists.join(' ');

  // Limpiar features del nombre para mejor match
  const cleanName = trackName
    .replace(/\s*\(feat\..*?\)/gi, '')
    .replace(/\s*\(with\..*?\)/gi, '')
    .replace(/\s*\(ft\..*?\)/gi, '')
    .trim();

  return [
    `${cleanName} ${mainArtist}`,
    `${trackName} ${mainArtist}`,
    `${cleanName} ${allArtists}`,
    albumName ? `${cleanName} ${mainArtist} ${albumName}` : null,
    `${trackName} ${allArtists}`,
  ].filter(Boolean);
}

// ─────────────────────────────────────────────
//  Elegir el mejor resultado por duración
//  Margen de ±15 segundos respecto a Spotify
// ─────────────────────────────────────────────

function pickBestResult(candidates, expectedDurationSec) {
  if (!candidates.length) return null;
  if (!expectedDurationSec) return candidates[0];

  const MARGIN_SEC = 15;

  const byDuration = candidates.filter((v) => {
    const dur = v.durationInSec || 0;
    return Math.abs(dur - expectedDurationSec) <= MARGIN_SEC;
  });

  if (byDuration.length > 0) {
    byDuration.sort((a, b) => {
      return Math.abs((a.durationInSec || 0) - expectedDurationSec)
           - Math.abs((b.durationInSec || 0) - expectedDurationSec);
    });
    console.log(`🎯 Match por duración: "${byDuration[0].name || byDuration[0].title}" (${byDuration[0].durationInSec}s vs ${expectedDurationSec}s)`);
    return byDuration[0];
  }

  console.log(`⚠️ Sin match de duración exacto, usando primer resultado`);
  return candidates[0];
}

// ─────────────────────────────────────────────
//  Buscar en SoundCloud
//  play-dl soporta SoundCloud nativamente sin cookies ni API key
// ─────────────────────────────────────────────

async function findSoundCloudAudio(trackName, artists, albumName, durationSec) {
  const queries = buildSoundCloudQueries(trackName, artists, albumName);
  console.log(`🎵 Buscando en SoundCloud: "${trackName}" — ${artists.join(', ')}`);

  for (const query of queries) {
    try {
      const results = await playdl.search(query, {
        source: { soundcloud: 'tracks' },
        limit: 5,
      });

      if (!results.length) continue;

      const best = pickBestResult(results, durationSec);
      if (best?.url) {
        console.log(`✅ SoundCloud encontró: "${best.name || best.title}" con query: "${query}"`);
        return best.url;
      }
    } catch (err) {
      console.log(`⚠️ SoundCloud falló para "${query}": ${err.message}`);
    }
  }

  throw new Error(`No se encontró en SoundCloud: "${trackName}" de ${artists.join(', ')}`);
}

// ─────────────────────────────────────────────
//  Main search function
// ─────────────────────────────────────────────

async function searchTrack(query) {
  console.log(`🔍 Buscando: ${query}`);

  try {
    if (query.includes('spotify.com/track'))    return await resolveSpotifyTrackUrl(query);
    if (query.includes('spotify.com/playlist')) return await resolveSpotifyPlaylist(query);
    if (query.includes('spotify.com/album'))    return await resolveSpotifyAlbum(query);

    // Links de YouTube — solo se aceptan como URL directa
    if (query.includes('youtube.com/') || query.includes('youtu.be/')) {
      return await resolveYouTubeUrl(query);
    }

    // Cualquier otra URL no soportada
    if (query.startsWith('http://') || query.startsWith('https://')) {
      throw new Error('Solo se aceptan links de Spotify o YouTube. Para buscar una canción escribe el nombre directamente.');
    }

    // Búsqueda por texto → Spotify → SoundCloud
    return await searchSpotify(query);
  } catch (err) {
    console.error('❌ Error en searchTrack:', err.message);
    throw err;
  }
}

// ─────────────────────────────────────────────
//  Búsqueda por texto: Spotify da los metadatos,
//  SoundCloud da el audio
// ─────────────────────────────────────────────

async function searchSpotify(query) {
  await ensureSpotifyToken();

  const res   = await spotify.searchTracks(query, { limit: 1 });
  const track = res.body.tracks?.items?.[0];

  if (!track) throw new Error(`No encontré "${query}" en Spotify.`);

  const artists     = track.artists.map((a) => a.name);
  const durationSec = Math.floor(track.duration_ms / 1000);

  console.log(`✅ Spotify: "${track.name}" — ${artists.join(', ')}`);

  const scUrl = await findSoundCloudAudio(track.name, artists, track.album.name, durationSec);

  return {
    title:      `${track.name} — ${artists.join(', ')}`,
    url:        scUrl,
    thumbnail:  track.album.images?.[0]?.url || null,
    duration:   durationSec,
    spotifyUrl: track.external_urls.spotify,
    album:      track.album.name,
    source:     'soundcloud',
  };
}

// ─────────────────────────────────────────────
//  Resolver link de track de Spotify
// ─────────────────────────────────────────────

async function resolveSpotifyTrackUrl(spotifyUrl) {
  await ensureSpotifyToken();

  const trackId = spotifyUrl.split('/track/')[1]?.split('?')[0];
  if (!trackId) throw new Error('URL de Spotify inválida.');

  const res     = await spotify.getTrack(trackId);
  const track   = res.body;
  const artists = track.artists.map((a) => a.name);
  const durationSec = Math.floor(track.duration_ms / 1000);

  console.log(`✅ Spotify track: "${track.name}" — ${artists.join(', ')}`);

  const scUrl = await findSoundCloudAudio(track.name, artists, track.album.name, durationSec);

  return {
    title:      `${track.name} — ${artists.join(', ')}`,
    url:        scUrl,
    thumbnail:  track.album.images?.[0]?.url || null,
    duration:   durationSec,
    spotifyUrl: track.external_urls.spotify,
    album:      track.album.name,
    source:     'soundcloud',
  };
}

// ─────────────────────────────────────────────
//  Resolver playlist de Spotify
// ─────────────────────────────────────────────

async function resolveSpotifyPlaylist(spotifyUrl) {
  await ensureSpotifyToken();

  const playlistId = spotifyUrl.split('/playlist/')[1]?.split('?')[0];
  if (!playlistId) throw new Error('URL de playlist de Spotify inválida.');

  const res   = await spotify.getPlaylist(playlistId);
  const items = res.body.tracks.items.filter((i) => i.track);

  console.log(`✅ Playlist: "${res.body.name}" — ${items.length} canciones`);

  const tracks = items.slice(0, 50).map((item) => {
    const t = item.track;
    return {
      title:               `${t.name} — ${t.artists.map((a) => a.name).join(', ')}`,
      url:                 null,
      spotifyTrackName:    t.name,
      spotifyArtists:      t.artists.map((a) => a.name),
      spotifyAlbum:        t.album.name,
      thumbnail:           t.album.images?.[0]?.url || null,
      duration:            Math.floor(t.duration_ms / 1000),
      spotifyUrl:          t.external_urls.spotify,
      album:               t.album.name,
      needsResolve:        true,
      source:              'soundcloud',
    };
  });

  return { isPlaylist: true, tracks, playlistName: res.body.name };
}

// ─────────────────────────────────────────────
//  Resolver álbum de Spotify
// ─────────────────────────────────────────────

async function resolveSpotifyAlbum(spotifyUrl) {
  await ensureSpotifyToken();

  const albumId = spotifyUrl.split('/album/')[1]?.split('?')[0];
  if (!albumId) throw new Error('URL de álbum de Spotify inválida.');

  const res   = await spotify.getAlbum(albumId);
  const album = res.body;

  console.log(`✅ Álbum: "${album.name}" — ${album.tracks.items.length} canciones`);

  const tracks = album.tracks.items.slice(0, 50).map((t) => ({
    title:               `${t.name} — ${t.artists.map((a) => a.name).join(', ')}`,
    url:                 null,
    spotifyTrackName:    t.name,
    spotifyArtists:      t.artists.map((a) => a.name),
    spotifyAlbum:        album.name,
    thumbnail:           album.images?.[0]?.url || null,
    duration:            Math.floor(t.duration_ms / 1000),
    spotifyUrl:          t.external_urls.spotify,
    album:               album.name,
    needsResolve:        true,
    source:              'soundcloud',
  }));

  return { isPlaylist: true, tracks, playlistName: `💿 ${album.name}` };
}

// ─────────────────────────────────────────────
//  Resolver URL de YouTube directa
//  Solo se usa cuando el usuario manda un link de YouTube explícitamente
// ─────────────────────────────────────────────

async function resolveYouTubeUrl(url) {
  console.log(`📹 Resolviendo URL de YouTube: ${url}`);

  const info = await playdl.video_info(url);
  if (!info?.video_details) throw new Error('No se pudo obtener información del video de YouTube.');

  console.log(`✅ YouTube: "${info.video_details.title}"`);

  return {
    title:      info.video_details.title,
    url:        info.video_details.url,
    thumbnail:  info.video_details.thumbnails?.[0]?.url || null,
    duration:   info.video_details.durationInSec,
    album:      null,
    spotifyUrl: null,
    source:     'youtube',
  };
}

// ─────────────────────────────────────────────
//  Resolver track lazy (de playlist/álbum) al momento de reproducir
// ─────────────────────────────────────────────

async function resolveTrackUrl(track) {
  if (!track.needsResolve) return track;

  console.log(`🔗 Resolviendo: ${track.title}`);

  const url = await findSoundCloudAudio(
    track.spotifyTrackName,
    track.spotifyArtists,
    track.spotifyAlbum,
    track.duration
  );

  return { ...track, url, needsResolve: false };
}

// ─────────────────────────────────────────────
//  Obtener stream de audio
//  play-dl maneja tanto SoundCloud como YouTube con la misma API
// ─────────────────────────────────────────────

async function getAudioStream(url) {
  console.log(`🎬 Obteniendo stream: ${url}`);

  const stream = await playdl.stream(url, {
    discordPlayerCompatibility: true,
  });

  if (!stream?.stream) throw new Error('No se pudo obtener el stream de audio.');

  console.log(`✅ Stream listo (${stream.type})`);
  return stream;
}

module.exports = { searchTrack, resolveTrackUrl, getAudioStream };
