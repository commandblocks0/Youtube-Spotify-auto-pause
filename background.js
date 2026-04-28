let spotifyPausedByExtension = false;
let lastYouTubePlayback = 0;
let spotifyPlayRequestId = 0;

const DEFAULT_SETTINGS = {
    "yt-play-pause": true,
    "yt-focus": true,
    "yt-blur": true,
    "yt-fullscreen": true,
    "sp-play-pause": true,
    "sp-stop-yt-play": true,
    "sp-play-yt-stop": true,
    "sp-first-open": true,
    "sp-headphones": true
};

const PLAY_KEYWORDS = ["play", "prehr", "reproduc", "jouer", "spielen", "riproduci", "odtworz"];
const PAUSE_KEYWORDS = ["pause", "pausa", "stopp", "arrêt", "arrêter", "przerwij", "pozastav"];
const YOUTUBE_URL_PATTERNS = ["*://youtube.com/*", "*://*.youtube.com/*"];
const SPOTIFY_URL_PATTERNS = ["*://open.spotify.com/*"];

const spotifyStartupHandledTabIds = new Set();

function includesAnyKeyword(value, keywords) {
    if (!value) return false;
    const normalized = value.trim().toLowerCase();
    return keywords.some((keyword) => normalized.includes(keyword));
}

function isPlayStateLabel(label) {
    return includesAnyKeyword(label, PLAY_KEYWORDS);
}

function isPauseStateLabel(label) {
    return includesAnyKeyword(label, PAUSE_KEYWORDS);
}

function isYouTubeUrl(url) {
    return typeof url === "string" && /https?:\/\/([a-z0-9-]+\.)*youtube\.com\//i.test(url);
}

function isSpotifyUrl(url) {
    return typeof url === "string" && /^https?:\/\/open\.spotify\.com\//i.test(url);
}

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getSettings() {
    const result = await chrome.storage.local.get("settings");
    return { ...DEFAULT_SETTINGS, ...(result.settings || {}) };
}

async function queryYouTubeTabs() {
    return chrome.tabs.query({ url: YOUTUBE_URL_PATTERNS });
}

async function querySpotifyTabs() {
    return chrome.tabs.query({ url: SPOTIFY_URL_PATTERNS });
}

async function maybeResumeSpotifyAfterYouTubeGone() {
    const settings = await getSettings();
    if (!settings["sp-play-pause"] || !settings["sp-play-yt-stop"]) return;

    const ytTabs = await queryYouTubeTabs();
    if (ytTabs.length > 0) return;

    controlSpotify("play", { allowWake: true });
}

async function maybeAutoplaySpotifyOnOpen(tabId) {
    if (spotifyStartupHandledTabIds.has(tabId)) return;

    const settings = await getSettings();
    if (!settings["sp-play-pause"] || !settings["sp-first-open"]) return;

    spotifyStartupHandledTabIds.add(tabId);
    controlSpotify("play", { allowWake: true, forcePlay: true, preferredTabId: tabId });
}

chrome.runtime.onMessage.addListener(async (message, sender, sendResponse) => {
    if (!message || !message.type) return;

    switch (message.type) {
        case "yt_play":
            controlYouTube("play");
            break;

        case "yt_pause":
            controlYouTube("pause");
            break;

        case "spotify_play":
            controlSpotify("play", { allowWake: true });
            break;

        case "spotify_pause":
            controlSpotify("pause");
            break;

        case "yt_active":
            lastYouTubePlayback = Date.now();
            break;

        case "spotify_manual_toggle":
            spotifyPausedByExtension = false;
            spotifyPlayRequestId += 1;
            break;

        case "spotify_auto_played":
            spotifyPausedByExtension = false;
            break;
    }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
    spotifyStartupHandledTabIds.delete(tabId);
    await maybeResumeSpotifyAfterYouTubeGone();
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
    const updatedUrl = changeInfo.url || tab.url || "";

    if (changeInfo.url && !isSpotifyUrl(changeInfo.url)) {
        spotifyStartupHandledTabIds.delete(tabId);
    }

    if (changeInfo.status === "complete" && isSpotifyUrl(updatedUrl)) {
        await maybeAutoplaySpotifyOnOpen(tabId);
    }

    if (changeInfo.url && !isYouTubeUrl(changeInfo.url)) {
        await maybeResumeSpotifyAfterYouTubeGone();
    }
});

