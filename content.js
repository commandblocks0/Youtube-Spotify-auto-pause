const isYouTube = location.hostname.includes("youtube.com");
const isSpotify = location.hostname.includes("spotify.com");

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

let settings = { ...DEFAULT_SETTINGS };

async function loadSettings() {
	const result = await chrome.storage.local.get("settings");
	settings = { ...DEFAULT_SETTINGS, ...(result.settings || {}) };
}

loadSettings();

chrome.storage.onChanged.addListener((changes, areaName) => {
	if (areaName !== "local" || !changes.settings) return;
	settings = { ...DEFAULT_SETTINGS, ...(changes.settings.newValue || {}) };
});

if (isYouTube) {
	let currentVideo = null;
	let wasPlayingBeforeBackgroundPause = false;

	function sendSpotifyMessage(payload) {
		if (chrome?.runtime?.sendMessage) {
			chrome.runtime.sendMessage(payload);
		}
	}

	function shouldPauseOnBackground() {
		if (!settings["yt-play-pause"]) return false;
		if (!settings["yt-blur"]) return false;
		if (document.fullscreenElement && settings["yt-fullscreen"]) return false;
		return true;
	}

	function shouldResumeOnFocus() {
		if (!settings["yt-play-pause"]) return false;
		if (!settings["yt-focus"]) return false;
		return true;
	}

	function pauseForBackground(video) {
		if (!video || !shouldPauseOnBackground()) return;
		if (video.paused) {
			wasPlayingBeforeBackgroundPause = false;
			return;
		}

		wasPlayingBeforeBackgroundPause = true;
		video.pause();
	}

	function resumeFromBackground(video) {
		if (!video || !shouldResumeOnFocus()) return;
		if (!wasPlayingBeforeBackgroundPause) return;

		wasPlayingBeforeBackgroundPause = false;
		video.play().catch(() => { });
	}

	function onVideoPlay() {
		if (!settings["sp-play-pause"]) return;
		if (!settings["sp-stop-yt-play"]) return;
		sendSpotifyMessage({ type: "spotify_pause" });
	}

	function onVideoPauseOrEnded() {
		if (!settings["sp-play-pause"]) return;
		if (!settings["sp-play-yt-stop"]) return;
		sendSpotifyMessage({ type: "spotify_play" });
	}

	function attachVideoListeners(video) {
		if (!video || video === currentVideo) return;

		if (currentVideo) {
			currentVideo.removeEventListener("play", onVideoPlay);
			currentVideo.removeEventListener("pause", onVideoPauseOrEnded);
			currentVideo.removeEventListener("ended", onVideoPauseOrEnded);
		}

		currentVideo = video;
		currentVideo.addEventListener("play", onVideoPlay);
		currentVideo.addEventListener("pause", onVideoPauseOrEnded);
		currentVideo.addEventListener("ended", onVideoPauseOrEnded);
	}

	function initYouTube() {
		const video = document.querySelector("#movie_player .html5-main-video");
		attachVideoListeners(video);
	}

	window.addEventListener("blur", () => pauseForBackground(currentVideo));
	window.addEventListener("focus", () => resumeFromBackground(currentVideo));

	document.addEventListener("visibilitychange", () => {
		if (document.hidden) {
			pauseForBackground(currentVideo);
			return;
		}

		resumeFromBackground(currentVideo);
	});

	window.addEventListener("beforeunload", () => {
		if (!settings["sp-play-pause"]) return;
		if (!settings["sp-play-yt-stop"]) return;
		sendSpotifyMessage({ type: "spotify_play" });
	});

	const observer = new MutationObserver(() => initYouTube());
	observer.observe(document.body, { childList: true, subtree: true });

	initYouTube();
}

if (isSpotify) {
	let hasPlayed = false;
	let manualButton = null;
	let firstOpenRetryStarted = false;

	function isPlayState(label) {
		if (!label) return false;
		const normalized = label.trim().toLowerCase();
		const playKeywords = ["play", "prehr", "reproduc", "jouer", "spielen", "riproduci", "odtworz"];
		return playKeywords.some((word) => normalized.includes(word));
	}

	function delay(ms) {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}

	async function tryPlay() {
		if (hasPlayed) return false;
		if (!settings["sp-play-pause"]) return false;
		if (!settings["sp-first-open"]) return false;

		const btn = document.querySelector('[data-testid="control-button-playpause"]');
		if (!btn || btn.disabled) return false;

		const label = btn.getAttribute("aria-label");
		const mediaState = navigator.mediaSession?.playbackState;
		const shouldPlay = mediaState === "paused" || mediaState === "none" || isPlayState(label);

		if (!shouldPlay) return false;

		btn.click();
		hasPlayed = true;
		return true;
	}

	async function tryPlayWithRetries() {
		if (firstOpenRetryStarted) return;
		firstOpenRetryStarted = true;

		for (let attempt = 0; attempt < 8; attempt += 1) {
			const played = await tryPlay();
			if (played) return;
			await delay(750);
		}
	}

	function handleManualToggle(event) {
		if (!event.isTrusted) return;

		const btn = event.currentTarget;
		requestAnimationFrame(() => {
			const label = btn.getAttribute("aria-label");
			chrome.runtime.sendMessage({ type: "spotify_manual_toggle", label });
		});
	}

	function attachManualListener(btn) {
		if (!btn) return;
		if (manualButton === btn) return;

		if (manualButton) {
			manualButton.removeEventListener("click", handleManualToggle);
		}

		manualButton = btn;
		manualButton.addEventListener("click", handleManualToggle);
	}

	function initSpotify() {
		const btn = document.querySelector('[data-testid="control-button-playpause"]');
		if (!btn) return;

		attachManualListener(btn);
		tryPlayWithRetries();
	}

	const observer = new MutationObserver(() => initSpotify());
	observer.observe(document.body, { childList: true, subtree: true });

	document.addEventListener("visibilitychange", () => {
		if (!document.hidden) {
			initSpotify();
		}
	});

	initSpotify();
}
