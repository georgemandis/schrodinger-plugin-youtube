// YouTube plugin for Schrodinger
//
// When the clip is a YouTube link, paste something more useful than the link:
//
//   Titled link            [Me at the zoo](https://youtu.be/jNQXAC9IVRw)
//   Details                title, channel, length and link
//   Transcript             the captions as readable paragraphs
//   Transcript with times  one caption per line, each with its timestamp
//   Embed code             the <iframe> (no network needed)
//
// Only www.youtube.com is contacted, and only when you paste. What is sent is
// the video id; nothing else from your clipboard leaves the machine.

// --- recognizing a link -------------------------------------------------------

function parseTime(value) {
    if (!value) return 0;
    if (/^\d+$/.test(value)) return parseInt(value, 10);
    const m = value.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
    return m ? (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0) : 0;
}

// The whole clip must be one YouTube link (surrounding whitespace aside).
function parseVideo(text) {
    const t = text.trim();
    if (!t || /\s/.test(t) || t.length > 300) return null;
    let url;
    try { url = new URL(/^https?:\/\//i.test(t) ? t : 'https://' + t); } catch { return null; }
    const host = url.hostname.replace(/^(www|m|music)\./, '').toLowerCase();
    let id = null;
    if (host === 'youtu.be') id = url.pathname.slice(1).split('/')[0];
    else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
        if (url.pathname === '/watch') id = url.searchParams.get('v');
        else {
            const m = url.pathname.match(/^\/(?:shorts|embed|live|v)\/([^/?#]+)/);
            if (m) id = m[1];
        }
    }
    if (!id || !/^[\w-]{11}$/.test(id)) return null;
    return { id, start: parseTime(url.searchParams.get('t') || url.searchParams.get('start')) };
}

const shortUrl = v => `https://youtu.be/${v.id}` + (v.start ? `?t=${v.start}` : '');

// --- talking to YouTube ---------------------------------------------------------

// The app's own player API. It answers with the video's details and caption
// tracks in one request, and its caption links work without a browser session.
const CLIENT = { clientName: 'ANDROID', clientVersion: '20.10.38' };
const CLIENT_AGENT = 'com.google.android.youtube/20.10.38 (Linux; U; Android 14)';

async function fetchPlayer(video) {
    const res = await schrodinger.fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': CLIENT_AGENT },
        body: JSON.stringify({ context: { client: CLIENT }, videoId: video.id }),
    });
    if (!res.ok) throw new Error(`YouTube answered ${res.status}`);
    const data = await res.json();
    const status = data.playabilityStatus || {};
    if (!data.videoDetails) {
        throw new Error((status.reason || 'YouTube returned no details for this video').replace(/\.$/, '').toLowerCase());
    }
    return data;
}

// The public oEmbed endpoint: less detail, but it is documented and stable,
// so the two simplest modes don't depend on the player API staying as it is.
async function fetchTitle(video) {
    const res = await schrodinger.fetch(
        `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent('https://www.youtube.com/watch?v=' + video.id)}`);
    if (res.status === 401 || res.status === 403) throw new Error('this video is private or cannot be embedded');
    if (res.status === 404 || res.status === 400) throw new Error('YouTube has no video at this link');
    if (!res.ok) throw new Error(`YouTube answered ${res.status}`);
    const data = await res.json();
    return { title: data.title, channel: data.author_name };
}

function pickTrack(tracks, wanted) {
    const prefs = [wanted, (typeof navigator !== 'undefined' && navigator.language || '').split('-')[0], 'en']
        .filter(Boolean).map(l => l.toLowerCase());
    const base = t => (t.languageCode || '').split('-')[0].toLowerCase();
    // Captions someone wrote beat auto-generated ones in the same language.
    const ranked = [...tracks].sort((a, b) => (a.kind === 'asr') - (b.kind === 'asr'));
    for (const lang of prefs) {
        const hit = ranked.find(t => (t.languageCode || '').toLowerCase() === lang) || ranked.find(t => base(t) === lang);
        if (hit) return hit;
    }
    return ranked[0];
}

async function fetchCaptions(video, config) {
    const player = await fetchPlayer(video);
    const tracks = (((player.captions || {}).playerCaptionsTracklistRenderer || {}).captionTracks) || [];
    if (!tracks.length) throw new Error('this video has no captions');
    const track = pickTrack(tracks, (config.language || '').trim());
    const res = await schrodinger.fetch(track.baseUrl);
    if (!res.ok) throw new Error(`YouTube answered ${res.status} for the captions`);
    const xml = new DOMParser().parseFromString(await res.text(), 'text/xml');
    // Two schemas are in use: <p t="ms" d="ms"> and the older <text start="s" dur="s">.
    const cues = [...xml.querySelectorAll('p, text')].map(node => {
        const ms = node.hasAttribute('t') ? parseInt(node.getAttribute('t'), 10) : Math.round(parseFloat(node.getAttribute('start') || '0') * 1000);
        const dur = node.hasAttribute('d') ? parseInt(node.getAttribute('d'), 10) : Math.round(parseFloat(node.getAttribute('dur') || '0') * 1000);
        const text = node.textContent.replace(/\s+/g, ' ').trim();
        return { ms, dur, text };
    }).filter(c => c.text);
    if (!cues.length) throw new Error('the captions for this video are empty');
    return { cues, details: player.videoDetails, auto: track.kind === 'asr' };
}

// --- formatting ---------------------------------------------------------------

function clock(seconds) {
    const s = Math.floor(seconds);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    const pad = n => String(n).padStart(2, '0');
    return h ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

// Captions arrive as short screen-sized lines. Join them into paragraphs,
// breaking where the speaker pauses or a paragraph has run long enough.
function paragraphs(cues) {
    const out = [];
    let current = '';
    cues.forEach((cue, i) => {
        const prev = cues[i - 1];
        const pause = prev ? cue.ms - (prev.ms + prev.dur) : 0;
        const endsSentence = /[.!?]["')\]]?$/.test(current);
        if (current && (pause > 2500 || (current.length > 500 && endsSentence) || current.length > 900)) {
            out.push(current);
            current = '';
        }
        current += (current ? ' ' : '') + cue.text;
    });
    if (current) out.push(current);
    return out.join('\n\n');
}

const escapeHtml = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const escapeMd = s => s.replace(/([\\[\]])/g, '\\$1');

const text = value => ({ format: schrodinger.textFormat(), data: schrodinger.encode(value) });

const MODES = {
    async link(video) {
        const { title } = await fetchTitle(video);
        const url = shortUrl(video);
        // A real link for rich-text targets, Markdown for plain-text ones.
        return [
            { format: schrodinger.htmlFormat(), data: schrodinger.encode(`<a href="${escapeHtml(url)}">${escapeHtml(title)}</a>`) },
            text(`[${escapeMd(title)}](${url})`),
        ];
    },
    async details(video) {
        const d = (await fetchPlayer(video)).videoDetails;
        const length = d.isLiveContent && d.lengthSeconds === '0' ? 'live' : clock(Number(d.lengthSeconds || 0));
        return [text(`${d.title}\n${d.author} · ${length}\n${shortUrl(video)}`)];
    },
    async transcript(video, config) {
        const { cues, details } = await fetchCaptions(video, config);
        return [text(`${details.title}\n${shortUrl(video)}\n\n${paragraphs(cues)}`)];
    },
    async timestamps(video, config) {
        const { cues } = await fetchCaptions(video, config);
        return [text(cues.map(c => `[${clock(c.ms / 1000)}] ${c.text}`).join('\n'))];
    },
    async embed(video) {
        const src = `https://www.youtube-nocookie.com/embed/${video.id}` + (video.start ? `?start=${video.start}` : '');
        return [text(`<iframe width="560" height="315" src="${src}" title="YouTube video player" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" referrerpolicy="strict-origin-when-cross-origin" allowfullscreen></iframe>`)];
    },
};

// --- plugin -------------------------------------------------------------------

let cache = { changeCount: null, video: null };

async function clipVideo(entry) {
    if (cache.changeCount === entry.changeCount) return cache.video;
    const format = entry.formats.find(f => f.format === schrodinger.textFormat());
    let video = null;
    if (format && format.size <= 400) {
        video = parseVideo(schrodinger.decode(await schrodinger.readFormat(entry, format.format)));
    }
    cache = { changeCount: entry.changeCount, video };
    return video;
}

export default {
    id: "youtube",
    label: "YouTube",
    modes: [
        { id: "link", label: "Titled link", default: true },
        { id: "details", label: "Details" },
        { id: "transcript", label: "Transcript" },
        { id: "timestamps", label: "Transcript with times" },
        { id: "embed", label: "Embed code" }
    ],
    async appliesTo(entry) {
        return (await clipVideo(entry)) !== null;
    },
    async apply(entry, mode) {
        const video = await clipVideo(entry);
        if (!video) throw new Error('this clip is not a YouTube link');
        return (MODES[mode] || MODES.link)(video, schrodinger.getConfig() || {});
    }
};
