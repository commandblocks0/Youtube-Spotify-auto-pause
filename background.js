let spotifyPausedByExtension = false;
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

async function getSettings() {
    const result = await chrome.storage.local.get("settings");
    return { ...DEFAULT_SETTINGS, ...(result.settings || {}) };
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
            controlSpotify("play");
            break;

        case "spotify_pause":
            controlSpotify("pause");
            break;

        case "spotify_manual_toggle":
            spotifyPausedByExtension = false;
            break;
    }
});

chrome.tabs.onRemoved.addListener(async () => {
    if (!spotifyPausedByExtension) return;

    const settings = await getSettings();
    if (!settings["sp-play-pause"] || !settings["sp-play-yt-stop"]) return;

    const youtubeTabs = await chrome.tabs.query({ url: "*://www.youtube.com/*" });
    if (youtubeTabs.length > 0) return;

    controlSpotify("play");
});

async function controlYouTube(action) {
    const tabs = await chrome.tabs.query({ url: "*://www.youtube.com/*" });

    for (const tab of tabs) {
        chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: (action) => {
                const video = document.querySelector('#movie_player .html5-main-video');
                if (!video) return;

                if (action === "play" && video.paused) {
                    video.play();
                }

                if (action === "pause" && !video.paused) {
                    video.pause();
                }
            },
            args: [action]
        });
    }
}

async function controlSpotify(action) {
    if (action === "play" && !spotifyPausedByExtension) return;
    const settings = await getSettings();

    if (action === "play" && settings["sp-headphones"]) {
        const hasHeadphones = await spotifyHasHeadphonesOutput();
        if (hasHeadphones === false) return;
    }

    const tabs = await chrome.tabs.query({ url: "*://open.spotify.com/*" });

    for (const tab of tabs) {
        const [injectionResult] = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: (action) => {
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

                if (action === "pause") {
                    if (inPauseState) {
                        btn.click();
                        return { label, clicked: true };
                    }
                    return { label, clicked: false };
                }

                if (action === "play") {
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

        const result = injectionResult?.result;
        if (!result) continue;

        if (action === "pause") {
            if (result.clicked) {
                spotifyPausedByExtension = true;
            } else if (isPlayStateLabel(result.label)) {
                spotifyPausedByExtension = false;
            }
        } else if (action === "play") {
            if (isPauseStateLabel(result.label) || result.clicked) {
                spotifyPausedByExtension = false;
            }
        }
    }
}

async function spotifyHasHeadphonesOutput() {
    const tabs = await chrome.tabs.query({ url: "*://open.spotify.com/*" });
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
