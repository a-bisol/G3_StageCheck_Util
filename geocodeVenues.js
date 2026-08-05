require("dotenv").config();
const { initializeApp, cert } = require("firebase-admin/app");
const {
	getFirestore,
	FieldValue,
	GeoPoint,
} = require("firebase-admin/firestore");
const axios = require("axios");

const args = process.argv.slice(2);
const params = {
	limit:
		args.find((arg) => arg.startsWith("--limit="))?.split("=")[1] || null,
};

const serviceAccount = require(process.env.SERVICE_ACCOUNT_PATH);
initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore();

async function geocodeAddress(address, retryCount = 0) {
	const url = "https://nominatim.openstreetmap.org/search";
	try {
		const response = await axios.get(url, {
			params: {
				q: address,
				format: "json",
				limit: 1,
			},
			headers: {
				"User-Agent": "StageCheck/1.0",
			},
			timeout: 10000,
		});

		if (response.data && response.data.length > 0) {
			const result = response.data[0];
			return {
				lat: parseFloat(result.lat),
				lng: parseFloat(result.lon),
			};
		}
		return null;
	} catch (error) {
		if (error.response && error.response.status === 403 && retryCount < 3) {
			console.log(`Rate limited, waiting 5 seconds before retry...`);
			await new Promise((resolve) => setTimeout(resolve, 5000));
			return geocodeAddress(address, retryCount + 1);
		}
		console.error(`Geocoding failed for "${address}":`, error.message);
		return null;
	}
}

async function geocodeVenues() {
	let query = db.collection("venues").where("location", "==", null);

	if (params.limit) {
		query = query.limit(parseInt(params.limit, 10));
		console.log(`Limiting to ${params.limit} venues`);
	}

	const venuesSnapshot = await query.get();
	console.log(`Found ${venuesSnapshot.size} venues needing geocoding`);

	if (venuesSnapshot.empty) {
		console.log("No venues need geocoding");
		return;
	}

	const BATCH_SIZE = 10;
	let batch = db.batch();
	let operationCount = 0;
	let successCount = 0;
	let failCount = 0;

	async function commitBatch() {
		if (operationCount === 0) return;
		await batch.commit();
		console.log(`Committed batch (${operationCount} operations)`);
		batch = db.batch();
		operationCount = 0;
		await new Promise((resolve) => setTimeout(resolve, 1000));
	}

	for (const doc of venuesSnapshot.docs) {
		const data = doc.data();
		const addressParts = [
			data.address?.street,
			data.address?.city,
			data.address?.state,
			data.address?.country,
		].filter((part) => part && part.length > 0);

		const fullAddress = addressParts.join(", ");

		if (!fullAddress) {
			console.warn(`Venue ${doc.id} has no address to geocode`);
			continue;
		}

		console.log(`Geocoding: ${doc.id} - ${fullAddress}`);
		const coords = await geocodeAddress(fullAddress);

		if (coords) {
			const venueRef = db.collection("venues").doc(doc.id);
			batch.update(venueRef, {
				location: new GeoPoint(coords.lat, coords.lng),
				lastUpdated: FieldValue.serverTimestamp(),
			});
			operationCount++;
			successCount++;
			console.log(`Found: ${coords.lat}, ${coords.lng}`);
		} else {
			failCount++;
			console.log(`No results found`);
		}

		if (operationCount >= BATCH_SIZE) {
			await commitBatch();
		}
	}

	await commitBatch();

	console.log("Geocoding complete!");
	console.log(`Successfully geocoded: ${successCount}`);
	console.log(`Failed to geocode: ${failCount}`);
}

async function main() {
	try {
		await geocodeVenues();
	} catch (error) {
		console.error("Geocoding failed:", error);
		process.exit(1);
	}
}

main();