async function controlYouTube(action) {
    const tabs = await queryYouTubeTabs();

    for (const tab of tabs) {
        chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: (videoAction) => {
                const video = document.querySelector("#movie_player .html5-main-video");
                if (!video) return;

                if (videoAction === "play" && video.paused) {
                    video.play();
                }

                if (videoAction === "pause" && !video.paused) {
                    video.pause();
                }
            },
            args: [action]
        });
    }
}

function reorderTabsByPreference(tabs, preferredTabId) {
    if (!preferredTabId) return tabs;
    return [...tabs].sort((a, b) => {
        if (a.id === preferredTabId) return -1;
        if (b.id === preferredTabId) return 1;
        return 0;
    });
}

async function wakeSpotifyTabsIfNeeded(tabs, options = {}) {
    const { activateTab = false } = options;
    let shouldWait = false;

    for (const tab of tabs) {
        if (tab.discarded) {
            chrome.tabs.reload(tab.id);
            shouldWait = true;
        }

        if (tab.status !== "complete") {
            shouldWait = true;
        }

        if (activateTab) {
            try {
                await chrome.tabs.update(tab.id, { active: true });
                await delay(300);
            } catch {
                // Best effort: continue even if activation fails.
            }
        }
    }

    if (shouldWait) {
        await delay(1000);
    }
}

