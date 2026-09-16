#!/bin/zsh

PORT=${1:-8083}
echo "Starting SonicMapper Local Server on http://localhost:$PORT ..."
python3 -m http.server $PORT
