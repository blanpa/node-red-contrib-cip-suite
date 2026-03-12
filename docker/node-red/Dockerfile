FROM nodered/node-red:latest

# Copy the contrib package into the container
COPY --chown=node-red:root package.json /opt/cip-suite/package.json
COPY --chown=node-red:root nodes/ /opt/cip-suite/nodes/
COPY --chown=node-red:root icons/ /opt/cip-suite/icons/

# Install the package and its dependencies
WORKDIR /opt/cip-suite
RUN npm install --production

# Set up Node-RED to load our package
WORKDIR /usr/src/node-red
RUN npm install /opt/cip-suite

# Copy example flow as the default flow
COPY --chown=node-red:root docker/node-red/flows.json /data/flows.json
COPY --chown=node-red:root docker/node-red/settings.js /data/settings.js
