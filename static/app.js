const LIKE_THRESHOLD = 0.80; // played ≥80% → liked

function authFetch(url, options = {}) {
  const token = localStorage.getItem('auth_token');
  if (token) {
    options = { ...options, headers: { 'Authorization': `Bearer ${token}`, ...options.headers } };
  }
  return fetch(url, options);
}

// ── Auth ─────────────────────────────────────────────────────────────────────

async function checkAuth() {
  const res = await authFetch('/auth/me');
  const { user_id } = await res.json();
  return user_id;
}

function showLoginPanel() {
  document.getElementById('login-panel').style.display = '';
  document.getElementById('player-panel').style.display = 'none';
}

function showPlayerPanel() {
  document.getElementById('login-panel').style.display = 'none';
  document.getElementById('player-panel').style.display = '';
}

async function handleSendLink() {
  const email = document.getElementById('login-email').value.trim();
  const msg   = document.getElementById('login-msg');
  const btn   = document.getElementById('btn-send-link');
  if (!email) return;
  btn.disabled = true;
  btn.textContent = 'Sending…';
  msg.textContent = '';
  try {
    const res = await fetch('/auth/send-link', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ email }),
    });
    const data = await res.json();
    if (data.ok) {
      document.getElementById('email-section').style.display = 'none';
      document.getElementById('code-section').style.display = '';
      msg.style.color   = '#1db954';
      msg.textContent   = 'Check your email for a 6-digit code.';
      setTimeout(() => document.getElementById('login-code').focus(), 50);
    } else {
      msg.style.color   = '#e05263';
      msg.textContent   = data.error || 'Something went wrong.';
      btn.textContent = 'Send login link';
      btn.disabled = false;
    }
  } catch {
    msg.style.color = '#e05263';
    msg.textContent = 'Network error. Try again.';
    btn.textContent = 'Send login link';
    btn.disabled = false;
  }
}

async function handleVerifyCode() {
  const code = document.getElementById('login-code').value.trim().replace(/\D/g, '');
  const msg  = document.getElementById('login-msg');
  const btn  = document.getElementById('btn-verify-code');
  if (code.length !== 6) return;
  btn.disabled = true;
  btn.textContent = 'Verifying…';
  msg.textContent = '';
  try {
    const res  = await fetch('/auth/verify-code', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ code }),
    });
    const data = await res.json();
    if (data.token) {
      localStorage.setItem('auth_token', data.token);
      showPlayerPanel();
    } else {
      msg.style.color = '#e05263';
      msg.textContent = data.error || 'Invalid code.';
      btn.textContent = 'Verify code';
      btn.disabled = false;
    }
  } catch {
    msg.style.color = '#e05263';
    msg.textContent = 'Network error. Try again.';
    btn.textContent = 'Verify code';
    btn.disabled = false;
  }
}

let player           = null;
let playerReady      = false;
let pendingVideoId   = null;
let ytApiReady       = false;
let currentSong      = null;
let feedbackSent     = false;
let superlikedSent   = false;
let progressTimer    = null;
let adPlaying        = false;
let songHistory      = [];
let historyIndex     = -1;
let skipReasonId       = null;
let skipReasonArtistId = null;
let skipReasonTimer    = null;
let silentAudio        = null;
let wakeLock           = null;
let nextSong           = null; // preloaded next song
let nextSongFetch      = null; // in-flight preload promise

// ── YouTube IFrame API ────────────────────────────────────────────────────────

window.onYouTubeIframeAPIReady = function () {
  ytApiReady = true;
};

function initPlayer(videoId) {
  playerReady = false;
  player = new YT.Player('yt-player', {
    height: '1', width: '1',
    videoId,
    playerVars: { autoplay: 1, playsinline: 1, controls: 0, rel: 0 },
    events: {
      onReady:       e => { playerReady = true; e.target.playVideo(); },
      onStateChange: handleStateChange,
      onError:       handleError,
    },
  });
}

