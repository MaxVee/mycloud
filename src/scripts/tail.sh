#!/bin/bash

LAMBDA="$1"
MINUTES_AGO=$2
if [ -z "$MINUTES_AGO" ]; then
  MINUTES_AGO=5
fi

function minutesago () {
  CODE="console.log(Date.now() - $1 * 60 * 1000)"
  node -e "$CODE"
}

echo "logging invocations starting $MINUTES_AGO minutes ago"
./node_modules/.bin/sls logs -f "$LAMBDA" --startTime $(minutesago $MINUTES_AGO) --tail
