#!/bin/bash
name=
url=
stage=

while getopts u:s: opt; do
  case $opt in
  u)
      url=$OPTARG
      ;;
  s)
      stage=$OPTARG
      ;;
  *)
      exit 1
      ;;
  esac
done

if [ -z "$stage" ] || [ -z "url" ]; then
  # stage=$(./lib/scripts/var.js custom.stage)
  echo '-u (url) and -s (stage) are required'
  exit 1
fi

set -x
echo "{ \"url\": \"$url\" }" | ./node_modules/.bin/sls invoke --stage=$stage -f addfriend
