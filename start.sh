#!/bin/bash
npm run dev --prefix backend &
BACKEND_PID=$!

npm run dev --prefix frontend &
FRONTEND_PID=$!

trap "kill $BACKEND_PID $FRONTEND_PID 2>/dev/null; exit" SIGTERM SIGINT

wait $BACKEND_PID $FRONTEND_PID
