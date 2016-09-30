FROM node:6.6

RUN mkdir -p /usr/src/app
WORKDIR /usr/src/app

COPY package.json /usr/src/app/
RUN npm install
COPY . /usr/src/app
RUN mv node-anonize2-relic node_modules/

# defaults for some required ENV variables
ENV PORT 8080
ENV NODE_ENV "development" 
ENV DEBUG "*,-babel,-babel*,-mongo:Connection,-mongo:Pool"

EXPOSE 8080

CMD [ "npm", "start" ]