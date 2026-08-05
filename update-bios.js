require("dotenv").config();
const { initializeApp, cert } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const wiki = require("wikipedia");

const BATCH_SIZE = 30;
const DELAY_MS = 2500;
const LOOKBACK_HOURS = 36;
const LASTFM_API_KEY = process.env.LASTFM_API_KEY;

if (!LASTFM_API_KEY) {
	console.warn(
		"LASTFM_API_KEY not set. Last.fm will be skipped, using Wikipedia only.",
	);
}

const serviceAccount = require(process.env.SERVICE_ACCOUNT_PATH);
initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore();

function cleanText(text) {
	if (!text) return "";
	return text
		.replace(/<a[^>]*>.*?<\/a>/g, "")
		.replace(/<[^>]+>/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

async function fetchLastFmBio(artistName) {
	if (!LASTFM_API_KEY) return null;

	const url = new URL("https://ws.audioscrobbler.com/2.0/");
	url.searchParams.append("method", "artist.getInfo");
	url.searchParams.append("artist", artistName);
	url.searchParams.append("api_key", LASTFM_API_KEY);
	url.searchParams.append("format", "json");

	try {
		const response = await fetch(url.toString());
		if (!response.ok) throw new Error(`HTTP ${response.status}`);

		const data = await response.json();
		if (data.error) return null;

		const bioData = data?.artist?.bio;
		if (!bioData) return null;

		let bio = bioData.summary;
		if (bio && typeof bio === "string") {
			bio = cleanText(bio);
			return bio || null;
		}

		bio = bioData.content;
		if (bio && typeof bio === "string") {
			bio = cleanText(bio);
			return bio || null;
		}

		return null;
	} catch (error) {
		console.error(`Last.fm error for "${artistName}":`, error.message);
		return null;
	}
}

async function fetchWikipediaBio(artistName) {
	try {
		const searchResults = await wiki.search(artistName);
		if (!searchResults || searchResults.results.length === 0) return null;

		const normalize = (str) =>
			str
				.replace(/[^\w\s]/g, "")
				.replace(/\s+/g, " ")
				.trim()
				.toLowerCase();

		const normalizedArtist = normalize(artistName);

		let bestMatch = null;
		let bestScore = 0;

		for (const result of searchResults.results) {
			const normalizedTitle = normalize(result.title);
			const contains =
				normalizedTitle.includes(normalizedArtist) ||
				normalizedArtist.includes(normalizedTitle);
			const ratio =
				Math.min(normalizedTitle.length, normalizedArtist.length) /
				Math.max(normalizedTitle.length, normalizedArtist.length);
			if (contains && ratio > 0.5) {
				if (ratio > bestScore) {
					bestScore = ratio;
					bestMatch = result;
				}
			}
		}

		if (!bestMatch) return null;

		const page = await wiki.page(bestMatch.title);
		const summary = await page.summary();

		if (summary && summary.extract) {
			const extract = summary.extract;
			if (
				extract.includes("may refer to") ||
				extract.includes("disambiguation")
			) {
				return null;
			}
			return extract;
		}
		return null;
	} catch (error) {
		if (error.message?.includes("Page not found")) return null;
		console.error(`Wikipedia error for "${artistName}":`, error.message);
		return null;
	}
}

async function fetchArtistBio(artistName) {
	let bio = await fetchLastFmBio(artistName);
	if (bio) return bio;
	bio = await fetchWikipediaBio(artistName);
	return bio || null;
}

function hasBio(data) {
	return (
		data.bio && typeof data.bio === "string" && data.bio.trim().length > 0
	);
}

async function updateRecentArtistBios() {
	console.log(
		`Starting bio update for artists created in the last ${LOOKBACK_HOURS} hours...`,
	);

	const cutoffTime = new Date(Date.now() - LOOKBACK_HOURS * 60 * 60 * 1000);

	try {
		const artistsSnapshot = await db
			.collection("artists")
			.where("createdAt", ">", cutoffTime)
			.get();

		if (artistsSnapshot.empty) {
			console.log(
				`No artists created in the last ${LOOKBACK_HOURS} hours`,
			);
			return;
		}

		console.log(`Found ${artistsSnapshot.size} artists created recently`);

		const docsToUpdate = artistsSnapshot.docs.filter(
			(doc) => !hasBio(doc.data()),
		);

		if (docsToUpdate.length === 0) {
			console.log("All recent artists already have a bio");
			return;
		}

		console.log(`${docsToUpdate.length} of these need a bio`);

		let updated = 0,
			failed = 0;

		for (let i = 0; i < docsToUpdate.length; i += BATCH_SIZE) {
			const batch = db.batch();
			const batchDocs = docsToUpdate.slice(i, i + BATCH_SIZE);

			console.log(
				`Processing batch ${Math.floor(i / BATCH_SIZE) + 1}...`,
			);

			for (const doc of batchDocs) {
				const data = doc.data();
				const name = data.name;

				if (!name) {
					console.warn(`Doc ${doc.id} has no 'name'. Skipping`);
					failed++;
					continue;
				}

				const bio = await fetchArtistBio(name);
				if (bio) {
					batch.update(doc.ref, { bio });
					updated++;
					console.log(`Bio added for: "${name}"`);
				} else {
					failed++;
					console.log(`No bio found for: "${name}"`);
				}
			}

			if (batch._ops.length > 0) {
				await batch.commit();
				console.log(`Batch committed (${batch._ops.length} updates)`);
			}

			if (i + BATCH_SIZE < docsToUpdate.length) {
				console.log(`Waiting ${DELAY_MS}ms...`);
				await new Promise((resolve) => setTimeout(resolve, DELAY_MS));
			}
		}

		console.log(`Updated (bio added): ${updated}`);
		console.log(`Failed (no bio):     ${failed}`);
	} catch (error) {
		console.error("Fatal error:", error);
	}
}

updateRecentArtistBios();
