#!/bin/sh
. ./setenv.sh

if [ -z "$BITGO_TOKEN" -o -z "$BITGO_ENTERPRISE_ID" ]; then
 echo "ERROR: Missing BITGO_TOKEN or BITGO_ENTERPRISE_ID"
 echo "please edit ./setenv.sh and set BITGO_* vars before running, thanks" 
else
 docker-compose up
fi
