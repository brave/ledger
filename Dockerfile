FROM node:6.6

RUN wget https://cmake.org/files/v3.6/cmake-3.6.2-Linux-x86_64.tar.gz
RUN tar -xf cmake-3.6.2-Linux-x86_64.tar.gz

RUN ln -s /cmake-3.6.2-Linux-x86_64/bin/cmake /usr/local/bin/cmake
RUN ln -s /cmake-3.6.2-Linux-x86_64/bin/ccmake /usr/local/bin/ccmake
RUN ln -s /cmake-3.6.2-Linux-x86_64/bin/cmake-gui /usr/local/bin/cmake-gui
RUN ln -s /cmake-3.6.2-Linux-x86_64/bin/cpack /usr/local/bin/cpack
RUN ln -s /cmake-3.6.2-Linux-x86_64/bin/ctest /usr/local/bin/ctest

RUN mkdir -p /usr/src/app
WORKDIR /usr/src/app

COPY package.json /usr/src/app/
RUN npm install
COPY . /usr/src/app

# defaults for some required ENV variables
ENV PORT 8080
ENV NODE_ENV "development" 
ENV DEBUG "*,-babel,-babel*,-mongo:Connection,-mongo:Pool"

EXPOSE 8080

CMD [ "npm", "start" ]