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

const switches = [...document.querySelectorAll(".switch")];
let settings = { ...DEFAULT_SETTINGS };

function setSwitchState(item, isEnabled) {
    item.toggleAttribute("checked", Boolean(isEnabled));
}

async function loadSettings() {
    const result = await chrome.storage.local.get("settings");
    settings = { ...DEFAULT_SETTINGS, ...(result.settings || {}) };

    for (const item of switches) {
        setSwitchState(item, settings[item.id]);
    }

    await chrome.storage.local.set({ settings });
}

function bindSwitchEvents() {
    for (const item of switches) {
        item.addEventListener("click", async () => {
            const nextValue = !item.hasAttribute("checked");
            setSwitchState(item, nextValue);
            settings[item.id] = nextValue;
            await chrome.storage.local.set({ settings });
        });
    }
}

bindSwitchEvents();
loadSettings();
