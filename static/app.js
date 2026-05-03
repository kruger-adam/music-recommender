const LIKE_THRESHOLD = 0.80; // played ≥80% → liked

let player        = null;
let ytApiReady    = false;
let currentSong   = null;
let feedbackSent  = false;
let progressTimer = null;
let adPlaying     = false;

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
      toast('Liked ♥', '#1db954');
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

async function loadNextSong() {
  setLoading(true);
  try {
    const res  = await fetch('/api/next');
    const song = await res.json();
    if (song.error) throw new Error(song.error);

    currentSong  = song;
    feedbackSent = false;
    adPlaying    = false;

    updateUI(song);

    if (!player) {
      // First song: wait for YT API if needed
      const ready = () => ytApiReady
        ? initPlayer(song.video_id)
        : setTimeout(ready, 100);
      ready();
    } else {
      player.loadVideoById(song.video_id);
    }

    startProgress();
    refreshStats();
  } catch (err) {
    console.error('loadNextSong failed:', err);
    setStatus('Error loading song — retrying…');
    setTimeout(loadNextSong, 3000);
  } finally {
    setLoading(false);
  }
}

// ── Feedback ──────────────────────────────────────────────────────────────────

function sendFeedback(completion, liked) {
  if (!currentSong || feedbackSent) return;
  feedbackSent = true;
  fetch('/api/feedback', {
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
  loadNextSong();
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

function setLoading(on) {
  document.getElementById('btn-skip').disabled = on;
  if (on) document.getElementById('song-artist').textContent = 'Loading…';
}

function setStatus(msg) {
  document.getElementById('song-title').textContent  = msg;
  document.getElementById('song-artist').textContent = '';
}

async function refreshStats() {
  const res  = await fetch('/api/stats');
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
  document.getElementById('btn-start').style.display = 'none';
  document.getElementById('btn-skip').style.display  = '';
  loadNextSong();
});

document.getElementById('btn-skip').addEventListener('click', skipSong);

// Inject YouTube IFrame API script
const ytScript = document.createElement('script');
ytScript.src   = 'https://www.youtube.com/iframe_api';
document.head.appendChild(ytScript);

refreshStats();
