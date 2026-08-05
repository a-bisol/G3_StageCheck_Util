require("dotenv").config();
const { initializeApp, cert } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const { getMessaging } = require("firebase-admin/messaging");

const LOOKBACK_HOURS = 24;

const serviceAccount = require(process.env.SERVICE_ACCOUNT_PATH);
initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore();
const messaging = getMessaging();

async function sendDailyArtistNotifications() {
	console.log("Starting daily summary notification job...");
	const cutoff = new Date(Date.now() - LOOKBACK_HOURS * 60 * 60 * 1000);

	const eventsSnap = await db
		.collection("events")
		.where("createdAt", ">=", cutoff)
		.get();

	if (eventsSnap.empty) {
		console.log(`No new events in the last ${LOOKBACK_HOURS} hours.`);
		return;
	}

	const artistCounts = {};
	eventsSnap.forEach((doc) => {
		const artists = doc.data().artistIds || [];
		artists.forEach((artistId) => {
			artistCounts[artistId] = (artistCounts[artistId] || 0) + 1;
		});
	});

	console.log("Aggregated counts:", artistCounts);

	const userSummaryMap = {};

	for (const [artistId, count] of Object.entries(artistCounts)) {
		const artistDoc = await db.collection("artists").doc(artistId).get();
		if (!artistDoc.exists) continue;

		const artistData = artistDoc.data();
		const artistName = artistData.name || artistId;
		const followers = artistData.following || [];

		followers.forEach((userId) => {
			if (!userSummaryMap[userId]) {
				userSummaryMap[userId] = [];
			}
			userSummaryMap[userId].push({ name: artistName, count });
		});
	}

	console.log(
		`Building notifications for ${Object.keys(userSummaryMap).length} users...`,
	);

	for (const [userId, artistSummaries] of Object.entries(userSummaryMap)) {
		const summaryParts = artistSummaries.map(
			(s) => `${s.name} (${s.count})`,
		);
		const body = summaryParts.join(", ");

		const truncatedBody =
			body.length > 400 ? body.slice(0, 397) + "..." : body;

		const userDoc = await db.collection("users").doc(userId).get();
		if (!userDoc.exists) continue;

		const tokens = userDoc.data().fcmTokens || [];
		if (tokens.length === 0) continue;

		const payload = {
			notification: {
				title: "🎵 New shows announced!",
				body: truncatedBody,
			},
			tokens: tokens,
			android: {
				priority: "high",
				notification: {
					sound: "default",
					channelId: "artist_updates",
				},
			},
		};

		try {
			const response = await messaging.sendEachForMulticast(payload);
			console.log(
				`User ${userId}: ${response.successCount} succeeded, ${response.failureCount} failed.`,
			);
		} catch (error) {
			console.error(`Failed to send to user ${userId}:`, error);
		}
	}

	console.log("Summary notification job completed.");
}

sendDailyArtistNotifications();
