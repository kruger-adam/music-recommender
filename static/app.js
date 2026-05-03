const LIKE_THRESHOLD = 0.80; // played ≥80% → liked

function getUserId() {
  let id = localStorage.getItem('user_id');
  if (!id) { id = crypto.randomUUID(); localStorage.setItem('user_id', id); }
  return id;
}

let player          = null;
let ytApiReady      = false;
let currentSong     = null;
let feedbackSent    = false;
let superlikedSent  = false;
let progressTimer   = null;
let adPlaying       = false;
let songHistory     = [];
let historyIndex    = -1;

// ── YouTube IFrame API ────────────────────────────────────────────────────────

window.onYouTubeIframeAPIReady = function () {
  ytApiReady = true;
};

function initPlayer(videoId) {
  player = new YT.Player('yt-player', {
    height: '1', width: '1',
    videoId,
    playerVars: { autoplay: 1, playsinline: 1, controls: 0, rel: 0 },
    events: {
      onReady:       e => e.target.playVideo(),
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
    }
  }

  if (e.data === YT.PlayerState.ENDED) {
    if (!adPlaying) {
      if (!feedbackSent) sendFeedback(1.0, true);
      if (!superlikedSent) toast('Liked ♥', '#1db954');
      loadNextSong();
    }
  }
}

function handleError(e) {
  // video unembeddable or not found — skip silently
  console.warn('YT error', e.data);
  loadNextSong();
}

// ── Song loading ──────────────────────────────────────────────────────────────

function playSong(song) {
  currentSong     = song;
  feedbackSent    = false;
  superlikedSent  = false;
  adPlaying       = false;
  const superBtn = document.getElementById('btn-superlike');
  superBtn.classList.remove('superliked');
  superBtn.disabled = false;

  updateUI(song);
  updateNavButtons();

  if (!player) {
    const ready = () => ytApiReady
      ? initPlayer(song.video_id)
      : setTimeout(ready, 100);
    ready();
  } else {
    player.loadVideoById(song.video_id);
  }

  startProgress();
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

  setLoading(true);
  try {
    const res  = await fetch('/api/next', { headers: { 'X-User-ID': getUserId() } });
    const song = await res.json();
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
  fetch('/api/feedback', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'X-User-ID': getUserId() },
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
  loadNextSong();
}

function togglePause() {
  if (!player) return;
  const btn = document.getElementById('btn-pause');
  if (player.getPlayerState() === YT.PlayerState.PLAYING) {
    player.pauseVideo();
    btn.textContent = 'Resume';
  } else if (player.getPlayerState() === YT.PlayerState.PAUSED) {
    player.playVideo();
    btn.textContent = 'Pause';
  }
}

// ── Progress bar ──────────────────────────────────────────────────────────────

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
  fetch('/api/superlike', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'X-User-ID': getUserId() },
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
  toast('Superliked ♥♥', '#1db954');
}

function setLoading(on) {
  document.getElementById('btn-skip').disabled      = on;
  document.getElementById('btn-pause').disabled     = on;
  document.getElementById('btn-prev').disabled      = on || historyIndex <= 0;
  document.getElementById('btn-superlike').disabled = on;
  if (on) document.getElementById('song-artist').textContent = 'Loading…';
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
  const res = await fetch('/api/trend', { headers: { 'X-User-ID': getUserId() } });
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

document.addEventListener('DOMContentLoaded', () => {
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
  const res  = await fetch('/api/stats', { headers: { 'X-User-ID': getUserId() } });
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

// ── Startup ───────────────────────────────────────────────────────────────────

document.getElementById('btn-start').addEventListener('click', () => {
  document.getElementById('btn-start').style.display     = 'none';
  document.getElementById('btn-prev').style.display      = '';
  document.getElementById('btn-pause').style.display     = '';
  document.getElementById('btn-superlike').style.display = '';
  document.getElementById('btn-skip').style.display      = '';
  loadNextSong();
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