function handleStateChange(e) {
  if (e.data === YT.PlayerState.PLAYING) {
    const playingId = player.getVideoData()?.video_id;
    if (playingId && currentSong && playingId !== currentSong.video_id) {
      // ad detected
      if (!adPlaying) {
        adPlaying = true;
        clearInterval(progressTimer);
        document.getElementById('btn-skip').disabled = true;
        document.getElementById('song-artist').textContent = 'Ad playing…';
      }
    } else if (adPlaying) {
      // ad finished, song starting
      adPlaying = false;
      document.getElementById('btn-skip').disabled = false;
      updateUI(currentSong);
      startProgress();
    } else if ('mediaSession' in navigator) {
      navigator.mediaSession.playbackState = 'playing';
    }
  }

  if (e.data === YT.PlayerState.ENDED) {
    if (!adPlaying) {
      if (!feedbackSent) sendFeedback(1.0, true);
      if (!superlikedSent) toast('Liked ♥', '#1db954');
      hideSkipReason();
      loadNextSong();
    }
  }
}

function handleError(e) {
  // video unembeddable or not found — skip silently
  console.warn('YT error', e.data);
  loadNextSong();
}

// ── MediaSession (lock screen controls + background audio) ───────────────────

function setupMediaSession() {
  if (!('mediaSession' in navigator)) return;
  navigator.mediaSession.setActionHandler('play', () => {
    player?.playVideo();
    navigator.mediaSession.playbackState = 'playing';
    document.getElementById('btn-pause').textContent = 'Pause';
  });
  navigator.mediaSession.setActionHandler('pause', () => {
    player?.pauseVideo();
    navigator.mediaSession.playbackState = 'paused';
    document.getElementById('btn-pause').textContent = 'Resume';
  });
  navigator.mediaSession.setActionHandler('nexttrack', skipSong);
  navigator.mediaSession.setActionHandler('previoustrack', previousSong);
}

function updateMediaSession(song) {
  if (!('mediaSession' in navigator)) return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title:   song.title,
    artist:  song.artist_name || '',
    artwork: song.thumbnail ? [{ src: song.thumbnail }] : [],
  });
  navigator.mediaSession.playbackState = 'playing';
}

// ── Background playback keepalive ─────────────────────────────────────────────

// Mobile browsers suspend pages when backgrounded. A looping silent <audio> element
// maintains an audio session so iOS/Android keep the YouTube iframe alive. Wake Lock
// prevents the screen from auto-locking mid-song.

function startAudioSession() {
  if (!silentAudio) {
    silentAudio      = new Audio('/static/silence.wav');
    silentAudio.loop = true;
    silentAudio.volume = 0.01;
  }
  silentAudio.play().catch(() => {});
}

async function acquireWakeLock() {
  if (!('wakeLock' in navigator) || wakeLock) return;
  try { wakeLock = await navigator.wakeLock.request('screen'); } catch {}
}

// iOS suspends cross-origin iframes (YouTube embed) when backgrounded — we can't
// prevent the stop, but we track whether we were playing and resume immediately on return.
let wasPlayingBeforeHide = false;

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    wasPlayingBeforeHide = player?.getPlayerState?.() === YT.PlayerState.PLAYING;
  } else {
    acquireWakeLock();
    if (wasPlayingBeforeHide && currentSong) {
      // Small delay lets the player settle after iOS thaws the frozen page
      setTimeout(() => player?.playVideo(), 200);
    }
  }
});

// ── Song loading ──────────────────────────────────────────────────────────────

function preloadNextSong() {
  if (historyIndex < songHistory.length - 1) return; // already have songs queued
  if (nextSong || nextSongFetch) return;
  nextSongFetch = authFetch('/api/next')
    .then(r => r.json())
    .then(song => { if (!song.error) nextSong = song; })
    .catch(() => {})
    .finally(() => { nextSongFetch = null; });
}

