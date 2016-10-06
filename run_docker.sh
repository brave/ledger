#!/bin/sh

if [ ! -z "$DOCKER_MACHINE_NAME" ]; then
  export REMOTE_BASE_PATH=$(docker-machine ssh $DOCKER_MACHINE_NAME pwd)
  export CONFIG_PATH=$REMOTE_BASE_PATH/config
  docker-machine scp -r  ./config $DOCKER_MACHINE_NAME:$CONFIG_PATH
else
  export CONFIG_PATH=$PWD/config
fi

docker-compose up