async function controlSpotify(action, options = {}) {
    const { allowWake = false, forcePlay = false, preferredTabId = null } = options;

    if (action === "pause") {
        spotifyPlayRequestId += 1;
    }

    const settings = await getSettings();
    const playRequestId = action === "play" ? spotifyPlayRequestId + 1 : spotifyPlayRequestId;

    if (action === "play") {
        spotifyPlayRequestId = playRequestId;
    }

    const attempts = action === "play" ? 8 : 2;

    for (let attempt = 0; attempt < attempts; attempt += 1) {
        if (action === "play" && playRequestId !== spotifyPlayRequestId) return;

        let tabs = await querySpotifyTabs();
        if (!tabs.length) return;

        tabs = reorderTabsByPreference(tabs, preferredTabId);

        if (allowWake && attempt === 0) {
            await wakeSpotifyTabsIfNeeded(tabs, { activateTab: forcePlay });
        }

        let sawResult = false;

        for (const tab of tabs) {
            let injectionResult;
            try {
                [injectionResult] = await chrome.scripting.executeScript({
                    target: { tabId: tab.id },
                    func: async (spotifyAction, requireHeadphones) => {
                        const PLAY_KEYWORDS = ["play", "prehr", "reproduc", "jouer", "spielen", "riproduci", "odtworz"];
                        const PAUSE_KEYWORDS = ["pause", "pausa", "stopp", "arrêt", "arrêter", "przerwij", "pozastav"];

                        function includesAnyKeyword(value, keywords) {
                            if (!value) return false;
                            const normalized = value.trim().toLowerCase();
                            return keywords.some((keyword) => normalized.includes(keyword));
                        }

                        async function headphonesConnected() {
                            try {
                                const permission = await navigator.permissions?.query?.({ name: "microphone" });
                                if (permission?.state !== "granted") {
                                    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
                                    stream.getTracks().forEach((track) => track.stop());
                                }

                                const devices = await navigator.mediaDevices.enumerateDevices();
                                return devices.some((device) => {
                                    return device.kind === "audiooutput" && device.label.toLowerCase().includes("headphone");
                                });
                            } catch {
                                return false;
                            }
                        }

                        function clearHeadphonePlayInterval() {
                            if (!window.__youtubeSpotifyHeadphonePlayInterval) return;
                            clearInterval(window.__youtubeSpotifyHeadphonePlayInterval);
                            window.__youtubeSpotifyHeadphonePlayInterval = null;
                        }

                        function startHeadphonePlayInterval() {
                            if (window.__youtubeSpotifyHeadphonePlayInterval) return { label: null, clicked: false, pending: true };

                            window.__youtubeSpotifyHeadphonePlayInterval = setInterval(async () => {
                                if (window.__youtubeSpotifyHeadphoneCheckInProgress) return;
                                window.__youtubeSpotifyHeadphoneCheckInProgress = true;

                                try {
                                    const btn = document.querySelector('[data-testid="control-button-playpause"]');
                                    if (!btn || btn.disabled) return;
                                    if (!(await headphonesConnected())) return;

                                    const label = btn.getAttribute("aria-label");
                                    const mediaState = navigator.mediaSession?.playbackState;
                                    const shouldPlay = mediaState === "paused" || mediaState === "none" || includesAnyKeyword(label, PLAY_KEYWORDS);
                                    if (!shouldPlay) {
                                        clearHeadphonePlayInterval();
                                        return;
                                    }

                                    btn.click();
                                    clearHeadphonePlayInterval();
                                    chrome.runtime.sendMessage({ type: "spotify_auto_played" });
                                } finally {
                                    window.__youtubeSpotifyHeadphoneCheckInProgress = false;
                                }
                            }, 100);

                            return { label: null, clicked: false, pending: true };
                        }

                        const btn = document.querySelector('[data-testid="control-button-playpause"]');
                        if (!btn) return { label: null, clicked: false };

                        const label = btn.getAttribute("aria-label");
                        const mediaState = navigator.mediaSession?.playbackState;
                        const inPauseState = mediaState === "playing" || includesAnyKeyword(label, PAUSE_KEYWORDS);
                        const inPlayState = mediaState === "paused" || mediaState === "none" || includesAnyKeyword(label, PLAY_KEYWORDS);

                        if (spotifyAction === "pause") {
                            clearHeadphonePlayInterval();
                            if (inPauseState) {
                                btn.click();
                                return { label, clicked: true };
                            }
                            return { label, clicked: false };
                        }

                        if (spotifyAction === "play") {
                            if (inPauseState) {
                                clearHeadphonePlayInterval();
                                return { label, clicked: false, playing: true };
                            }

                            if (requireHeadphones && !(await headphonesConnected())) {
                                return startHeadphonePlayInterval();
                            }

                            if (inPlayState) {
                                btn.click();
                                clearHeadphonePlayInterval();
                                await new Promise((resolve) => setTimeout(resolve, 400));

                                const nextLabel = btn.getAttribute("aria-label");
                                const nextMediaState = navigator.mediaSession?.playbackState;
                                const playing = nextMediaState === "playing" || includesAnyKeyword(nextLabel, PAUSE_KEYWORDS);
                                return { label: nextLabel, clicked: true, playing };
                            }
                            return { label, clicked: false };
                        }

                        return { label, clicked: false };
                    },
                    args: [action, settings["sp-headphones"]]
                });
            } catch {
                continue;
            }

            const result = injectionResult?.result;
            if (!result) continue;
            sawResult = true;

            if (action === "pause") {
                if (result.clicked) {
                    spotifyPausedByExtension = true;
                    return;
                }
                if (isPlayStateLabel(result.label)) {
                    spotifyPausedByExtension = false;
                }
            } else if (action === "play") {
                if (result.playing || isPauseStateLabel(result.label)) {
                    spotifyPausedByExtension = false;
                    return;
                }
            }
        }

        if (action === "pause" && sawResult) return;
        if (attempt < attempts - 1) {
            await delay(800);
        }
    }
}