function playSong(song) {
  currentSong     = song;
  localStorage.setItem('lastSong', JSON.stringify(song));
  feedbackSent    = false;
  superlikedSent  = false;
  adPlaying       = false;
  const superBtn      = document.getElementById('btn-superlike');
  const wasSuperliked = !!song.superliked;
  superBtn.classList.toggle('superliked', wasSuperliked);
  superBtn.disabled = wasSuperliked;

  updateUI(song);
  updateMediaSession(song);
  updateNavButtons();
  startAudioSession();
  acquireWakeLock();

  if (!player) {
    const ready = () => ytApiReady
      ? initPlayer(song.video_id)
      : setTimeout(ready, 100);
    ready();
  } else if (playerReady) {
    player.loadVideoById(song.video_id);
  } else {
    pendingVideoId = song.video_id;
  }

  startProgress();
  preloadNextSong();
}

async function loadNextSong() {
  // If we're not at the end of history, step forward without an API call
  if (historyIndex < songHistory.length - 1) {
    historyIndex++;
    playSong(songHistory[historyIndex]);
    refreshStats();
    drawTrend();
    return;
  }

  // Use preloaded song instantly if ready
  if (nextSong) {
    const song = nextSong;
    nextSong = null;
    songHistory.push(song);
    historyIndex = songHistory.length - 1;
    playSong(song);
    refreshStats();
    drawTrend();
    return;
  }

  // Wait for in-flight preload (much faster than a fresh fetch), else fetch fresh
  setLoading(true);
  try {
    if (nextSongFetch) await nextSongFetch;
    let song = nextSong;
    nextSong = null;
    if (!song) {
      const res = await authFetch('/api/next');
      song = await res.json();
    }
    if (song.error) throw new Error(song.error);

    songHistory.push(song);
    historyIndex = songHistory.length - 1;

    playSong(song);
    refreshStats();
    drawTrend();
  } catch (err) {
    console.error('loadNextSong failed:', err);
    setStatus('Error loading song — retrying…');
    setTimeout(loadNextSong, 3000);
  } finally {
    setLoading(false);
  }
}

function previousSong() {
  if (historyIndex <= 0 || !currentSong) return;
  const current  = player?.getCurrentTime?.() ?? 0;
  const duration = player?.getDuration?.()    ?? 1;
  const ratio    = duration > 0 ? current / duration : 0;
  const liked    = ratio >= LIKE_THRESHOLD;
  sendFeedback(ratio, liked);
  historyIndex--;
  playSong(songHistory[historyIndex]);
  refreshStats();
  drawTrend();
}

// ── Feedback ──────────────────────────────────────────────────────────────────

function sendFeedback(completion, liked) {
  if (!currentSong || feedbackSent) return;
  feedbackSent = true;
  localStorage.removeItem('lastSong');
  authFetch('/api/feedback', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      video_id:    currentSong.video_id,
      title:       currentSong.title,
      artist_name: currentSong.artist_name,
      artist_id:   currentSong.artist_id,
      completion,
      liked,
    }),
  });
}

function skipSong() {
  if (!currentSong) return;
  const current  = player?.getCurrentTime?.() ?? 0;
  const duration = player?.getDuration?.()    ?? 1;
  const ratio    = duration > 0 ? current / duration : 0;
  const liked    = ratio >= LIKE_THRESHOLD;
  sendFeedback(ratio, liked);
  toast(liked ? 'Liked ♥' : 'Skipped', liked ? '#1db954' : '#888');
  const skippedId       = currentSong.video_id;
  const skippedArtistId = currentSong.artist_id;
  loadNextSong();
  if (!liked) showSkipReason(skippedId, skippedArtistId);
}

function togglePause() {
  if (!player) return;
  const btn = document.getElementById('btn-pause');
  if (player.getPlayerState() === YT.PlayerState.PLAYING) {
    player.pauseVideo();
    btn.textContent = 'Resume';
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
  } else if (player.getPlayerState() === YT.PlayerState.PAUSED) {
    player.playVideo();
    btn.textContent = 'Pause';
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
  }
}

