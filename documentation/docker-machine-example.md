# Deploy to AWS w/ Docker Machine

`docker-machine` makes it incredibly easy to provision a machine in AWS and deploy the Ledger server there.

```
# create new AWS machine
MACHINE_NAME="aws-ledger-test"
docker-machine create --driver amazonec2 --amazonec2-subnet-id subnet-blah --amazonec2-vpc-id vpc-blah $MACHINE_NAME


# go to ledger repo directory
cd ~/projs/git/ledger/ 

# point local docker commands to new machine
$(docker-machine env $MACHINE_NAME) 

# build and run Ledger / Mongo / Redis
export EXTERNAL_PORT=80
docker-compose build
./run_docker.sh

# tell AWS to open port 80 to everyone
ACTIVE_SECURITY_GROUP_ID=$(docker-machine inspect $ACTIVE_MACHINE | jq .Driver.SecurityGroupIds[0])
aws ec2 --region=us-east-1 authorize-security-group-ingress  --group-id $ACTIVE_SECURITY_GROUP_ID --protocol tcp --port 80 --cidr "0.0.0.0/0"

# test!
ACTIVE_MACHINE_IP=$(docker-machine ip $ACTIVE_MACHINE)
curl "http://$ACTIVE_MACHINE_IP:80/"
# Welcome to the Brave Ledger.
```
