require("dotenv").config();
const { initializeApp, cert } = require("firebase-admin/app");
const {
	getFirestore,
	FieldValue,
	GeoPoint,
} = require("firebase-admin/firestore");

const args = process.argv.slice(2);
const params = {
	limit:
		args.find((arg) => arg.startsWith("--limit="))?.split("=")[1] || null,
};

const serviceAccount = require(process.env.SERVICE_ACCOUNT_PATH);
initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore();

function slugify(text) {
	return text
		.toString()
		.toLowerCase()
		.replace(/\s+/g, "-")
		.replace(/[^\w\-]+/g, "")
		.replace(/\-\-+/g, "-")
		.replace(/^-+/, "")
		.replace(/-+$/, "");
}

function generateVenueKey(data) {
	const name = data.venueName || "unknown-venue";
	const city = data.venueCity || "";
	const state = data.venueState || "";

	const parts = [slugify(name), slugify(city), slugify(state)].filter(
		(part) => part && part.length > 0,
	);

	return parts.length === 0 ? slugify(name) : parts.join("-");
}

async function migrateVenues() {
	console.log("Starting venue migration...");

	let query = db.collection("events");
	if (params.limit) {
		query = query.limit(parseInt(params.limit, 10));
		console.log(`Limiting to ${params.limit} events (for testing)`);
	}

	const eventsSnapshot = await query.get();
	console.log(`Found ${eventsSnapshot.size} events`);

	if (eventsSnapshot.empty) {
		console.log("No events found. Exiting.");
		return;
	}

	const venueMap = new Map();

	eventsSnapshot.forEach((doc) => {
		const data = doc.data();
		const eventId = doc.id;

		if (!data.venueName) {
			console.warn(`Event ${eventId} has no venueName. Skipping`);
			return;
		}

		const key = generateVenueKey(data);

		if (venueMap.has(key)) {
			const existing = venueMap.get(key);
			existing.eventIds.push(eventId);

			if (data.venueLat && data.venueLong) {
				const lat = parseFloat(data.venueLat);
				const lng = parseFloat(data.venueLong);
				if (!isNaN(lat) && !isNaN(lng) && lat !== 0 && lng !== 0) {
					if (!existing.lat || existing.lat === 0) {
						existing.lat = lat;
						existing.lng = lng;
					}
				}
			}
			existing.address = {
				street: existing.address.street || data.venueAddress || "",
				city: existing.address.city || data.venueCity || "",
				state: existing.address.state || data.venueState || "",
				country: existing.address.country || data.venueCountry || "",
			};
		} else {
			const lat = parseFloat(data.venueLat) || 0;
			const lng = parseFloat(data.venueLong) || 0;

			venueMap.set(key, {
				name: data.venueName.trim(),
				address: {
					street: data.venueAddress || "",
					city: data.venueCity || "",
					state: data.venueState || "",
					country: data.venueCountry || "",
				},
				location:
					lat !== 0 && lng !== 0 && !isNaN(lat) && !isNaN(lng)
						? new GeoPoint(lat, lng)
						: null,
				createdAt: FieldValue.serverTimestamp(),
				lastUpdated: FieldValue.serverTimestamp(),
				eventIds: [eventId],
			});
		}
	});

	console.log(`Deduplicated into ${venueMap.size} unique venues`);

	const BATCH_SIZE = 500;
	let batch = db.batch();
	let operationCount = 0;

	async function commitBatch() {
		if (operationCount === 0) return;
		await batch.commit();
		console.log(`Committed batch (${operationCount} operations)`);
		batch = db.batch();
		operationCount = 0;
		await new Promise((resolve) => setTimeout(resolve, 250));
	}

	for (const [venueKey, venueData] of venueMap.entries()) {
		const { eventIds, ...venueDoc } = venueData;
		const venueRef = db.collection("venues").doc(venueKey);
		batch.set(venueRef, venueDoc, { merge: true });
		operationCount++;

		for (const eventId of eventIds) {
			const eventRef = db.collection("events").doc(eventId);
			batch.update(eventRef, {
				venueDirectoryId: venueKey,
			});
			operationCount++;
		}

		if (operationCount >= BATCH_SIZE) {
			await commitBatch();
		}
	}

	await commitBatch();

	console.log("Migration complete!");
	console.log(`Created/Updated ${venueMap.size} venue documents`);
	console.log(`Linked all events to their new venueDirectoryId`);
}

async function main() {
	try {
		await migrateVenues();
	} catch (error) {
		console.error("Migration failed:", error);
		process.exit(1);
	}
}

main();
