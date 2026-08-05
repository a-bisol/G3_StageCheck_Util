require("dotenv").config();
const { initializeApp, cert } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const axios = require("axios");

const args = process.argv.slice(2);
const params = {
	city: args.find((arg) => arg.startsWith("--city="))?.split("=")[1],
	radius:
		args.find((arg) => arg.startsWith("--radius="))?.split("=")[1] || "15",
	unit: args.find((arg) => arg.startsWith("--unit="))?.split("=")[1] || "km",
	startDate:
		args.find((arg) => arg.startsWith("--startDate="))?.split("=")[1] ||
		new Date().toISOString().split("T")[0],
	limit: args.find((arg) => arg.startsWith("--limit="))?.split("=")[1] || "5",
	classificationName:
		args.find((arg) => arg.startsWith("--className="))?.split("=")[1] ||
		"Music",
	artist: args.find((arg) => arg.startsWith("--artist="))?.split("=")[1],
};

const serviceAccount = require(process.env.SERVICE_ACCOUNT_PATH);
initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore();

async function fetchEvents(limit = 200) {
	const url = "https://app.ticketmaster.com/discovery/v2/events.json";
	let allEvents = [];
	let page = 0;
	const pageSize = Math.min(limit, 200);
	let hasMore = true;

	while (hasMore && allEvents.length < limit) {
		const requestParams = {
			apikey: process.env.TICKETMASTER_API_KEY,
			radius: params.radius,
			unit: params.unit,
			startDateTime: `${params.startDate}T00:00:00Z`,
			size: pageSize,
			page: page,
			sort: "date,asc",
			source: "ticketmaster",
			includeTBD: "no",
			includeTBA: "no",
			classificationName: params.classificationName,
		};

		if (params.city) requestParams.city = params.city;
		if (params.artist) requestParams.keyword = params.artist;

		const response = await axios.get(url, { params: requestParams });
		const events = response.data._embedded?.events || [];
		allEvents = allEvents.concat(events);

		const pageInfo = response.data.page;
		if (pageInfo && pageInfo.totalPages) {
			if (page + 1 >= pageInfo.totalPages) {
				hasMore = false;
			} else {
				page++;
			}
		} else {
			hasMore = false;
		}

		console.log(
			`Fetched page ${page} (${events.length} events, cumulative ${allEvents.length})`,
		);
	}

	return allEvents;
}

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
		lastSyncedAt: FieldValue.serverTimestamp(),
	};
}

async function updateEvents(events) {
	if (events.length === 0) return;

	const eventIds = events.map((e) => e.id);
	const allArtistIds = new Set();
	for (const rawEvent of events) {
		const attractions = rawEvent._embedded?.attractions || [];
		for (const attr of attractions) {
			if (attr.id) allArtistIds.add(attr.id);
		}
	}
	const artistIds = Array.from(allArtistIds);

	let eventBatch = db.batch();
	let artistBatch = db.batch();
	let eventOpCount = 0;
	let artistOpCount = 0;

	const processedArtistIds = new Set();

	for (const rawEvent of events) {
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

		const artistIdsForEvent = attractions.map((a) => a.id);

		const cleanedEvent = transformEvent(rawEvent, artistIdsForEvent);

		const eventRef = db.collection("events").doc(rawEvent.id);
		eventBatch.set(eventRef, cleanedEvent, { merge: true });
		eventOpCount++;

		for (const artist of attractions) {
			if (!processedArtistIds.has(artist.id)) {
				processedArtistIds.add(artist.id);
				const artistData = {
					name: artist.name,
					image3x2: artist.image3x2,
					image16x9: artist.image16x9,
					lastSyncedAt: FieldValue.serverTimestamp(),
				};

				const artistRef = db.collection("artists").doc(artist.id);
				artistBatch.set(artistRef, artistData, { merge: true });
				artistOpCount++;
			}
		}

		if (eventOpCount + artistOpCount >= 450) {
			await eventBatch.commit();
			await artistBatch.commit();
			console.log(
				`Committed intermediate batch: ${eventOpCount} events, ${artistOpCount} artists`,
			);
			eventBatch = db.batch();
			artistBatch = db.batch();
			eventOpCount = 0;
			artistOpCount = 0;
		}
	}

	if (eventOpCount > 0 || artistOpCount > 0) {
		await eventBatch.commit();
		await artistBatch.commit();
		console.log(
			`Final commit: ${eventOpCount} events, ${artistOpCount} artists`,
		);
	}

	console.log(
		`Synced ${events.length} events, and ${processedArtistIds.size} unique artists`,
	);
}

async function main() {
	try {
		const limit = parseInt(params.limit, 10) || 5;
		const cityDisplay = params.city || "no city specified";
		console.log(
			`Fetching events for ${cityDisplay} (radius: ${params.radius} ${params.unit}), limit: ${limit}...`,
		);

		const events = await fetchEvents(limit);
		if (events.length === 0) {
			console.log("No events found.");
			return;
		}

		await updateEvents(events);
	} catch (error) {
		console.error("Error:", error.response?.data || error.message);
		process.exit(1);
	}
}

main();
