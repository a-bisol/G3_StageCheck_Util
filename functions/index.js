require("dotenv").config();
const admin = require("firebase-admin");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const functions = require("firebase-functions");
const { onDocumentCreated } = require("firebase-functions/v2/firestore");

if (!admin.apps.length) {
	try {
		admin.initializeApp({
			projectId: "g3-stagecheck",
		});
	} catch (e) {
		const serviceAccount = require(process.env.SERVICE_ACCOUNT_PATH);
		admin.initializeApp({
			credential: admin.credential.cert(serviceAccount),
			projectId: "g3-stagecheck",
		});
	}
}
const db = admin.firestore();

function getSmallestImageByRatio(images, targetRatio = "3_2") {
	const filtered = images.filter((img) => img.ratio === targetRatio);
	if (filtered.length === 0) return null;
	const smallest = filtered.reduce((smallest, img) => {
		const width = img.width || Infinity;
		const smallestWidth = smallest.width || Infinity;
		return width < smallestWidth ? img : smallest;
	}, {});
	return smallest.url || null;
}

function getLargestImageByRatio(images, targetRatio = "16_9") {
	const filtered = images.filter((img) => img.ratio === targetRatio);
	if (filtered.length === 0) return null;
	const largest = filtered.reduce((largest, img) => {
		const width = img.width || -Infinity;
		const largestWidth = largest.width || -Infinity;
		return width > largestWidth ? img : largest;
	}, {});
	return largest.url || null;
}

function transformEvent(rawEvent, artistIds) {
	const venue = rawEvent._embedded?.venues?.[0] || {};
	const dates = rawEvent.dates || {};
	const startDate = dates.start || {};
	const eventImages = rawEvent.images || [];

	return {
		id: rawEvent.id,
		ticketmasterUrl: rawEvent.url,
		name: rawEvent.name,
		genre: rawEvent.classifications?.[0]?.genre?.name || "Other",
		subGenre: rawEvent.classifications?.[0]?.subGenre?.name || "",
		artistIds: artistIds,
		headliner: rawEvent._embedded?.attractions?.[0]?.name || rawEvent.name,
		venueName: venue.name,
		venueCity: venue.city?.name || "",
		venueState: venue.state?.stateCode || "",
		venueCountry: venue.country?.countryCode || "",
		venueAddress: venue.address?.line1 || "",
		venueID: venue.id,
		venueLat:
			venue.location?.latitude != null
				? Number(venue.location.latitude)
				: null,
		venueLong:
			venue.location?.longitude != null
				? Number(venue.location.longitude)
				: null,
		localDate: startDate.localDate,
		localTime: startDate.localTime || "",
		dateTime: startDate.dateTime || "",
		status: rawEvent.dates?.status?.code || "onsale",
		eventImage3x2: getSmallestImageByRatio(eventImages, "3_2"),
		eventImage16x9: getLargestImageByRatio(eventImages, "16_9"),
		lastSyncedAt: admin.firestore.FieldValue.serverTimestamp(),
	};
}

async function fetchEvents(params) {
	let apiKey = process.env.TICKETMASTER_API_KEY;
	if (!apiKey) {
		try {
			const config = functions.config();
			if (config.ticketmaster && config.ticketmaster.api_key) {
				apiKey = config.ticketmaster.api_key;
			}
		} catch (e) {}
	}

	if (!apiKey) {
		throw new Error("Missing Ticketmaster API key.");
	}

	const url = "https://app.ticketmaster.com/discovery/v2/events.json";
	const requestParams = {
		apikey: apiKey,
		radius: params.radius,
		unit: params.unit,
		startDateTime: `${params.startDate}T00:00:00Z`,
		size: params.limit,
		sort: "date,asc",
		source: "ticketmaster",
		includeTBD: "no",
		includeTBA: "no",
		classificationName: params.classificationName,
	};

	if (params.city && params.city.trim() !== "") {
		requestParams.city = params.city;
	}

	if (params.artist && params.artist.trim() !== "") {
		requestParams.keyword = params.artist;
	}

	if (params.endDate) {
		requestParams.endDateTime = `${params.endDate}T23:59:59Z`;
	}

	const logParams = { ...requestParams };
	logParams.apikey = "lolno";
	console.log(
		"Ticketmaster API Request: ",
		JSON.stringify(logParams, null, 2),
	);

	try {
		const response = await axios.get(url, { params: requestParams });

		const totalEvents = response.data._embedded?.events?.length || 0;

		if (totalEvents > 0) {
			const firstEvent = response.data._embedded.events[0];
			console.log(
				`First event date: ${firstEvent.dates?.start?.localDate || "Unknown"}`,
			);
			const lastEvent = response.data._embedded.events[totalEvents - 1];
			console.log(
				`Last event date: ${lastEvent.dates?.start?.localDate || "unknown"}`,
			);
		}
		return response.data._embedded?.events || [];
	} catch (error) {
		console.error(
			"Ticketmaster API error:",
			error.message || error.response?.data,
		);
		throw error;
	}
}

function processEvents(rawEvents) {
	const cleanedEvents = [];
	const artistsMap = new Map();

	for (const rawEvent of rawEvents) {
		const attractions = (rawEvent._embedded?.attractions || []).map(
			(attraction) => ({
				id: attraction.id,
				name: attraction.name,
				image3x2: getSmallestImageByRatio(
					attraction.images || [],
					"3_2",
				),
				image16x9: getLargestImageByRatio(
					attraction.images || [],
					"16_9",
				),
			}),
		);

		const artistIds = attractions.map((a) => a.id);
		const cleanedEvent = transformEvent(rawEvent, artistIds);
		cleanedEvents.push(cleanedEvent);

		for (const artist of attractions) {
			if (!artistsMap.has(artist.id)) {
				artistsMap.set(artist.id, {
					name: artist.name,
					image3x2: artist.image3x2,
					image16x9: artist.image16x9,
				});
			}
		}
	}

	return { cleanedEvents, artistsMap };
}