// ── Progress bar ──────────────────────────────────────────────────────────────

document.querySelector('.progress-bar').addEventListener('click', e => {
  if (!player?.seekTo || !player.getDuration?.()) return;
  const rect = e.currentTarget.getBoundingClientRect();
  const frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  player.seekTo(frac * player.getDuration(), true);
});

function startProgress() {
  clearInterval(progressTimer);
  document.getElementById('progress-fill').style.width = '0%';
  document.getElementById('time-current').textContent  = '0:00';
  document.getElementById('time-total').textContent    = '0:00';

  progressTimer = setInterval(() => {
    if (!player?.getCurrentTime) return;
    const cur = player.getCurrentTime();
    const dur = player.getDuration();
    if (dur > 0) {
      document.getElementById('progress-fill').style.width = (cur / dur * 100) + '%';
      document.getElementById('time-current').textContent  = fmt(cur);
      document.getElementById('time-total').textContent    = fmt(dur);
    }
  }, 500);
}

function fmt(s) {
  const m = Math.floor(s / 60), sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, '0')}`;
}

// ── UI helpers ────────────────────────────────────────────────────────────────

function updateUI(song) {
  document.getElementById('song-title').textContent  = song.title;
  document.getElementById('song-artist').textContent = song.artist_name || '—';

  const reasonEl = document.getElementById('song-reason');
  reasonEl.textContent = song.reason || '';
  if (song.reason) {
    requestAnimationFrame(() => {
      const dist      = reasonEl.scrollWidth - reasonEl.clientWidth;
      if (dist > 0) {
        const textWidth = reasonEl.scrollWidth;
        reasonEl.textContent = '';
        const span = document.createElement('span');
        span.className = 'marquee-inner';
        span.textContent = song.reason + '   ·   ' + song.reason;
        reasonEl.appendChild(span);
        const period = span.offsetWidth - textWidth;
        span.style.setProperty('--scroll-dist', `-${period}px`);
      }
    });
  }

  const img  = document.getElementById('album-art');
  const ph   = document.getElementById('art-placeholder');
  if (song.thumbnail) {
    img.src = song.thumbnail;
    img.classList.remove('hidden');
    ph.style.display = 'none';
  } else {
    img.classList.add('hidden');
    ph.style.display = 'flex';
  }
}

function sendSuperlike() {
  if (!currentSong || feedbackSent) return;
  feedbackSent   = true;
  superlikedSent = true;
  authFetch('/api/superlike', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      video_id:    currentSong.video_id,
      title:       currentSong.title,
      artist_name: currentSong.artist_name,
      artist_id:   currentSong.artist_id,
      completion:  1.0,
    }),
  });
  const btn = document.getElementById('btn-superlike');
  btn.classList.add('superliked');
  btn.disabled = true;
  toast('Superliked ♥', '#1db954');
}

function setLoading(on) {
  document.getElementById('btn-skip').disabled      = on;
  document.getElementById('btn-pause').disabled     = on;
  document.getElementById('btn-prev').disabled      = on || historyIndex <= 0;
  document.getElementById('btn-superlike').disabled = on;
  if (on) {
    document.getElementById('song-artist').textContent = 'Loading…';
    document.getElementById('song-reason').textContent = '';
  }
}

function updateNavButtons() {
  document.getElementById('btn-prev').disabled = historyIndex <= 0;
}

function setStatus(msg) {
  document.getElementById('song-title').textContent  = msg;
  document.getElementById('song-artist').textContent = '';
}

let trendBuckets = [];
let skipDetailOpen = false;

async function drawTrend() {
  const res = await authFetch('/api/trend');
  const { buckets } = await res.json();
  const wrap = document.getElementById('trend-wrap');
  if (buckets.length < 2) { wrap.style.display = 'none'; return; }

  trendBuckets = buckets;
  wrap.style.display = '';
  const W = 284, H = 44, pad = 4;
  const svg = document.getElementById('trend-svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('width', W);
  svg.setAttribute('height', H);

  const xs = buckets.map((_, i) => pad + i * (W - 2 * pad) / (buckets.length - 1));
  const ys = buckets.map(v => H - pad - v * (H - 2 * pad));
  const pts = xs.map((x, i) => `${x},${ys[i]}`).join(' ');
  const trending = buckets.at(-1) >= buckets.at(-2);
  const color = trending ? '#1db954' : '#e05263';

  renderTrendLabel(trending, color);

  svg.innerHTML = `
    <polyline points="${pts}" fill="none" stroke="${color}" stroke-width="2"
      stroke-linejoin="round" stroke-linecap="round" opacity="0.85"/>
    <circle cx="${xs.at(-1)}" cy="${ys.at(-1)}" r="3" fill="${color}"/>
  `;

  if (skipDetailOpen) drawSkipDetail();
}

function renderTrendLabel(trending, color) {
  const label = document.getElementById('trend-label');
  const arrow = skipDetailOpen ? '▾' : '▸';
  label.style.color = color;
  label.textContent = (trending ? '↑ Recommender improving' : '↓ Recommender needs more data') + `  ${arrow}`;
}

function drawSkipDetail() {
  const buckets = trendBuckets;
  if (buckets.length < 2) return;

  const W = 284, H = 90;
  const padL = 26, padR = 4, padT = 6, padB = 16;
  const chartW = W - padL - padR;
  const chartH = H - padT - padB;

  const svg = document.getElementById('skip-svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('width', W);
  svg.setAttribute('height', H);

  const skipRates = buckets.map(v => 1 - v);
  const slot = chartW / buckets.length;
  const barW = Math.max(4, slot - 3);

  const gridLines = [0, 0.5, 1].map(v => {
    const y = padT + chartH * (1 - v);
    return `
      <line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" stroke="#2a2a2a" stroke-width="1"/>
      <text x="${padL - 4}" y="${y + 3}" text-anchor="end" font-size="8" fill="#555">${Math.round(v * 100)}%</text>
    `;
  }).join('');

  const bars = skipRates.map((rate, i) => {
    const barH = Math.max(1, rate * chartH);
    const x = padL + i * slot + (slot - barW) / 2;
    const y = padT + chartH - barH;
    const color = rate > 0.5 ? '#e05263' : '#888';
    return `<rect x="${x}" y="${y}" width="${barW}" height="${barH}" fill="${color}" opacity="0.7" rx="1"/>`;
  }).join('');

  const xLabel = (i) => {
    const n = (i + 1) * 5;
    return `<text x="${padL + i * slot + slot / 2}" y="${H - 2}" text-anchor="middle" font-size="8" fill="#444">
      ${n}
    </text>`;
  };
  const step = buckets.length <= 6 ? 1 : Math.ceil(buckets.length / 6);
  const xLabels = buckets.map((_, i) => (i % step === 0 ? xLabel(i) : '')).join('');

  svg.innerHTML = gridLines + bars + xLabels;
}

document.addEventListener('DOMContentLoaded', async () => {
  setupMediaSession();

  const userId = await checkAuth();
  if (userId) {
    showPlayerPanel();
    const savedRaw = localStorage.getItem('lastSong');
    if (savedRaw) {
      try {
        const savedSong = JSON.parse(savedRaw);
        updateUI(savedSong);
        document.getElementById('btn-start').textContent = 'Resume';
      } catch {
        localStorage.removeItem('lastSong');
      }
    }
  } else {
    showLoginPanel();
  }

  document.getElementById('btn-send-link').addEventListener('click', handleSendLink);
  document.getElementById('login-email').addEventListener('keydown', e => {
    if (e.key === 'Enter') handleSendLink();
  });
  document.getElementById('btn-verify-code').addEventListener('click', handleVerifyCode);
  document.getElementById('login-code').addEventListener('keydown', e => {
    if (e.key === 'Enter') handleVerifyCode();
  });

  document.getElementById('trend-label').addEventListener('click', () => {
    skipDetailOpen = !skipDetailOpen;
    const detail = document.getElementById('skip-detail');
    if (skipDetailOpen) {
      detail.style.display = '';
      drawSkipDetail();
    } else {
      detail.style.display = 'none';
    }
    const trending = trendBuckets.length >= 2 && trendBuckets.at(-1) >= trendBuckets.at(-2);
    const color = trending ? '#1db954' : '#e05263';
    renderTrendLabel(trending, color);
  });
});

async function refreshStats() {
  const res  = await authFetch('/api/stats');
  const data = await res.json();
  const el   = document.getElementById('stats');
  if (data.total === 0) { el.textContent = ''; return; }
  el.innerHTML =
    `<span>${data.liked} liked</span> · <span>${data.skipped} skipped</span>`;
}

let toastTimer = null;
function toast(msg, color = '#fff') {
  const el = document.getElementById('toast');
  el.textContent  = msg;
  el.style.color  = color;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 900);
}

// ── Skip reason ───────────────────────────────────────────────────────────────

const GENRE_CHIPS = [
  { label: 'Pop',        key: 'pop' },
  { label: 'Rock',       key: 'rock' },
  { label: 'Country',    key: 'country' },
  { label: 'R&B',        key: 'rnb' },
  { label: 'Hip-hop',    key: 'hiphop' },
  { label: 'Electronic', key: 'electronic' },
  { label: 'Jazz',       key: 'jazz' },
  { label: 'Folk',       key: 'folk' },
  { label: 'Latin',      key: 'latin' },
  { label: 'Reggae',     key: 'reggae' },
];

const GENRE_SUBSTYLES = {
  pop:        { label: 'What style of Pop?',        chips: [{ label: '80s Pop',      seed: 'pop_80s' }, { label: '90s Pop',   seed: 'pop_90s' }, { label: '2000s Pop',  seed: 'pop_2000s' }, { label: 'Indie Pop',    seed: 'pop_indie' }] },
  rock:       { label: 'What style of Rock?',       chips: [{ label: 'Classic Rock', seed: 'rock_classic' }, { label: '80s Rock',  seed: 'rock_80s' }, { label: '90s Alt',    seed: 'rock_alternative' }, { label: 'Hard Rock',    seed: 'rock_hard' }, { label: 'Indie Rock', seed: 'rock_indie' }] },
  country:    { label: 'What style of Country?',    chips: [{ label: 'Classic',      seed: 'country_classic' }, { label: '90s',    seed: 'country_90s' }, { label: 'Country Pop', seed: 'country_pop' }, { label: 'New Country',  seed: 'country_new' }, { label: 'Bluegrass', seed: 'country_bluegrass' }] },
  rnb:        { label: 'What style of R&B?',        chips: [{ label: 'Motown',       seed: 'rnb_motown' }, { label: '70s Soul',  seed: 'rnb_soul' }, { label: '90s R&B',    seed: 'rnb_90s' }, { label: '2000s R&B',    seed: 'rnb_2000s' }] },
  hiphop:     { label: 'What style of Hip-hop?',    chips: [{ label: '90s',          seed: 'hiphop_90s' }, { label: '2000s',     seed: 'hiphop_2000s' }, { label: 'Trap',      seed: 'hiphop_trap' }, { label: 'Old School',   seed: 'hiphop_oldschool' }] },
  electronic: { label: 'What style of Electronic?', chips: [{ label: '90s Dance',    seed: 'electronic_90s' }, { label: 'Euro Dance', seed: 'electronic_euro' }, { label: 'EDM',    seed: 'electronic_edm' }, { label: 'House',        seed: 'electronic_house' }, { label: 'Synthwave', seed: 'electronic_synth' }] },
  jazz:       { label: 'What style of Jazz?',       chips: [{ label: 'Standards',    seed: 'jazz_standards' }, { label: 'Smooth',  seed: 'jazz_smooth' }, { label: 'Bebop',     seed: 'jazz_bebop' }, { label: 'Swing',        seed: 'jazz_swing' }] },
  folk:       { label: 'What style of Folk?',       chips: [{ label: 'Folk',         seed: 'folk_classic' }, { label: 'Americana', seed: 'folk_americana' }, { label: 'Singer-Songwriter', seed: 'folk_singersong' }] },
  latin:      { label: 'What style of Latin?',      chips: [{ label: 'Latin Pop',    seed: 'latin_pop' }, { label: 'Reggaeton', seed: 'latin_reggaeton' }, { label: 'Salsa',    seed: 'latin_salsa' }, { label: 'Bossa Nova',   seed: 'latin_bossa' }] },
  reggae:     { label: 'What style of Reggae?',     chips: [{ label: 'Reggae',       seed: 'reggae_classic' }, { label: 'Ska',   seed: 'reggae_ska' }, { label: 'Dancehall',  seed: 'reggae_dancehall' }] },
};

let pendingPrimaryReason = null;
let pendingGenreKey       = null;

function showSkipReason(videoId, artistId) {
  skipReasonId         = videoId;
  skipReasonArtistId   = artistId || null;
  pendingPrimaryReason = null;
  pendingGenreKey      = null;
  clearTimeout(skipReasonTimer);
  document.querySelectorAll('.chip').forEach(c => c.classList.remove('selected'));
  document.getElementById('skip-reason-secondary').style.display = 'none';
  document.getElementById('skip-reason-panel').style.display = '';
}

function hideSkipReason() {
  clearTimeout(skipReasonTimer);
  document.getElementById('skip-reason-panel').style.display = 'none';
  document.getElementById('skip-reason-secondary').style.display = 'none';
  skipReasonId         = null;
  skipReasonArtistId   = null;
  pendingPrimaryReason = null;
  pendingGenreKey      = null;
}

function sendSkipReason(reason) {
  if (!skipReasonId) return;
  authFetch('/api/skip-reason', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ video_id: skipReasonId, reason }),
  });
  hideSkipReason();
}

function showSecondary(primaryReason) {
  pendingPrimaryReason = primaryReason;
  pendingGenreKey      = null;
  if (primaryReason === 'wrong_genre') {
    renderSecondaryChips('What genre?', GENRE_CHIPS, ({ key }) => showTertiary(key));
  } else if (primaryReason === 'not_mood') {
    renderSecondaryChips('More or less energy?', [
      { label: 'More energy', key: 'more_energy' },
      { label: 'Less energy', key: 'less_energy' },
    ], ({ key }) => selectSeed(key));
  }
  document.getElementById('skip-reason-secondary').style.display = '';
}

function showTertiary(genreKey) {
  pendingGenreKey = genreKey;
  const config = GENRE_SUBSTYLES[genreKey];
  if (!config) return;
  renderSecondaryChips(config.label, config.chips, ({ seed }) => selectSeed(seed));
}

function renderSecondaryChips(label, chips, onClick) {
  document.getElementById('skip-reason-secondary-label').textContent = label;
  const container = document.getElementById('skip-reason-secondary-chips');
  container.innerHTML = '';
  chips.forEach(chip => {
    const btn = document.createElement('button');
    btn.className   = 'chip';
    btn.textContent = chip.label;
    btn.addEventListener('click', () => onClick(chip));
    container.appendChild(btn);
  });
}

function selectSeed(seed) {
  const parts = [pendingPrimaryReason, pendingGenreKey, seed].filter(Boolean);
  sendSkipReason(parts.join(':'));
  sendFeedback(0, false);
  loadNextSongWith({ seed, requested: '1' });
}

function selectArtist(artistName) {
  sendSkipReason(`not_artist:${artistName}`);
  sendFeedback(0, false);
  loadNextSongWith({ artist: artistName, requested: '1' });
}

async function loadNextSongWith(params) {
  setLoading(true);
  try {
    const url  = '/api/next?' + new URLSearchParams(params);
    const res  = await authFetch(url);
    const song = await res.json();
    if (song.error) throw new Error(song.error);
    songHistory.push(song);
    historyIndex = songHistory.length - 1;
    playSong(song);
    refreshStats();
    drawTrend();
  } catch (err) {
    console.error('loadNextSongWith failed:', err);
  } finally {
    setLoading(false);
  }
}

async function showSimilarArtists() {
  pendingPrimaryReason = 'not_artist';
  document.getElementById('skip-reason-secondary-label').textContent = 'Similar artists:';
  const container = document.getElementById('skip-reason-secondary-chips');
  container.innerHTML = '<span class="chip-loading">Loading…</span>';
  document.getElementById('skip-reason-secondary').style.display = '';
  try {
    const params = new URLSearchParams({ video_id: skipReasonId });
    if (skipReasonArtistId) params.set('exclude_artist', skipReasonArtistId);
    const { artists } = await authFetch(`/api/similar-artists?${params}`).then(r => r.json());
    if (!artists.length) {
      container.innerHTML = '';
      return;
    }
    renderSecondaryChips(
      'Similar artists:',
      artists.map(a => ({ label: a.name, key: a.name })),
      ({ key }) => selectArtist(key)
    );
  } catch {
    container.innerHTML = '';
  }
}

document.querySelectorAll('.chip[data-reason]').forEach(btn => {
  btn.addEventListener('click', () => {
    btn.classList.add('selected');
    const reason = btn.dataset.reason;
    if (reason === 'wrong_genre' || reason === 'not_mood') {
      showSecondary(reason);
    } else if (reason === 'not_artist') {
      showSimilarArtists();
    } else {
      sendSkipReason(reason);
    }
  });
});

// ── Startup ───────────────────────────────────────────────────────────────────

// Pre-initialize the YT player with no video so the iframe is created while the
// user gesture is still active. iOS ties autoplay permission to the gesture that
// created the player element — doing it after an async fetch loses that context.
function preinitPlayer() {
  if (!ytApiReady || player) return;
  player = new YT.Player('yt-player', {
    height: '1', width: '1',
    playerVars: { playsinline: 1, controls: 0, rel: 0 },
    events: {
      onReady: () => {
        playerReady = true;
        if (pendingVideoId) { player.loadVideoById(pendingVideoId); pendingVideoId = null; }
      },
      onStateChange: handleStateChange,
      onError:       handleError,
    },
  });
}

document.getElementById('btn-start').addEventListener('click', () => {
  const savedRaw = localStorage.getItem('lastSong');
  document.getElementById('btn-start').style.display     = 'none';
  document.getElementById('btn-prev').style.display      = '';
  document.getElementById('btn-pause').style.display     = '';
  document.getElementById('btn-superlike').style.display = '';
  document.getElementById('btn-skip').style.display      = '';
  startAudioSession(); // must happen within user gesture to unlock iOS audio session
  preinitPlayer();     // must happen within user gesture to unlock iOS autoplay
  let savedSong = null;
  if (savedRaw) { try { savedSong = JSON.parse(savedRaw); } catch {} }
  if (savedSong) {
    playSong(savedSong);
  } else {
    loadNextSong();
  }
});

document.getElementById('btn-prev').addEventListener('click', previousSong);
document.getElementById('btn-skip').addEventListener('click', skipSong);
document.getElementById('btn-pause').addEventListener('click', togglePause);
document.getElementById('btn-superlike').addEventListener('click', sendSuperlike);

document.addEventListener('keydown', (e) => {
  if (!currentSong) return;
  if (e.key === 'ArrowRight') { e.preventDefault(); skipSong(); }
  if (e.key === 'ArrowLeft')  { e.preventDefault(); previousSong(); }
  if (e.key === ' ')          { e.preventDefault(); togglePause(); }
});

// Inject YouTube IFrame API script
const ytScript = document.createElement('script');
ytScript.src   = 'https://www.youtube.com/iframe_api';
document.head.appendChild(ytScript);

refreshStats();
