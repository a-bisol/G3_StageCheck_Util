#!/bin/bash
cd /home/ash/stagecheck-sync || exit 1

node sync-event.js --limit=600 --city="Toronto"
node sync-event.js --limit=500 --city="New York City"
node sync-event.js --limit=500 --city="Chicago"
node sync-event.js --limit=500 --city="Buffalo"

node geocodeVenues.js

node migrateEvents.js &
node update-bios.js &
node sendNotifications.js &

wait

echo "All scripts completed at $(date)"
