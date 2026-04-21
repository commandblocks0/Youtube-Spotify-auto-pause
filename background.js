let spotifyPausedByExtension = false;
let lastYouTubePlayback = 0;

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
const HEADPHONE_KEYWORDS = ["headphone", "headset", "earbud", "airpods", "buds", "pods", "sluch", "sluchat", "auricular"];
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
    if (!spotifyPausedByExtension) return;

    const settings = await getSettings();
    if (!settings["sp-play-pause"] || !settings["sp-play-yt-stop"]) return;
    if (Date.now() - lastYouTubePlayback < 2000) return;

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

    if (action === "play" && !spotifyPausedByExtension && !forcePlay) return;
    const settings = await getSettings();

    if (action === "play" && settings["sp-headphones"]) {
        const hasHeadphones = await spotifyHasHeadphonesOutput();
        if (hasHeadphones === false) return;
    }

    const attempts = action === "play" ? 8 : 2;

    for (let attempt = 0; attempt < attempts; attempt += 1) {
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
                    func: (spotifyAction) => {
                        const PLAY_KEYWORDS = ["play", "prehr", "reproduc", "jouer", "spielen", "riproduci", "odtworz"];
                        const PAUSE_KEYWORDS = ["pause", "pausa", "stopp", "arrêt", "arrêter", "przerwij", "pozastav"];

                        function includesAnyKeyword(value, keywords) {
                            if (!value) return false;
                            const normalized = value.trim().toLowerCase();
                            return keywords.some((keyword) => normalized.includes(keyword));
                        }

                        const btn = document.querySelector('[data-testid="control-button-playpause"]');
                        if (!btn) return { label: null, clicked: false };

                        const label = btn.getAttribute("aria-label");
                        const mediaState = navigator.mediaSession?.playbackState;
                        const inPauseState = mediaState === "playing" || includesAnyKeyword(label, PAUSE_KEYWORDS);
                        const inPlayState = mediaState === "paused" || mediaState === "none" || includesAnyKeyword(label, PLAY_KEYWORDS);

                        if (spotifyAction === "pause") {
                            if (inPauseState) {
                                btn.click();
                                return { label, clicked: true };
                            }
                            return { label, clicked: false };
                        }

                        if (spotifyAction === "play") {
                            if (inPlayState) {
                                btn.click();
                                return { label, clicked: true };
                            }
                            return { label, clicked: false };
                        }

                        return { label, clicked: false };
                    },
                    args: [action]
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
                if (result.clicked || isPauseStateLabel(result.label)) {
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

async function spotifyHasHeadphonesOutput() {
    const tabs = await querySpotifyTabs();
    if (!tabs.length) return null;
    let sawNoHeadphones = false;

    for (const tab of tabs) {
        const [injectionResult] = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: async (keywords) => {
                try {
                    const enumerate = navigator.mediaDevices?.enumerateDevices;
                    if (!enumerate) return { connected: null };

                    const devices = await enumerate.call(navigator.mediaDevices);
                    const outputs = devices.filter((device) => device.kind === "audiooutput");
                    if (!outputs.length) return { connected: null };

                    const namedOutputs = outputs.filter((device) => device.label && device.label.trim().length > 0);
                    if (!namedOutputs.length) return { connected: null };

                    const connected = namedOutputs.some((device) => {
                        const label = device.label.toLowerCase();
                        return keywords.some((keyword) => label.includes(keyword));
                    });

                    return { connected };
                } catch {
                    return { connected: null };
                }
            },
            args: [HEADPHONE_KEYWORDS]
        });

        const connected = injectionResult?.result?.connected;
        if (connected === true) return true;
        if (connected === false) sawNoHeadphones = true;
    }

    return sawNoHeadphones ? false : null;
}