async function writeToFirestore(cleanedEvents, artistsMap) {
	if (cleanedEvents.length === 0) return;

	let eventBatch = db.batch();
	let artistBatch = db.batch();
	let eventOpCount = 0;
	let artistOpCount = 0;

	for (const event of cleanedEvents) {
		const eventRef = db.collection("events").doc(event.id);
		eventBatch.set(eventRef, event, { merge: true });
		eventOpCount++;
	}

	const processedArtistIds = new Set();
	for (const [artistId, artistData] of artistsMap) {
		if (!processedArtistIds.has(artistId)) {
			processedArtistIds.add(artistId);
			const artistRef = db.collection("artists").doc(artistId);
			const artistDoc = {
				...artistData,
				lastSyncedAt: admin.firestore.FieldValue.serverTimestamp(),
			};
			artistBatch.set(artistRef, artistDoc, { merge: true });
			artistOpCount++;
		}
	}

	await eventBatch.commit();
	await artistBatch.commit();

	console.log(
		`Synced ${cleanedEvents.length} events and ${artistsMap.size} unique artists`,
	);
}

async function runSync(params, options = { dryRun: false }) {
	console.log(
		`Fetching events for ${params.city} (radius: ${params.radius} ${params.unit})...`,
	);
	const rawEvents = await fetchEvents(params);
	if (rawEvents.length === 0) {
		console.log("No events found");
		return [];
	}

	const { cleanedEvents, artistsMap } = processEvents(rawEvents);

	await writeToFirestore(cleanedEvents, artistsMap);
	return cleanedEvents;
}

async function main() {
	const args = process.argv.slice(2);
	const params = {
		city: args.find((arg) => arg.startsWith("--city="))?.split("=")[1],
		radius:
			args.find((arg) => arg.startsWith("--radius="))?.split("=")[1] ||
			"15",
		unit:
			args.find((arg) => arg.startsWith("--unit="))?.split("=")[1] ||
			"km",
		startDate:
			args.find((arg) => arg.startsWith("--startDate="))?.split("=")[1] ||
			new Date().toISOString().split("T")[0],
		limit:
			args.find((arg) => arg.startsWith("--limit="))?.split("=")[1] ||
			"5",
		classificationName:
			args.find((arg) => arg.startsWith("--className="))?.split("=")[1] ||
			"Music",
		artist: args.find((arg) => arg.startsWith("--artist="))?.split("=")[1],
	};

	try {
		const cleanedEvents = await runSync(params);
	} catch (error) {
		console.error("Error:", error.response?.data || error.message);
		process.exit(1);
	}
}

if (require.main === module) {
	main();
}

exports.syncEvents = functions.https.onRequest(async (req, res) => {
	console.log("Incoming HTTP request:");
	console.log(`Method: ${req.method}`);
	console.log(`Headers: ${JSON.stringify(req.headers, null, 2)}`);
	console.log(`Body: ${JSON.stringify(req.body, null, 2)}`);

	res.set("Access-Control-Allow-Origin", "*");
	if (req.method === "OPTIONS") {
		res.set("Access-Control-Allow-Methods", "POST");
		res.set("Access-Control-Allow-Headers", "Content-Type");
		return res.status(204).send("");
	}

	if (req.method !== "POST") {
		return res.status(405).json({ error: "Method not allowed" });
	}

	try {
		const params = {
			city: req.body.city,
			radius: req.body.radius || "25",
			unit: req.body.unit || "km",
			startDate:
				req.body.startDate || new Date().toISOString().split("T")[0],
			endDate: req.body.endDate,
			limit: req.body.limit || "5",
			classificationName: req.body.classificationName || "Music",
			artist: req.body.artist || undefined,
		};

		console.log("Parsed params:", JSON.stringify(params, null, 2));

		const cleanedEvents = await runSync(params, { dryRun: false });

		const responseBody = {
			success: true,
			count: cleanedEvents.length,
			events: cleanedEvents,
		};

		console.log(
			`Sending response: success=${responseBody.success}, count=${responseBody.count}`,
		);
		if (cleanedEvents.length > 0) {
			console.log(`First event date: ${cleanedEvents[0].localDate}`);
			console.log(
				`Last event date: ${cleanedEvents[cleanedEvents.length - 1].localDate}`,
			);
		}

		res.status(200).json(responseBody);
	} catch (error) {
		console.error("HTTP error:", error);
		res.status(500).json({ error: error.message });
	}
});

exports.addCreatedAtToEvent = onDocumentCreated(
	"events/{eventId}",
	async (event) => {
		const snap = event.data;
		if (!snap.exists) return;
		const data = snap.data();
		if (!data.createdAt) {
			await snap.ref.update({
				createdAt: admin.firestore.FieldValue.serverTimestamp(),
			});
		}
	},
);

exports.addCreatedAtToArtist = onDocumentCreated(
	"artists/{artistId}",
	async (event) => {
		const snap = event.data;
		if (!snap.exists) return;
		const data = snap.data();
		if (!data.createdAt) {
			await snap.ref.update({
				createdAt: admin.firestore.FieldValue.serverTimestamp(),
			});
		}
	},
);
