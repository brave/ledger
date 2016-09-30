#!/bin/sh
. ./setenv.sh

if [ -z "$BITGO_TOKEN" -o -z "$BITGO_ENTERPRISE_ID" ]; then
 echo "ERROR: Missing BITGO_TOKEN or BITGO_ENTERPRISE_ID"
 echo "please edit ./setenv.sh and set BITGO_* vars before running, thanks" 
 exit
fi


if [ "$GITHUB_DISABLE_AUTHENTICATION" != true ]; then
  if [ -z "$GITHUB_CLIENT_ID" -o -z "$GITHUB_CLIENT_SECRET" ]; then
    echo "ERROR: Missing GITHUB_CLIENT_ID or GITHUB_CLIENT_SECRET"
    echo "please edit ./setenv.sh and set GITHUB_* vars before running, thanks"
    echo "OR, you can set GITHUB_DISABLE_AUTHENTICATION=true to disable authentication!"
    exit
  fi
else
  echo "WARNING: Running with GITHUB_DISABLE_AUTHENTICATION=true !"
fi

docker-compose up
