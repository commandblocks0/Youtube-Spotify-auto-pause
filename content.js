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
	let spotifyPauseRequestedForCurrentPlayback = false;
	let spotifyResumeRequestedForCurrentStop = false;
	let pauseTimeout = null;

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
		if (video.paused) return;

		wasPlayingBeforeBackgroundPause = true;
		video.pause();
	}

	function resumeFromBackground(video) {
		if (!video || !shouldResumeOnFocus()) return;
		if (!wasPlayingBeforeBackgroundPause) return;

		wasPlayingBeforeBackgroundPause = false;
		video.play().catch(() => { });
	}

	function requestSpotifyPauseForYouTubePlayback() {
		if (!settings["sp-play-pause"]) return;
		if (!settings["sp-stop-yt-play"]) return;
		if (spotifyPauseRequestedForCurrentPlayback) return;

		spotifyPauseRequestedForCurrentPlayback = true;
		spotifyResumeRequestedForCurrentStop = false;
		sendSpotifyMessage({ type: "spotify_pause" });
	}

	function requestSpotifyResumeForYouTubeStop() {
		if (!settings["sp-play-pause"]) return;
		if (!settings["sp-play-yt-stop"]) return;
		if (spotifyResumeRequestedForCurrentStop) return;

		spotifyResumeRequestedForCurrentStop = true;
		spotifyPauseRequestedForCurrentPlayback = false;
		sendSpotifyMessage({ type: "spotify_play" });
	}

	function syncSpotifyWithCurrentVideoState(video) {
		if (!video) return;
		if (!video.paused) {
			requestSpotifyPauseForYouTubePlayback();
			return;
		}

		requestSpotifyResumeForYouTubeStop();
	}

	function onVideoPlay() {
		if (pauseTimeout) {
			clearTimeout(pauseTimeout);
			pauseTimeout = null;
		}
		requestSpotifyPauseForYouTubePlayback();
	}

	function onVideoPause() {
		if (pauseTimeout) {
			clearTimeout(pauseTimeout);
		}

		pauseTimeout = setTimeout(() => {
			if (currentVideo && currentVideo.paused) {
				requestSpotifyResumeForYouTubeStop();
			}
			pauseTimeout = null;
		}, 400);
	}

	function attachVideoListeners(video) {
		if (!video || video === currentVideo) return;

		if (currentVideo) {
			currentVideo.removeEventListener("play", onVideoPlay);
			currentVideo.removeEventListener("pause", onVideoPause);
		}

		if (pauseTimeout) {
			clearTimeout(pauseTimeout);
			pauseTimeout = null;
		}

		currentVideo = video;
		spotifyPauseRequestedForCurrentPlayback = false;
		spotifyResumeRequestedForCurrentStop = false;
		currentVideo.addEventListener("play", onVideoPlay);
		currentVideo.addEventListener("pause", onVideoPause);
	}

	function initYouTube() {
		const video = document.querySelector("#movie_player .html5-main-video");
		attachVideoListeners(video);
		syncSpotifyWithCurrentVideoState(video);
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
	setInterval(() => syncSpotifyWithCurrentVideoState(currentVideo), 1500);
	setInterval(() => {
		if (!currentVideo) return;
		if (currentVideo.paused) return;
		sendSpotifyMessage({ type: "yt_active" });
	}, 1000);

	initYouTube();
}

if (isSpotify) {
	let hasPlayed = false;
	let manualButton = null;
	let firstOpenRetryInProgress = false;
	let headphonePlayInterval = null;
	let headphonePlayCheckInProgress = false;

	function isPlayState(label) {
		if (!label) return false;
		const normalized = label.trim().toLowerCase();
		const playKeywords = ["play", "prehr", "reproduc", "jouer", "spielen", "riproduci", "odtworz"];
		return playKeywords.some((word) => normalized.includes(word));
	}

	function delay(ms) {
		return new Promise((resolve) => setTimeout(resolve, ms));
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

	function stopHeadphonePlayInterval() {
		if (headphonePlayInterval) {
			clearInterval(headphonePlayInterval);
			headphonePlayInterval = null;
		}

		if (window.__youtubeSpotifyHeadphonePlayInterval) {
			clearInterval(window.__youtubeSpotifyHeadphonePlayInterval);
			window.__youtubeSpotifyHeadphonePlayInterval = null;
		}
	}

	async function tryPlay(options = {}) {
		const { requireHeadphones = false } = options;
		if (hasPlayed) return false;
		if (!settings["sp-play-pause"]) return false;
		if (!settings["sp-first-open"]) return false;
		if (requireHeadphones && !(await headphonesConnected())) return false;

		const btn = document.querySelector('[data-testid="control-button-playpause"]');
		if (!btn || btn.disabled) return false;

		const label = btn.getAttribute("aria-label");
		const mediaState = navigator.mediaSession?.playbackState;
		const alreadyPlaying = mediaState === "playing" || (label && !isPlayState(label));
		const shouldPlay = mediaState === "paused" || mediaState === "none" || isPlayState(label);

		if (alreadyPlaying) {
			hasPlayed = true;
			return true;
		}
		if (!shouldPlay) return false;

		btn.click();
		await delay(400);

		const nextLabel = btn.getAttribute("aria-label");
		const nextMediaState = navigator.mediaSession?.playbackState;
		const played = nextMediaState === "playing" || (nextLabel && !isPlayState(nextLabel));
		if (played) {
			hasPlayed = true;
			stopHeadphonePlayInterval();
			chrome.runtime.sendMessage({ type: "spotify_auto_played" });
		}

		return played;
	}

	function startHeadphonePlayInterval() {
		if (headphonePlayInterval) return;

		headphonePlayInterval = setInterval(async () => {
			if (headphonePlayCheckInProgress) return;
			headphonePlayCheckInProgress = true;

			try {
				await tryPlay({ requireHeadphones: true });
			} finally {
				headphonePlayCheckInProgress = false;
			}
		}, 100);
	}

	async function tryPlayWithRetries() {
		if (firstOpenRetryInProgress) return;
		if (hasPlayed) return;
		firstOpenRetryInProgress = true;

		for (let attempt = 0; attempt < 20; attempt += 1) {
			const played = await tryPlay();
			if (played) {
				firstOpenRetryInProgress = false;
				return;
			}
			await delay(1000);
		}

		firstOpenRetryInProgress = false;
	}

	function handleManualToggle(event) {
		if (!event.isTrusted) return;
		stopHeadphonePlayInterval();

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
		if (settings["sp-headphones"]) {
			startHeadphonePlayInterval();
			return;
		}
		tryPlayWithRetries();
	}

	const observer = new MutationObserver(() => initSpotify());
	observer.observe(document.body, { childList: true, subtree: true });

	document.addEventListener("visibilitychange", () => {
		if (!document.hidden) {
			initSpotify();
		}
	});

	navigator.mediaDevices?.addEventListener?.("devicechange", () => {
		initSpotify();
	});

	initSpotify();
}
